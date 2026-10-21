/** ASR adapters against mock vendor servers (sync, async poll + resume, error mapping). */
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AiError } from "../src/ai/errors.js";
import { clearGoogleTokenCache } from "../src/ai/asr/adapters/google-auth.js";
import { signV4 } from "../src/ai/asr/adapters/sigv4.js";
import { asrReasonOf, probeAsr, transcribe, type AsrCheckpoint, type AsrProviderConfig, type MediaTools, type TranscribeRequest } from "../src/ai/asr/index.js";

type Rec = { method: string; path: string; query: URLSearchParams; headers: IncomingHttpHeaders; body: Buffer };
type Reply = { status?: number; headers?: Record<string, string>; json?: unknown; text?: string };

async function mock(handler: (r: Rec, all: Rec[]) => Reply | Promise<Reply>) {
  const requests: Rec[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const u = new URL(req.url!, "http://x");
    const rec: Rec = { method: req.method!, path: u.pathname, query: u.searchParams, headers: req.headers, body: Buffer.concat(chunks) };
    requests.push(rec);
    try {
      const r = await handler(rec, requests);
      res.writeHead(r.status ?? 200, { "content-type": r.json !== undefined ? "application/json" : "text/plain", ...r.headers });
      res.end(r.json !== undefined ? JSON.stringify(r.json) : (r.text ?? ""));
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const form = (r: Rec) => new Response(r.body, { headers: { "content-type": String(r.headers["content-type"]) } }).formData();

let dir: string;
let audio: string;
const noTools: MediaTools = {
  probe: async () => ({ durationSec: 30, sizeBytes: 100 }),
  silences: async () => [],
  extract: async () => {
    throw new Error("extract should not be called");
  },
};
const req = (extra: Partial<TranscribeRequest> = {}): TranscribeRequest => ({ audio: { path: audio }, durationSec: 30, language: "zh-TW", ...extra });
const deps = { tools: noTools, retryBaseMs: 1 };

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "asr-test-"));
  audio = join(dir, "meeting.mp3");
  await writeFile(audio, Buffer.from("ID3fake-mp3-bytes"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe("OpenAI family", () => {
  it("gpt-transcribe: languages[], keywords[], prompt; text-only + s2twp", async () => {
    const m = await mock(() => ({ json: { text: "我们讨论软件和 transformer 的 attention。", languages: ["zh", "en"] }, headers: { "x-request-id": "req_1" } }));
    const cfg: AsrProviderConfig = { kind: "openai", baseUrl: m.url, model: "gpt-transcribe", fields: { api_key: "sk-test", project: "proj" } };
    const t = await transcribe(cfg, req({ extraLanguages: ["en"], keyterms: ["transformer", "attention"], prompt: "繁體中文會議" }), deps);
    const r = m.requests[0]!;
    expect(r.path).toBe("/audio/transcriptions");
    expect(r.headers.authorization).toBe("Bearer sk-test");
    expect(r.headers["openai-project"]).toBe("proj");
    const fd = await form(r);
    expect(fd.get("model")).toBe("gpt-transcribe");
    expect(fd.get("response_format")).toBe("json");
    expect(fd.getAll("languages[]")).toEqual(["zh", "en"]);
    expect(fd.getAll("keywords[]")).toEqual(["transformer", "attention"]);
    expect(fd.get("prompt")).toBe("繁體中文會議");
    expect((fd.get("file") as File).name).toBe("audio.mp3");
    expect(t.segments).toHaveLength(1);
    expect(t.segments[0]!.text).toBe("我們討論軟體和 transformer 的 attention。");
    expect(t.segments[0]!.end).toBe(30);
    expect(t.warnings).toEqual(expect.arrayContaining(["no_timestamps", "script_converted"]));
    expect(t.source.scriptConversion).toBe("s2twp");
    expect(t.source.requestIds).toEqual(["req_1"]);
    expect(t.languages).toEqual(["zh", "en"]);
    await m.close();
  });

  it("whisper-1 verbose_json: segments, words, low-confidence drop", async () => {
    const m = await mock(() => ({
      json: {
        language: "chinese",
        duration: 12,
        text: "大家好 hello",
        segments: [
          { start: 0, end: 3, text: " 大家好", avg_logprob: -0.2, no_speech_prob: 0.01 },
          { start: 3, end: 6, text: "字幕由某某提供", avg_logprob: -1.5, no_speech_prob: 0.9 },
          { start: 6, end: 8, text: " hello", avg_logprob: -0.1, no_speech_prob: 0.01 },
        ],
        words: [
          { word: "大", start: 0, end: 0.5 },
          { word: "家", start: 0.5, end: 1 },
          { word: "hello", start: 6, end: 7 },
        ],
      },
    }));
    const t = await transcribe({ kind: "openai", baseUrl: m.url, model: "whisper-1", fields: { api_key: "k" } }, req({ wordTimestamps: true, convertScript: "none" }), deps);
    const fd = await form(m.requests[0]!);
    expect(fd.get("response_format")).toBe("verbose_json");
    expect(fd.getAll("timestamp_granularities[]")).toEqual(["segment", "word"]);
    expect(fd.get("language")).toBe("zh");
    expect(t.segments.map((s) => s.text)).toEqual(["大家好", "hello"]);
    expect(t.segments.map((s) => s.id)).toEqual([0, 1]);
    expect(t.warnings).toContain("low_confidence_dropped");
    expect(t.words?.map((w) => w.segmentId)).toEqual([0, 0, 1]);
    await m.close();
  });

  it("gpt-4o-transcribe-diarize: diarized_json, speaker references, S1/S2", async () => {
    const m = await mock(() => ({
      json: { task: "transcribe", duration: 9, text: "", segments: [
        { id: "a", start: 0, end: 2, speaker: "Alice", text: "你好", type: "transcript.text.segment" },
        { id: "b", start: 2, end: 5, speaker: "B", text: "嗨", type: "transcript.text.segment" },
        { id: "c", start: 5, end: 9, speaker: "Alice", text: "開始吧", type: "transcript.text.segment" },
      ] },
    }));
    const t = await transcribe(
      { kind: "openai", baseUrl: m.url, model: "gpt-4o-transcribe-diarize", fields: { api_key: "k" } },
      req({ diarize: true, prompt: "ignored", speakers: { references: [{ name: "Alice", clip: Buffer.from("wav"), mime: "audio/wav" }] } }),
      deps,
    );
    const fd = await form(m.requests[0]!);
    expect(fd.get("response_format")).toBe("diarized_json");
    expect(fd.get("chunking_strategy")).toBe("auto");
    expect(fd.getAll("known_speaker_names[]")).toEqual(["Alice"]);
    expect(String(fd.get("known_speaker_references[]"))).toMatch(/^data:audio\/wav;base64,/);
    expect(fd.get("prompt")).toBeNull();
    expect(t.speakers).toEqual([{ id: "S1", label: "Alice" }, { id: "S2", label: "B" }]);
    expect(t.segments.map((s) => s.speaker)).toEqual(["S1", "S2", "S1"]);
    expect(t.warnings).toContain("prompt_unsupported");
    await m.close();
  });

  it("maps 429 (retried, honours Retry-After), 401, insufficient_quota, 413", async () => {
    let n = 0;
    const m = await mock((r) => {
      if (r.headers.authorization === "Bearer bad") return { status: 401, json: { error: { message: "Incorrect API key", type: "invalid_request_error", code: "invalid_api_key" } } };
      if (r.headers.authorization === "Bearer poor") return { status: 429, json: { error: { message: "quota", code: "insufficient_quota" } } };
      if (r.headers.authorization === "Bearer big") return { status: 413, json: { error: { message: "Maximum content size limit exceeded" } } };
      return ++n === 1 ? { status: 429, headers: { "retry-after": "0" }, json: { error: { code: "rate_limit_exceeded", message: "slow down" } } } : { json: { text: "好" } };
    });
    const ok = await transcribe({ kind: "groq", baseUrl: m.url, fields: { api_key: "k" } }, req(), deps);
    expect(ok.segments[0]!.text).toBe("好");
    expect(n).toBe(2);
    const fail = (key: string) => transcribe({ kind: "groq", baseUrl: m.url, fields: { api_key: key } }, req({ durationSec: 30 }), { ...deps, chunkRetries: 0 }).catch((e) => e);
    const e401 = await fail("bad");
    expect(e401).toBeInstanceOf(AiError);
    expect(e401.code).toBe("auth_failed");
    expect(e401.message_zh).toBeTruthy();
    expect((await fail("poor")).code).toBe("quota_exhausted");
    const e413 = await fail("big");
    expect(e413.code).toBe("bad_request");
    expect(asrReasonOf(e413)).toBe("too_large");
    await m.close();
  });

  it("generic OpenAI-compatible: custom path, falls back to json when verbose_json is rejected", async () => {
    const m = await mock(async (r) => {
      const fd = await form(r);
      return fd.get("response_format") === "verbose_json" ? { status: 400, json: { error: { message: "response_format verbose_json not supported" } } } : { json: { text: "ok" } };
    });
    const t = await transcribe({ kind: "openai_compatible", baseUrl: m.url, fields: { transcription_path: "/v1/stt" } }, req(), deps);
    expect(m.requests.map((r) => r.path)).toEqual(["/v1/stt", "/v1/stt"]);
    expect(m.requests[0]!.headers.authorization).toBeUndefined();
    expect(t.segments[0]!.text).toBe("ok");
    await m.close();
  });

  it("speaches + WhisperX wrapper contract (diarize fields, speakers on segments/words) + probes", async () => {
    const m = await mock((r) => {
      if (r.path === "/health") return { json: { status: "ok" } };
      if (r.path.startsWith("/v1/models/")) return { json: { id: "large-v3" } };
      return {
        json: {
          text: "甲乙",
          language: "zh",
          duration: 4,
          segments: [{ start: 0, end: 2, text: "甲", speaker: "SPEAKER_00" }, { start: 2, end: 4, text: "乙", speaker: "SPEAKER_01" }],
          words: [{ word: "甲", start: 0, end: 1, score: 0.9, speaker: "SPEAKER_00" }, { word: "乙", start: 2, end: 3, score: 0.8, speaker: "SPEAKER_01" }],
        },
      };
    });
    const cfg: AsrProviderConfig = { kind: "whisperx", baseUrl: m.url, fields: { api_key: "wx" } };
    const t = await transcribe(cfg, req({ diarize: true, speakers: { min: 2, max: 3 }, keyterms: ["BERT"] }), deps);
    const r = m.requests[0]!;
    expect(r.path).toBe("/v1/audio/transcriptions");
    const fd = await form(r);
    expect(fd.get("diarize")).toBe("true");
    expect(fd.get("min_speakers")).toBe("2");
    expect(fd.get("max_speakers")).toBe("3");
    expect(fd.get("hotwords")).toBe("BERT");
    expect(t.speakers.map((s) => s.label)).toEqual(["SPEAKER_00", "SPEAKER_01"]);
    expect(t.words?.map((w) => w.speaker)).toEqual(["S1", "S2"]);
    expect((await probeAsr(cfg)).ok).toBe(true);
    expect(m.requests.at(-2)!.path).toBe("/health");
    expect((await probeAsr({ kind: "speaches", baseUrl: `${m.url}/v1`, model: "large-v3", fields: {} })).ok).toBe(true);
    await m.close();
  });

  it("NIM HTTP: json text only, language passthrough, health probe", async () => {
    const m = await mock((r) => (r.path === "/v1/health/ready" ? { text: "ready" } : { json: { text: "台灣 code-switch", usage: { type: "duration", seconds: 3 } } }));
    const cfg: AsrProviderConfig = { kind: "nim", baseUrl: m.url, fields: {} };
    const wav = join(dir, "a.wav");
    await writeFile(wav, "RIFF");
    const t = await transcribe(cfg, { audio: { path: wav }, durationSec: 3, language: "zh-TW" }, deps);
    const fd = await form(m.requests[0]!);
    expect(fd.get("language")).toBe("zh-TW");
    expect(fd.get("model")).toBe("parakeet-ctc-0.6b-zh-tw");
    expect(t.segments[0]).toMatchObject({ start: 0, end: 3, text: "台灣 code-switch" });
    expect(t.source.scriptConversion).toBe("none");
    expect((await probeAsr(cfg)).ok).toBe(true);
    await m.close();
  });

  it("whisper.cpp: configurable inference path, nested words, 503 loading → unavailable", async () => {
    let loading = true;
    const m = await mock((r) => {
      if (r.path === "/health") return loading ? { status: 503, json: { status: "loading model" } } : { json: { status: "ok" } };
      return { json: { text: "嗨", segments: [{ start: 0, end: 1, text: "嗨", words: [{ word: "嗨", start: 0, end: 0.8, probability: 0.9 }] }] } };
    });
    const cfg: AsrProviderConfig = { kind: "whispercpp", baseUrl: m.url, fields: { inference_path: "/v1/audio/transcriptions" } };
    const p = await probeAsr(cfg);
    expect(p.ok).toBe(false);
    expect(p.error?.code).toBe("unavailable");
    loading = false;
    expect((await probeAsr(cfg)).ok).toBe(true);
    const wav = join(dir, "b.wav");
    await writeFile(wav, "RIFF");
    const t = await transcribe(cfg, { audio: { path: wav }, durationSec: 1 }, deps);
    expect(m.requests.at(-1)!.path).toBe("/v1/audio/transcriptions");
    expect(t.words?.[0]).toMatchObject({ text: "嗨", confidence: 0.9 });
    await m.close();
  });
});

describe("Deepgram / ElevenLabs / Azure (sync)", () => {
  it("Deepgram: raw body, Token auth, zh-TW, diarize_model, keyterm, utterances", async () => {
    const m = await mock(() => ({
      json: {
        metadata: { request_id: "dg-1", duration: 5 },
        results: {
          channels: [{ alternatives: [{ transcript: "你好 嗨", words: [{ word: "你好", punctuated_word: "你好，", start: 0, end: 1, speaker: 0, confidence: 0.9 }, { word: "嗨", start: 2, end: 3, speaker: 1, confidence: 0.8 }] }] }],
          utterances: [{ start: 0, end: 1, transcript: "你好，", speaker: 0, confidence: 0.9 }, { start: 2, end: 3, transcript: "嗨", speaker: 1, confidence: 0.8 }],
        },
      },
    }));
    const t = await transcribe({ kind: "deepgram", baseUrl: m.url, fields: { api_key: "dgk" } }, req({ diarize: true, keyterms: ["LoRA", "BERT"] }), deps);
    const r = m.requests[0]!;
    expect(r.path).toBe("/v1/listen");
    expect(r.headers.authorization).toBe("Token dgk");
    expect(r.headers["content-type"]).toBe("audio/mpeg");
    expect(r.body.toString()).toBe("ID3fake-mp3-bytes");
    expect(r.query.get("language")).toBe("zh-TW");
    expect(r.query.get("diarize_model")).toBe("latest");
    expect(r.query.getAll("keyterm")).toEqual(["LoRA", "BERT"]);
    expect(t.segments.map((s) => [s.text, s.speaker])).toEqual([["你好，", "S1"], ["嗨", "S2"]]);
    expect(t.source.requestIds).toEqual(["dg-1"]);
    expect(t.source.scriptConversion).toBe("none");
    await m.close();
  });

  it("Deepgram error body {err_code} → mapped", async () => {
    const m = await mock(() => ({ status: 402, json: { err_code: "ASR_PAYMENT_REQUIRED", err_msg: "Project does not have enough credits", request_id: "x" } }));
    const e = await transcribe({ kind: "deepgram", baseUrl: m.url, fields: { api_key: "k" } }, req(), deps).catch((x) => x);
    expect(e.code).toBe("quota_exhausted");
    expect(e.vendorCode).toBe("ASR_PAYMENT_REQUIRED");
    await m.close();
  });

  it("ElevenLabs: multipart fields, words → segments by speaker, iso3 language", async () => {
    const m = await mock(() => ({
      json: {
        language_code: "zho",
        text: "大家好。今天開會",
        words: [
          { text: "大家好。", type: "word", start: 0, end: 1, speaker_id: "speaker_0", logprob: -0.1 },
          { text: " ", type: "spacing", start: 1, end: 1.1 },
          { text: "今天", type: "word", start: 1.2, end: 1.6, speaker_id: "speaker_1" },
          { text: "開會", type: "word", start: 1.6, end: 2, speaker_id: "speaker_1" },
        ],
      },
    }));
    const t = await transcribe({ kind: "elevenlabs", baseUrl: m.url, fields: { api_key: "xi" } }, req({ diarize: true, speakers: { expected: 3 }, keyterms: ["Whisper"] }), deps);
    const r = m.requests[0]!;
    expect(r.headers["xi-api-key"]).toBe("xi");
    const fd = await form(r);
    expect(fd.get("model_id")).toBe("scribe_v2");
    expect(fd.get("language_code")).toBe("zho");
    expect(fd.get("num_speakers")).toBe("3");
    expect(fd.getAll("keyterms")).toEqual(["Whisper"]);
    expect(t.segments.map((s) => [s.text, s.speaker])).toEqual([["大家好。", "S1"], ["今天開會", "S2"]]);
    await m.close();
  });

  it("Azure fast transcription: definition JSON, phrases with ms offsets", async () => {
    const m = await mock(() => ({
      headers: { "apim-request-id": "az-1" },
      json: {
        durationMilliseconds: 4000,
        combinedPhrases: [{ text: "哈囉。測試。" }],
        phrases: [
          { speaker: 1, offsetMilliseconds: 0, durationMilliseconds: 1500, text: "哈囉。", locale: "zh-TW", confidence: 0.9, words: [{ text: "哈囉", offsetMilliseconds: 0, durationMilliseconds: 1000 }] },
          { speaker: 2, offsetMilliseconds: 2000, durationMilliseconds: 1500, text: "測試。", locale: "zh-TW", confidence: 0.8, words: [] },
        ],
      },
    }));
    const t = await transcribe({ kind: "azure_speech", fields: { endpoint: m.url, api_key: "azk" } }, req({ diarize: true, keyterms: ["Kaldi"] }), deps);
    const r = m.requests[0]!;
    expect(r.path).toBe("/speechtotext/transcriptions:transcribe");
    expect(r.query.get("api-version")).toBe("2025-10-15");
    expect(r.headers["ocp-apim-subscription-key"]).toBe("azk");
    const fd = await form(r);
    const def = JSON.parse(String(fd.get("definition")));
    expect(def.locales).toEqual(["zh-TW"]);
    expect(def.diarization).toEqual({ enabled: true, maxSpeakers: 10 });
    expect(def.phraseList).toEqual({ phrases: ["Kaldi"] });
    expect(t.segments[1]).toMatchObject({ start: 2, end: 3.5, text: "測試。", speaker: "S2", language: "zh-TW" });
    expect(t.words?.[0]).toMatchObject({ start: 0, end: 1 });
    expect(t.source.requestIds).toEqual(["az-1"]);
    await m.close();
  });
});

describe("AssemblyAI (async + resume)", () => {
  it("upload → submit → poll; checkpoint holds the transcript id; delete afterwards", async () => {
    let polls = 0;
    const m = await mock((r) => {
      if (r.path === "/v2/upload") return { json: { upload_url: "https://cdn.example/u1" } };
      if (r.path === "/v2/transcript" && r.method === "POST") return { json: { id: "tr_1", status: "queued" } };
      if (r.path === "/v2/transcript/tr_1" && r.method === "GET")
        return ++polls < 3
          ? { json: { id: "tr_1", status: polls === 1 ? "queued" : "processing" } }
          : { json: { id: "tr_1", status: "completed", text: "嗨", language_code: "zh", audio_duration: 30, words: [{ text: "嗨", start: 1000, end: 1500, speaker: "A", confidence: 0.9 }], utterances: [{ speaker: "A", start: 1000, end: 1500, text: "嗨", confidence: 0.9 }] } };
      if (r.method === "DELETE") return { json: {} };
      return { status: 404, json: { error: "nope" } };
    });
    const cps: AsrCheckpoint[] = [];
    const t = await transcribe(
      { kind: "assemblyai", baseUrl: m.url, pollIntervalMs: 5, fields: { api_key: "aai" } },
      req({ diarize: true, speakers: { expected: 2 }, keyterms: ["語音 辨識"], prompt: "meeting", onCheckpoint: (c) => void cps.push(c) }),
      deps,
    );
    expect(m.requests[0]!.headers.authorization).toBe("aai");
    const sub = JSON.parse(m.requests[1]!.body.toString());
    expect(sub).toMatchObject({ audio_url: "https://cdn.example/u1", language_code: "zh", speaker_labels: true, speakers_expected: 2, keyterms_prompt: ["語音 辨識"], prompt: "meeting" });
    expect(sub.speech_models).toEqual(["universal-3-5-pro", "universal-2"]);
    expect(cps[0]!.vendorJobs).toEqual({ "0": "tr_1" });
    expect(t.segments[0]).toMatchObject({ start: 1, end: 1.5, speaker: "S1" });
    expect(t.vendorJobId).toBe("tr_1");
    expect(m.requests.at(-1)!.method).toBe("DELETE");
    await m.close();
  });

  it("resume with a saved id polls without re-uploading; failed job clears the id", async () => {
    const m = await mock((r) => {
      if (r.path === "/v2/transcript/tr_old") return { json: { id: "tr_old", status: "error", error: "Audio file could not be decoded" } };
      return { status: 500, text: "unexpected" };
    });
    const cps: AsrCheckpoint[] = [];
    const e = await transcribe(
      { kind: "assemblyai", baseUrl: m.url, pollIntervalMs: 5, fields: { api_key: "k" } },
      req({ resume: { vendorJobs: { "0": "tr_old" }, done: {} }, onCheckpoint: (c) => void cps.push(c) }),
      deps,
    ).catch((x) => x);
    expect(m.requests.map((r) => r.path)).toEqual(["/v2/transcript/tr_old"]);
    expect(asrReasonOf(e)).toBe("job_failed");
    expect(cps.at(-1)!.vendorJobs).toEqual({});
    await m.close();
  });
});

describe("Google STT v2", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });

  it("inline Recognize with a service-account JWT; chunks to ≤ 55 s without a bucket", async () => {
    clearGoogleTokenCache();
    const m = await mock((r) => {
      if (r.path === "/token") return { json: { access_token: "ya29.test", expires_in: 3600 } };
      return { json: { results: [{ alternatives: [{ transcript: "測試", confidence: 0.9, words: [{ word: "測試", startOffset: "0.5s", endOffset: "1.200s", speakerLabel: "1" }] }], resultEndOffset: "1.5s", languageCode: "cmn-hant-tw" }] } };
    });
    const sa = JSON.stringify({ client_email: "asr@p.iam.gserviceaccount.com", private_key: privateKey, token_uri: `${m.url}/token`, project_id: "proj" });
    const cfg: AsrProviderConfig = { kind: "google_stt", fields: { service_account_json: sa, api_base: m.url, location: "us" } };
    const t = await transcribe(cfg, req({ durationSec: 30, diarize: true, keyterms: ["Conformer"] }), deps);
    const tok = new URLSearchParams(m.requests[0]!.body.toString());
    expect(tok.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(tok.get("assertion")!.split(".")).toHaveLength(3);
    const r = m.requests[1]!;
    expect(r.path).toBe("/v2/projects/proj/locations/us/recognizers/_:recognize");
    expect(r.headers.authorization).toBe("Bearer ya29.test");
    const body = JSON.parse(r.body.toString());
    expect(body.config.languageCodes).toEqual(["cmn-Hant-TW"]);
    expect(body.config.features.diarizationConfig).toBeTruthy();
    expect(body.config.adaptation.phraseSets[0].inlinePhraseSet.phrases[0].value).toBe("Conformer");
    expect(Buffer.from(body.content, "base64").toString()).toBe("ID3fake-mp3-bytes");
    expect(t.segments[0]).toMatchObject({ start: 0.5, end: 1.5, text: "測試", speaker: "S1" });
    expect(t.words?.[0]).toMatchObject({ start: 0.5, end: 1.2 });
    await m.close();
  });

  it("BatchRecognize via GCS: upload, poll op (op name saved), delete staged object", async () => {
    clearGoogleTokenCache();
    let polls = 0;
    const m = await mock((r) => {
      if (r.path === "/token") return { json: { access_token: "tok", expires_in: 3600 } };
      if (r.path === "/upload/storage/v1/b/bkt/o") return { json: { name: r.query.get("name") } };
      if (r.path.endsWith(":batchRecognize")) return { json: { name: "projects/proj/locations/us/operations/op1" } };
      if (r.path === "/v2/projects/proj/locations/us/operations/op1") {
        if (++polls < 2) return { json: { name: "op1", done: false } };
        const uri = `gs://bkt/${decodeURIComponent(m.requests.find((x) => x.path.startsWith("/upload"))!.query.get("name")!)}`;
        return { json: { name: "op1", done: true, response: { results: { [uri]: { inlineResult: { transcript: { results: [{ alternatives: [{ transcript: "長錄音" }], resultEndOffset: "600s" }] } } } } } } };
      }
      if (r.method === "DELETE") return { json: {} };
      return { status: 404, json: { error: { code: 404, message: "?", status: "NOT_FOUND" } } };
    });
    const sa = { client_email: "b@p", private_key: privateKey, token_uri: `${m.url}/token`, project_id: "proj" };
    const cps: AsrCheckpoint[] = [];
    const t = await transcribe(
      { kind: "google_stt", pollIntervalMs: 5, fields: { service_account_json: sa, api_base: m.url, storage_base: m.url, gcs_bucket: "bkt" } },
      req({ durationSec: 600, onCheckpoint: (c) => void cps.push(c) }),
      deps,
    );
    expect(cps[0]!.vendorJobs["0"]).toMatch(/^projects\/proj\/locations\/us\/operations\/op1\|gs:\/\/bkt\/asr-tmp\//);
    expect(t.segments[0]).toMatchObject({ text: "長錄音", end: 600 });
    const del = m.requests.find((r) => r.method === "DELETE")!;
    expect(decodeURIComponent(del.path)).toMatch(/^\/storage\/v1\/b\/bkt\/o\/asr-tmp\/.+\.mp3$/);
    await m.close();
  });
});

describe("AWS Transcribe", () => {
  it("SigV4 matches the AWS documentation test vector", () => {
    const h = signV4({
      method: "GET",
      url: "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
      service: "iam",
      region: "us-east-1",
      creds: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
      now: new Date("2015-08-30T12:36:00Z"),
    });
    expect(h.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
    );
  });

  it("S3 PUT → StartTranscriptionJob → poll → fetch result → delete job + object", async () => {
    let polls = 0;
    const m = await mock((r) => {
      const target = String(r.headers["x-amz-target"] ?? "");
      if (r.path.startsWith("/bkt/") && r.method === "PUT") return { text: "" };
      if (r.path.startsWith("/bkt/") && r.method === "DELETE") return { status: 204 };
      if (target === "Transcribe.StartTranscriptionJob") return { json: { TranscriptionJob: { TranscriptionJobStatus: "IN_PROGRESS" } } };
      if (target === "Transcribe.GetTranscriptionJob")
        return ++polls < 2
          ? { json: { TranscriptionJob: { TranscriptionJobStatus: "IN_PROGRESS" } } }
          : { json: { TranscriptionJob: { TranscriptionJobStatus: "COMPLETED", LanguageCode: "zh-TW", Transcript: { TranscriptFileUri: `${m.url}/result.json` } } } };
      if (target === "Transcribe.DeleteTranscriptionJob") return { json: {} };
      if (r.path === "/result.json")
        return {
          json: {
            jobName: "x",
            results: {
              transcripts: [{ transcript: "你好。好" }],
              items: [
                { id: 0, type: "pronunciation", start_time: "0.5", end_time: "1.0", speaker_label: "spk_0", alternatives: [{ content: "你好", confidence: "0.9" }] },
                { id: 1, type: "punctuation", alternatives: [{ content: "。" }] },
                { id: 2, type: "pronunciation", start_time: "2.0", end_time: "2.5", speaker_label: "spk_1", alternatives: [{ content: "好", confidence: "0.8" }] },
              ],
            },
          },
        };
      if (target === "Transcribe.ListTranscriptionJobs") return { status: 400, json: { __type: "UnrecognizedClientException", message: "The security token included in the request is invalid." } };
      return { status: 400, json: { __type: "BadRequestException", message: "?" } };
    });
    const cfg: AsrProviderConfig = {
      kind: "aws_transcribe",
      pollIntervalMs: 5,
      fields: { region: "ap-northeast-1", access_key_id: "AKID", secret_access_key: "SECRET", s3_bucket: "bkt", s3_endpoint: m.url, transcribe_endpoint: m.url },
    };
    const cps: AsrCheckpoint[] = [];
    const t = await transcribe(cfg, req({ diarize: true, onCheckpoint: (c) => void cps.push(c) }), deps);
    const put = m.requests[0]!;
    expect(put.method).toBe("PUT");
    expect(put.headers["x-amz-content-sha256"]).toBe("UNSIGNED-PAYLOAD");
    expect(String(put.headers.authorization)).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/ap-northeast-1\/s3\/aws4_request/);
    const start = JSON.parse(m.requests[1]!.body.toString());
    expect(start).toMatchObject({ LanguageCode: "zh-TW", MediaFormat: "mp3", Settings: { ShowSpeakerLabels: true, MaxSpeakerLabels: 10 } });
    expect(start.Media.MediaFileUri).toMatch(/^s3:\/\/bkt\/asr-tmp\/hub-.+\.mp3$/);
    expect(String(m.requests[1]!.headers.authorization)).toContain("/transcribe/aws4_request");
    expect(cps[0]!.vendorJobs["0"]).toMatch(/^hub-[0-9a-f-]+\|asr-tmp\//);
    expect(t.segments.map((s) => [s.text, s.speaker])).toEqual([["你好。", "S1"], ["好", "S2"]]);
    expect(t.language).toBe("zh-TW");
    const tail = m.requests.slice(-2).map((r) => r.headers["x-amz-target"] ?? r.method);
    expect(tail).toEqual(["Transcribe.DeleteTranscriptionJob", "DELETE"]);
    const p = await probeAsr(cfg);
    expect(p.error?.code).toBe("auth_failed");
    await m.close();
  });
});

describe("orchestrator", () => {
  it("transcodes unsupported formats, network errors → unavailable", async () => {
    const extracted: string[] = [];
    const tools: MediaTools = {
      ...noTools,
      extract: async (_i, out, fmt) => {
        extracted.push(fmt);
        await writeFile(out, "converted");
      },
    };
    const m = await mock(() => ({ json: { text: "ok" } }));
    const ogg = join(dir, "voice.ogg");
    await writeFile(ogg, "OggS");
    await transcribe({ kind: "openai", baseUrl: m.url, model: "gpt-4o-transcribe", fields: { api_key: "k" } }, { audio: { path: ogg }, durationSec: 10 }, { ...deps, tools });
    expect(extracted).toEqual(["mp3"]);
    expect(((await form(m.requests[0]!)).get("file") as File).name).toBe("audio.mp3");
    await m.close();
    const e = await transcribe({ kind: "openai", baseUrl: m.url, fields: { api_key: "k" } }, req(), { ...deps, chunkRetries: 0 }).catch((x) => x);
    expect(e.code).toBe("unavailable");
  });

  it("accepts a stream input (spooled to tmp)", async () => {
    const m = await mock(() => ({ json: { text: "串流" } }));
    async function* gen() {
      yield new TextEncoder().encode("ID3");
      yield new TextEncoder().encode("more");
    }
    const t = await transcribe({ kind: "openai", baseUrl: m.url, model: "gpt-4o-transcribe", fields: { api_key: "k" } }, { audio: { stream: gen(), mime: "audio/mpeg", filename: "x.mp3" }, durationSec: 5 }, deps);
    expect(t.segments[0]!.text).toBe("串流");
    const file = (await form(m.requests[0]!)).get("file") as File;
    expect(await file.text()).toBe("ID3more");
    await m.close();
  });
});
