/**
 * Chunking for vendors with size/duration limits: cut at silences (ffmpeg silencedetect),
 * merge chunk results back onto the source timeline. Planning and merging are pure.
 */
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { asrErr } from "./err.js";
import { r3 } from "./normalize.js";
import type { AudioFormat, ChunkPlanEntry, ChunkResult, Segment, TranscriptWarning, Word } from "./types.js";

export type Silence = { start: number; end: number };

/** Parses `silence_start: x` / `silence_end: y | silence_duration: d` lines from ffmpeg stderr. */
export function parseSilencedetect(stderr: string, totalSec?: number): Silence[] {
  const out: Silence[] = [];
  let open: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (s) {
      open = Math.max(0, parseFloat(s[1]!));
      continue;
    }
    const e = /silence_end:\s*([\d.]+)/.exec(line);
    if (e && open != null) {
      out.push({ start: open, end: parseFloat(e[1]!) });
      open = null;
    }
  }
  if (open != null && totalSec != null && totalSec > open) out.push({ start: open, end: totalSec });
  return out;
}

export type PlanOptions = {
  /** Hard upper bound per chunk (seconds). */
  maxChunkSec: number;
  /** Search window before the bound for the best silence (default 180 s, clamped to maxChunkSec/2). */
  windowSec?: number;
  /** Minimum silence length to cut at (default 0.3 s). */
  minSilenceSec?: number;
  /** Overlap at hard cuts (default 2 s). */
  overlapSec?: number;
  /** Start of the range to plan (for re-planning a remainder). */
  from?: number;
  firstIndex?: number;
};

/**
 * Greedy plan: for each chunk, cut at the middle of the longest silence inside
 * [start + max − window, start + max]; if none, hard-cut at start + max with an overlap.
 */
export function planChunks(durationSec: number, silences: Silence[], opts: PlanOptions): ChunkPlanEntry[] {
  const max = Math.max(5, opts.maxChunkSec);
  const window = Math.min(opts.windowSec ?? 180, max / 2);
  const minSil = opts.minSilenceSec ?? 0.3;
  const overlap = opts.overlapSec ?? 2;
  const plan: ChunkPlanEntry[] = [];
  let keepFrom = opts.from ?? 0;
  let start = keepFrom;
  let index = opts.firstIndex ?? 0;
  while (durationSec - start > max + 0.001) {
    const lo = keepFrom + max - window;
    const hi = Math.min(start + max, durationSec);
    let best: Silence | null = null;
    for (const s of silences) {
      const a = Math.max(s.start, lo);
      const b = Math.min(s.end, hi);
      if (b - a < minSil) continue;
      if (!best || b - a > Math.min(best.end, hi) - Math.max(best.start, lo)) best = { start: a, end: b };
    }
    if (best) {
      const cut = r3((best.start + best.end) / 2);
      plan.push({ index: index++, start: r3(start), end: cut, keepFrom: r3(keepFrom), keepTo: cut });
      start = keepFrom = cut;
    } else {
      const cut = r3(keepFrom + max - overlap);
      const end = r3(Math.min(cut + overlap / 2, durationSec));
      plan.push({ index: index++, start: r3(start), end, keepFrom: r3(keepFrom), keepTo: cut });
      keepFrom = cut;
      start = r3(Math.max(0, cut - overlap / 2));
    }
  }
  plan.push({ index, start: r3(start), end: r3(durationSec), keepFrom: r3(keepFrom), keepTo: r3(durationSec) });
  return plan;
}

/** The last `chars` characters of the text, cut at a sentence/word boundary when possible. */
export function promptTail(text: string, chars = 200): string {
  const t = text.trim();
  if (t.length <= chars) return t;
  const tail = t.slice(-chars);
  const m = /[。！？.!?，,\s]/.exec(tail);
  return m && m.index < chars / 2 ? tail.slice(m.index + 1).trim() : tail;
}

/** Builds the prompt for chunk n: base prompt (glossary) + tail of the previous chunk's text. */
export function chainPrompt(base: string | undefined, previousText: string | undefined, maxChars = 800): string | undefined {
  const tail = previousText ? promptTail(previousText) : "";
  const p = [base?.trim(), tail].filter(Boolean).join("\n");
  if (!p) return undefined;
  return p.length > maxChars ? p.slice(p.length - maxChars) : p;
}

export type MergedChunks = {
  text: string;
  segments: Omit<Segment, "id">[];
  words: Word[];
  warnings: TranscriptWarning[];
  languages: string[];
};

/**
 * Merges chunk results (times relative to each chunk's `start`) onto the source timeline.
 * - offsets every timestamp by `entry.start`
 * - keeps only items whose start falls inside [keepFrom, keepTo) (drops the overlap duplicate)
 * - drops a segment that repeats the previous one's text right at a seam
 * - `speakerScope: "global"` keeps labels as-is (vendor was given speaker references);
 *   `"chunk"` namespaces them as `c{n}:{label}` and warns `speaker_labels_per_chunk`.
 */
export function mergeChunks(
  entries: { entry: ChunkPlanEntry; result: ChunkResult }[],
  opts: { speakerScope: "global" | "chunk" },
): MergedChunks {
  const sorted = [...entries].sort((a, b) => a.entry.start - b.entry.start);
  const segments: Omit<Segment, "id">[] = [];
  const words: Word[] = [];
  const warnings = new Set<TranscriptWarning>();
  const languages = new Set<string>();
  const multi = sorted.length > 1;
  let sawSpeaker = false;
  const spk = (n: number, s: string | null | undefined) => {
    if (s == null || s === "") return null;
    sawSpeaker = true;
    return opts.speakerScope === "chunk" && multi ? `c${n}:${s}` : s;
  };
  for (const { entry, result } of sorted) {
    const off = entry.start;
    const isLast = entry === sorted[sorted.length - 1]!.entry;
    const inKeep = (absStart: number, absEnd: number) => {
      const mid = absEnd > absStart ? absStart + Math.min(0.25, (absEnd - absStart) / 2) : absStart;
      return mid >= entry.keepFrom - 0.001 && (isLast || mid < entry.keepTo);
    };
    for (const w of result.words ?? []) {
      const start = r3(w.start + off);
      const end = r3(w.end + off);
      if (!inKeep(start, end)) continue;
      words.push({ ...w, start, end, speaker: spk(entry.index, w.speaker), segmentId: undefined });
    }
    for (const s of result.segments) {
      const start = r3(s.start + off);
      const end = r3(s.end + off);
      if (!inKeep(start, end)) continue;
      const prev = segments[segments.length - 1];
      if (prev && prev.text.trim() === s.text.trim() && start - prev.end < 3) continue;
      segments.push({ ...s, start, end, speaker: spk(entry.index, s.speaker) });
    }
    for (const w of result.warnings ?? []) warnings.add(w);
    if (result.language) languages.add(result.language);
    for (const l of result.languages ?? []) languages.add(l);
  }
  if (multi) warnings.add("chunked");
  if (multi && opts.speakerScope === "chunk" && sawSpeaker) warnings.add("speaker_labels_per_chunk");
  // A text-only chunk has one segment spanning [0, duration]; inKeep uses its start, so it survives.
  return {
    text: segments.map((s) => s.text).join(segments.some((s) => /[㐀-鿿]/.test(s.text)) ? "" : " "),
    segments,
    words,
    warnings: [...warnings],
    languages: [...languages],
  };
}

// ---------------------------------------------------------------- ffmpeg

export type MediaInfo = { durationSec: number; sizeBytes: number };

/** Media operations the orchestrator needs; the default spawns ffmpeg/ffprobe, tests inject fakes. */
export interface MediaTools {
  probe(path: string, signal?: AbortSignal): Promise<MediaInfo>;
  silences(path: string, signal?: AbortSignal): Promise<Silence[]>;
  /** Re-encodes [start,end) (or the whole file when both undefined) to mono 16 kHz in `format`. */
  extract(input: string, output: string, format: AudioFormat, range?: { start: number; end: number }, signal?: AbortSignal): Promise<void>;
}

function run(cmd: string, args: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], signal });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => {
      stderr += d;
      if (stderr.length > 4_000_000) stderr = stderr.slice(-2_000_000);
    });
    p.on("error", (e) => reject(asrErr("unavailable", `${cmd}: ${e.message}`, { cause: e })));
    p.on("close", (code) =>
      code === 0 ? resolve({ stdout, stderr }) : reject(asrErr("bad_request", `${cmd} exited ${code}: ${stderr.slice(-400)}`, { reason: "unsupported_format" })),
    );
  });
}

const CODEC: Record<AudioFormat, string[]> = {
  ogg: ["-c:a", "libopus", "-b:a", "24k", "-application", "voip", "-f", "ogg"],
  webm: ["-c:a", "libopus", "-b:a", "24k", "-f", "webm"],
  mp3: ["-c:a", "libmp3lame", "-b:a", "32k", "-f", "mp3"],
  m4a: ["-c:a", "aac", "-b:a", "48k", "-f", "ipod"],
  mp4: ["-c:a", "aac", "-b:a", "48k", "-f", "mp4"],
  flac: ["-c:a", "flac", "-f", "flac"],
  wav: ["-c:a", "pcm_s16le", "-f", "wav"],
};

/** Approximate bytes per second of `extract` output, for size planning. */
export const BYTES_PER_SEC: Record<AudioFormat, number> = {
  ogg: 3_100, webm: 3_100, mp3: 4_000, m4a: 6_000, mp4: 6_000, flac: 20_000, wav: 32_000,
};

export const ffmpegTools = (ffmpeg = "ffmpeg", ffprobe = "ffprobe"): MediaTools => ({
  async probe(path, signal) {
    const { stdout } = await run(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path], signal);
    const durationSec = parseFloat(stdout.trim());
    if (!Number.isFinite(durationSec)) throw asrErr("bad_request", "ffprobe: cannot read duration", { reason: "unsupported_format" });
    return { durationSec, sizeBytes: (await stat(path)).size };
  },
  async silences(path, signal) {
    const { stderr } = await run(ffmpeg, ["-hide_banner", "-nostats", "-i", path, "-vn", "-af", "silencedetect=noise=-35dB:d=0.5", "-f", "null", "-"], signal);
    const dur = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(stderr);
    const total = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : undefined;
    return parseSilencedetect(stderr, total);
  },
  async extract(input, output, format, range, signal) {
    const args = ["-hide_banner", "-nostats", "-y"];
    if (range) args.push("-ss", String(range.start), "-to", String(range.end));
    args.push("-i", input, "-vn", "-ac", "1", "-ar", "16000", "-avoid_negative_ts", "make_zero", ...CODEC[format], output);
    await run(ffmpeg, args, signal);
  },
});
