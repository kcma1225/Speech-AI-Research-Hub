/** Decode rate for peak extraction; plenty for an overview waveform and cheap to stream. */
export const PEAK_SAMPLE_RATE = 8000;
/** Peaks per second of audio before downsampling (also the cap on resolution: ceil(duration·20)). */
export const PEAKS_PER_SECOND = 20;
export const MAX_PEAKS = 1000;

/**
 * Streaming waveform peaks from mono s16le PCM. `push` folds each chunk into fixed windows of
 * `sampleRate / 20` samples (only the max |sample| per window is kept, so memory is ~20 numbers per
 * second of audio, not the PCM). `finish` downsamples those windows to
 * N = min(1000, ceil(duration·20)) buckets by max, normalizes by the global max to [0,1] and rounds
 * to 3 decimals. Silence yields all zeros; no samples yields [].
 */
export class PeakAccumulator {
  private readonly window: number;
  private readonly windows: number[] = [];
  private current = 0;
  private inWindow = 0;
  private leftover: number | null = null;

  constructor(sampleRate = PEAK_SAMPLE_RATE) {
    this.window = Math.max(1, Math.round(sampleRate / PEAKS_PER_SECOND));
  }

  push(chunk: Buffer) {
    let offset = 0;
    // A sample may straddle two chunks.
    if (this.leftover !== null && chunk.length > 0) {
      this.add(Buffer.from([this.leftover, chunk[0]!]).readInt16LE(0));
      this.leftover = null;
      offset = 1;
    }
    const end = offset + Math.floor((chunk.length - offset) / 2) * 2;
    for (let i = offset; i < end; i += 2) this.add(chunk.readInt16LE(i));
    if (end < chunk.length) this.leftover = chunk[end]!;
  }

  finish(): number[] {
    const windows = this.inWindow > 0 ? [...this.windows, this.current] : this.windows;
    return bucketPeaks(windows, MAX_PEAKS);
  }

  private add(sample: number) {
    const magnitude = Math.abs(sample);
    if (magnitude > this.current) this.current = magnitude;
    if (++this.inWindow === this.window) {
      this.windows.push(this.current);
      this.current = 0;
      this.inWindow = 0;
    }
  }
}

/**
 * Groups `windows` (each one 1/20 s) into min(max, windows.length) buckets of near-equal size by max,
 * then normalizes by the global max and rounds to 3 decimals.
 */
export function bucketPeaks(windows: readonly number[], max = MAX_PEAKS): number[] {
  const count = Math.min(max, windows.length);
  const buckets: number[] = [];
  for (let j = 0; j < count; j++) {
    const from = Math.floor((j * windows.length) / count);
    const to = Math.floor(((j + 1) * windows.length) / count);
    let peak = 0;
    for (let i = from; i < to; i++) if (windows[i]! > peak) peak = windows[i]!;
    buckets.push(peak);
  }
  const top = buckets.reduce((a, b) => Math.max(a, b), 0);
  return buckets.map(value => (top > 0 ? Math.round((value / top) * 1000) / 1000 : 0));
}

/** Decodes `input` to mono 8 kHz s16le on stdout. */
export function peakArgs(input: string): string[] {
  return ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", input, "-vn", "-ac", "1", "-ar", String(PEAK_SAMPLE_RATE), "-f", "s16le", "pipe:1"];
}
