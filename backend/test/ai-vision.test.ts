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
import { detectVision, hasImages, hintKey, memberVision } from "../src/ai/platform/vision.js";
import { validateMemberParams } from "../src/ai/platform/params.js";
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
  const p = (kind: string) => ({ id: "p1", kind });
  it("prefers the override, then the model listing, then the name, then the vendor", () => {
    const hints = new Map([[hintKey("p1", "glm/glm-5.3-flash"), true], [hintKey("p1", "glm/glm-5-turbo"), false], [hintKey("p1", "gpt-4o-x"), false]]);
    expect(detectVision(p("openai-compatible"), "glm/glm-5.3-flash", hints)).toEqual({ detected: true, source: "model_list" });
    expect(detectVision(p("openai-compatible"), "glm/glm-5-turbo", hints)).toEqual({ detected: false, source: "model_list" });
    // The listing beats the name heuristic.
    expect(detectVision(p("openai-compatible"), "gpt-4o-x", hints).detected).toBe(false);
    expect(detectVision(p("openai-compatible"), "qwen2.5-vl-7b", new Map())).toEqual({ detected: true, source: "name" });
    expect(detectVision(p("openai-compatible"), "llama3.1:8b", new Map())).toEqual({ detected: false, source: "unknown" });
    expect(detectVision(p("openai"), "o3-mini", new Map()).detected).toBe(false);
    expect(detectVision(p("anthropic"), "some-future-model", new Map())).toEqual({ detected: true, source: "vendor" });
    expect(detectVision(p("claude-cli"), "claude-sonnet-4", new Map())).toEqual({ detected: false, source: "vendor" });
    expect(memberVision(p("openai-compatible"), "llama3.1:8b", { vision: "yes" }, new Map())).toMatchObject({ vision: true, detected: false, source: "override", overridden: true });
    expect(memberVision(p("openai-compatible"), "glm/glm-5.3-flash", { vision: "no" }, hints)).toMatchObject({ vision: false, detected: true, overridden: true });
  });

  it("validates the tri-state param and reads gateway capability hints", () => {
    expect(validateMemberParams("chat", "openai-compatible", { vision: "yes" })).toEqual({ params: { vision: "yes" }, issues: [] });
    expect(validateMemberParams("chat", "openai-compatible", { vision: "maybe" }).issues).toHaveLength(1);
    expect(validateMemberParams("chat", "openai-compatible", { vision: "" }).params).toEqual({});
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

  it("stores listing hints on test and reports detection", async () => {
    const r = json(await send("POST", `/api/admin/ai/providers/${ids.p}/test`, {}));
    expect(r.models).toEqual(expect.arrayContaining([expect.objectContaining({ id: "seer", vision: true })]));
    expect(json(await get(admin, `/api/admin/ai/vision?provider_id=${ids.p}&model=seer`))).toEqual({ detected: true, source: "model_list" });
    expect(json(await get(admin, `/api/admin/ai/vision?provider_id=${ids.p}&model=text-only`))).toEqual({ detected: false, source: "model_list" });
    expect((await get(student, `/api/admin/ai/vision?provider_id=${ids.p}&model=seer`)).statusCode).toBe(403);
  });

  it("sends image requests only to members with vision; text requests keep the order", async () => {
    const route = await send("POST", "/api/admin/ai/routes", {
      name: "視覺備援",
      capability: "chat",
      strategy: "fallback",
      members: [{ provider_id: ids.p, model: "text-only" }, { provider_id: ids.p, model: "seer" }],
    });
    expect(route.statusCode).toBe(201);
    ids.route = json(route).route.id;
    expect((await send("PUT", "/api/admin/ai/roles/slides", { route_id: ids.route })).statusCode).toBe(200);
    const routes = json(await get(admin, "/api/admin/ai/routes")).routes;
    expect(routes.find((r: { id: string }) => r.id === ids.route).members.map((m: { vision: { vision: boolean } }) => m.vision.vision)).toEqual([false, true]);

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
    await send("PUT", `/api/admin/ai/routes/${ids.route}`, { name: "視覺備援", capability: "chat", strategy: "fallback", members: [{ provider_id: ids.p, model: "text-only" }] });
    await platform.recompute();
    expect(await platform.capabilities("slides")).toEqual({ vision: false });
    const err = await platform.chat("slides", { messages: msgs }).catch((e) => e);
    expect(err.code).toBe("vision_unavailable");
    expect(err.status).toBe(422);
    // The role is not marked down by an image request it cannot serve.
    expect((await platform.recompute()).find((s) => s.role === "slides")?.state).toBe("ok");

    await send("PUT", `/api/admin/ai/routes/${ids.route}`, { name: "視覺備援", capability: "chat", strategy: "fallback", members: [{ provider_id: ids.p, model: "text-only", params: { vision: "yes" } }] });
    await platform.recompute();
    expect(await platform.capabilities("slides")).toEqual({ vision: true });
    expect((await platform.chat("slides", { messages: msgs })).text).toBe("來自 text-only");
  });
});
