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

/**
 * Audio-only, metadata stripped, 24 kHz mono 48 kbps AAC in an M4A container. Several inputs (recorder parts of one
 * recording) are decoded and concatenated in order; video streams are ignored (audio extraction from video files).
 */
export function transcodeArgs(input: string | string[], output: string): string[] {
  const inputs = Array.isArray(input) ? input : [input];
  const many = inputs.length > 1;
  return [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    ...inputs.flatMap(file => ["-i", file]),
    ...(many
      ? ["-filter_complex", `${inputs.map((_, i) => `[${i}:a:0]aresample=48000,aformat=channel_layouts=mono[a${i}]`).join(";")};${inputs.map((_, i) => `[a${i}]`).join("")}concat=n=${inputs.length}:v=0:a=1[out]`, "-map", "[out]"]
      : ["-map", "0:a:0"]),
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

/** ffprobe arguments listing each stream as `<codec_type>,<attached_pic 0|1>` (CSV, one per line). */
export function streamTypesArgs(input: string): string[] {
  return ["-v", "error", "-show_entries", "stream=codec_type:stream_disposition=attached_pic", "-of", "csv=p=0", input];
}

/** Whether `streamTypesArgs` output lists a real video stream (cover art in audio files does not count). */
export function hasVideoStream(text: string): boolean {
  return text.split(/\r?\n/).some(line => {
    const [type, attached] = line.trim().split(",");
    return type === "video" && attached !== "1";
  });
}
