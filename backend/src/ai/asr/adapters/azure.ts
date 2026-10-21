/**
 * Azure AI Speech fast transcription (sync, multipart `audio` + `definition`).
 * Batch transcription (blob URLs + polling) is not implemented: fast covers < 2 h / 300 MB.
 */
import { expectJson, expectOk, fileBlob, requireStr, str, trimSlash, vendorFetch } from "../http.js";
import { mapLanguage, msToSec } from "../normalize.js";
import type { AsrAdapter, AsrProviderConfig, ChunkResult, Word } from "../types.js";

const base = (cfg: AsrProviderConfig) => trimSlash(cfg.baseUrl ?? requireStr(cfg.fields, "endpoint", "azure_speech"));
const auth = (cfg: AsrProviderConfig): Record<string, string> => {
  const token = str(cfg.fields, "bearer_token");
  return token ? { authorization: `Bearer ${token}` } : { "ocp-apim-subscription-key": requireStr(cfg.fields, "api_key", "azure_speech") };
};

/** Exported for tests. */
export function parseAzureFast(body: any): ChunkResult {
  const words: Word[] = [];
  const segments = (body.phrases ?? []).map((p: any) => {
    const start = msToSec(p.offsetMilliseconds);
    const speaker = p.speaker != null ? String(p.speaker) : null;
    for (const w of p.words ?? [])
      words.push({ start: msToSec(w.offsetMilliseconds), end: msToSec(w.offsetMilliseconds + w.durationMilliseconds), text: String(w.text), speaker, confidence: null });
    return {
      start,
      end: msToSec(p.offsetMilliseconds + p.durationMilliseconds),
      text: String(p.text ?? "").trim(),
      speaker,
      confidence: p.confidence ?? null,
      language: p.locale ?? null,
    };
  });
  const locales = [...new Set(segments.map((s: any) => s.language).filter(Boolean))] as string[];
  return {
    text: (body.combinedPhrases ?? []).map((c: any) => c.text).join("\n"),
    segments,
    words: words.length ? words : undefined,
    language: locales[0] ?? null,
    languages: locales.length > 1 ? locales : undefined,
    durationSec: typeof body.durationMilliseconds === "number" ? msToSec(body.durationMilliseconds) : undefined,
  };
}

export const azureSpeechAdapter: AsrAdapter = {
  kind: "azure_speech",
  capabilities: () => ({
    diarization: true,
    wordTimestamps: true,
    maxBytes: 300 * 1024 * 1024,
    maxDurationSec: 2 * 3600,
    async: false,
    streaming: false,
    prompt: false,
    keyterms: 500,
    formats: ["wav", "mp3", "ogg", "flac", "webm", "m4a"],
    traditionalNative: true,
  }),
  async transcribe(cfg, input) {
    const ver = str(cfg.fields, "api_version") ?? "2025-10-15";
    const lang = mapLanguage(input.language, "bcp47");
    const def: Record<string, unknown> = {
      locales: [lang ?? "zh-TW", ...(input.extraLanguages ?? [])].filter((v, i, a) => a.indexOf(v) === i),
      profanityFilterMode: "None",
    };
    if (input.diarize) def.diarization = { enabled: true, maxSpeakers: Math.max(2, Math.min(35, input.speakers?.max ?? input.speakers?.expected ?? 10)) };
    if (input.keyterms.length) def.phraseList = { phrases: input.keyterms };
    const form = new FormData();
    form.set("audio", await fileBlob(input.part), input.part.filename);
    form.set("definition", JSON.stringify(def));
    const res = await vendorFetch(cfg, `${base(cfg)}/speechtotext/transcriptions:transcribe?api-version=${ver}`, { method: "POST", headers: auth(cfg), body: form }, input.signal);
    const out = parseAzureFast(await expectJson(res, "azure_speech"));
    out.requestId = res.headers.get("apim-request-id") ?? undefined;
    return out;
  },
  async probe(cfg, signal) {
    await expectOk(await vendorFetch(cfg, `${base(cfg)}/speechtotext/models/base?top=1&api-version=2024-11-15`, { headers: auth(cfg), timeoutMs: 10_000 }, signal), "azure_speech");
  },
};
