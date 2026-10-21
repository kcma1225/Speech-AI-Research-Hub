/** AssemblyAI: upload → submit → poll (async). Saves the transcript id for resume. Times are ms. */
import { asrErr } from "../err.js";
import { bool, expectJson, fileBlob, num, pollUntil, requireStr, str, trimSlash, vendorFetch } from "../http.js";
import { mapLanguage, msToSec, segmentsFromWords } from "../normalize.js";
import type { AsrAdapter, AsrProviderConfig, ChunkResult, Word } from "../types.js";

function base(cfg: AsrProviderConfig) {
  if (cfg.baseUrl ?? str(cfg.fields, "base_url")) return trimSlash((cfg.baseUrl ?? str(cfg.fields, "base_url"))!);
  return str(cfg.fields, "region") === "eu" ? "https://api.eu.assemblyai.com" : "https://api.assemblyai.com";
}
const auth = (cfg: AsrProviderConfig) => ({ authorization: requireStr(cfg.fields, "api_key", "assemblyai") });

/** Parses a completed transcript. Exported for tests. */
export function parseAssembly(body: any): ChunkResult {
  const words: Word[] = (body.words ?? []).map((w: any) => ({
    start: msToSec(w.start),
    end: msToSec(w.end),
    text: String(w.text ?? ""),
    speaker: w.speaker ?? null,
    confidence: w.confidence ?? null,
  }));
  const segments = Array.isArray(body.utterances) && body.utterances.length
    ? body.utterances.map((u: any) => ({
        start: msToSec(u.start),
        end: msToSec(u.end),
        text: String(u.text ?? "").trim(),
        speaker: u.speaker ?? null,
        confidence: u.confidence ?? null,
      }))
    : segmentsFromWords(words);
  return {
    text: String(body.text ?? ""),
    segments,
    words: words.length ? words : undefined,
    language: body.language_code ?? null,
    durationSec: typeof body.audio_duration === "number" ? body.audio_duration : undefined,
    requestId: body.id,
  };
}

export const assemblyaiAdapter: AsrAdapter = {
  kind: "assemblyai",
  capabilities: (cfg) => ({
    diarization: true,
    wordTimestamps: true,
    maxBytes: Math.floor(2.2 * 1024 ** 3),
    maxDurationSec: 10 * 3600,
    async: true,
    streaming: false,
    prompt: /universal-3/.test(cfg.model ?? "universal-3-5-pro"),
    keyterms: /universal-2$/.test(cfg.model ?? "") ? 200 : 1000,
    formats: ["ogg", "mp3", "m4a", "wav", "flac", "webm", "mp4"],
    traditionalNative: false,
  }),
  async transcribe(cfg, input) {
    const b = base(cfg);
    let id = input.vendorJobId;
    if (!id) {
      const up = await expectJson<{ upload_url: string }>(
        await vendorFetch(cfg, `${b}/v2/upload`, { method: "POST", headers: { ...auth(cfg), "content-type": "application/octet-stream" }, body: await fileBlob(input.part) }, input.signal),
        "assemblyai",
      );
      const model = cfg.model ?? str(cfg.fields, "model");
      const req: Record<string, unknown> = {
        audio_url: up.upload_url,
        speech_models: model ? [model, ...(model === "universal-2" ? [] : ["universal-2"])] : ["universal-3-5-pro", "universal-2"],
        punctuate: true,
        format_text: true,
      };
      const lang = mapLanguage(input.language, "iso1");
      if (lang) req.language_code = lang;
      else req.language_detection = true;
      if (input.diarize) {
        req.speaker_labels = true;
        const sp = input.speakers;
        if (sp?.expected) req.speakers_expected = sp.expected;
        else if (sp?.min || sp?.max) req.speaker_options = { min_speakers_expected: sp.min, max_speakers_expected: sp.max };
      }
      if (input.keyterms.length) req.keyterms_prompt = input.keyterms.map((k) => k.split(/\s+/).slice(0, 6).join(" "));
      if (input.prompt && !/universal-2$/.test(model ?? "")) req.prompt = input.prompt;
      const sub = await expectJson<{ id: string }>(
        await vendorFetch(cfg, `${b}/v2/transcript`, { method: "POST", headers: { ...auth(cfg), "content-type": "application/json" }, body: JSON.stringify(req) }, input.signal),
        "assemblyai",
      );
      id = sub.id;
      await input.onVendorJob(id);
    }
    const body = await pollUntil<any>(
      async () => {
        const res = await vendorFetch(cfg, `${b}/v2/transcript/${encodeURIComponent(id!)}`, { headers: auth(cfg), timeoutMs: 60_000 }, input.signal);
        if (res.status === 404) throw asrErr("bad_request", `assemblyai: transcript ${id} not found`, { status: 404, reason: "job_failed" });
        const j = await expectJson(res, "assemblyai");
        if (j.status === "completed") return { done: true, value: j };
        if (j.status === "error") throw asrErr("bad_request", `assemblyai job failed: ${String(j.error ?? "").slice(0, 300)}`, { reason: "job_failed" });
        return { done: false };
      },
      { intervalMs: cfg.pollIntervalMs ?? 5_000, maxMs: num(cfg.fields, "max_wait_ms") ?? 3 * 3600_000, signal: input.signal, what: "assemblyai" },
    );
    const out = parseAssembly(body);
    if (bool(cfg.fields, "delete_after", true)) await assemblyaiAdapter.cancel!(cfg, id).catch(() => undefined);
    return out;
  },
  async cancel(cfg, id) {
    const r = await vendorFetch(cfg, `${base(cfg)}/v2/transcript/${encodeURIComponent(id)}`, { method: "DELETE", headers: auth(cfg), timeoutMs: 15_000 });
    await r.body?.cancel();
  },
  async probe(cfg, signal) {
    await expectJson(await vendorFetch(cfg, `${base(cfg)}/v2/transcript?limit=1`, { headers: auth(cfg), timeoutMs: 10_000 }, signal), "assemblyai");
  },
};
