/**
 * Google Cloud Speech-to-Text v2 (chirp_3).
 * - Without `gcs_bucket`: inline `Recognize` only (≤ 1 min / 10 MB per request), so the orchestrator
 *   chunks long audio into ~55 s pieces (many requests; diarization is per chunk).
 * - With `gcs_bucket`: uploads to GCS, `BatchRecognize` (long-running op, polled; op name saved for
 *   resume), inline results, then deletes the staged object.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { asrErr } from "../err.js";
import { bool, expectJson, expectOk, fileBlob, num, pollUntil, requireStr, str, trimSlash, vendorFetch } from "../http.js";
import { durationToSec, mapLanguage, r3 } from "../normalize.js";
import type { AdapterCallInput, AsrAdapter, AsrProviderConfig, ChunkResult, Segment, Word } from "../types.js";
import { googleAccessToken, parseServiceAccount } from "./google-auth.js";

function api(cfg: AsrProviderConfig) {
  const loc = str(cfg.fields, "location") ?? "us";
  const host = trimSlash(str(cfg.fields, "api_base") ?? (loc === "global" ? "https://speech.googleapis.com" : `https://${loc}-speech.googleapis.com`));
  const project = str(cfg.fields, "project_id") ?? parseServiceAccount(cfg.fields.service_account_json).project_id;
  if (!project) throw asrErr("bad_request", "google_stt: project_id is required");
  return { host, recognizer: `projects/${project}/locations/${loc}/recognizers/_`, project, loc };
}
const storageBase = (cfg: AsrProviderConfig) => trimSlash(str(cfg.fields, "storage_base") ?? "https://storage.googleapis.com");

function recognitionConfig(cfg: AsrProviderConfig, input: AdapterCallInput) {
  const langs = [mapLanguage(input.language, "google"), ...(input.extraLanguages ?? []).map((l) => mapLanguage(l, "google"))].filter(Boolean) as string[];
  const features: Record<string, unknown> = { enableAutomaticPunctuation: true, enableWordTimeOffsets: input.wordTimestamps, enableWordConfidence: true };
  if (input.diarize) features.diarizationConfig = { minSpeakerCount: input.speakers?.min ?? 1, maxSpeakerCount: input.speakers?.max ?? input.speakers?.expected ?? 6 };
  const c: Record<string, unknown> = {
    autoDecodingConfig: {},
    model: cfg.model ?? str(cfg.fields, "model") ?? "chirp_3",
    languageCodes: langs.length ? [...new Set(langs)] : ["auto"],
    features,
  };
  if (input.keyterms.length) c.adaptation = { phraseSets: [{ inlinePhraseSet: { phrases: input.keyterms.map((value) => ({ value, boost: 10 })) } }] };
  return c;
}

/** Parses `results[]` of a recognize response. Exported for tests. */
export function parseGoogleResults(results: any[]): ChunkResult {
  const segments: Omit<Segment, "id">[] = [];
  const words: Word[] = [];
  let prevEnd = 0;
  const langs = new Set<string>();
  for (const r of results ?? []) {
    const alt = r.alternatives?.[0];
    const end = durationToSec(r.resultEndOffset ?? r.resultEndTime);
    if (!alt?.transcript?.trim()) {
      prevEnd = end || prevEnd;
      continue;
    }
    const ws: Word[] = (alt.words ?? []).map((w: any) => ({
      start: durationToSec(w.startOffset ?? w.startTime),
      end: durationToSec(w.endOffset ?? w.endTime),
      text: String(w.word ?? ""),
      speaker: w.speakerLabel || null,
      confidence: w.confidence ?? null,
    }));
    words.push(...ws);
    if (r.languageCode) langs.add(r.languageCode);
    segments.push({
      start: r3(ws[0]?.start ?? prevEnd),
      end: r3(end || ws[ws.length - 1]?.end || prevEnd),
      text: alt.transcript.trim(),
      speaker: ws[0]?.speaker ?? null,
      confidence: alt.confidence ?? null,
      language: r.languageCode ?? null,
    });
    prevEnd = end || prevEnd;
  }
  return {
    text: segments.map((s) => s.text).join(""),
    segments,
    words: words.length ? words : undefined,
    language: [...langs][0] ?? null,
    languages: langs.size > 1 ? [...langs] : undefined,
  };
}

const ext = (name: string) => /\.([a-z0-9]+)$/i.exec(name)?.[1] ?? "bin";

async function batch(cfg: AsrProviderConfig, input: AdapterCallInput, token: string): Promise<ChunkResult> {
  const { host, recognizer } = api(cfg);
  const bucket = requireStr(cfg.fields, "gcs_bucket", "google_stt");
  const auth = { authorization: `Bearer ${token}` };
  let opName: string;
  let uri: string;
  if (input.vendorJobId) {
    [opName, uri] = input.vendorJobId.split("|") as [string, string];
  } else {
    const object = `${str(cfg.fields, "staging_prefix") ?? "asr-tmp/"}${randomUUID()}.${ext(input.part.filename)}`;
    await expectJson(
      await vendorFetch(
        cfg,
        `${storageBase(cfg)}/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(object)}`,
        { method: "POST", headers: { ...auth, "content-type": input.part.mime }, body: await fileBlob(input.part) },
        input.signal,
      ),
      "google-gcs",
    );
    uri = `gs://${bucket}/${object}`;
    const body: Record<string, unknown> = {
      config: recognitionConfig(cfg, input),
      files: [{ uri }],
      recognitionOutputConfig: { inlineResponseConfig: {} },
    };
    if (bool(cfg.fields, "use_dynamic_batch")) body.processingStrategy = "DYNAMIC_BATCHING";
    const op = await expectJson<{ name: string }>(
      await vendorFetch(cfg, `${host}/v2/${recognizer}:batchRecognize`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) }, input.signal),
      "google_stt",
    );
    opName = op.name;
    await input.onVendorJob(`${opName}|${uri}`);
  }
  try {
    const done = await pollUntil<any>(
      async () => {
        const t = await googleAccessToken(cfg, input.signal);
        const j = await expectJson(await vendorFetch(cfg, `${host}/v2/${opName}`, { headers: { authorization: `Bearer ${t}` }, timeoutMs: 60_000 }, input.signal), "google_stt");
        if (!j.done) return { done: false };
        if (j.error) throw asrErr("bad_request", `google batch failed: ${j.error.message ?? j.error.code}`, { reason: "job_failed" });
        return { done: true, value: j.response };
      },
      { intervalMs: cfg.pollIntervalMs ?? 10_000, maxMs: num(cfg.fields, "max_wait_ms") ?? (bool(cfg.fields, "use_dynamic_batch") ? 25 : 4) * 3600_000, signal: input.signal, what: "google_stt" },
    );
    const file = done?.results?.[uri] ?? Object.values(done?.results ?? {})[0];
    if ((file as any)?.error) throw asrErr("bad_request", `google batch file error: ${(file as any).error.message}`, { reason: "job_failed" });
    const t = (file as any)?.inlineResult?.transcript ?? (file as any)?.transcript;
    const out = parseGoogleResults(t?.results ?? []);
    out.requestId = opName;
    return out;
  } finally {
    const [, b, ...rest] = /^gs:\/\/([^/]+)\/(.+)$/.exec(uri) ?? [];
    if (b && rest[0] && !input.signal.aborted) {
      const t = await googleAccessToken(cfg).catch(() => token);
      await vendorFetch(cfg, `${storageBase(cfg)}/storage/v1/b/${encodeURIComponent(b)}/o/${encodeURIComponent(rest[0])}`, { method: "DELETE", headers: { authorization: `Bearer ${t}` }, timeoutMs: 15_000 })
        .then((r) => r.body?.cancel())
        .catch(() => undefined);
    }
  }
}

export const googleSttAdapter: AsrAdapter = {
  kind: "google_stt",
  capabilities: (cfg) => {
    const hasBucket = !!str(cfg.fields, "gcs_bucket");
    return {
      diarization: true,
      wordTimestamps: true,
      maxBytes: hasBucket ? undefined : 10 * 1024 * 1024,
      maxDurationSec: hasBucket ? 3600 : 59,
      preferredChunkSec: hasBucket ? 3600 : 55,
      async: hasBucket,
      streaming: false,
      prompt: false,
      keyterms: 1000,
      formats: ["flac", "wav", "ogg", "mp3", "webm", "m4a"],
      traditionalNative: true,
    };
  },
  async transcribe(cfg, input) {
    const token = await googleAccessToken(cfg, input.signal);
    if (str(cfg.fields, "gcs_bucket")) return batch(cfg, input, token);
    if (input.part.sizeBytes > 10 * 1024 * 1024) throw asrErr("bad_request", "google_stt inline limit is 10 MB", { reason: "too_large" });
    const { host, recognizer } = api(cfg);
    const content = (await readFile(input.part.path)).toString("base64");
    const res = await vendorFetch(
      cfg,
      `${host}/v2/${recognizer}:recognize`,
      { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ config: recognitionConfig(cfg, input), content }) },
      input.signal,
    );
    const j = await expectJson(res, "google_stt");
    const out = parseGoogleResults(j.results ?? []);
    out.requestId = j.metadata?.requestId;
    return out;
  },
  async cancel(cfg, vendorJobId) {
    const [opName] = vendorJobId.split("|");
    const { host } = api(cfg);
    const t = await googleAccessToken(cfg);
    await vendorFetch(cfg, `${host}/v2/${opName}:cancel`, { method: "POST", headers: { authorization: `Bearer ${t}` }, timeoutMs: 15_000 }).then((r) => r.body?.cancel());
  },
  async probe(cfg, signal) {
    const t = await googleAccessToken(cfg, signal);
    const { host, project, loc } = api(cfg);
    await expectOk(await vendorFetch(cfg, `${host}/v2/projects/${project}/locations/${loc}/recognizers?pageSize=1`, { headers: { authorization: `Bearer ${t}` }, timeoutMs: 10_000 }, signal), "google_stt");
  },
};
