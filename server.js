const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const fetch = require('node-fetch');
const dotenv = require('dotenv');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { bundle } = require('@remotion/bundler');
const { renderMedia, selectComposition } = require('@remotion/renderer');
const { parseSrt } = require('./src/parseSrt');

dotenv.config();

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 8080;
const OUT_DIR = path.join(__dirname, 'out');
const RENDER_TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS || 180000);
const CPU_COUNT = os.cpus().length;
const DEFAULT_RENDER_CONCURRENCY = Math.max(1, Math.min(2, Math.floor(CPU_COUNT / 2)));
const RENDER_CONCURRENCY = Number(process.env.RENDER_CONCURRENCY || DEFAULT_RENDER_CONCURRENCY);
const OFFTHREAD_VIDEO_THREADS = Number(
  process.env.OFFTHREAD_VIDEO_THREADS || Math.max(1, Math.min(4, CPU_COUNT - 1))
);
const X264_PRESET = process.env.X264_PRESET || 'veryfast';
const CRF = Number(process.env.CRF || 23);
const RENDER_SCALE_RAW = Number(process.env.RENDER_SCALE || 1);
const RENDER_SCALE = Math.min(1, Math.max(0.25, Number.isFinite(RENDER_SCALE_RAW) ? RENDER_SCALE_RAW : 1));
const RENDER_IMAGE_FORMAT_RAW = process.env.RENDER_IMAGE_FORMAT || 'jpeg';
const RENDER_IMAGE_FORMAT = ['jpeg', 'png', 'webp', 'none'].includes(RENDER_IMAGE_FORMAT_RAW)
  ? RENDER_IMAGE_FORMAT_RAW
  : 'jpeg';
const RENDER_JPEG_QUALITY = Number(process.env.RENDER_JPEG_QUALITY || 78);
const HARDWARE_ACCELERATION_RAW = process.env.HARDWARE_ACCELERATION || 'if-possible';
const HARDWARE_ACCELERATION = ['disable', 'if-possible', 'required'].includes(
  HARDWARE_ACCELERATION_RAW
)
  ? HARDWARE_ACCELERATION_RAW
  : 'if-possible';
const NORMALIZE_AUDIO = process.env.NORMALIZE_AUDIO !== 'false';
const MEDIA_CACHE_TTL_MS = Number(process.env.MEDIA_CACHE_TTL_MS || 10 * 60 * 1000);
// By default, delete rendered MP4 after upload (no local copies). Set to "false" to keep for debugging.
const DELETE_OUTPUT_AFTER_RESPONSE = process.env.DELETE_OUTPUT_AFTER_RESPONSE !== 'false';
const WEBHOOK_TIMEOUT_MS = Number(process.env.WEBHOOK_TIMEOUT_MS || 10000);
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || '';
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || '';
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || '';
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || '';
const R2_ENDPOINT =
  process.env.R2_ENDPOINT || (R2_ACCOUNT_ID ? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : '');
const R2_PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL || '';

// Ensure output dir exists
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
app.use('/assets', express.static(OUT_DIR));

// Cache the webpack bundle so we don't rebuild on every request
let bundleCache = null;
const mediaCache = new Map();
let r2Client = null;

function createR2Client() {
  if (r2Client) return r2Client;
  if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    return null;
  }

  r2Client = new S3Client({
    region: 'auto',
    endpoint: R2_ENDPOINT,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });

  return r2Client;
}

async function notifyWebhook(webhookUrl, payload) {
  if (!webhookUrl) return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Webhook responded with ${response.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function uploadToR2({ objectKey, localPath }) {
  const client = createR2Client();
  if (!client) {
    throw new Error('R2 client is not configured. Check .env R2_* variables.');
  }
  if (!R2_BUCKET_NAME) {
    throw new Error('R2_BUCKET_NAME is missing in .env');
  }

  const body = fs.createReadStream(localPath);
  await client.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: objectKey,
      Body: body,
      ContentType: 'video/mp4',
    })
  );

  return R2_PUBLIC_BASE_URL ? `${R2_PUBLIC_BASE_URL.replace(/\/$/, '')}/${objectKey}` : null;
}

async function downloadToTempFile(url, extensionHint = '.bin') {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch media: ${response.status} ${url}`);
  }

  const safeExt = extensionHint.startsWith('.') ? extensionHint : `.${extensionHint}`;
  const filePath = path.join(
    OUT_DIR,
    `asset_${Date.now()}_${Math.random().toString(36).slice(2)}${safeExt}`
  );

  await new Promise((resolve, reject) => {
    const fileStream = fs.createWriteStream(filePath);
    response.body.pipe(fileStream);
    response.body.on('error', reject);
    fileStream.on('finish', resolve);
    fileStream.on('error', reject);
  });

  return filePath;
}

function cleanupExpiredMediaCache() {
  const now = Date.now();
  for (const [url, entry] of mediaCache.entries()) {
    if (entry.expiresAt > now) continue;
    mediaCache.delete(url);
    fs.unlink(entry.filePath, () => {});
  }
}

function extensionFromUrl(url, fallbackExt) {
  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname);
    return ext || fallbackExt;
  } catch {
    return fallbackExt;
  }
}

async function resolveMediaPath(url, fallbackExt) {
  cleanupExpiredMediaCache();

  const cached = mediaCache.get(url);
  if (cached && fs.existsSync(cached.filePath) && cached.expiresAt > Date.now()) {
    cached.expiresAt = Date.now() + MEDIA_CACHE_TTL_MS;
    return { filePath: cached.filePath, fromCache: true };
  }

  const filePath = await downloadToTempFile(url, extensionFromUrl(url, fallbackExt));
  mediaCache.set(url, {
    filePath,
    expiresAt: Date.now() + MEDIA_CACHE_TTL_MS,
  });

  return { filePath, fromCache: false };
}

function getPublicBaseUrl(req) {
  const forwardedProto = req.get('x-forwarded-proto');
  const protocol = forwardedProto || req.protocol || 'http';
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${protocol}://${host}`;
}

function getBundledFfmpegPath() {
  const platform = os.platform();
  if (platform === 'win32') {
    return path.join(
      __dirname,
      'node_modules',
      '@remotion',
      'compositor-win32-x64-msvc',
      'ffmpeg.exe'
    );
  }
  if (platform === 'linux') {
    return path.join(
      __dirname,
      'node_modules',
      '@remotion',
      'compositor-linux-x64-gnu',
      'ffmpeg'
    );
  }
  if (platform === 'darwin') {
    return path.join(
      __dirname,
      'node_modules',
      '@remotion',
      'compositor-darwin-x64',
      'ffmpeg'
    );
  }
  return null;
}

function normalizeAudioToWav(inputPath) {
  const ffmpegPath = getBundledFfmpegPath();
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
    throw new Error('Bundled ffmpeg not found for this platform (needed for audio normalization)');
  }

  const outPath = path.join(
    OUT_DIR,
    `asset_${Date.now()}_${Math.random().toString(36).slice(2)}_norm.wav`
  );

  const result = spawnSync(
    ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      inputPath,
      '-vn',
      '-ac',
      '2',
      '-ar',
      '48000',
      '-c:a',
      'pcm_s16le',
      outPath,
    ],
    { encoding: 'utf-8' }
  );

  if (result.status !== 0) {
    const stderr = result.stderr || result.stdout || '';
    throw new Error(`Audio normalization failed: ${stderr.trim() || `exit ${result.status}`}`);
  }

  return outPath;
}

async function getBundle() {
  if (bundleCache) return bundleCache;
  console.log('📦 Building Remotion bundle (first time only)...');
  bundleCache = await bundle({
    entryPoint: path.resolve('./src/remotion/index.tsx'),
    webpackOverride: (config) => config,
  });
  console.log('✅ Bundle ready');
  return bundleCache;
}

// ─────────────────────────────────────────────
// Health check
// ─────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'caption-renderer' });
});

// ─────────────────────────────────────────────
// Main render endpoint
// POST /render
// Body: {
//   videoUrl, audioUrl, captionsUrl, durationSeconds?, song_name?,
//   cloudflare_key, metadata?
// }
// Returns 202 immediately; completion is reported via WEBHOOK_URL.
// ─────────────────────────────────────────────
async function runRenderJob({
  jobId,
  baseUrl,
  videoUrl,
  audioUrl,
  captionsUrl,
  durationSeconds,
  songName,
  objectKey,
  callbackUrl,
  webhookMetadata,
}) {
  const renderStartedAt = Date.now();
  let tempVideoPath = null;
  let tempAudioPath = null;
  let normAudioPath = null;
  let shouldCleanupVideo = false;
  let shouldCleanupAudio = false;
  let outputPath = null;
  let failureWebhookSent = false;
  let failurePhase = 'generation';

  const cleanupPath = (filePath) => {
    if (!filePath) return;
    fs.unlink(filePath, (unlinkErr) => {
      if (unlinkErr && unlinkErr.code !== 'ENOENT') {
        console.warn(`Could not delete temp asset ${filePath}:`, unlinkErr.message);
      }
    });
  };

  try {
    console.log(`\n🎬 [${jobId}] Starting render job`);
    // 1. Fetch captions and media in parallel for faster startup
    console.log(`📄 [${jobId}] Fetching captions + media...`);
    const srtPromise = fetch(captionsUrl);
    const videoPromise = resolveMediaPath(videoUrl, '.mp4');
    const audioPromise = resolveMediaPath(audioUrl, '.mp3');

    const [srtResponse, videoResult, audioResult] = await Promise.all([
      srtPromise,
      videoPromise,
      audioPromise,
    ]);

    if (!srtResponse.ok) throw new Error(`Failed to fetch captions: ${srtResponse.status}`);
    const srtContent = await srtResponse.text();
    const captions = parseSrt(srtContent);
    console.log(`   ✅ [${jobId}] Parsed ${captions.length} caption chunks`);
    tempVideoPath = videoResult.filePath;
    tempAudioPath = audioResult.filePath;
    shouldCleanupVideo = !videoResult.fromCache;
    shouldCleanupAudio = !audioResult.fromCache;

    let audioForRenderPath = tempAudioPath;
    if (NORMALIZE_AUDIO) {
      console.log(`🎚 [${jobId}] Normalizing audio for stable mixing...`);
      normAudioPath = normalizeAudioToWav(tempAudioPath);
      audioForRenderPath = normAudioPath;
      console.log(`   ✅ [${jobId}] Audio normalized`);
    }

    if (captions.length === 0) {
      await notifyWebhook(callbackUrl, {
        status: 'FAILURE',
        phase: 'generation',
        reason: 'No captions found in SRT file',
        cloudflare_key: objectKey,
        metadata: webhookMetadata,
        job_id: jobId,
        tookMs: Date.now() - renderStartedAt,
      });
      return;
    }

    // 2. Determine video duration
    const lastCaption = captions[captions.length - 1];
    const durationS = durationSeconds ?? lastCaption.end + 0.5;
    const FPS = 30;
    const durationInFrames = Math.ceil(durationS * FPS);
    console.log(`   ⏱ [${jobId}] Duration: ${durationS}s (${durationInFrames} frames)`);

    const localVideoUrl = `${baseUrl}/assets/${encodeURIComponent(path.basename(tempVideoPath))}`;
    const localAudioUrl = `${baseUrl}/assets/${encodeURIComponent(path.basename(audioForRenderPath))}`;

    // 4. Get/build the Remotion bundle
    const serveUrl = await getBundle();

    // 5. Select composition with dynamic duration
    const inputProps = {
      videoUrl: localVideoUrl,
      audioUrl: localAudioUrl,
      captions,
      durationInFrames,
      songName,
    };

    const composition = await selectComposition({
      serveUrl,
      id: 'CaptionVideo',
      inputProps,
    });

    // Override duration dynamically
    composition.durationInFrames = durationInFrames;

    // 6. Render
    const outputFilename = `render_${Date.now()}.mp4`;
    outputPath = path.join(OUT_DIR, outputFilename);

    console.log(`🎥 [${jobId}] Rendering video...`);
    await renderMedia({
      composition,
      serveUrl,
      codec: 'h264',
      outputLocation: outputPath,
      inputProps,
      onProgress: ({ progress }) => {
        process.stdout.write(`\r   [${jobId}] Progress: ${Math.round(progress * 100)}%`);
      },
      timeoutInMilliseconds: RENDER_TIMEOUT_MS,
      concurrency: RENDER_CONCURRENCY,
      x264Preset: X264_PRESET,
      crf: CRF,
      offthreadVideoThreads: OFFTHREAD_VIDEO_THREADS,
      scale: RENDER_SCALE,
      imageFormat: RENDER_IMAGE_FORMAT,
      jpegQuality: RENDER_JPEG_QUALITY,
      hardwareAcceleration: HARDWARE_ACCELERATION,
      chromiumOptions: {
        disableWebSecurity: true, // needed for cross-origin video/audio URLs
      },
    });

    console.log(`\n✅ [${jobId}] Render complete:`, outputPath);
    // 7. Upload to Cloudflare R2
    let uploadedUrl = null;
    failurePhase = 'upload';
    try {
      uploadedUrl = await uploadToR2({ objectKey, localPath: outputPath });
    } catch (uploadErr) {
      await notifyWebhook(callbackUrl, {
        status: 'FAILURE',
        phase: 'upload',
        reason: uploadErr.message,
        cloudflare_key: objectKey,
        metadata: webhookMetadata,
        job_id: jobId,
        tookMs: Date.now() - renderStartedAt,
      });
      failureWebhookSent = true;
      throw uploadErr;
    }

    // 8. Notify success webhook
    await notifyWebhook(callbackUrl, {
      status: 'SUCCESS',
      phase: 'uploaded',
      cloudflare_key: objectKey,
      output_url: uploadedUrl,
      metadata: webhookMetadata,
      job_id: jobId,
      tookMs: Date.now() - renderStartedAt,
    });

    console.log(`✅ [${jobId}] Job finished (webhook sent)`);
  } catch (err) {
    console.error(`\n❌ [${jobId}] Render failed:`, err.message);
    if (!failureWebhookSent) {
      try {
        await notifyWebhook(callbackUrl, {
          status: 'FAILURE',
          phase: failurePhase,
          reason: err.message,
          cloudflare_key: objectKey,
          metadata: webhookMetadata,
          job_id: jobId,
          tookMs: Date.now() - renderStartedAt,
        });
      } catch (webhookErr) {
        console.warn('Failed to send webhook failure update:', webhookErr.message);
      }
    }
  } finally {
    if (shouldCleanupVideo) cleanupPath(tempVideoPath);
    if (shouldCleanupAudio) cleanupPath(tempAudioPath);
    if (normAudioPath) cleanupPath(normAudioPath);
    if (DELETE_OUTPUT_AFTER_RESPONSE && outputPath && fs.existsSync(outputPath)) {
      fs.unlink(outputPath, (err) => {
        if (err && err.code !== 'ENOENT') {
          console.warn(`Could not delete render output ${outputPath}:`, err.message);
        }
      });
    } else if (outputPath && fs.existsSync(outputPath)) {
      console.log(`📁 [${jobId}] Output kept on disk: ${outputPath}`);
    }
  }
}

app.post('/render', (req, res) => {
  const {
    videoUrl,
    audioUrl,
    captionsUrl,
    durationSeconds,
    song_name,
    cloudflare_key,
    cloudflareKey,
    metadata,
  } = req.body;

  const objectKey = typeof cloudflare_key === 'string' ? cloudflare_key.trim() : String(cloudflareKey || '').trim();
  const callbackUrl = WEBHOOK_URL.trim();
  const webhookMetadata =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? metadata
      : null;

  // Validate (sync only — response returns before any heavy work)
  if (!videoUrl || !audioUrl || !captionsUrl) {
    return res.status(400).json({
      error: 'Missing required fields: videoUrl, audioUrl, captionsUrl',
    });
  }
  if (!objectKey || !callbackUrl) {
    return res.status(400).json({
      error: 'Missing required configuration: cloudflare_key payload and WEBHOOK_URL in .env',
    });
  }
  if (metadata !== undefined && webhookMetadata === null) {
    return res.status(400).json({
      error: 'metadata must be an object when provided',
    });
  }

  const jobId = `job_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
  const baseUrl = getPublicBaseUrl(req);
  const songName = typeof song_name === 'string' ? song_name.trim() : '';

  console.log('\n🎬 Render request accepted (async)');
  console.log('  Job:      ', jobId);
  console.log('  Video:    ', videoUrl);
  console.log('  Audio:    ', audioUrl);
  console.log('  Captions: ', captionsUrl);
  if (songName) console.log('  Song:     ', songName);
  console.log('  R2 Key:   ', objectKey);
  console.log('  Webhook:  ', callbackUrl);

  setImmediate(() => {
    runRenderJob({
      jobId,
      baseUrl,
      videoUrl,
      audioUrl,
      captionsUrl,
      durationSeconds,
      songName,
      objectKey,
      callbackUrl,
      webhookMetadata,
    }).catch((unhandledErr) => {
      console.error(`[${jobId}] Unhandled job error:`, unhandledErr);
    });
  });

  return res.status(202).json({
    accepted: true,
    status: 'generation_started',
    job_id: jobId,
    cloudflare_key: objectKey,
    metadata: webhookMetadata,
    message: 'Render started; result will be sent to WEBHOOK_URL when complete.',
  });
});

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n🚀 Caption Renderer running on port ${PORT}`);
  console.log(`   POST /render  — accept job (202), render async, webhook on complete`);
  console.log(`   GET  /health  — health check\n`);

  // Pre-warm the bundle on startup
  try {
    await getBundle();
  } catch (err) {
    console.warn('⚠️  Bundle pre-warm failed:', err.message);
  }
});
