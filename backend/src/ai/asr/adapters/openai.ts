/**
 * OpenAI `/audio/transcriptions` and everything shaped like it:
 * OpenAI, Azure OpenAI, Groq, speaches (faster-whisper), NVIDIA NIM HTTP, our WhisperX wrapper,
 * and the generic OpenAI-compatible kind.
 */
import { asrErr, asrReasonOf } from "../err.js";
import { bool, expectJson, expectOk, fileBlob, num, requireStr, str, trimSlash, vendorFetch } from "../http.js";
import { mapLanguage, r3, textOnlyResult } from "../normalize.js";
import type { AdapterCallInput, AsrAdapter, AsrCapabilities, AsrProviderConfig, AudioFormat, ChunkResult, Word } from "../types.js";

const MB = 1024 * 1024;
const OPENAI_FORMATS: AudioFormat[] = ["mp3", "m4a", "wav", "webm", "mp4"];
const WHISPER_FORMATS: AudioFormat[] = ["mp3", "m4a", "wav", "ogg", "flac", "webm", "mp4"];

export type OpenAiModelMode = "gpt-transcribe" | "gpt-4o" | "diarize" | "verbose" | "json";

/** Which request/response shape a model uses. */
export function modelMode(kind: string, model: string, cfg?: AsrProviderConfig): OpenAiModelMode {
  if (kind === "nim") return "json";
  if (kind === "openai_compatible" && cfg && !bool(cfg.fields, "supports_verbose_json", true)) return "json";
  if (/transcribe-diarize/.test(model)) return "diarize";
  if (/^gpt-.*transcribe/.test(model) && /^gpt-4o/.test(model)) return "gpt-4o";
  if (/^gpt-.*transcribe/.test(model)) return "gpt-transcribe";
  return "verbose";
}

const DEFAULT_MODEL: Record<string, string> = {
  openai: "gpt-transcribe",
  azure_openai: "whisper",
  groq: "whisper-large-v3",
  speaches: "Systran/faster-whisper-large-v3",
  whisperx: "large-v3",
  nim: "parakeet-ctc-0.6b-zh-tw",
  openai_compatible: "whisper-1",
};

const modelOf = (cfg: AsrProviderConfig) => cfg.model ?? str(cfg.fields, "model") ?? DEFAULT_MODEL[cfg.kind] ?? "whisper-1";

function baseUrl(cfg: AsrProviderConfig): string {
  const dflt: Record<string, string> = {
    openai: "https://api.openai.com/v1",
    groq: "https://api.groq.com/openai/v1",
  };
  const u = cfg.baseUrl ?? str(cfg.fields, "base_url") ?? dflt[cfg.kind];
  if (!u) throw asrErr("bad_request", `${cfg.kind}: base_url is required`);
  return trimSlash(u);
}

/** Transcription URL + auth headers for the kind. */
export function endpoint(cfg: AsrProviderConfig): { url: string; headers: Record<string, string>; modelsUrl?: string; healthUrl?: string } {
  const key = str(cfg.fields, "api_key");
  const headers: Record<string, string> = {};
  if (cfg.kind === "azure_openai") {
    const ep = trimSlash(requireStr(cfg.fields, "endpoint", cfg.kind));
    const dep = requireStr(cfg.fields, "deployment", cfg.kind);
    const ver = str(cfg.fields, "api_version") ?? "2025-04-01-preview";
    if (key) headers["api-key"] = key;
    return { url: `${ep}/openai/deployments/${encodeURIComponent(dep)}/audio/transcriptions?api-version=${ver}`, headers };
  }
  const base = baseUrl(cfg);
  if (key) headers.authorization = `Bearer ${key}`;
  if (cfg.kind === "openai") {
    const org = str(cfg.fields, "organization");
    const project = str(cfg.fields, "project");
    if (org) headers["openai-organization"] = org;
    if (project) headers["openai-project"] = project;
  }
  const path = cfg.kind === "openai_compatible" ? (str(cfg.fields, "transcription_path") ?? "/audio/transcriptions") : "/audio/transcriptions";
  // speaches / NIM / WhisperX wrapper are configured with the server root; OpenAI/Groq/generic include /v1.
  const v1 = cfg.kind === "speaches" || cfg.kind === "nim" || cfg.kind === "whisperx" ? (/\/v1$/.test(base) ? base : `${base}/v1`) : base;
  const root = v1.replace(/\/v1$/, "");
  return {
    url: `${v1}${path.startsWith("/") ? path : `/${path}`}`,
    headers,
    modelsUrl: `${v1}/models`,
    healthUrl: cfg.kind === "nim" ? `${root}/v1/health/ready` : cfg.kind === "speaches" || cfg.kind === "whisperx" ? `${root}/health` : undefined,
  };
}

function capabilities(cfg: AsrProviderConfig): AsrCapabilities {
  const model = modelOf(cfg);
  const mode = modelMode(cfg.kind, model, cfg);
  const base: AsrCapabilities = {
    diarization: false,
    wordTimestamps: false,
    maxBytes: 25 * MB,
    async: false,
    streaming: false,
    prompt: true,
    keyterms: 0,
    formats: WHISPER_FORMATS,
    traditionalNative: false,
  };
  switch (cfg.kind) {
    case "openai":
    case "azure_openai":
      base.formats = OPENAI_FORMATS;
      base.streaming = cfg.kind === "openai" && mode !== "verbose";
      if (mode === "gpt-transcribe") return { ...base, keyterms: 100, maxDurationSec: 1500, preferredChunkSec: 1200 };
      if (mode === "gpt-4o") return { ...base, maxDurationSec: 1500, preferredChunkSec: 1200 };
      if (mode === "diarize") return { ...base, diarization: true, prompt: false, maxDurationSec: 1500, preferredChunkSec: 1200 };
      return { ...base, wordTimestamps: true, preferredChunkSec: 1200 };
    case "groq":
      return { ...base, wordTimestamps: true, maxBytes: (str(cfg.fields, "tier") === "dev" ? 100 : 25) * MB, preferredChunkSec: 1200 };
    case "speaches":
      return { ...base, wordTimestamps: true, maxBytes: undefined, preferredChunkSec: 600, maxDurationSec: num(cfg.fields, "max_chunk_sec") ?? 1800, keyterms: 50 };
    case "whisperx":
      return { ...base, wordTimestamps: true, diarization: true, keyterms: 50, maxBytes: (num(cfg.fields, "max_upload_mb") ?? 500) * MB, maxDurationSec: num(cfg.fields, "max_duration_sec") ?? 4 * 3600 };
    case "nim":
      return { ...base, prompt: false, maxBytes: (num(cfg.fields, "max_upload_mb") ?? 100) * MB, formats: ["wav", "flac", "ogg"], maxDurationSec: 600, preferredChunkSec: 300, traditionalNative: /zh-tw/i.test(model) };
    default: {
      const fmts = cfg.fields.accepted_formats;
      return {
        ...base,
        prompt: mode !== "json" || bool(cfg.fields, "supports_prompt", true),
        wordTimestamps: mode === "verbose" && bool(cfg.fields, "supports_word_timestamps"),
        diarization: bool(cfg.fields, "supports_diarization"),
        maxBytes: (num(cfg.fields, "max_upload_mb") ?? 25) * MB,
        maxDurationSec: num(cfg.fields, "max_duration_sec"),
        formats: Array.isArray(fmts) && fmts.length ? (fmts as AudioFormat[]) : WHISPER_FORMATS,
      };
    }
  }
}

type VerboseSeg = { start: number; end: number; text: string; speaker?: string; avg_logprob?: number; no_speech_prob?: number };
type VerboseWord = { word?: string; text?: string; start: number; end: number; probability?: number; score?: number; speaker?: string };

/** Parses `json` / `verbose_json` / `diarized_json` bodies. Exported for tests. */
export function parseOpenAiBody(body: any, durationHint?: number, dropLowConfidence = true): ChunkResult {
  const warnings: ChunkResult["warnings"] = [];
  const language = typeof body.language === "string" ? body.language : null;
  const languages: string[] | undefined = Array.isArray(body.languages)
    ? body.languages.map((l: any) => (typeof l === "string" ? l : l?.code ?? l?.language)).filter(Boolean)
    : undefined;
  const duration = typeof body.duration === "number" ? body.duration : body.usage?.seconds ?? durationHint;
  if (!Array.isArray(body.segments)) {
    return textOnlyResult(String(body.text ?? ""), duration, { language, languages, durationSec: duration });
  }
  let dropped = false;
  const segments = (body.segments as VerboseSeg[])
    .filter((s) => {
      const bad = dropLowConfidence && (s.no_speech_prob ?? 0) > 0.6 && (s.avg_logprob ?? 0) < -1;
      if (bad) dropped = true;
      return !bad && String(s.text ?? "").trim() !== "";
    })
    .map((s) => ({
      start: r3(s.start),
      end: r3(s.end),
      text: String(s.text).trim(),
      speaker: s.speaker ?? null,
      confidence: typeof s.avg_logprob === "number" ? r3(Math.exp(s.avg_logprob)) : null,
    }));
  if (dropped) warnings.push("low_confidence_dropped");
  const words: Word[] | undefined = Array.isArray(body.words)
    ? (body.words as VerboseWord[]).map((w) => ({
        start: r3(w.start),
        end: r3(w.end),
        text: String(w.word ?? w.text ?? "").trim(),
        speaker: w.speaker ?? null,
        confidence: w.probability ?? w.score ?? null,
      }))
    : undefined;
  return { text: String(body.text ?? segments.map((s) => s.text).join("")), segments, words, language, languages, durationSec: duration, warnings };
}

async function dataUrl(clip: Buffer, mime: string) {
  return `data:${mime};base64,${clip.toString("base64")}`;
}

async function buildForm(cfg: AsrProviderConfig, input: AdapterCallInput, mode: OpenAiModelMode, caps: AsrCapabilities): Promise<FormData> {
  const model = modelOf(cfg);
  const form = new FormData();
  form.set("file", await fileBlob(input.part), input.part.filename);
  if (cfg.kind !== "azure_openai") form.set("model", model);
  const lang = mapLanguage(input.language, "iso1");
  const prompt = caps.prompt ? input.prompt : undefined;
  switch (mode) {
    case "gpt-transcribe": {
      form.set("response_format", "json");
      const langs = [lang, ...(input.extraLanguages ?? []).map((l) => mapLanguage(l, "iso1"))].filter((l): l is string => !!l);
      for (const l of new Set(langs)) form.append("languages[]", l);
      for (const k of input.keyterms) form.append("keywords[]", k);
      if (prompt) form.set("prompt", prompt);
      break;
    }
    case "gpt-4o":
      form.set("response_format", "json");
      if (lang) form.set("language", lang);
      if (prompt) form.set("prompt", prompt);
      break;
    case "diarize":
      form.set("response_format", "diarized_json");
      form.set("chunking_strategy", "auto");
      if (lang) form.set("language", lang);
      for (const ref of (input.speakers?.references ?? []).slice(0, 4)) {
        form.append("known_speaker_names[]", ref.name);
        form.append("known_speaker_references[]", await dataUrl(ref.clip, ref.mime));
      }
      break;
    case "verbose":
      form.set("response_format", "verbose_json");
      form.set("temperature", "0");
      form.append("timestamp_granularities[]", "segment");
      if (input.wordTimestamps && caps.wordTimestamps) form.append("timestamp_granularities[]", "word");
      if (lang) form.set("language", lang);
      if (prompt) form.set("prompt", prompt);
      if (cfg.kind === "speaches" && input.keyterms.length) form.set("hotwords", input.keyterms.join(", "));
      if (cfg.kind === "whisperx") {
        form.set("diarize", input.diarize ? "true" : "false");
        const sp = input.speakers;
        if (sp?.min ?? sp?.expected) form.set("min_speakers", String(sp?.min ?? sp?.expected));
        if (sp?.max ?? sp?.expected) form.set("max_speakers", String(sp?.max ?? sp?.expected));
        if (input.keyterms.length) form.set("hotwords", input.keyterms.join(", "));
      }
      break;
    case "json":
      form.set("response_format", "json");
      if (lang || cfg.kind === "nim") form.set("language", cfg.kind === "nim" ? (input.language && input.language !== "auto" ? input.language : "multi") : lang!);
      if (prompt && cfg.kind !== "nim") form.set("prompt", prompt);
      break;
  }
  return form;
}

async function transcribe(cfg: AsrProviderConfig, input: AdapterCallInput): Promise<ChunkResult> {
  const caps = capabilities(cfg);
  const mode = modelMode(cfg.kind, modelOf(cfg), cfg);
  const { url, headers } = endpoint(cfg);
  const send = async (m: OpenAiModelMode) => {
    const res = await vendorFetch(cfg, url, { method: "POST", headers, body: await buildForm(cfg, input, m, caps) }, input.signal);
    const body = await expectJson(res, cfg.kind);
    return { body, requestId: res.headers.get("x-request-id") ?? undefined };
  };
  let out;
  try {
    out = await send(mode);
  } catch (e) {
    // Generic servers that reject verbose_json: retry once as plain json.
    if (cfg.kind === "openai_compatible" && mode === "verbose" && (e as { code?: string }).code === "bad_request" && !["too_large", "too_long"].includes(asrReasonOf(e) ?? "")) out = await send("json");
    else throw e;
  }
  const r = parseOpenAiBody(out.body, input.part.durationSec, bool(cfg.fields, "drop_low_confidence", true));
  r.requestId = out.requestId;
  return r;
}

async function probe(cfg: AsrProviderConfig, signal?: AbortSignal): Promise<void> {
  const ep = endpoint(cfg);
  if (ep.healthUrl) {
    await expectOk(await vendorFetch(cfg, ep.healthUrl, { headers: ep.headers, timeoutMs: 10_000 }, signal), cfg.kind);
    if (cfg.kind === "nim") return;
  }
  if (cfg.kind === "azure_openai") return; // no cheap probe; a deep probe (transcribe a clip) is the admin test
  const model = modelOf(cfg);
  const r = await vendorFetch(cfg, `${ep.modelsUrl}/${encodeURIComponent(model)}`, { headers: ep.headers, timeoutMs: 10_000 }, signal);
  if (r.status === 404 || r.status === 405) {
    await r.body?.cancel();
    const list = await expectJson<{ data?: { id: string }[] }>(await vendorFetch(cfg, ep.modelsUrl!, { headers: ep.headers, timeoutMs: 10_000 }, signal), cfg.kind);
    if (Array.isArray(list.data) && list.data.length && !list.data.some((m) => m.id === model) && cfg.kind !== "speaches")
      throw asrErr("model_not_found", `${cfg.kind}: model ${model} not listed`);
    return;
  }
  await expectOk(r, cfg.kind);
}

const make = (kind: string): AsrAdapter => ({ kind, capabilities, transcribe, probe });

export const openaiAdapter = make("openai");
export const azureOpenaiAdapter = make("azure_openai");
export const groqAdapter = make("groq");
export const speachesAdapter = make("speaches");
export const whisperxAdapter = make("whisperx");
export const nimAdapter = make("nim");
export const openaiCompatibleAdapter = make("openai_compatible");
