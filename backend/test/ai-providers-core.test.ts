import { describe, expect, it } from "vitest";
import {
  AI_ERROR_CODES,
  AiError,
  aggregateChat,
  classifyHttpError,
  CODECS,
  createClient,
  listProviders,
  parseRetryAfter,
  publicProviders,
  registerProvider,
  getProvider,
  secretKeys,
  validateAccount,
  type ChatEvent,
} from "../src/ai/providers/index.js";

const SPEC_VENDORS = [
  "openai", "anthropic", "gemini", "vertex", "azure", "bedrock", "mistral", "deepseek", "xai", "groq", "cohere", "together",
  "fireworks", "openrouter", "perplexity", "cerebras", "dashscope-intl", "dashscope-cn", "zhipu", "moonshot", "voyage", "jina",
  "vllm", "ollama", "lmstudio", "llamacpp", "sglang", "tgi", "localai", "tei", "openai-compatible",
];

describe("errors", () => {
  it("every code has 繁中 message + hint and a retryable flag", () => {
    for (const [code, info] of Object.entries(AI_ERROR_CODES)) {
      expect(info.message_zh, code).toMatch(/[一-鿿]/);
      expect(info.hint_zh, code).toMatch(/[一-鿿]/);
      expect(typeof info.retryable).toBe("boolean");
    }
    const e = new AiError("rate_limited", { retryAfterMs: 5, vendorMessage: "secret prompt? no" });
    expect(e.toResponse()).toEqual({ error: AI_ERROR_CODES.rate_limited.message_zh, code: "rate_limited", hint: AI_ERROR_CODES.rate_limited.hint_zh });
    expect(e.retryable).toBe(true);
  });

  it("parses Retry-After forms", () => {
    expect(parseRetryAfter(new Headers({ "retry-after": "1.5" }))).toBe(1500);
    expect(parseRetryAfter(new Headers({ "retry-after-ms": "250" }))).toBe(250);
    expect(parseRetryAfter(new Headers({ "retry-after": new Date(10_000).toUTCString() }), 4_000)).toBe(6000);
    expect(parseRetryAfter(new Headers())).toBeUndefined();
  });

  it.each([
    [402, {}, "quota_exhausted"],
    [403, { error: { message: "Input flagged by moderation", metadata: {} } }, "content_filtered"],
    [403, { error: { message: "Permission denied: API key invalid" } }, "auth_failed"],
    [413, {}, "context_too_long"],
    [498, {}, "overloaded"],
    [529, {}, "overloaded"],
    [504, {}, "timeout"],
    [400, { error: { code: "data_inspection_failed", message: "Input data may contain inappropriate content." } }, "content_filtered"],
    [422, { detail: [{ msg: "field required" }] }, "bad_request"],
  ])("classifies %i", (status, body, code) => {
    expect(classifyHttpError({ status, body }).code).toBe(code);
  });
});

describe("registry", () => {
  it("contains every vendor from the spec with consistent data", () => {
    const ids = listProviders().map((p) => p.id);
    for (const v of SPEC_VENDORS) expect(ids, v).toContain(v);
    for (const p of listProviders()) {
      expect(CODECS[p.codec], p.id).toBeDefined();
      expect(p.label.zh && p.label.en, p.id).toBeTruthy();
      expect(["external", "local"]).toContain(p.category);
      const keys = p.fields.map((f) => f.key);
      expect(new Set(keys).size, `${p.id} duplicate field`).toBe(keys.length);
      for (const f of p.fields) {
        expect(f.label.zh, `${p.id}.${f.key}`).toBeTruthy();
        if (f.type === "select") expect(f.options?.length, `${p.id}.${f.key}`).toBeGreaterThan(0);
        if (f.showIf) expect(keys, `${p.id}.${f.key} showIf`).toContain(f.showIf.key);
      }
      if (p.auth.type === "api_key" && !p.auth.optional) expect(secretKeys(p), p.id).toContain(p.auth.secretKey ?? "apiKey");
      if (p.capabilities.embeddings) expect(CODECS[p.embedCodec ?? p.codec].embed, p.id).toBeDefined();
      if (p.capabilities.chat) expect(CODECS[p.codec].chatStream, p.id).toBeDefined();
      if (!p.defaultBaseUrl && !p.resolveBaseUrl) expect(p.fields.find((f) => f.key === "baseUrl")?.required, `${p.id} needs a base URL`).toBe(true);
    }
  });

  it("publicProviders is JSON-safe and hides hooks", () => {
    const pub = publicProviders();
    const json = JSON.parse(JSON.stringify(pub));
    expect(json).toEqual(pub);
    const vertex = pub.find((p) => p.id === "vertex") as Record<string, unknown>;
    expect(vertex.resolveBaseUrl).toBeUndefined();
    expect((pub.find((p) => p.id === "zhipu")!.quirks as Record<string, unknown>).mapError).toBeUndefined();
  });

  it("validateAccount applies defaults, checks required/showIf and drops unknown keys", () => {
    const az = getProvider("azure")!;
    const r1 = validateAccount(az, { endpoint: "https://x.openai.azure.com", junk: 1 }, {});
    expect(r1.config).toMatchObject({ authMode: "api_key", apiStyle: "responses", timeoutMs: 120000 });
    expect(r1.config.junk).toBeUndefined();
    expect(r1.issues.map((i) => i.key)).toEqual(["apiKey"]);
    expect(validateAccount(az, { endpoint: "https://x", authMode: "api_key" }, {}, ["apiKey"]).issues).toEqual([]);
    const r2 = validateAccount(az, { endpoint: "ftp://x", authMode: "entra" }, {});
    expect(r2.issues.map((i) => i.key).sort()).toEqual(["clientId", "clientSecret", "endpoint", "tenantId"]);
    expect(r2.issues[0]!.message_zh).toMatch(/[一-鿿]/);
    const v = validateAccount(getProvider("vertex")!, {}, { serviceAccountJson: '{"type":"user"}' });
    expect(v.issues.map((i) => i.key)).toContain("serviceAccountJson");
  });

  it("supports registering extension providers (e.g. OAuth subscriptions)", async () => {
    registerProvider({ ...getProvider("openai")!, id: "test-oauth", auth: { type: "oauth" }, fields: [] });
    const c = createClient("test-oauth", { baseUrl: "http://127.0.0.1:1/v1" }, {}, { oauthTokenProvider: async () => "tok" });
    expect(c.entry.id).toBe("test-oauth");
    await expect(createClient("test-oauth", { baseUrl: "http://127.0.0.1:1/v1" }, {}).chat({ model: "m", messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ code: "auth_failed" });
  });

  it("missing credentials / base URL fail cleanly", async () => {
    await expect(createClient("openai", {}, {}).chat({ model: "m", messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ code: "auth_failed" });
    const p = await createClient("openai-compatible", {}, {}).probe();
    expect(p).toMatchObject({ ok: false, error: { code: "bad_request" } });
    expect(() => createClient("nope", {}, {})).toThrow(AiError);
  });
});

describe("aggregateChat", () => {
  async function* gen(evs: ChatEvent[]) {
    for (const e of evs) yield e;
  }
  it("builds the assistant message", async () => {
    const r = await aggregateChat(
      gen([
        { type: "reasoning_delta", text: "r" },
        { type: "text_delta", text: "a" },
        { type: "tool_call_start", index: 0, id: "t", name: "f" },
        { type: "tool_call_end", index: 0, id: "t", name: "f", input: { x: 1 }, argsJson: '{"x":1}' },
        { type: "usage", usage: { inputTokens: 1 } },
        { type: "usage", usage: { outputTokens: 2 } },
        { type: "done", stopReason: "tool_use", providerState: { codec: "openai-chat", data: { a: 1 } } },
      ]),
    );
    expect(r.message).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "a" },
        { type: "tool_use", id: "t", name: "f", input: { x: 1 } },
      ],
      reasoning: "r",
      providerState: { codec: "openai-chat", data: { a: 1 } },
    });
    expect(r.usage).toEqual({ inputTokens: 1, outputTokens: 2 });
  });
  it("throws error events and missing done", async () => {
    await expect(aggregateChat(gen([{ type: "error", error: new AiError("overloaded", { midStream: true }) }]))).rejects.toMatchObject({ code: "overloaded" });
    await expect(aggregateChat(gen([{ type: "text_delta", text: "a" }]))).rejects.toMatchObject({ code: "unavailable" });
  });
});
