/**
 * AWS Transcribe (batch). Needs an S3 bucket in the same region (`s3_bucket`): the audio is PUT to
 * `s3://<bucket>/<s3_prefix><uuid>.<ext>`, a job is started, polled (job name saved for resume),
 * the result fetched from the service-managed URI, then the job and the object are deleted.
 * Credentials need s3:PutObject/DeleteObject on the prefix and transcribe:Start/Get/DeleteTranscriptionJob.
 */
import { randomUUID } from "node:crypto";
import { asrErr } from "../err.js";
import { errorFromResponse, expectJson, fileBlob, num, pollUntil, requireStr, str, trimSlash, vendorFetch } from "../http.js";
import { mapLanguage, r3, segmentsFromWords } from "../normalize.js";
import type { AdapterCallInput, AsrAdapter, AsrProviderConfig, ChunkResult, Segment, Word } from "../types.js";
import { signV4, type AwsCreds } from "./sigv4.js";

const region = (cfg: AsrProviderConfig) => requireStr(cfg.fields, "region", "aws_transcribe");
const creds = (cfg: AsrProviderConfig): AwsCreds => ({
  accessKeyId: requireStr(cfg.fields, "access_key_id", "aws_transcribe"),
  secretAccessKey: requireStr(cfg.fields, "secret_access_key", "aws_transcribe"),
  sessionToken: str(cfg.fields, "session_token"),
});
const transcribeUrl = (cfg: AsrProviderConfig) => trimSlash(str(cfg.fields, "transcribe_endpoint") ?? `https://transcribe.${region(cfg)}.amazonaws.com`) + "/";

function s3Url(cfg: AsrProviderConfig, bucket: string, key: string) {
  const ep = str(cfg.fields, "s3_endpoint");
  const k = key.split("/").map(encodeURIComponent).join("/");
  return ep ? `${trimSlash(ep)}/${bucket}/${k}` : `https://${bucket}.s3.${region(cfg)}.amazonaws.com/${k}`;
}

async function call(cfg: AsrProviderConfig, target: string, payload: unknown, signal?: AbortSignal): Promise<any> {
  const url = transcribeUrl(cfg);
  const body = JSON.stringify(payload);
  const headers = { "content-type": "application/x-amz-json-1.1", "x-amz-target": `Transcribe.${target}` };
  const signed = signV4({ method: "POST", url, headers, body, service: "transcribe", region: region(cfg), creds: creds(cfg) });
  return expectJson(await vendorFetch(cfg, url, { method: "POST", headers: { ...headers, ...signed }, body, timeoutMs: 60_000 }, signal), "aws_transcribe");
}

async function s3(cfg: AsrProviderConfig, method: "PUT" | "DELETE", bucket: string, key: string, input?: AdapterCallInput) {
  const url = s3Url(cfg, bucket, key);
  const headers: Record<string, string> = input ? { "content-type": input.part.mime } : {};
  const signed = signV4({ method, url, headers, payloadHash: input ? "UNSIGNED-PAYLOAD" : undefined, service: "s3", region: region(cfg), creds: creds(cfg) });
  const res = await vendorFetch(cfg, url, { method, headers: { ...headers, ...signed }, body: input ? await fileBlob(input.part) : undefined }, input?.signal);
  if (!res.ok && !(method === "DELETE" && res.status === 404)) throw await errorFromResponse(res, "aws_s3");
  await res.body?.cancel();
}

const FORMAT: Record<string, string> = { mp3: "mp3", mp4: "mp4", m4a: "m4a", wav: "wav", flac: "flac", ogg: "ogg", webm: "webm", amr: "amr" };

/** Parses a Transcribe result JSON. Exported for tests. */
export function parseAwsTranscript(body: any): ChunkResult {
  const r = body?.results ?? {};
  const words: Word[] = [];
  const byId = new Map<number, Word>();
  for (const it of r.items ?? []) {
    const alt = it.alternatives?.[0] ?? {};
    if (it.type === "punctuation") {
      const last = words[words.length - 1];
      if (last) last.text += alt.content ?? "";
      continue;
    }
    const w: Word = {
      start: r3(parseFloat(it.start_time)),
      end: r3(parseFloat(it.end_time)),
      text: String(alt.content ?? ""),
      speaker: it.speaker_label ?? null,
      confidence: alt.confidence != null ? Number(alt.confidence) : null,
    };
    words.push(w);
    if (it.id != null) byId.set(Number(it.id), w);
  }
  // Older outputs put speakers only in speaker_labels.segments.
  if (words.length && words.every((w) => w.speaker == null) && Array.isArray(r.speaker_labels?.segments)) {
    for (const seg of r.speaker_labels.segments) {
      const a = parseFloat(seg.start_time);
      const b = parseFloat(seg.end_time);
      for (const w of words) if (w.start >= a - 0.001 && w.start < b) w.speaker = seg.speaker_label;
    }
  }
  let segments: Omit<Segment, "id">[];
  if (Array.isArray(r.audio_segments) && r.audio_segments.length) {
    segments = r.audio_segments.map((s: any) => ({
      start: r3(parseFloat(s.start_time)),
      end: r3(parseFloat(s.end_time)),
      text: String(s.transcript ?? "").trim(),
      speaker: s.speaker_label ?? byId.get(Number(s.items?.[0]))?.speaker ?? null,
    }));
  } else segments = segmentsFromWords(words);
  return {
    text: String(r.transcripts?.[0]?.transcript ?? ""),
    segments: segments.filter((s) => s.text),
    words: words.length ? words : undefined,
    language: r.language_code ?? null,
    requestId: body?.jobName,
  };
}

export const awsTranscribeAdapter: AsrAdapter = {
  kind: "aws_transcribe",
  capabilities: () => ({
    diarization: true,
    wordTimestamps: true,
    maxBytes: 2 * 1024 ** 3,
    maxDurationSec: 4 * 3600,
    async: true,
    streaming: false,
    prompt: false,
    keyterms: 0, // custom vocabulary is configured in AWS (vocabulary_name), not per request
    formats: ["ogg", "mp3", "m4a", "wav", "flac", "webm", "mp4"],
    traditionalNative: true,
  }),
  async transcribe(cfg, input) {
    const bucket = requireStr(cfg.fields, "s3_bucket", "aws_transcribe");
    let jobName: string;
    let key: string;
    if (input.vendorJobId) {
      [jobName, key] = input.vendorJobId.split("|") as [string, string];
    } else {
      jobName = `hub-${randomUUID()}`;
      const ext = /\.([a-z0-9]+)$/i.exec(input.part.filename)?.[1]?.toLowerCase() ?? "ogg";
      key = `${str(cfg.fields, "s3_prefix") ?? "asr-tmp/"}${jobName}.${ext}`;
      await s3(cfg, "PUT", bucket, key, input);
      const lang = mapLanguage(input.language, "bcp47");
      const settings: Record<string, unknown> = {};
      if (input.diarize) {
        settings.ShowSpeakerLabels = true;
        settings.MaxSpeakerLabels = Math.max(2, Math.min(30, input.speakers?.max ?? input.speakers?.expected ?? 10));
      }
      const vocab = str(cfg.fields, "vocabulary_name");
      if (vocab) settings.VocabularyName = vocab;
      const req: Record<string, unknown> = {
        TranscriptionJobName: jobName,
        Media: { MediaFileUri: `s3://${bucket}/${key}` },
        MediaFormat: FORMAT[ext] ?? "ogg",
        Settings: settings,
      };
      if (lang) req.LanguageCode = lang;
      else req.IdentifyLanguage = true;
      await call(cfg, "StartTranscriptionJob", req, input.signal);
      await input.onVendorJob(`${jobName}|${key}`);
    }
    try {
      const job = await pollUntil<any>(
        async () => {
          const j = (await call(cfg, "GetTranscriptionJob", { TranscriptionJobName: jobName }, input.signal)).TranscriptionJob;
          if (j?.TranscriptionJobStatus === "COMPLETED") return { done: true, value: j };
          if (j?.TranscriptionJobStatus === "FAILED") throw asrErr("bad_request", `aws job failed: ${j.FailureReason ?? ""}`, { reason: "job_failed" });
          return { done: false };
        },
        { intervalMs: cfg.pollIntervalMs ?? 10_000, maxMs: num(cfg.fields, "max_wait_ms") ?? 4 * 3600_000, signal: input.signal, what: "aws_transcribe" },
      );
      const uri = job.Transcript?.TranscriptFileUri;
      if (!uri) throw asrErr("unavailable", "aws: completed job has no TranscriptFileUri");
      const out = parseAwsTranscript(await expectJson(await vendorFetch(cfg, uri, { timeoutMs: 120_000 }, input.signal), "aws_transcribe"));
      out.requestId = jobName;
      if (job.LanguageCode) out.language = job.LanguageCode;
      await call(cfg, "DeleteTranscriptionJob", { TranscriptionJobName: jobName }).catch(() => undefined);
      return out;
    } finally {
      // On abort the remote job keeps running and a resumed attempt still needs the object.
      if (!input.signal.aborted) await s3(cfg, "DELETE", bucket, key).catch(() => undefined);
    }
  },
  async cancel(cfg, vendorJobId) {
    const [jobName, key] = vendorJobId.split("|");
    await call(cfg, "DeleteTranscriptionJob", { TranscriptionJobName: jobName }).catch(() => undefined);
    if (key) await s3(cfg, "DELETE", requireStr(cfg.fields, "s3_bucket", "aws_transcribe"), key).catch(() => undefined);
  },
  async probe(cfg, signal) {
    await call(cfg, "ListTranscriptionJobs", { MaxResults: 1 }, signal);
  },
};
