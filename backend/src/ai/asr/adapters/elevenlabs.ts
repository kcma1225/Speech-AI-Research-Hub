/** ElevenLabs Scribe: POST /v1/speech-to-text (multipart, sync). Words only → segments built here. */
import { expectJson, expectOk, fileBlob, requireStr, str, trimSlash, vendorFetch } from "../http.js";
import { mapLanguage, r3, segmentsFromWords } from "../normalize.js";
import type { AsrAdapter, AsrProviderConfig, ChunkResult, Word } from "../types.js";

const REGION: Record<string, string> = {
  us: "https://api.elevenlabs.io",
  eu: "https://api.eu.residency.elevenlabs.io",
  in: "https://api.in.residency.elevenlabs.io",
  sg: "https://api.sg.residency.elevenlabs.io",
};
const base = (cfg: AsrProviderConfig) => trimSlash(cfg.baseUrl ?? str(cfg.fields, "base_url") ?? REGION[str(cfg.fields, "region") ?? "us"] ?? REGION.us!);
const auth = (cfg: AsrProviderConfig) => ({ "xi-api-key": requireStr(cfg.fields, "api_key", "elevenlabs") });

/** Exported for tests. */
export function parseElevenLabs(body: any): ChunkResult {
  const words: Word[] = (body.words ?? [])
    .filter((w: any) => w.type === "word" || w.type == null)
    .map((w: any) => ({
      start: r3(w.start),
      end: r3(w.end),
      text: String(w.text ?? ""),
      speaker: w.speaker_id ?? null,
      confidence: typeof w.logprob === "number" ? r3(Math.exp(w.logprob)) : null,
    }));
  return {
    text: String(body.text ?? ""),
    segments: segmentsFromWords(words),
    words: words.length ? words : undefined,
    language: body.language_code ?? null,
    requestId: body.transcription_id,
  };
}

export const elevenlabsAdapter: AsrAdapter = {
  kind: "elevenlabs",
  capabilities: () => ({
    diarization: true,
    wordTimestamps: true,
    maxBytes: 3 * 1024 ** 3,
    maxDurationSec: 10 * 3600,
    async: false,
    streaming: true,
    prompt: false,
    keyterms: 1000,
    formats: ["ogg", "mp3", "m4a", "wav", "flac", "webm", "mp4"],
    traditionalNative: false,
  }),
  async transcribe(cfg, input) {
    const form = new FormData();
    form.set("model_id", cfg.model ?? str(cfg.fields, "model") ?? "scribe_v2");
    form.set("file", await fileBlob(input.part), input.part.filename);
    const lang = mapLanguage(input.language, "iso3");
    if (lang) form.set("language_code", lang);
    form.set("diarize", input.diarize ? "true" : "false");
    const n = input.speakers?.expected ?? input.speakers?.max;
    if (input.diarize && n) form.set("num_speakers", String(Math.min(32, n)));
    form.set("timestamps_granularity", "word");
    form.set("tag_audio_events", "false");
    for (const k of input.keyterms) form.append("keyterms", k.slice(0, 49));
    const res = await vendorFetch(cfg, `${base(cfg)}/v1/speech-to-text`, { method: "POST", headers: auth(cfg), body: form }, input.signal);
    return parseElevenLabs(await expectJson(res, "elevenlabs"));
  },
  async probe(cfg, signal) {
    await expectOk(await vendorFetch(cfg, `${base(cfg)}/v1/models`, { headers: auth(cfg), timeoutMs: 10_000 }, signal), "elevenlabs");
  },
};
