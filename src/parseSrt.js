/**
 * Parses an SRT file string into an array of caption objects
 * { index, start, end, text }
 * All times are in seconds (float)
 */
function parseSrt(srtContent) {
  const captions = [];
  // Split on double newline to get blocks
  const blocks = srtContent.trim().split(/\n\s*\n/);

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 3) continue;

    const index = parseInt(lines[0].trim(), 10);
    const timeLine = lines[1].trim();
    const text = lines.slice(2).join(' ').trim();

    // Parse "00:00:01,000 --> 00:00:04,000"
    const timeMatch = timeLine.match(
      /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/
    );
    if (!timeMatch) continue;

    const toSeconds = (h, m, s, ms) =>
      parseInt(h) * 3600 + parseInt(m) * 60 + parseInt(s) + parseInt(ms) / 1000;

    captions.push({
      index,
      start: toSeconds(timeMatch[1], timeMatch[2], timeMatch[3], timeMatch[4]),
      end:   toSeconds(timeMatch[5], timeMatch[6], timeMatch[7], timeMatch[8]),
      text,
    });
  }

  return captions;
}

module.exports = { parseSrt };
