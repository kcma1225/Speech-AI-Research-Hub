/** whisper.cpp `whisper-server`: POST {inference_path} (default /inference), GET /health. No auth. */
import { expectJson, expectOk, fileBlob, requireStr, str, trimSlash, vendorFetch } from "../http.js";
import { mapLanguage } from "../normalize.js";
import type { AsrAdapter, AsrProviderConfig } from "../types.js";
import { parseOpenAiBody } from "./openai.js";

const base = (cfg: AsrProviderConfig) => trimSlash(cfg.baseUrl ?? requireStr(cfg.fields, "base_url", "whispercpp"));

export const whispercppAdapter: AsrAdapter = {
  kind: "whispercpp",
  capabilities: () => ({
    diarization: false,
    wordTimestamps: true,
    maxBytes: 200 * 1024 * 1024,
    maxDurationSec: 1800,
    preferredChunkSec: 600,
    async: false,
    streaming: false,
    prompt: true,
    keyterms: 0,
    // Without --convert the server only reads 16 kHz WAV; the orchestrator transcodes to the first format.
    formats: ["wav"],
    traditionalNative: false,
  }),
  async transcribe(cfg, input) {
    const path = str(cfg.fields, "inference_path") ?? "/inference";
    const form = new FormData();
    form.set("file", await fileBlob(input.part), input.part.filename);
    form.set("response_format", "verbose_json");
    form.set("temperature", "0");
    const lang = mapLanguage(input.language, "iso1");
    if (lang) form.set("language", lang);
    if (input.prompt) form.set("prompt", input.prompt);
    const headers: Record<string, string> = {};
    const key = str(cfg.fields, "api_key"); // when behind an auth proxy
    if (key) headers.authorization = `Bearer ${key}`;
    const res = await vendorFetch(cfg, `${base(cfg)}${path.startsWith("/") ? path : `/${path}`}`, { method: "POST", body: form, headers }, input.signal);
    const body = await expectJson(res, "whispercpp");
    // whisper.cpp nests words per segment.
    if (Array.isArray(body.segments) && !body.words) {
      body.words = body.segments.flatMap((s: any) => (Array.isArray(s.words) ? s.words : []));
      if (!body.words.length) delete body.words;
    }
    return parseOpenAiBody(body, input.part.durationSec);
  },
  async probe(cfg, signal) {
    await expectOk(await vendorFetch(cfg, `${base(cfg)}/health`, { timeoutMs: 10_000 }, signal), "whispercpp");
  },
};
