/** Deepgram pre-recorded: POST /v1/listen with the raw audio body (sync). */
import { expectJson, expectOk, fileBlob, requireStr, str, trimSlash, vendorFetch } from "../http.js";
import { mapLanguage, r3, segmentsFromWords } from "../normalize.js";
import type { AsrAdapter, AsrProviderConfig, ChunkResult, Word } from "../types.js";

export const deepgramBase = (cfg: AsrProviderConfig) => trimSlash(cfg.baseUrl ?? str(cfg.fields, "base_url") ?? "https://api.deepgram.com");
export const deepgramAuth = (cfg: AsrProviderConfig) => `Token ${requireStr(cfg.fields, "api_key", "deepgram")}`;

/** Parses a Deepgram listen response. Exported for tests. */
export function parseDeepgram(body: any): ChunkResult {
  const alt = body?.results?.channels?.[0]?.alternatives?.[0] ?? {};
  const words: Word[] = (alt.words ?? []).map((w: any) => ({
    start: r3(w.start),
    end: r3(w.end),
    text: String(w.punctuated_word ?? w.word ?? ""),
    speaker: w.speaker != null ? String(w.speaker) : null,
    confidence: w.confidence ?? null,
  }));
  const utterances: any[] | undefined = body?.results?.utterances;
  const segments = Array.isArray(utterances) && utterances.length
    ? utterances.map((u) => ({
        start: r3(u.start),
        end: r3(u.end),
        text: String(u.transcript ?? "").trim(),
        speaker: u.speaker != null ? String(u.speaker) : null,
        confidence: u.confidence ?? null,
      }))
    : segmentsFromWords(words);
  return {
    text: String(alt.transcript ?? ""),
    segments: segments.filter((s) => s.text),
    words: words.length ? words : undefined,
    language: body?.results?.channels?.[0]?.detected_language ?? null,
    durationSec: body?.metadata?.duration,
    requestId: body?.metadata?.request_id,
  };
}

export const deepgramAdapter: AsrAdapter = {
  kind: "deepgram",
  capabilities: () => ({
    diarization: true,
    wordTimestamps: true,
    maxBytes: 2 * 1024 ** 3,
    async: false,
    streaming: true,
    prompt: false,
    keyterms: 100,
    formats: ["ogg", "mp3", "m4a", "wav", "flac", "webm", "mp4"],
    traditionalNative: true,
  }),
  async transcribe(cfg, input) {
    const q = new URLSearchParams({
      model: cfg.model ?? str(cfg.fields, "model") ?? "nova-3",
      smart_format: "true",
      punctuate: "true",
      utterances: "true",
    });
    const lang = mapLanguage(input.language, "bcp47");
    if (lang) q.set("language", lang);
    else q.set("detect_language", "true");
    if (input.diarize) q.set("diarize_model", "latest");
    for (const k of input.keyterms) q.append("keyterm", k);
    const res = await vendorFetch(
      cfg,
      `${deepgramBase(cfg)}/v1/listen?${q}`,
      { method: "POST", headers: { authorization: deepgramAuth(cfg), "content-type": input.part.mime }, body: await fileBlob(input.part) },
      input.signal,
    );
    return parseDeepgram(await expectJson(res, "deepgram"));
  },
  async probe(cfg, signal) {
    await expectOk(await vendorFetch(cfg, `${deepgramBase(cfg)}/v1/projects`, { headers: { authorization: deepgramAuth(cfg) }, timeoutMs: 10_000 }, signal), "deepgram");
  },
};
