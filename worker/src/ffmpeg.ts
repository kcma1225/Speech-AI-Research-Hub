/**
 * Incremental parser for `ffmpeg -progress pipe:1` output. Feed stdout chunks; returns the
 * latest encoded position in seconds when a chunk completes an `out_time_us=` line.
 */
export class ProgressParser {
  private buffer = "";

  push(chunk: string): number | null {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    let seconds: number | null = null;
    for (const line of lines) {
      // out_time_ms is (despite the name) also microseconds; prefer out_time_us.
      const match = /^out_time_us=(\d+)$/.exec(line.trim());
      if (match) seconds = Number(match[1]) / 1e6;
    }
    return seconds;
  }
}

/** Maps encoded seconds to 0–95 % (the rest is upload). Unknown duration yields null. */
export function progressPercent(seconds: number, duration: number | null): number | null {
  if (!duration || duration <= 0 || !Number.isFinite(seconds)) return null;
  return Math.max(0, Math.min(95, Math.floor((seconds / duration) * 95)));
}

/** Audio-only, metadata stripped, 24 kHz mono 48 kbps AAC in an M4A container. */
export function transcodeArgs(input: string, output: string): string[] {
  return [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-i", input,
    "-vn", "-map_metadata", "-1",
    "-ac", "1", "-ar", "24000", "-c:a", "aac", "-b:a", "48k",
    "-movflags", "+faststart",
    "-f", "mp4",
    "-progress", "pipe:1",
    output,
  ];
}

export function parseDuration(text: string): number | null {
  const seconds = Number(text.trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}
