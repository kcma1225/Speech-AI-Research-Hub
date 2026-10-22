/** Speech-to-text by multimodal chat models: audio capability, codec audio blocks, LLM transcript parsing, chunk merge, routing. */
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LightMyRequestResponse } from "fastify";
import { llmAsrAdapter, answerBudget, type LlmChatFn } from "../src/ai/asr/adapters/llm.js";
import { buildTranscribePrompt, collapseLoops, parseJsonAnswer, parseLlmTranscript, parseTime } from "../src/ai/asr/llm-transcript.js";
import { transcribe, type MediaTools } from "../src/ai/asr/index.js";
import { toAnthropicMessages, buildAnthropicBody } from "../src/ai/codecs/anthropic-messages.js";
import { toGeminiContents } from "../src/ai/codecs/gemini.js";
import { parseModelList, toOpenAiMessages, inputAudioPart } from "../src/ai/codecs/openai-chat.js";
import { buildResponsesBody } from "../src/ai/codecs/openai-responses.js";
import { ensureAudioSupported, hasAudio } from "../src/ai/codecs/shared.js";
import type { CodecContext } from "../src/ai/codecs/codec.js";
import { getProvider } from "../src/ai/providers/index.js";
import { AiPlatform } from "../src/ai/platform/index.js";
import { audioCodecOf, modelAudio } from "../src/ai/platform/audio.js";
import { resolveProfile } from "../src/ai/platform/models.js";
import { validateMemberParams } from "../src/ai/platform/params.js";
import type { ProfileFields } from "../src/ai/catalog/index.js";
import type { AudioBlock, ChatMessage } from "../src/ai/types.js";
import { createTestContext, hasTestDb, ORIGIN, type TestContext } from "./helpers.js";
import { MockServer, sse } from "./ai-providers-mock.js";

process.env.PROVIDER_TOKEN_KEY ??= randomBytes(32).toString("base64");

const AUDIO: AudioBlock = { type: "audio", source: { kind: "base64", mediaType: "audio/mpeg", data: "SUQzAAAA" } };
const msgs: ChatMessage[] = [
  { role: "system", content: "sys" },
  { role: "user", content: [{ type: "text", text: "逐字稿" }, AUDIO] },
];
const prof = (model: string, api: ProfileFields = {}, overrides: ProfileFields = {}) => resolveProfile({ family: "llm" }, { model_id: model, api, overrides });
const acct = (kind: string, config: Record<string, unknown> = {}) => ({ kind, config, family: "llm" as const });

describe("audio input capability", () => {
  it("listing > catalog > name > vendor; manual override wins; protocols without audio are always no", () => {
    expect(modelAudio(acct("openai-compatible"), "oc/muse", prof("oc/muse", { audio_input: true }))).toMatchObject({ audio: true, source: "model_list" });
    expect(modelAudio(acct("openai-compatible"), "glm/glm-5.3-flash", prof("glm/glm-5.3-flash", { audio_input: false }))).toMatchObject({ audio: false, source: "model_list" });
    expect(modelAudio(acct("gemini"), "gemini-2.5-flash", prof("gemini-2.5-flash"))).toMatchObject({ audio: true, source: "catalog" });
    expect(modelAudio(acct("openai-compatible"), "gpt-4o-mini-audio-preview", prof("gpt-4o-mini-audio-preview"))).toMatchObject({ audio: true, source: "catalog" });
    expect(modelAudio(acct("openai-compatible"), "Qwen/Qwen2.5-Omni-7B", prof("Qwen/Qwen2.5-Omni-7B")).audio).toBe(true);
    expect(modelAudio(acct("openai-compatible"), "ultravox-v0_5", prof("ultravox-v0_5"))).toMatchObject({ audio: true, source: "name" });
    expect(modelAudio(acct("openai-compatible"), "gpt-4o", prof("gpt-4o"))).toMatchObject({ audio: false, source: "catalog" });
    expect(modelAudio(acct("openai-compatible"), "my-model", prof("my-model"))).toMatchObject({ audio: false, source: "unknown", codec_ok: true });
    expect(modelAudio(acct("openai-compatible"), "my-model", prof("my-model", {}, { audio_input: true }))).toMatchObject({ audio: true, source: "override", overridden: true });
    expect(modelAudio(acct("gemini"), "gemini-embedding-001", prof("gemini-embedding-001")).audio).toBe(false);
    // Anthropic / Ollama native / Claude CLI cannot carry audio, whatever the profile says.
    for (const k of ["anthropic", "ollama", "claude-cli"]) expect(modelAudio(acct(k), "x", prof("x", {}, { audio_input: true }))).toMatchObject({ audio: false, codec_ok: false });
    // OpenAI defaults to the Responses API (no audio input): audio goes over Chat Completions instead.
    expect(audioCodecOf({ kind: "openai", config: {} })).toEqual({ codec: "openai-chat", configPatch: { apiStyle: "chat" } });
    expect(audioCodecOf({ kind: "openai", config: { apiStyle: "chat" } })).toEqual({ codec: "openai-chat" });
    expect(modelAudio(acct("openai"), "gpt-audio-mini", prof("gpt-audio-mini")).audio).toBe(true);
    expect(modelAudio(acct("chatgpt"), "gpt-5", prof("gpt-5")).codec_ok).toBe(false);
  });

  it("reads gateway capability hints and input modalities from listings", () => {
    const list = parseModelList({
      data: [
        { id: "oc/muse", capabilities: { audioInput: true, vision: true } },
        { id: "glm", capabilities: { audioInput: false } },
        { id: "or/gemini", architecture: { input_modalities: ["text", "image", "audio"] } },
        { id: "plain" },
      ],
    });
    expect(list.map((m) => m.hints?.audioInput)).toEqual([true, false, true, undefined]);
  });

  it("chat models on LLM accounts get the speech-option subset as member params", () => {
    expect(validateMemberParams("asr", "openai-compatible", { language: "zh-TW", diarization: true, max_chunk_sec: 300 }).issues).toEqual([]);
    expect(validateMemberParams("asr", "gemini", { word_timestamps: true }).issues).toHaveLength(1);
  });
});

describe("codec audio blocks", () => {
  it("openai-chat: input_audio with format; Mistral bare string; DashScope data URL", () => {
    const out = toOpenAiMessages(msgs) as Array<{ content: unknown }>;
    expect(out[1]!.content).toEqual([{ type: "text", text: "逐字稿" }, { type: "input_audio", input_audio: { data: "SUQzAAAA", format: "mp3" } }]);
    expect(inputAudioPart(AUDIO, "string")).toEqual({ type: "input_audio", input_audio: "SUQzAAAA" });
    expect(inputAudioPart({ ...AUDIO, source: { ...AUDIO.source, mediaType: "audio/wav" } }, "data_url")).toEqual({ type: "input_audio", input_audio: { data: "data:audio/wav;base64,SUQzAAAA", format: "wav" } });
    expect(getProvider("mistral")!.quirks.audioInputStyle).toBe("string");
  });
  it("gemini: inlineData part", () => {
    expect(toGeminiContents(msgs)[0]!.parts).toEqual([{ text: "逐字稿" }, { inlineData: { mimeType: "audio/mpeg", data: "SUQzAAAA" } }]);
  });
  it("other protocols refuse audio with `unsupported` instead of dropping it", () => {
    expect(hasAudio(msgs)).toBe(true);
    const ctx = (id: string) => ({ entry: getProvider(id)!, config: {}, secrets: {}, quirks: {} }) as unknown as CodecContext;
    expect(() => buildAnthropicBody(ctx("anthropic"), { model: "claude", messages: msgs, maxTokens: 10 }, false)).toThrow(expect.objectContaining({ code: "unsupported" }));
    expect(() => buildResponsesBody(ctx("openai"), { model: "gpt-5", messages: msgs })).toThrow(expect.objectContaining({ code: "unsupported" }));
    expect(() => ensureAudioSupported(ctx("gemini"), { model: "g", messages: msgs }, "gemini")).not.toThrow();
    // Text-only requests are unaffected.
    expect(toAnthropicMessages([{ role: "user", content: "hi" }])).toHaveLength(1);
  });
});

describe("LLM transcript parsing", () => {
  it("parses times in seconds and clock formats", () => {
    expect([parseTime(3.5), parseTime("12.5"), parseTime("01:23.5"), parseTime("1:02:03"), parseTime("7s"), parseTime("x"), parseTime(-1)]).toEqual([3.5, 12.5, 83.5, 3723, 7, undefined, undefined]);
  });

  it("clean JSON → segments with speakers, language and the approximate-timestamps warning", () => {
    const r = parseLlmTranscript(
      JSON.stringify({ language: "zh-TW", segments: [{ start: 0.4, end: 3.1, speaker: "S1", text: "我們先看 baseline。" }, { start: "00:03.5", end: "00:06", speaker: "Speaker 2", text: "好，WER 是 12%。" }] }),
      30,
      { diarize: true },
    );
    expect(r.segments).toEqual([
      { start: 0.4, end: 3.1, text: "我們先看 baseline。", speaker: "S1", confidence: null, language: null },
      { start: 3.5, end: 6, text: "好，WER 是 12%。", speaker: "S2", confidence: null, language: null },
    ]);
    expect(r.language).toBe("zh-TW");
    expect(r.text).toBe("我們先看 baseline。好，WER 是 12%。");
    expect(r.warnings).toEqual(["timestamps_approximate"]);
  });

  it("repairs fenced and truncated JSON (cut at the last complete segment)", () => {
    const truncated = '```json\n{"language":"zh","segments":[{"start":0,"end":2,"text":"第一句"},{"start":2,"end":4,"text":"第二句"},{"start":4,"end":';
    expect(parseJsonAnswer(truncated)).toMatchObject({ repaired: true });
    const r = parseLlmTranscript(truncated, 10, { diarize: false });
    expect(r.segments.map((s) => s.text)).toEqual(["第一句", "第二句"]);
    expect(r.coveredSec).toBe(4);
    expect(parseLlmTranscript("<think>hmm</think>\n```json\n[{\"start\":1,\"end\":2,\"text\":\"嗨\"}]\n```", 5, { diarize: false }).segments).toHaveLength(1);
  });

  it("accepts timestamped lines and plain text", () => {
    const lines = parseLlmTranscript("[00:01] S1: 大家好\n[00:04 - 00:07] S2: 今天報告 RAG", 10, { diarize: true });
    expect(lines.segments.map((s) => [s.start, s.end, s.speaker, s.text])).toEqual([
      [1, 4, "S1", "大家好"],
      [4, 7, "S2", "今天報告 RAG"],
    ]);
    const plain = parseLlmTranscript("這是一段沒有時間戳的文字", 8, { diarize: false });
    expect(plain.segments).toEqual([expect.objectContaining({ start: 0, end: 8, text: "這是一段沒有時間戳的文字" })]);
    expect(plain.warnings).toContain("no_timestamps");
    expect(parseLlmTranscript('{"language":null,"segments":[]}', 8, { diarize: false }).segments).toEqual([]);
  });

  it("makes timestamps monotonic, clamps them to the clip, rescales a model that used another clock", () => {
    const r = parseLlmTranscript(JSON.stringify({ segments: [{ start: 5, end: 3, text: "a" }, { start: 2, end: 9, text: "b" }, { start: 12, text: "c" }] }), 10, { diarize: false });
    for (let i = 1; i < r.segments.length; i++) expect(r.segments[i]!.start).toBeGreaterThanOrEqual(r.segments[i - 1]!.start);
    for (const s of r.segments) {
      expect(s.end).toBeGreaterThan(s.start);
      expect(s.end).toBeLessThanOrEqual(10);
    }
    // Absolute meeting time (e.g. 600–620 s) in a 20 s clip is rescaled onto the clip.
    const abs = parseLlmTranscript(JSON.stringify({ segments: [{ start: 600, end: 610, text: "x" }, { start: 610, end: 620, text: "y" }] }), 20, { diarize: false });
    expect(abs.segments.at(-1)!.end).toBeLessThanOrEqual(20);
  });

  it("trims decoding loops", () => {
    expect(collapseLoops("我們我們我們我們我們我們開始")).toEqual({ text: "我們開始", changed: true });
    const loop = parseLlmTranscript(JSON.stringify({ segments: Array.from({ length: 6 }, (_, i) => ({ start: i, end: i + 1, text: "謝謝大家" })) }), 10, { diarize: false });
    expect(loop.segments).toHaveLength(2);
    expect(loop.warnings).toContain("repetition_trimmed");
  });

  it("prompt asks for Traditional Chinese JSON segments with the glossary and context", () => {
    const p = buildTranscribePrompt({ durationSec: 600, language: "zh-TW", extraLanguages: ["en"], diarize: true, keyterms: ["Conformer", "WER"], prompt: "上一段：好，我們繼續" });
    expect(p.system).toMatch(/繁體中文/);
    expect(p.system).toMatch(/600 seconds/);
    expect(p.system).toMatch(/"speaker":"S1"/);
    expect(p.user).toMatch(/Conformer, WER/);
    expect(p.user).toMatch(/do NOT transcribe/);
    expect(answerBudget(600, 16384)).toBe(15512);
    expect(answerBudget(600, 8192)).toBe(8192);
  });
});

describe("LLM adapter through the ASR orchestrator", () => {
  let dir: string;
  let src: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "asr-llm-"));
    src = join(dir, "meeting.mp3");
    await writeFile(src, "fake-mp3");
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // Chunks are written as "chunk:<start>-<end>" so the fake model knows which part it got.
  const tools: MediaTools = {
    probe: async () => ({ durationSec: 1300, sizeBytes: 1 }),
    silences: async () => [],
    extract: async (_in, out, _fmt, range) => writeFile(out, `chunk:${range?.start}-${range?.end}`),
  };
  const partOf = (req: Parameters<LlmChatFn>[0]) => {
    const audio = (req.messages[1]!.content as Array<{ type: string; source?: { data: string } }>).find((b) => b.type === "audio")!;
    const [a, b] = Buffer.from(audio.source!.data, "base64").toString().replace("chunk:", "").split("-").map(Number);
    return { start: a!, end: b! };
  };

  it("chunks at ≤ 10 min, offsets times, drops the overlap duplicate, converts to Traditional script", async () => {
    const seen: Array<{ start: number; end: number }> = [];
    const chat: LlmChatFn = async (req) => {
      const part = partOf(req);
      seen.push(part);
      const len = part.end - part.start;
      // Each part: one line at its start, one near its end (which the next part repeats at its own start).
      const segs = [
        { start: 0.5, end: 3, speaker: "S1", text: `第${seen.length}段开始` },
        { start: len - 2.4, end: len - 0.2, speaker: "S2", text: `接缝${seen.length}` },
      ];
      if (seen.length > 1) segs.unshift({ start: 0, end: 0.4, speaker: "S2", text: `接缝${seen.length - 1}` });
      return { text: JSON.stringify({ language: "zh-TW", segments: segs }), stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 20 } };
    };
    const usage = {};
    const adapter = llmAsrAdapter({ chat, codec: "gemini", usage });
    const t = await transcribe({ kind: "llm_audio", fields: {}, model: "gemini-2.5-flash" }, { audio: { path: src }, language: "zh-TW", diarize: true, convertScript: "s2twp" }, { adapter, tools, retryBaseMs: 1 });
    expect(seen.length).toBe(3);
    expect(Math.max(...seen.map((p) => p.end - p.start))).toBeLessThanOrEqual(600);
    const starts = t.segments.map((s) => s.start);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    // The seam line is kept once (from the earlier part).
    expect(t.segments.filter((s) => s.text === "接縫1")).toHaveLength(1);
    expect(t.segments[0]).toMatchObject({ start: 0.5, text: "第1段開始" });
    expect(t.warnings).toEqual(expect.arrayContaining(["timestamps_approximate", "chunked", "speaker_labels_per_chunk", "script_converted"]));
    expect(t.source.chunks).toHaveLength(3);
    expect(usage).toEqual({ inputTokens: 300, outputTokens: 60 });
  });

  it("a truncated answer re-plans the part at half the length", async () => {
    let calls = 0;
    const chat: LlmChatFn = async (req) => {
      calls++;
      const part = partOf(req);
      if (part.end - part.start > 400) return { text: '{"segments":[{"start":0,"end":5,"text":"只寫到這裡"},{"start":5,', stopReason: "max_tokens", usage: {} };
      return { text: JSON.stringify({ segments: [{ start: 1, end: 2, text: `第${calls}次` }] }), stopReason: "end_turn", usage: {} };
    };
    const shortTools: MediaTools = { ...tools, probe: async () => ({ durationSec: 700, sizeBytes: 1 }) };
    const t = await transcribe({ kind: "llm_audio", fields: {}, model: "m" }, { audio: { path: src }, language: "zh-TW" }, { adapter: llmAsrAdapter({ chat, codec: "openai-chat" }), tools: shortTools, retryBaseMs: 1 });
    expect(t.segments.length).toBeGreaterThanOrEqual(2);
    expect(t.source.chunks.every((c) => c.duration <= 400)).toBe(true);
  });
});

describe.skipIf(!hasTestDb)("asr role bound to multimodal chat models", () => {
  let t: TestContext;
  let admin: { id: string; cookie: string };
  let platform: AiPlatform;
  let dir: string;
  let clip: string;
  const GW = new MockServer();
  const GEM = new MockServer();
  const ASR = new MockServer();
  let earDown = false;
  const ids: Record<string, string> = {};
  const json = (r: LightMyRequestResponse) => r.json() as Record<string, any>;
  const send = (method: "POST" | "PUT" | "PATCH", url: string, payload: object) => t.app.inject({ method, url, headers: { origin: ORIGIN, cookie: admin.cookie }, payload });
  const get = (url: string) => t.app.inject({ method: "GET", url, headers: { cookie: admin.cookie } });
  const answer = JSON.stringify({ language: "zh-TW", segments: [{ start: 0.2, end: 2.5, speaker: "S1", text: "今天讨论 Conformer。" }, { start: 2.8, end: 5, speaker: "S2", text: "好的。" }] });
  const tools: MediaTools = {
    probe: async () => ({ durationSec: 30, sizeBytes: 8 }),
    silences: async () => [],
    extract: async () => {
      throw new Error("no transcode expected for mp3 input");
    },
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "asr-llm-db-"));
    clip = join(dir, "clip.mp3");
    await writeFile(clip, "fake-mp3-bytes");
    await GW.start();
    GW.on("GET", "/v1/models", { body: { data: [{ id: "ear", capabilities: { audioInput: true } }, { id: "text-only", capabilities: { audioInput: false } }, { id: "whisper-1" }] } });
    GW.on("POST", "/v1/chat/completions", (req) =>
      earDown
        ? { status: 503, body: { error: { message: "busy" } } }
        : {
            chunks: sse([
              { choices: [{ index: 0, delta: { role: "assistant", content: answer } }] },
              { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
              { choices: [], usage: { prompt_tokens: 900, completion_tokens: 80 } },
            ]),
          },
    );
    await GEM.start();
    GEM.on("GET", "/v1beta/models", { body: { models: [{ name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"], inputTokenLimit: 1048576, outputTokenLimit: 65536 }] } });
    GEM.on("POST", "/v1beta/models/gemini-2.5-flash:streamGenerateContent", {
      chunks: sse([{ candidates: [{ content: { role: "model", parts: [{ text: answer }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 960, candidatesTokenCount: 70 } }], false),
    });
    await ASR.start();
    ASR.on("GET", "/health", { body: { status: "ok" } });
    ASR.on("POST", "/v1/audio/transcriptions", { body: { text: "備援轉錄", language: "zh", duration: 30, segments: [{ start: 0, end: 3, text: "備援轉錄" }] } });

    t = await createTestContext();
    admin = await t.ownerCookie();
    platform = new AiPlatform(t.db, t.app.log, { asrDeps: { tools, retryBaseMs: 1 }, snapshotTtlMs: 0, sleep: async () => {} });
    ids.gw = json(await send("POST", "/api/admin/ai/providers", { family: "llm", kind: "openai-compatible", name: "閘道", config: { baseUrl: `${GW.url}/v1` }, secrets: { apiKey: "k" } })).provider.id;
    ids.gem = json(await send("POST", "/api/admin/ai/providers", { family: "llm", kind: "gemini", name: "Gemini", config: { baseUrl: `${GEM.url}/v1beta` }, secrets: { apiKey: "g" } })).provider.id;
    ids.asr = json(await send("POST", "/api/admin/ai/providers", { family: "asr", kind: "speaches", name: "Whisper", config: { base_url: ASR.url }, secrets: {} })).provider.id;
    for (const p of [ids.gw, ids.gem]) await send("POST", `/api/admin/ai/providers/${p}/sync`, {});
    const models = json(await get("/api/admin/ai/models")).models as Array<{ id: string; model_id: string }>;
    for (const m of models) ids[m.model_id] = m.id;
  });
  afterAll(async () => {
    await platform?.stop();
    await t?.close();
    await Promise.all([GW.stop(), GEM.stop(), ASR.stop()]);
    await rm(dir, { recursive: true, force: true });
  });

  it("profiles report audio input; only audio-capable chat models bind to asr, never to asr_live", async () => {
    const models = json(await get("/api/admin/ai/models")).models as Array<Record<string, any>>;
    expect(models.find((m) => m.model_id === "ear")).toMatchObject({ fields: { audio_input: true, capability: "chat" }, sources: { audio_input: "provider_api" }, audio: { audio: true, codec_ok: true } });
    expect(models.find((m) => m.model_id === "gemini-2.5-flash")).toMatchObject({ audio: { audio: true, source: "catalog" } });
    const reg = json(await get("/api/admin/ai/registry"));
    expect(reg.platform_params.asr_llm.map((f: { key: string }) => f.key)).toContain("max_chunk_sec");

    const bad = await send("PUT", "/api/admin/ai/bindings", { roles: ["asr"], target: { model_id: ids["text-only"] } });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);
    expect(json(bad)).toMatchObject({ code: "capability_mismatch" });
    expect(json(bad).error).toMatch(/音訊輸入/);
    // A Whisper model listed by a chat gateway: the message points to an ASR account instead of contradicting itself.
    const whisper = await send("PUT", "/api/admin/ai/bindings", { roles: ["asr"], target: { model_id: ids["whisper-1"] } });
    expect(json(whisper).code).toBe("capability_mismatch");
    expect(json(whisper).error).toContain("語音轉文字」帳號");
    const live = await send("PUT", "/api/admin/ai/bindings", { roles: ["asr_live"], target: { model_id: ids.ear } });
    expect(json(live).code).toBe("route_invalid");
    // The admin can turn audio input on by hand (e.g. a new model the listing does not describe).
    const patched = json(await send("PATCH", `/api/admin/ai/models/${ids["text-only"]}`, { overrides: { audio_input: true } }));
    expect(patched.model).toMatchObject({ fields: { audio_input: true }, audio: { source: "override" } });
    expect((await send("PUT", "/api/admin/ai/bindings", { roles: ["asr"], target: { model_id: ids["text-only"] } })).statusCode).toBe(200);
    // Binding did not turn the chat model into an "asr" model.
    expect(json(await get("/api/admin/ai/models")).models.find((m: { model_id: string }) => m.model_id === "text-only").fields.capability).toBe("chat");
  });

  it("openai-compatible: sends input_audio + JSON instructions, returns a unified Traditional-Chinese transcript", async () => {
    await send("PUT", "/api/admin/ai/bindings", { roles: ["asr"], target: { model_id: ids.ear }, params: { language: "zh-TW", diarization: true } });
    platform.invalidate();
    GW.requests.length = 0;
    const tr = await platform.transcribe({ audio: { path: clip }, durationSec: 30 }, { glossary: ["Conformer", "WER"] });
    const body = GW.requests.find((r) => r.path === "/v1/chat/completions")!.json;
    expect(body.model).toBe("ear");
    expect(body.messages[0]).toMatchObject({ role: "system" });
    const parts = body.messages[1].content as Array<Record<string, any>>;
    expect(parts.find((p) => p.type === "input_audio")).toEqual({ type: "input_audio", input_audio: { data: Buffer.from("fake-mp3-bytes").toString("base64"), format: "mp3" } });
    expect(parts.find((p) => p.type === "text")!.text).toMatch(/Conformer, WER/);
    expect(tr.segments.map((s) => s.text)).toEqual(["今天討論 Conformer。", "好的。"]);
    expect(tr.speakers.length).toBe(2);
    expect(tr.warnings).toEqual(expect.arrayContaining(["timestamps_approximate", "script_converted"]));
    expect(tr.route).toMatchObject({ role: "asr", model: "ear", providerKind: "openai-compatible" });
    await platform.logger.flush();
    const row = (await t.db.query("SELECT capability, model, ok, tokens_in, tokens_out FROM ai_call_log WHERE role='asr' ORDER BY started_at DESC LIMIT 1")).rows[0];
    expect(row).toMatchObject({ capability: "asr", model: "ear", ok: true, tokens_in: 900, tokens_out: 80 });
  });

  it("gemini: inlineData audio part + JSON mode", async () => {
    await send("PUT", "/api/admin/ai/bindings", { roles: ["asr"], target: { model_id: ids["gemini-2.5-flash"] } });
    platform.invalidate();
    const tr = await platform.transcribe({ audio: { path: clip }, durationSec: 30, language: "zh-TW" });
    const body = GEM.requests.find((r) => r.path.endsWith(":streamGenerateContent"))!.json;
    expect(body.contents[0].parts).toEqual(expect.arrayContaining([{ inlineData: { mimeType: "audio/mpeg", data: Buffer.from("fake-mp3-bytes").toString("base64") } }]));
    expect(body.generationConfig).toMatchObject({ responseMimeType: "application/json", temperature: 0 });
    expect(body.systemInstruction.parts[0].text).toMatch(/Traditional Chinese/);
    expect(tr.segments[0]!.text).toBe("今天討論 Conformer。");
  });

  it("a fallback group mixes a multimodal model and a dedicated ASR (Gemini/LLM → Whisper)", async () => {
    const g = await send("POST", "/api/admin/ai/groups", { name: "語音備援", capability: "asr", strategy: "fallback", members: [{ model_id: ids.ear }, { provider_id: ids.asr, model: "large-v3" }] });
    expect(g.statusCode).toBe(201);
    expect((await send("PUT", "/api/admin/ai/bindings", { roles: ["asr"], target: { group_id: json(g).group.id } })).statusCode).toBe(200);
    platform.invalidate();
    earDown = true;
    const tr = await platform.transcribe({ audio: { path: clip }, durationSec: 30, language: "zh-TW" });
    earDown = false;
    expect(tr.route).toMatchObject({ providerKind: "speaches", fallbackIndex: 1 });
    expect(tr.segments[0]!.text).toBe("備援轉錄");
    expect(tr.warnings).not.toContain("timestamps_approximate");
    await platform.logger.flush();
    const rows = (await t.db.query("SELECT model, ok, error_code, final FROM ai_call_log WHERE role='asr' ORDER BY started_at DESC LIMIT 2")).rows;
    expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ model: "ear", ok: false }), expect.objectContaining({ model: "large-v3", ok: true, final: true })]));

    // Every member down → llm_unavailable (ai-worker waits and resumes).
    ASR.on("POST", "/v1/audio/transcriptions", { status: 503, body: { error: "down" } });
    (ASR as unknown as { routes: Array<{ handler: unknown }> }).routes.reverse();
    earDown = true;
    const err = await platform.transcribe({ audio: { path: clip }, durationSec: 30 }).catch((e) => e);
    earDown = false;
    expect(err.code).toBe("llm_unavailable");
  });
});
