import React from 'react';
import {
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  Easing,
} from 'remotion';

interface Caption {
  index: number;
  start: number;
  end: number;
  text: string;
}

interface AnimatedCaptionsProps {
  captions: Caption[];
}

export const AnimatedCaptions: React.FC<AnimatedCaptionsProps> = ({ captions }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const currentTimeS = frame / fps;

  const smoothstep = (t: number) => {
    const x = Math.min(1, Math.max(0, t));
    return x * x * (3 - 2 * x);
  };

  // Find which caption is currently active.
  // We treat `end` as an exclusive boundary (`t < end`) like typical players.
  // If the next cue starts shortly after `end`, we "bridge" the gap to avoid popping.
  const MAX_GAP_HOLD_S = 0.18;
  const currentIndex = captions.findIndex((c, i) => {
    if (currentTimeS < c.start) return false;

    const hardEnd = c.end;
    const nextCue = captions[i + 1];
    if (!nextCue) return currentTimeS < hardEnd;

    const gap = Math.max(0, nextCue.start - hardEnd);
    const bridging = gap > 0 && gap <= MAX_GAP_HOLD_S;

    if (bridging && currentTimeS >= hardEnd && currentTimeS < nextCue.start) {
      return true;
    }

    return currentTimeS < hardEnd;
  });

  if (currentIndex === -1) return null;

  const current = captions[currentIndex];
  const next = captions[currentIndex + 1] ?? null;

  const hardEnd = current.end;
  const gapToNext = next ? Math.max(0, next.start - hardEnd) : 0;
  const bridgingShortGap = Boolean(next && gapToNext > 0 && gapToNext <= MAX_GAP_HOLD_S);
  const inGapHold = Boolean(
    next && bridgingShortGap && currentTimeS >= hardEnd && currentTimeS < next.start
  );

  // How far are we through the current caption (0 → 1)
  const lineDuration = Math.max(hardEnd - current.start, 1 / fps);
  const elapsedForProgress = Math.min(currentTimeS, hardEnd) - current.start;
  const progress = inGapHold ? 1 : Math.min(elapsedForProgress / lineDuration, 1);

  // Duration-adaptive timing keeps short and long phrases equally smooth.
  const transitionWindowS = Math.min(0.75, Math.max(0.32, lineDuration * 0.45));
  const previewWindowS = Math.min(
    lineDuration * 0.85,
    Math.max(0.45, transitionWindowS + 0.3)
  );
  const TRANSITION_START = Math.min(
    0.78,
    Math.max(0.3, 1 - transitionWindowS / lineDuration)
  );
  const PREVIEW_START = Math.max(
    0.04,
    Math.min(TRANSITION_START - 0.12, 1 - previewWindowS / lineDuration)
  );
  const exitRaw = Math.min(
    1,
    Math.max(0, (progress - TRANSITION_START) / Math.max(1 - TRANSITION_START, 1e-6))
  );
  const exitPhase = smoothstep(exitRaw);

  // --- Current line animation ---
  // A subtle rise + fade to mimic Suno-like caption handoff.
  const currentY = interpolate(exitPhase, [0, 1], [0, -18], {
    extrapolateRight: 'clamp',
    easing: Easing.inOut(Easing.cubic),
  });
  const currentOpacity = interpolate(exitPhase, [0, 1], [1, 0.42], {
    extrapolateRight: 'clamp',
    easing: Easing.inOut(Easing.cubic),
  });
  const currentScale = interpolate(exitPhase, [0, 1], [1, 0.99], {
    extrapolateRight: 'clamp',
    easing: Easing.inOut(Easing.cubic),
  });
  const currentBlurPx = interpolate(exitPhase, [0, 1], [0, 0.85], {
    extrapolateRight: 'clamp',
    easing: Easing.inOut(Easing.cubic),
  });
  const effectiveCurrentBlurPx = exitPhase < 0.08 ? 0 : currentBlurPx;

  // --- Entry animation for current caption ---
  // Keep this gentle to avoid the "bouncy" look.
  const entryFrames = frame - Math.round(current.start * fps);
  const entryProgress = interpolate(entryFrames, [0, Math.round(fps * 0.42)], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });
  const entryY = interpolate(entryProgress, [0, 1], [18, 0]);
  const entryOpacity = interpolate(entryProgress, [0, 1], [0, 1]);

  // Blend entry motion out as the handoff begins so we never "snap" between modes.
  const entryBlend = 1 - exitPhase;
  const finalCurrentY = entryY * entryBlend + currentY;
  const finalCurrentOpacity = entryOpacity * entryBlend + currentOpacity * (1 - entryBlend);
  const finalCurrentScale = 1 + (currentScale - 1) * exitPhase;

  // --- Next line animation ---
  // Keep it in its own row to prevent overlap when text wraps.
  const previewT = Math.min(
    1,
    Math.max(0, (progress - PREVIEW_START) / Math.max(TRANSITION_START - PREVIEW_START, 1e-6))
  );
  const previewPhase = smoothstep(previewT);

  const nextYPreview = interpolate(previewPhase, [0, 1], [22, 10], {
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });
  const nextScalePreview = interpolate(previewPhase, [0, 1], [0.94, 0.97], {
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });
  const nextOpacityPreview = interpolate(previewPhase, [0, 1], [0, 0.26], {
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });

  const nextYHandoff = interpolate(exitPhase, [0, 1], [10, -1], {
    extrapolateRight: 'clamp',
    easing: Easing.inOut(Easing.cubic),
  });
  const nextOpacityHandoff = interpolate(exitPhase, [0, 1], [0.26, 0.92], {
    extrapolateRight: 'clamp',
    easing: Easing.inOut(Easing.cubic),
  });
  const nextScaleHandoff = interpolate(exitPhase, [0, 1], [0.97, 1], {
    extrapolateRight: 'clamp',
    easing: Easing.inOut(Easing.cubic),
  });

  const handoffBlendWindow = Math.max(0.1, Math.min(0.22, transitionWindowS / lineDuration));
  const handoffBlend = smoothstep(
    Math.min(
      1,
      Math.max(0, (progress - TRANSITION_START) / Math.max(handoffBlendWindow, 1e-6))
    )
  );

  const finalNextY = nextYPreview * (1 - handoffBlend) + nextYHandoff * handoffBlend;
  const finalNextOpacity =
    nextOpacityPreview * (1 - handoffBlend) + nextOpacityHandoff * handoffBlend;
  const finalNextScale =
    nextScalePreview * (1 - handoffBlend) + nextScaleHandoff * handoffBlend;

  return (
    <div
      style={{
        position: 'absolute',
        top: '56%',
        left: '50%',
        width: 'min(92%, 920px)',
        transform: 'translate(-50%, -50%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        pointerEvents: 'none',
        overflow: 'visible',
      }}
    >
      {/* ── CURRENT CAPTION LINE ── */}
      <div
        style={{
          transform: `translateY(${finalCurrentY}px) scale(${finalCurrentScale})`,
          opacity: finalCurrentOpacity,
          filter: `blur(${effectiveCurrentBlurPx}px)`,
          transition: 'none',
          textAlign: 'center',
          width: '100%',
          minHeight: 140,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          paddingLeft: 20,
          paddingRight: 20,
        }}
      >
        <span
          style={{
            fontFamily: 'Montserrat, sans-serif',
            fontWeight: 900,
            fontSize: 56,
            color: '#FFFFFF',
            textShadow: '0 3px 20px rgba(0,0,0,0.85)',
            lineHeight: 1.2,
            display: 'inline-block',
            maxWidth: 860,
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            background: 'rgba(0,0,0,0.40)',
            borderRadius: 18,
            padding: '10px 24px',
          }}
        >
          {current.text}
        </span>
      </div>

      {/* ── NEXT CAPTION LINE (preview below, small + transparent) ── */}
      {next && !inGapHold && (
        <div
          style={{
            width: '100%',
            minHeight: 120,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transform: `translateY(${finalNextY}px) scale(${finalNextScale})`,
            opacity: finalNextOpacity,
            transition: 'none',
            paddingLeft: 20,
            paddingRight: 20,
          }}
        >
          <span
            style={{
              fontFamily: 'Montserrat, sans-serif',
              fontWeight: 900,
              fontSize: 48,
              color: '#FFFFFF',
              textShadow: '0 2px 14px rgba(0,0,0,0.75)',
              lineHeight: 1.2,
              display: 'inline-block',
              maxWidth: 860,
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              background: 'rgba(0,0,0,0.22)',
              borderRadius: 16,
              padding: '8px 20px',
            }}
          >
            {next.text}
          </span>
        </div>
      )}
    </div>
  );
};
