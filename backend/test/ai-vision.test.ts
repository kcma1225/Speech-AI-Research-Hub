/** Vision (image input): detection + override, codec image mapping, image-aware routing, status flag. */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LightMyRequestResponse } from "fastify";
import { toAnthropicMessages } from "../src/ai/codecs/anthropic-messages.js";
import { toConverseMessages } from "../src/ai/codecs/bedrock-converse.js";
import { toCohereMessages } from "../src/ai/codecs/cohere.js";
import { toGeminiContents } from "../src/ai/codecs/gemini.js";
import { toOllamaMessages } from "../src/ai/codecs/ollama-native.js";
import { parseModelList, toOpenAiMessages } from "../src/ai/codecs/openai-chat.js";
import { toResponsesInput } from "../src/ai/codecs/openai-responses.js";
import { aiFor, type AiPlatform } from "../src/ai/platform/index.js";
import { detectVision, hasImages, modelVision } from "../src/ai/platform/vision.js";
import { resolveProfile } from "../src/ai/platform/models.js";
import { validateMemberParams } from "../src/ai/platform/params.js";
import type { ProfileFields } from "../src/ai/catalog/index.js";
import type { ChatMessage } from "../src/ai/types.js";
import { createTestContext, hasTestDb, ORIGIN, type TestContext } from "./helpers.js";
import { MockServer, sse } from "./ai-providers-mock.js";

process.env.PROVIDER_TOKEN_KEY ??= randomBytes(32).toString("base64");

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const msgs: ChatMessage[] = [
  { role: "system", content: "sys" },
  {
    role: "user",
    content: [
      { type: "text", text: "看這張" },
      { type: "image", source: { kind: "base64", mediaType: "image/png", data: PNG } },
      { type: "image", source: { kind: "base64", mediaType: "image/webp", data: "UklGRg==" } },
    ],
  },
];

describe("vision detection", () => {
  const p = (kind: string) => ({ kind });
  const prof = (model: string, api: ProfileFields = {}, overrides: ProfileFields = {}) => resolveProfile({ family: "llm" }, { model_id: model, api, overrides });
  it("prefers the manual profile value, then the model listing, then the catalog, then the name, then the vendor", () => {
    expect(detectVision(p("openai-compatible"), "glm/glm-5.3-flash", prof("glm/glm-5.3-flash", { vision: true }))).toEqual({ detected: true, source: "model_list" });
    expect(detectVision(p("openai-compatible"), "glm/glm-5-turbo", prof("glm/glm-5-turbo", { vision: false }))).toEqual({ detected: false, source: "model_list" });
    // The listing beats the catalog and the name heuristic.
    expect(detectVision(p("openai-compatible"), "gpt-4o-x", prof("gpt-4o-x", { vision: false })).detected).toBe(false);
    expect(detectVision(p("openai-compatible"), "gpt-4o-mini", prof("gpt-4o-mini"))).toEqual({ detected: true, source: "catalog" });
    expect(detectVision(p("openai-compatible"), "qwen2.5-vl-7b", null)).toEqual({ detected: true, source: "name" });
    expect(detectVision(p("openai-compatible"), "llama3.1:8b", prof("llama3.1:8b"))).toEqual({ detected: false, source: "catalog" });
    expect(detectVision(p("openai-compatible"), "my-finetune", prof("my-finetune"))).toEqual({ detected: false, source: "unknown" });
    expect(detectVision(p("openai"), "o3-mini", prof("o3-mini")).detected).toBe(false);
    expect(detectVision(p("anthropic"), "some-future-model", prof("some-future-model"))).toEqual({ detected: true, source: "vendor" });
    expect(detectVision(p("claude-cli"), "claude-sonnet-4", prof("claude-sonnet-4"))).toEqual({ detected: false, source: "vendor" });
    expect(modelVision(p("openai-compatible"), "llama3.1:8b", prof("llama3.1:8b", {}, { vision: true }))).toMatchObject({ vision: true, source: "override", overridden: true });
    expect(modelVision(p("openai-compatible"), "glm/glm-5.3-flash", prof("glm/glm-5.3-flash", { vision: true }, { vision: false }))).toMatchObject({ vision: false, overridden: true });
  });

  it("vision is no longer a member param; gateway capability hints are read from listings", () => {
    expect(validateMemberParams("chat", "openai-compatible", { vision: "yes" }).issues).toHaveLength(1);
    const list = parseModelList({ data: [{ id: "glm/glm-5.3-flash", capabilities: { vision: true, tools: true } }, { id: "glm/glm-5", capabilities: { vision: false } }] });
    expect(list.map((m) => m.hints?.vision)).toEqual([true, false]);
  });

  it("detects images in user content and tool results", () => {
    expect(hasImages(msgs)).toBe(true);
    expect(hasImages([{ role: "user", content: "hi" }])).toBe(false);
    expect(hasImages([{ role: "tool", content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "image", source: { kind: "url", url: "https://x/y.png" } }] }] }])).toBe(true);
  });
});

describe("codec image mapping", () => {
  it("openai-chat: image_url data URLs in order", () => {
    const out = toOpenAiMessages(msgs) as Array<{ role: string; content: unknown }>;
    expect(out[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "看這張" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } },
        { type: "image_url", image_url: { url: "data:image/webp;base64,UklGRg==" } },
      ],
    });
  });
  it("openai-responses: input_image", () => {
    const { input } = toResponsesInput(msgs);
    expect(input[0]).toEqual({ role: "user", content: [{ type: "input_text", text: "看這張" }, { type: "input_image", image_url: `data:image/png;base64,${PNG}` }, { type: "input_image", image_url: "data:image/webp;base64,UklGRg==" }] });
  });
  it("anthropic: base64 source blocks", () => {
    const out = toAnthropicMessages(msgs);
    expect(out[0]!.content).toEqual([
      { type: "text", text: "看這張" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
      { type: "image", source: { type: "base64", media_type: "image/webp", data: "UklGRg==" } },
    ]);
  });
  it("gemini: inlineData parts", () => {
    const out = toGeminiContents(msgs);
    expect(out[0]!.parts).toEqual([{ text: "看這張" }, { inlineData: { mimeType: "image/png", data: PNG } }, { inlineData: { mimeType: "image/webp", data: "UklGRg==" } }]);
  });
  it("bedrock: image bytes with format", () => {
    const out = toConverseMessages(msgs, "bedrock") as Array<{ content: unknown[] }>;
    expect(out[0]!.content).toEqual([{ text: "看這張" }, { image: { format: "png", source: { bytes: PNG } } }, { image: { format: "webp", source: { bytes: "UklGRg==" } } }]);
    expect(() => toConverseMessages([{ role: "user", content: [{ type: "image", source: { kind: "url", url: "https://x/a.png" } }] }], "bedrock")).toThrow();
  });
  it("ollama: images array of raw base64", () => {
    const out = toOllamaMessages(msgs, "ollama") as Array<Record<string, unknown>>;
    expect(out.find((m) => m.role === "user")).toEqual({ role: "user", content: "看這張", images: [PNG, "UklGRg=="] });
  });
  it("cohere: image_url parts", () => {
    const out = toCohereMessages(msgs) as Array<{ role: string; content: unknown }>;
    expect(out.find((m) => m.role === "user")!.content).toEqual([
      { type: "text", text: "看這張" },
      { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } },
      { type: "image_url", image_url: { url: "data:image/webp;base64,UklGRg==" } },
    ]);
  });
});

describe.skipIf(!hasTestDb)("image-aware routing", () => {
  let t: TestContext;
  let admin: { id: string; cookie: string };
  let student: { id: string; cookie: string };
  let platform: AiPlatform;
  const S = new MockServer();
  const json = (r: LightMyRequestResponse) => r.json() as Record<string, any>;
  const send = (method: "POST" | "PUT", url: string, payload: object) => t.app.inject({ method, url, headers: { origin: ORIGIN, cookie: admin.cookie }, payload });
  const get = (who: { cookie: string }, url: string) => t.app.inject({ method: "GET", url, headers: { cookie: who.cookie } });
  const ok = (text: string) => ({ chunks: sse([{ choices: [{ index: 0, delta: { role: "assistant", content: text } }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }]) });
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    await S.start();
    S.on("GET", "/v1/models", { body: { data: [{ id: "text-only", capabilities: { vision: false } }, { id: "seer", capabilities: { vision: true } }] } });
    S.on("POST", "/v1/chat/completions", (req) => ok(`來自 ${req.json.model}`));
    t = await createTestContext();
    platform = aiFor(t.app);
    admin = await t.ownerCookie();
    student = await t.login("student", "Stu");
    const p = await send("POST", "/api/admin/ai/providers", { family: "llm", kind: "openai-compatible", name: "閘道", config: { baseUrl: `${S.url}/v1` }, secrets: { apiKey: "k" } });
    ids.p = json(p).provider.id;
  });
  afterAll(async () => {
    await platform?.logger.flush();
    await t?.close();
    await S.stop();
  });

  it("stores the listing as model profiles on test and reports detection", async () => {
    const r = json(await send("POST", `/api/admin/ai/providers/${ids.p}/test`, {}));
    expect(r.models).toEqual(expect.arrayContaining([expect.objectContaining({ id: "seer", vision: true })]));
    expect(r.models_synced).toBe(2);
    const models = json(await get(admin, `/api/admin/ai/models?provider_id=${ids.p}`)).models;
    ids.seer = models.find((m: { model_id: string }) => m.model_id === "seer").id;
    ids.text = models.find((m: { model_id: string }) => m.model_id === "text-only").id;
    expect(models.find((m: { model_id: string }) => m.model_id === "seer")).toMatchObject({ fields: { vision: true }, sources: { vision: "provider_api" } });
    expect(json(await get(admin, `/api/admin/ai/vision?provider_id=${ids.p}&model=seer`))).toEqual({ detected: true, source: "model_list" });
    expect(json(await get(admin, `/api/admin/ai/vision?provider_id=${ids.p}&model=text-only`))).toEqual({ detected: false, source: "model_list" });
    expect((await get(student, `/api/admin/ai/vision?provider_id=${ids.p}&model=seer`)).statusCode).toBe(403);
  });

  it("sends image requests only to members with vision; text requests keep the order", async () => {
    const group = await send("POST", "/api/admin/ai/groups", { name: "視覺備援", capability: "chat", strategy: "fallback", members: [{ model_id: ids.text }, { model_id: ids.seer }] });
    expect(group.statusCode).toBe(201);
    ids.group = json(group).group.id;
    expect((await send("PUT", "/api/admin/ai/bindings", { roles: ["slides"], target: { group_id: ids.group } })).statusCode).toBe(200);

    S.requests.length = 0;
    const text = await platform.chat("slides", { messages: [{ role: "user", content: "hi" }] });
    expect(text.text).toBe("來自 text-only");
    const img = await platform.chat("slides", { messages: msgs });
    expect(img.text).toBe("來自 seer");
    expect(img.route).toMatchObject({ model: "seer", fallbackIndex: 1 });
    const sent = S.requests.filter((q) => q.path === "/v1/chat/completions").map((q) => q.json.model);
    expect(sent).toEqual(["text-only", "seer"]);
    await platform.logger.flush();
    const log = (await t.db.query("SELECT error_code FROM ai_call_log WHERE role='slides'")).rows.map((r) => r.error_code);
    expect(log).not.toContain("no_vision");

    expect(await platform.capabilities("slides")).toEqual({ vision: true });
    const st = json(await get(student, "/api/ai/status"));
    expect(st.roles.slides).toMatchObject({ state: "ok", vision: true });
    expect(st.roles.assistant.vision).toBe(false);
  });

  it("fails with vision_unavailable (not llm_unavailable) when no member takes images; override fixes it", async () => {
    await send("PUT", `/api/admin/ai/groups/${ids.group}`, { name: "視覺備援", capability: "chat", strategy: "fallback", members: [{ model_id: ids.text }] });
    await platform.recompute();
    expect(await platform.capabilities("slides")).toEqual({ vision: false });
    const err = await platform.chat("slides", { messages: msgs }).catch((e) => e);
    expect(err.code).toBe("vision_unavailable");
    expect(err.status).toBe(422);
    // The role is not marked down by an image request it cannot serve.
    expect((await platform.recompute()).find((s) => s.role === "slides")?.state).toBe("ok");

    // Manual profile override (per model, not per member).
    const patched = await t.app.inject({ method: "PATCH", url: `/api/admin/ai/models/${ids.text}`, headers: { origin: ORIGIN, cookie: admin.cookie }, payload: { overrides: { vision: true } } });
    expect(json(patched).model).toMatchObject({ fields: { vision: true }, sources: { vision: "manual" }, vision: { source: "override" } });
    await platform.recompute();
    expect(await platform.capabilities("slides")).toEqual({ vision: true });
    expect((await platform.chat("slides", { messages: msgs })).text).toBe("來自 text-only");
  });
});
