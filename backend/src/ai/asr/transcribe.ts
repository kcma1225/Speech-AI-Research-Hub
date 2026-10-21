/**
 * ASR orchestrator: prepares audio (spool/transcode), chunks when the vendor has limits,
 * runs chunks sequentially with prompt chaining, merges, normalises speakers, converts script.
 */
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { BYTES_PER_SEC, chainPrompt, ffmpegTools, mergeChunks, planChunks, type MediaTools } from "./chunking.js";
import { asrErr, asrReasonOf, AiError } from "./err.js";
import { sleep } from "./http.js";
import { linkWords, normaliseSpeakers, r3 } from "./normalize.js";
import { convertTranscript } from "./opencc.js";
import { asrAdapterFor, getAsrEntry } from "./registry.js";
import type {
  AdapterCallInput,
  AsrAdapter,
  AsrCapabilities,
  AsrCheckpoint,
  AsrProviderConfig,
  AudioFormat,
  AudioPart,
  ChunkPlanEntry,
  ChunkResult,
  Segment,
  TranscribeRequest,
  Transcript,
  TranscriptWarning,
} from "./types.js";

export type TranscribeDeps = {
  tools?: MediaTools;
  /** Override adapter lookup (tests). */
  adapter?: AsrAdapter;
  /** Scratch directory (default os.tmpdir(); the container root is read-only, /tmp is writable). */
  tmpDir?: string;
  /** Retries per chunk for retryable errors (default 3). */
  chunkRetries?: number;
  /** Base backoff for retries (default 2000 ms; tests use small values). */
  retryBaseMs?: number;
};

const MIME: Record<string, string> = {
  mp3: "audio/mpeg", m4a: "audio/mp4", mp4: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac", webm: "audio/webm",
};
const EXT_FROM_MIME: Record<string, AudioFormat> = {
  "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/m4a": "m4a", "audio/aac": "m4a",
  "video/mp4": "mp4", "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/ogg": "ogg", "audio/opus": "ogg",
  "audio/flac": "flac", "audio/x-flac": "flac", "audio/webm": "webm", "video/webm": "webm",
};

export function formatOf(path: string, mime?: string): AudioFormat | undefined {
  const e = extname(path).slice(1).toLowerCase();
  if (e && e in MIME) return e as AudioFormat;
  if (e === "opus" || e === "oga") return "ogg";
  if (e === "mpga" || e === "mpeg") return "mp3";
  return mime ? EXT_FROM_MIME[mime.split(";")[0]!.trim().toLowerCase()] : undefined;
}

/** Target format when transcoding: smallest accepted. */
function targetFormat(caps: AsrCapabilities): AudioFormat {
  for (const f of ["ogg", "mp3", "webm", "m4a", "flac", "wav"] as AudioFormat[]) if (caps.formats.includes(f)) return f;
  return caps.formats[0] ?? "mp3";
}

const emptyCheckpoint = (): AsrCheckpoint => ({ vendorJobs: {}, done: {} });

/**
 * Transcribes one recording. Throws AiError (with `asrReason` for ASR-specific causes).
 * Callers: persist `onCheckpoint` payloads in the job row and pass them back as `resume`.
 */
export async function transcribe(cfg: AsrProviderConfig, req: TranscribeRequest, deps: TranscribeDeps = {}): Promise<Transcript> {
  const adapter = deps.adapter ?? asrAdapterFor(cfg.kind);
  if (!adapter) throw asrErr("unsupported", `unknown ASR kind ${cfg.kind}`);
  const tools = deps.tools ?? ffmpegTools();
  const signal = req.signal ?? new AbortController().signal;
  const caps = adapter.capabilities(cfg);
  const work = join(deps.tmpDir ?? tmpdir(), `asr-${randomUUID()}`);
  await mkdir(work, { recursive: true });
  const cp: AsrCheckpoint = req.resume ? structuredClone(req.resume) : emptyCheckpoint();
  const save = async () => req.onCheckpoint?.(structuredClone(cp));
  const warnings = new Set<TranscriptWarning>();
  try {
    // 1. Materialise the input as a local file.
    let srcPath: string;
    let srcMime: string;
    if ("path" in req.audio) {
      srcPath = req.audio.path;
      srcMime = req.audio.mime ?? MIME[formatOf(srcPath) ?? ""] ?? "application/octet-stream";
    } else {
      const fmt = formatOf(req.audio.filename ?? "", req.audio.mime) ?? "bin";
      srcPath = join(work, `input.${fmt}`);
      srcMime = req.audio.mime;
      const src = req.audio.stream as AsyncIterable<Uint8Array>;
      await pipeline(Readable.from(src), createWriteStream(srcPath), { signal });
    }
    const srcFormat = formatOf(srcPath, srcMime);
    const sizeBytes = (await stat(srcPath)).size;
    const durationSec = req.durationSec ?? (await tools.probe(srcPath, signal)).durationSec;

    // 2. Decide transcoding / chunking.
    const needsTranscode = !srcFormat || !caps.formats.includes(srcFormat);
    const fmt = needsTranscode ? targetFormat(caps) : srcFormat;
    const estBytes = needsTranscode ? BYTES_PER_SEC[fmt] * durationSec : sizeBytes;
    const memberMax = typeof cfg.fields.max_chunk_sec === "number" ? (cfg.fields.max_chunk_sec as number) : undefined;
    let maxChunk = Math.min(caps.maxDurationSec ?? Infinity, memberMax ?? Infinity);
    if (caps.maxBytes && estBytes > caps.maxBytes * 0.95) {
      const bps = needsTranscode ? BYTES_PER_SEC[fmt] : sizeBytes / Math.max(1, durationSec);
      maxChunk = Math.min(maxChunk, Math.floor((caps.maxBytes * 0.9) / bps));
    }
    const chunked = durationSec > maxChunk || !!cp.plan;
    const diarize = !!req.diarize && caps.diarization;
    if (req.diarize && !caps.diarization) warnings.add("diarization_unsupported");
    const wordTimestamps = req.wordTimestamps !== false && caps.wordTimestamps;
    if (req.wordTimestamps && !caps.wordTimestamps) warnings.add("word_timestamps_unsupported");
    const keyterms = (req.keyterms ?? []).map((k) => k.trim()).filter(Boolean);
    if (keyterms.length > caps.keyterms) warnings.add("keyterms_truncated");
    const prompt = caps.prompt ? req.prompt : undefined;
    if (req.prompt && !caps.prompt) warnings.add("prompt_unsupported");

    const baseInput = {
      language: req.language,
      extraLanguages: req.extraLanguages,
      diarize,
      speakers: req.speakers,
      keyterms: keyterms.slice(0, caps.keyterms),
      wordTimestamps,
      signal,
    };

    const runPart = async (key: string, part: AudioPart, partPrompt: string | undefined): Promise<ChunkResult> => {
      const input = (): AdapterCallInput => ({
        ...baseInput,
        part,
        prompt: partPrompt,
        vendorJobId: cp.vendorJobs[key],
        onVendorJob: async (id) => {
          cp.vendorJobs[key] = id;
          await save();
        },
      });
      try {
        return await withRetries(() => adapter.transcribe(cfg, input()), signal, deps.chunkRetries ?? 3, deps.retryBaseMs ?? 2000);
      } catch (e) {
        // A failed remote job must not be resumed again: forget it so the next attempt resubmits.
        if (asrReasonOf(e) === "job_failed" && cp.vendorJobs[key]) {
          delete cp.vendorJobs[key];
          await save();
        }
        throw e;
      }
    };

    let results: { entry: ChunkPlanEntry; result: ChunkResult }[];
    if (!chunked) {
      let part: AudioPart = { path: srcPath, mime: srcMime, sizeBytes, durationSec, filename: `audio.${srcFormat ?? fmt}` };
      if (needsTranscode) {
        const out = join(work, `full.${fmt}`);
        await tools.extract(srcPath, out, fmt, undefined, signal);
        part = { path: out, mime: MIME[fmt]!, sizeBytes: (await stat(out)).size, durationSec, filename: `audio.${fmt}` };
      }
      const entry: ChunkPlanEntry = { index: 0, start: 0, end: durationSec, keepFrom: 0, keepTo: durationSec };
      let result = cp.done["0"];
      if (!result) {
        try {
          result = await runPart("0", part, prompt);
        } catch (e) {
          // Vendor said too large/long although we thought it fit: fall back to chunking.
          const reason = asrReasonOf(e);
          if ((reason === "too_large" || reason === "too_long") && durationSec > 120 && !cp.vendorJobs["0"]) {
            return await transcribe(cfg, { ...req, resume: undefined, durationSec }, { ...deps, adapter: withMaxDuration(adapter, Math.min(1200, durationSec / 2)) });
          }
          throw e;
        }
      }
      results = [{ entry, result }];
      req.onProgress?.(1);
    } else {
      if (!cp.plan) {
        const silences = await tools.silences(srcPath, signal);
        cp.plan = planChunks(durationSec, silences, { maxChunkSec: Math.min(maxChunk, caps.preferredChunkSec ?? 1200) });
        await save();
      }
      results = [];
      let prevText: string | undefined;
      for (let i = 0; i < cp.plan.length; i++) {
        const entry: ChunkPlanEntry = cp.plan[i]!;
        const key = String(entry.index);
        let result = cp.done[key];
        if (!result) {
          const out = join(work, `chunk-${entry.index}.${fmt}`);
          await tools.extract(srcPath, out, fmt, { start: entry.start, end: entry.end }, signal);
          const part: AudioPart = { path: out, mime: MIME[fmt]!, sizeBytes: (await stat(out)).size, durationSec: r3(entry.end - entry.start), filename: `chunk-${entry.index}.${fmt}` };
          try {
            result = await runPart(key, part, caps.prompt ? chainPrompt(prompt, prevText) : undefined);
          } catch (e) {
            const reason = asrReasonOf(e);
            const len = entry.end - entry.start;
            if ((reason === "too_large" || reason === "too_long") && len > 60 && !cp.vendorJobs[key]) {
              // Re-plan this chunk and the rest at half the length.
              const rest = planChunks(durationSec, await tools.silences(srcPath, signal), {
                maxChunkSec: len / 2,
                from: entry.keepFrom,
                firstIndex: Math.max(...cp.plan.map((p) => p.index)) + 1,
              });
              cp.plan = [...cp.plan.slice(0, i), ...rest];
              await save();
              i--;
              await rm(out, { force: true });
              continue;
            }
            throw e;
          }
          await rm(out, { force: true });
          cp.done[key] = result;
          await save();
        }
        prevText = result.text;
        results.push({ entry, result });
        req.onProgress?.(Math.min(1, entry.end / durationSec));
      }
    }

    // 3. Merge and normalise.
    const refsGiven = (req.speakers?.references?.length ?? 0) > 0;
    const merged = mergeChunks(results, { speakerScope: refsGiven || results.length === 1 ? "global" : "chunk" });
    for (const w of merged.warnings) warnings.add(w);
    const segments: Segment[] = merged.segments.map((s, id) => ({ id, ...s }));
    const words = merged.words.length ? merged.words : undefined;
    const speakers = diarize || segments.some((s) => s.speaker) ? normaliseSpeakers(segments, words) : [];
    if (words) linkWords(words, segments);
    const requestIds = results.map((r) => r.result.requestId).filter((x): x is string => !!x);
    const entry = getAsrEntry(cfg.kind);
    const t: Transcript = {
      schema: 1,
      language: results[0]?.result.language ?? (req.language && req.language !== "auto" ? req.language : null),
      languages: merged.languages.length > 1 ? merged.languages : undefined,
      durationSec: r3(durationSec),
      segments,
      speakers,
      words,
      warnings: [...warnings],
      vendorJobId: Object.values(cp.vendorJobs).join(",") || undefined,
      source: {
        kind: cfg.kind,
        model: cfg.model ?? entry?.defaultModel ?? "",
        requestIds,
        chunks: results.map((r) => ({ index: r.entry.index, offset: r.entry.start, duration: r3(r.entry.end - r.entry.start) })),
        scriptConversion: "none",
      },
    };
    return convertTranscript(t, req.convertScript ?? entry?.defaultConvertScript ?? "none");
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

function withMaxDuration(adapter: AsrAdapter, maxSec: number): AsrAdapter {
  return {
    ...adapter,
    capabilities: (cfg) => {
      const c = adapter.capabilities(cfg);
      return { ...c, maxDurationSec: Math.min(c.maxDurationSec ?? Infinity, maxSec), preferredChunkSec: Math.min(c.preferredChunkSec ?? maxSec, maxSec) };
    },
  };
}

/** Retries `rate_limited` / `overloaded` / `unavailable` / `timeout` with exponential backoff (honours Retry-After). */
export async function withRetries<T>(fn: () => Promise<T>, signal: AbortSignal, retries: number, baseMs: number): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (signal.aborted) throw e;
      const code = e instanceof AiError ? e.code : undefined;
      const retryable = code === "rate_limited" || code === "overloaded" || code === "unavailable" || code === "timeout";
      if (!retryable || attempt >= retries) throw e;
      const wait = Math.min(60_000, (e as AiError).retryAfterMs ?? baseMs * 2 ** attempt);
      await sleep(wait, signal);
    }
  }
}
