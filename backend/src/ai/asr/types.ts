/**
 * Unified ASR types. Every adapter normalises its vendor output into `Transcript`.
 * Times are seconds (float, 3 dp). See docs/ai-asr-oauth.md.
 */

export type ScriptConversion = "none" | "s2tw" | "s2twp";

export type AudioFormat = "mp3" | "m4a" | "wav" | "ogg" | "flac" | "webm" | "mp4";

/** Audio input: a local file (preferred: chunking needs random access) or a stream that gets spooled to /tmp. */
export type AudioInput =
  | { path: string; mime?: string }
  | { stream: AsyncIterable<Uint8Array> | NodeJS.ReadableStream; mime: string; filename?: string };

export type SpeakerReference = { name: string; /** 2–10 s clip */ clip: Buffer; mime: string };

export type TranscribeRequest = {
  audio: AudioInput;
  /** BCP-47 hint, e.g. "zh-TW"; "auto" or undefined lets the vendor detect. Mapped per vendor. */
  language?: string;
  /** Extra languages for vendors that accept several (gpt-transcribe, Google). */
  extraLanguages?: string[];
  diarize?: boolean;
  speakers?: { min?: number; max?: number; expected?: number; references?: SpeakerReference[] };
  /** Bias terms (glossary). Truncated to the adapter's `keyterms` capability. */
  keyterms?: string[];
  /** Free-text prompt for prompt-capable vendors (Whisper family, AssemblyAI U-3.5). */
  prompt?: string;
  wordTimestamps?: boolean;
  convertScript?: ScriptConversion;
  /** Total duration if known (skips ffprobe). */
  durationSec?: number;
  signal?: AbortSignal;
  /** Resume state saved from `onCheckpoint` by a previous attempt of the same job. */
  resume?: AsrCheckpoint;
  /** Called whenever durable progress happens (vendor job submitted, chunk done). Persist it in the job row. */
  onCheckpoint?: (cp: AsrCheckpoint) => void | Promise<void>;
  /** Called with 0..1 progress. */
  onProgress?: (fraction: number) => void;
};

export type AsrCheckpoint = {
  /** Vendor job ids keyed by chunk index ("0" when not chunked). */
  vendorJobs: Record<string, string>;
  /** Finished chunk results keyed by chunk index, already offset-free (relative to the chunk start). */
  done: Record<string, ChunkResult>;
  /** Chunk plan used, so a resume cuts identically. */
  plan?: ChunkPlanEntry[];
};

export type Segment = {
  id: number;
  start: number;
  end: number;
  text: string;
  speaker?: string | null;
  confidence?: number | null;
  language?: string | null;
};

export type Word = {
  start: number;
  end: number;
  text: string;
  speaker?: string | null;
  confidence?: number | null;
  segmentId?: number;
};

export type Speaker = { id: string; label: string | null };

export type TranscriptWarning =
  | "speaker_labels_per_chunk"
  | "script_converted"
  | "no_timestamps"
  | "low_confidence_dropped"
  | "chunked"
  | "diarization_unsupported"
  | "word_timestamps_unsupported"
  | "keyterms_truncated"
  | "prompt_unsupported"
  /** Multimodal chat model: timestamps are the model's estimates (segment level, may drift). */
  | "timestamps_approximate"
  /** Multimodal chat model: a decoding loop (repeated line/phrase) was trimmed. */
  | "repetition_trimmed";

export type Transcript = {
  schema: 1;
  language: string | null;
  languages?: string[];
  durationSec: number;
  segments: Segment[];
  speakers: Speaker[];
  /** Separate from segments: callers store these in S3 (words.json). */
  words?: Word[];
  warnings: TranscriptWarning[];
  /** Vendor request/job id(s), comma separated when chunked. */
  vendorJobId?: string;
  source: {
    kind: string;
    model: string;
    requestIds: string[];
    chunks: { index: number; offset: number; duration: number }[];
    scriptConversion: ScriptConversion;
  };
};

/** One adapter call's result for one audio part (times relative to the part start). */
export type ChunkResult = {
  text: string;
  segments: Omit<Segment, "id">[];
  words?: Word[];
  language?: string | null;
  languages?: string[];
  durationSec?: number;
  requestId?: string;
  warnings?: TranscriptWarning[];
};

/**
 * A cut of the source: audio [start,end) is sent; output is kept only for [keepFrom,keepTo)
 * (differs from start/end only around hard cuts, which overlap by a couple of seconds).
 */
export type ChunkPlanEntry = { index: number; start: number; end: number; keepFrom: number; keepTo: number };

export type AsrCapabilities = {
  diarization: boolean;
  wordTimestamps: boolean;
  /** Upload limit in bytes; undefined = no practical limit. */
  maxBytes?: number;
  maxDurationSec?: number;
  /** Preferred chunk length when chunking (defaults to min(maxDurationSec, 1200)). */
  preferredChunkSec?: number;
  async: boolean;
  streaming: boolean;
  prompt: boolean;
  /** Max keyterms, 0 = none. */
  keyterms: number;
  formats: AudioFormat[];
  /** Vendor emits Traditional script natively for zh-TW. */
  traditionalNative: boolean;
};

/** A provider account + route-member params, already decrypted. */
export type AsrProviderConfig = {
  kind: string;
  baseUrl?: string;
  /** Secrets and per-kind fields from the registry form (api_key, region, …). */
  fields: Record<string, unknown>;
  model?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Injected fetch (tests / proxies). */
  fetch?: typeof fetch;
};

export type AudioPart = { path: string; mime: string; sizeBytes: number; durationSec?: number; filename: string };

export type AdapterCallInput = {
  part: AudioPart;
  language?: string;
  extraLanguages?: string[];
  diarize: boolean;
  speakers?: TranscribeRequest["speakers"];
  keyterms: string[];
  prompt?: string;
  wordTimestamps: boolean;
  signal: AbortSignal;
  /** Resume an async vendor job instead of resubmitting. */
  vendorJobId?: string;
  onVendorJob: (id: string) => Promise<void>;
};

export interface AsrAdapter {
  kind: string;
  capabilities(cfg: AsrProviderConfig): AsrCapabilities;
  transcribe(cfg: AsrProviderConfig, input: AdapterCallInput): Promise<ChunkResult>;
  /** Cheap liveness/key check; throws AiError on failure. */
  probe(cfg: AsrProviderConfig, signal?: AbortSignal): Promise<void>;
  /** Best-effort remote cleanup for an async job (cancel / delete). */
  cancel?(cfg: AsrProviderConfig, vendorJobId: string): Promise<void>;
}
