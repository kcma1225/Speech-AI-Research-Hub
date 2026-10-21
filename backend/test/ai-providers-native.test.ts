import { generateKeyPairSync, createVerify } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearTokenCache, createClient, getProvider, type ChatEvent, type ChatMessage, type ProviderEntry } from "../src/ai/providers/index.js";
import { encodeEventStreamMessage, EventStreamDecoder } from "../src/ai/providers/eventstream.js";
import { signSigV4 } from "../src/ai/providers/auth.js";
import { collect, MockServer, ndjsonLines, sse, sseNamed } from "./ai-providers-mock.js";

const srv = new MockServer();
beforeAll(() => srv.start());
afterAll(() => srv.stop());
beforeEach(() => {
  srv.reset();
  clearTokenCache();
});

const user = (content: string): ChatMessage => ({ role: "user", content });
const at = (id: string, over: Partial<ProviderEntry>): ProviderEntry => ({ ...getProvider(id)!, ...over });

// ---------------------------------------------------------------- Anthropic

describe("anthropic-messages codec", () => {
  const stream = sseNamed([
    ["message_start", { type: "message_start", message: { id: "msg_1", model: "claude-x", usage: { input_tokens: 12, cache_read_input_tokens: 4 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Hmm, " } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "weather." } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIG123" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["ping", { type: "ping" }],
    ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Checking." } }],
    ["content_block_stop", { type: "content_block_stop", index: 1 }],
    ["content_block_start", { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} } }],
    ["content_block_delta", { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"city": "Tai' } }],
    ["content_block_delta", { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: 'pei"}' } }],
    ["content_block_stop", { type: "content_block_stop", index: 2 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 30 } }],
    ["message_stop", { type: "message_stop" }],
  ]);

  it("streams thinking + text + tool_use and replays thinking blocks first", async () => {
    srv.once("POST", "/v1/messages", { chunks: stream });
    const c = createClient("anthropic", { baseUrl: `${srv.url}/v1`, betas: "a, b" }, { apiKey: "ant" });
    const tools = [{ name: "get_weather", inputSchema: { type: "object" } }];
    const r = await c.chat({ model: "claude-x", tools, messages: [{ role: "system", content: "S" }, user("weather?")], reasoning: { effort: "high" } });
    expect(r).toMatchObject({
      text: "Checking.",
      reasoning: "Hmm, weather.",
      stopReason: "tool_use",
      toolCalls: [{ id: "toolu_1", name: "get_weather", input: { city: "Taipei" } }],
      usage: { inputTokens: 12, outputTokens: 30, cacheReadTokens: 4 },
    });
    const req = srv.last();
    expect(req.headers["x-api-key"]).toBe("ant");
    expect(req.headers["anthropic-version"]).toBe("2023-06-01");
    expect(req.headers["anthropic-beta"]).toBe("a,b");
    expect(req.json).toMatchObject({ model: "claude-x", system: "S", max_tokens: 8192, thinking: { type: "adaptive" }, output_config: { effort: "high" }, tools: [{ name: "get_weather", input_schema: { type: "object" } }] });

    srv.once("POST", "/v1/messages", {
      chunks: sseNamed([
        ["message_start", { type: "message_start", message: { usage: { input_tokens: 1 } } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "Sunny" } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
        ["message_stop", { type: "message_stop" }],
      ]),
    });
    const r2 = await c.chat({ model: "claude-x", tools, messages: [user("weather?"), r.message, { role: "tool", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "25C", is_error: false }] }] });
    expect(r2.text).toBe("Sunny");
    expect(srv.last().json.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "weather?" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Hmm, weather.", signature: "SIG123" },
          { type: "text", text: "Checking." },
          { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Taipei" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "25C" }] },
    ]);
  });

  it("maps HTTP and mid-stream errors", async () => {
    const c = createClient("anthropic", { baseUrl: `${srv.url}/v1` }, { apiKey: "ant" });
    srv.once("POST", "/v1/messages", { status: 529, body: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } });
    await expect(c.chat({ model: "m", messages: [user("x")] })).rejects.toMatchObject({ code: "overloaded", retryable: true });
    srv.once("POST", "/v1/messages", { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 250000 tokens > 200000 maximum" } } });
    await expect(c.chat({ model: "m", messages: [user("x")] })).rejects.toMatchObject({ code: "context_too_long" });
    srv.once("POST", "/v1/messages", { status: 429, headers: { "retry-after": "3" }, body: { type: "error", error: { type: "rate_limit_error", message: "rl" } } });
    await expect(c.chat({ model: "m", messages: [user("x")] })).rejects.toMatchObject({ code: "rate_limited", retryAfterMs: 3000, retryable: true });
    srv.once("POST", "/v1/messages", { status: 429, body: { type: "error", error: { type: "rate_limit_error", message: "spend cap" } } });
    await expect(c.chat({ model: "m", messages: [user("x")] })).rejects.toMatchObject({ code: "rate_limited", retryable: false });
    srv.once("POST", "/v1/messages", {
      chunks: sseNamed([
        ["message_start", { type: "message_start", message: { usage: {} } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "par" } }],
        ["error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }],
      ]),
    });
    const events = await collect(c.chatStream({ model: "m", messages: [user("x")] }));
    expect(events.map((e) => e.type)).toEqual(["text_delta", "error"]);
    expect((events[1] as Extract<ChatEvent, { type: "error" }>).error).toMatchObject({ code: "overloaded", midStream: true, providerId: "anthropic" });
    srv.once("POST", "/v1/messages", {
      chunks: sseNamed([
        ["message_start", { type: "message_start", message: { usage: {} } }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "refusal" }, usage: { output_tokens: 0 } }],
        ["message_stop", { type: "message_stop" }],
      ]),
    });
    expect((await c.chat({ model: "m", messages: [user("x")] })).stopReason).toBe("content_filter");
  });

  it("lists models with pagination and capability hints", async () => {
    srv.once("GET", "/v1/models", { body: { data: [{ id: "claude-a", display_name: "A", max_input_tokens: 200000, max_tokens: 64000, capabilities: { image_input: { supported: true }, thinking: {} } }], has_more: true, last_id: "claude-a" } });
    srv.once("GET", "/v1/models", { body: { data: [{ id: "claude-b" }], has_more: false } });
    const models = await createClient("anthropic", { baseUrl: `${srv.url}/v1` }, { apiKey: "k" }).listModels();
    expect(models.map((m) => m.id)).toEqual(["claude-a", "claude-b"]);
    expect(models[0]).toMatchObject({ label: "A", contextWindow: 200000, maxOutputTokens: 64000, hints: { reasoning: true } });
    expect(srv.requests[1]!.url.searchParams.get("after_id")).toBe("claude-a");
  });
});

// ---------------------------------------------------------------- Gemini / Vertex

describe("gemini codec", () => {
  const gstream = sse(
    [
      { candidates: [{ content: { role: "model", parts: [{ text: "pondering", thought: true }] } }] },
      { candidates: [{ content: { role: "model", parts: [{ text: "I'll look" }] } }] },
      { candidates: [{ content: { role: "model", parts: [{ text: " it up", thoughtSignature: "TS_TEXT" }] } }] },
      {
        candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "lookup", args: { q: "x" } }, thoughtSignature: "TS_FC" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 5, thoughtsTokenCount: 3 },
        modelVersion: "gemini-x-001",
      },
    ],
    false,
  );

  it("streams thoughts/text/functionCall and replays parts with signatures", async () => {
    srv.once("POST", "/v1beta/models/gemini-x:streamGenerateContent", { chunks: gstream });
    const c = createClient("gemini", { baseUrl: `${srv.url}/v1beta` }, { apiKey: "g" });
    const tools = [{ name: "lookup", description: "d", inputSchema: { type: "object", properties: { q: { type: "string" } } } }];
    const r = await c.chat({ model: "gemini-x", tools, toolChoice: { name: "lookup" }, messages: [{ role: "system", content: "S" }, user("go")], reasoning: { effort: "low" }, maxTokens: 64 });
    expect(r).toMatchObject({ text: "I'll look it up", reasoning: "pondering", stopReason: "tool_use", usage: { inputTokens: 7, outputTokens: 8, reasoningTokens: 3 }, model: "gemini-x-001" });
    expect(r.toolCalls[0]).toMatchObject({ name: "lookup", input: { q: "x" } });
    const req = srv.last();
    expect(req.url.searchParams.get("alt")).toBe("sse");
    expect(req.headers["x-goog-api-key"]).toBe("g");
    expect(req.json).toMatchObject({
      systemInstruction: { parts: [{ text: "S" }] },
      generationConfig: { maxOutputTokens: 64, thinkingConfig: { thinkingLevel: "low", includeThoughts: true } },
      tools: [{ functionDeclarations: [{ name: "lookup", parametersJsonSchema: { type: "object" } }] }],
      toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["lookup"] } },
    });

    srv.once("POST", "/v1beta/models/gemini-x:streamGenerateContent", { chunks: sse([{ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] }], false) });
    await c.chat({ model: "gemini-x", tools, messages: [user("go"), r.message, { role: "tool", content: [{ type: "tool_result", tool_use_id: r.toolCalls[0]!.id, content: "found" }] }] });
    expect(srv.last().json.contents).toEqual([
      { role: "user", parts: [{ text: "go" }] },
      {
        role: "model",
        parts: [
          { text: "pondering", thought: true },
          { text: "I'll look it up", thoughtSignature: "TS_TEXT" },
          { functionCall: { name: "lookup", args: { q: "x" } }, thoughtSignature: "TS_FC" },
        ],
      },
      { role: "user", parts: [{ functionResponse: { name: "lookup", response: { result: "found" } } }] },
    ]);
  });

  it("maps blocked prompts, safety stops and RESOURCE_EXHAUSTED retry delays", async () => {
    const c = createClient("gemini", { baseUrl: `${srv.url}/v1beta` }, { apiKey: "g" });
    srv.once("POST", /streamGenerateContent$/, { chunks: sse([{ promptFeedback: { blockReason: "SAFETY" } }], false) });
    await expect(c.chat({ model: "g", messages: [user("x")] })).rejects.toMatchObject({ code: "content_filtered", midStream: true });
    srv.once("POST", /streamGenerateContent$/, { chunks: sse([{ candidates: [{ content: { parts: [{ text: "a" }] }, finishReason: "RECITATION" }] }], false) });
    expect((await c.chat({ model: "g", messages: [user("x")] })).stopReason).toBe("content_filter");
    srv.once("POST", /streamGenerateContent$/, {
      status: 429,
      body: { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "7s" }] } },
    });
    await expect(c.chat({ model: "g", messages: [user("x")] })).rejects.toMatchObject({ code: "rate_limited", retryAfterMs: 7000 });
    srv.once("POST", /streamGenerateContent$/, { status: 400, body: { error: { code: 400, status: "INVALID_ARGUMENT", message: "The input token count (2000000) exceeds the maximum number of tokens allowed (1048576)." } } });
    await expect(c.chat({ model: "g", messages: [user("x")] })).rejects.toMatchObject({ code: "context_too_long" });
  });

  it("embeds with taskType and lists models", async () => {
    srv.once("POST", "/v1beta/models/gemini-embedding-001:batchEmbedContents", (req) => ({ body: { embeddings: req.json.requests.map(() => ({ values: [1, 0, 0] })) } }));
    const c = createClient("gemini", { baseUrl: `${srv.url}/v1beta` }, { apiKey: "g" });
    const r = await c.embed({ model: "gemini-embedding-001", inputs: ["a", "b"], inputType: "document", dimensions: 3 });
    expect(r).toMatchObject({ dims: 3, vectors: [[1, 0, 0], [1, 0, 0]] });
    expect(srv.last().json.requests[0]).toEqual({ model: "models/gemini-embedding-001", content: { parts: [{ text: "a" }] }, taskType: "RETRIEVAL_DOCUMENT", outputDimensionality: 3 });
    srv.once("GET", "/v1beta/models", { body: { models: [{ name: "models/gemini-x", supportedGenerationMethods: ["generateContent"], inputTokenLimit: 1000 }, { name: "models/gemini-embedding-001", supportedGenerationMethods: ["embedContent"] }] } });
    expect(await c.listModels()).toEqual([
      { id: "gemini-x", kind: "chat", contextWindow: 1000, label: undefined, maxOutputTokens: undefined },
      { id: "gemini-embedding-001", kind: "embedding", contextWindow: undefined, label: undefined, maxOutputTokens: undefined },
    ]);
  });
});

describe("vertex (service account)", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const sa = () =>
    JSON.stringify({
      type: "service_account",
      project_id: "proj-1",
      client_email: "bot@proj-1.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
      token_uri: `${srv.url}/token`,
    });

  it("exchanges a signed JWT and calls Gemini and Claude publishers", async () => {
    srv.on("POST", "/token", (req) => {
      const assertion = new URLSearchParams(req.text).get("assertion")!;
      const [h, c, s] = assertion.split(".");
      const ok = createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, s!, "base64url");
      const claims = JSON.parse(Buffer.from(c!, "base64url").toString());
      return ok && claims.scope === "https://www.googleapis.com/auth/cloud-platform" ? { body: { access_token: "ya29.tok", expires_in: 3600 } } : { status: 400, body: { error_description: "bad jwt" } };
    });
    srv.on("POST", /:streamGenerateContent$/, { chunks: sse([{ candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }] }], false) });
    srv.on("POST", /:streamRawPredict$/, {
      chunks: sseNamed([
        ["message_start", { type: "message_start", message: { usage: {} } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "claude" } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
        ["message_stop", { type: "message_stop" }],
      ]),
    });
    const base = (loc: string) => (c: Record<string, unknown>) => `${srv.url}/v1/projects/${String(c.projectId || "proj-1")}/locations/${loc}`;
    const g = createClient(at("vertex", { resolveBaseUrl: base("global") }), {}, { serviceAccountJson: sa() });
    expect((await g.chat({ model: "gemini-x", messages: [user("x")] })).text).toBe("hi");
    expect(srv.last().path).toBe("/v1/projects/proj-1/locations/global/publishers/google/models/gemini-x:streamGenerateContent");
    expect(srv.last().headers.authorization).toBe("Bearer ya29.tok");

    const a = createClient(at("vertex", { resolveBaseUrl: base("us-east5") }), { publisher: "anthropic" }, { serviceAccountJson: sa() });
    expect(a.codecId).toBe("anthropic-messages");
    expect((await a.chat({ model: "claude-x@2026", messages: [user("x")] })).text).toBe("claude");
    expect(srv.last().path).toBe("/v1/projects/proj-1/locations/us-east5/publishers/anthropic/models/claude-x%402026:streamRawPredict");
    expect(srv.last().json.anthropic_version).toBe("vertex-2023-10-16");
    expect(srv.last().json.model).toBeUndefined();
    expect(srv.requests.filter((r) => r.path === "/token")).toHaveLength(1); // token cached
  });

  it("real resolveBaseUrl uses project from SA JSON and global host", () => {
    const url = getProvider("vertex")!.resolveBaseUrl!({ location: "global" }, { serviceAccountJson: sa() });
    expect(url).toBe("https://aiplatform.googleapis.com/v1/projects/proj-1/locations/global");
    expect(getProvider("vertex")!.resolveBaseUrl!({ location: "asia-east1", projectId: "p" }, {})).toBe("https://asia-east1-aiplatform.googleapis.com/v1/projects/p/locations/asia-east1");
  });

  it("invalid SA JSON → auth_failed via probe", async () => {
    const r = await createClient(at("vertex", { resolveBaseUrl: () => srv.url }), {}, { serviceAccountJson: "{nope" }).probe();
    expect(r).toMatchObject({ ok: false, error: { code: "auth_failed" } });
  });
});

// ---------------------------------------------------------------- Bedrock

describe("bedrock-converse codec", () => {
  const frame = (event: string, payload: unknown) => encodeEventStreamMessage({ ":event-type": event, ":message-type": "event", ":content-type": "application/json" }, JSON.stringify(payload));
  const exc = (type: string, message: string) => encodeEventStreamMessage({ ":exception-type": type, ":message-type": "exception", ":content-type": "application/json" }, JSON.stringify({ message }));
  const bedrock = (config: Record<string, unknown>, secrets: Record<string, string>) => createClient(at("bedrock", { resolveBaseUrl: () => srv.url }), config, secrets);

  it("decodes event-stream frames split across chunks", () => {
    const a = frame("messageStart", { role: "assistant" });
    const b = frame("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "hé" } });
    const all = new Uint8Array([...a, ...b]);
    const dec = new EventStreamDecoder();
    const out = [...dec.push(all.subarray(0, 5)), ...dec.push(all.subarray(5, a.length + 7)), ...dec.push(all.subarray(a.length + 7))];
    expect(out.map((m) => m.headers[":event-type"])).toEqual(["messageStart", "contentBlockDelta"]);
    expect(JSON.parse(new TextDecoder().decode(out[1]!.payload)).delta.text).toBe("hé");
    const bad = frame("x", {});
    bad[bad.length - 1] = bad[bad.length - 1]! ^ 0xff;
    expect(() => new EventStreamDecoder().push(bad)).toThrow(/CRC/);
  });

  it("SigV4 matches the AWS documentation example", () => {
    const req = { method: "GET", url: new URL("https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08"), headers: new Headers({ "content-type": "application/x-www-form-urlencoded; charset=utf-8" }), body: "" };
    signSigV4(req, { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" }, "us-east-1", "iam", new Date("2015-08-30T12:36:00Z"), { contentSha256Header: false });
    expect(req.headers.get("authorization")).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
    );
  });

  it("streams text, reasoning, tool use with SigV4 and replays reasoningContent", async () => {
    srv.once("POST", /\/converse-stream$/, {
      headers: { "content-type": "application/vnd.amazon.eventstream" },
      chunks: [
        frame("messageStart", { role: "assistant" }),
        frame("contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { text: "thinking" } } }),
        frame("contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { signature: "SIGB" } } }),
        frame("contentBlockStop", { contentBlockIndex: 0 }),
        frame("contentBlockDelta", { contentBlockIndex: 1, delta: { text: "Let me" } }),
        frame("contentBlockStop", { contentBlockIndex: 1 }),
        frame("contentBlockStart", { contentBlockIndex: 2, start: { toolUse: { toolUseId: "tu_1", name: "lookup" } } }),
        frame("contentBlockDelta", { contentBlockIndex: 2, delta: { toolUse: { input: '{"q":"' } } }),
        frame("contentBlockDelta", { contentBlockIndex: 2, delta: { toolUse: { input: 'x"}' } } }),
        frame("contentBlockStop", { contentBlockIndex: 2 }),
        frame("messageStop", { stopReason: "tool_use" }),
        frame("metadata", { usage: { inputTokens: 5, outputTokens: 6 }, metrics: { latencyMs: 10 } }),
      ],
    });
    const c = bedrock({ region: "us-west-2", accessKeyId: "AKID" }, { secretAccessKey: "secret", sessionToken: "sess" });
    const tools = [{ name: "lookup", inputSchema: { type: "object" } }];
    const model = "us.anthropic.claude-x-v1:0";
    const r = await c.chat({ model, tools, maxTokens: 100, messages: [{ role: "system", content: "S" }, user("go")], reasoning: { budgetTokens: 2048 } });
    expect(r).toMatchObject({ text: "Let me", reasoning: "thinking", stopReason: "tool_use", toolCalls: [{ id: "tu_1", name: "lookup", input: { q: "x" } }], usage: { inputTokens: 5, outputTokens: 6 } });
    const req = srv.last();
    expect(req.path).toBe("/model/us.anthropic.claude-x-v1%3A0/converse-stream");
    expect(String(req.headers.authorization)).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/us-west-2\/bedrock\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/);
    expect(req.headers["x-amz-security-token"]).toBe("sess");
    expect(req.json).toMatchObject({
      system: [{ text: "S" }],
      inferenceConfig: { maxTokens: 100 },
      toolConfig: { tools: [{ toolSpec: { name: "lookup", inputSchema: { json: { type: "object" } } } }] },
      additionalModelRequestFields: { thinking: { type: "enabled", budget_tokens: 2048 } },
    });

    srv.once("POST", /\/converse-stream$/, { headers: { "content-type": "application/vnd.amazon.eventstream" }, chunks: [frame("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "ok" } }), frame("messageStop", { stopReason: "end_turn" })] });
    await c.chat({ model, tools, messages: [user("go"), r.message, { role: "tool", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "found" }] }] });
    expect(srv.last().json.messages).toEqual([
      { role: "user", content: [{ text: "go" }] },
      { role: "assistant", content: [{ reasoningContent: { reasoningText: { text: "thinking", signature: "SIGB" } } }, { text: "Let me" }, { toolUse: { toolUseId: "tu_1", name: "lookup", input: { q: "x" } } }] },
      { role: "user", content: [{ toolResult: { toolUseId: "tu_1", content: [{ text: "found" }], status: "success" } }] },
    ]);
  });

  it("Bedrock API key bearer; in-stream and HTTP exceptions", async () => {
    const c = bedrock({ authMode: "bedrock_api_key" }, { apiKey: "ABSK-key" });
    srv.once("POST", /\/converse-stream$/, { headers: { "content-type": "application/vnd.amazon.eventstream" }, chunks: [frame("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "a" } }), exc("throttlingException", "Too many requests")] });
    const events = await collect(c.chatStream({ model: "m", messages: [user("x")] }));
    expect(srv.last().headers.authorization).toBe("Bearer ABSK-key");
    expect(events.at(-1)).toMatchObject({ type: "error", error: { code: "rate_limited", status: 429, midStream: true } });
    srv.once("POST", /\/converse-stream$/, { headers: { "content-type": "application/vnd.amazon.eventstream" }, chunks: [exc("ThrottlingException", "slow")] });
    expect((await collect(c.chatStream({ model: "m", messages: [user("x")] }))).at(-1)).toMatchObject({ type: "error", error: { code: "rate_limited" } });
    srv.once("POST", /\/converse-stream$/, { status: 400, headers: { "x-amzn-errortype": "ValidationException:http://internal.amazon.com/coral/com.amazon.bedrock/" }, body: { message: "Input is too long for requested model." } });
    await expect(c.chat({ model: "m", messages: [user("x")] })).rejects.toMatchObject({ code: "context_too_long" });
    srv.once("POST", /\/converse-stream$/, { status: 403, headers: { "x-amzn-errortype": "AccessDeniedException" }, body: { message: "You don't have access to the model" } });
    await expect(c.chat({ model: "m", messages: [user("x")] })).rejects.toMatchObject({ code: "auth_failed" });
  });

  it("embeds with Titan via InvokeModel", async () => {
    srv.on("POST", /\/invoke$/, { body: { embedding: [0, 2], inputTextTokenCount: 3 } });
    const r = await bedrock({ authMode: "bedrock_api_key" }, { apiKey: "k" }).embed({ model: "amazon.titan-embed-text-v2:0", inputs: ["a", "b"], inputType: "query", dimensions: 256 });
    expect(r).toMatchObject({ dims: 2, vectors: [[0, 1], [0, 1]], usage: { inputTokens: 6 } });
    expect(srv.last().json).toEqual({ inputText: "b", dimensions: 256, normalize: true });
  });
});

// ---------------------------------------------------------------- Ollama

describe("ollama-native codec", () => {
  it("streams NDJSON thinking/text/tool calls, sends num_ctx, replays thinking", async () => {
    srv.once("POST", "/api/chat", {
      headers: { "content-type": "application/x-ndjson" },
      chunks: ndjsonLines([
        { model: "qwen3", message: { role: "assistant", content: "", thinking: "hmm" }, done: false },
        { model: "qwen3", message: { role: "assistant", content: "Calling" }, done: false },
        { model: "qwen3", message: { role: "assistant", content: "", tool_calls: [{ function: { name: "lookup", arguments: { q: "x" } } }] }, done: false },
        { model: "qwen3", message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 11, eval_count: 7 },
      ]),
    });
    const c = createClient("ollama", { baseUrl: srv.url }, {});
    expect(c.warnings_zh[0]).toMatch(/num_ctx/);
    const tools = [{ name: "lookup", inputSchema: { type: "object" } }];
    const r = await c.chat({ model: "qwen3", tools, maxTokens: 50, messages: [user("go")], reasoning: { enabled: true } });
    expect(r).toMatchObject({ text: "Calling", reasoning: "hmm", stopReason: "tool_use", toolCalls: [{ name: "lookup", input: { q: "x" } }], usage: { inputTokens: 11, outputTokens: 7 } });
    expect(srv.last().json).toMatchObject({ model: "qwen3", stream: true, think: true, keep_alive: "5m", options: { num_ctx: 8192, num_predict: 50 } });

    srv.once("POST", "/api/chat", { chunks: ndjsonLines([{ message: { content: "ok" }, done: true, done_reason: "stop" }]) });
    await c.chat({ model: "qwen3", tools, messages: [user("go"), r.message, { role: "tool", content: [{ type: "tool_result", tool_use_id: r.toolCalls[0]!.id, content: "found" }] }] });
    expect(srv.last().json.messages.slice(1)).toEqual([
      { role: "assistant", content: "Calling", tool_calls: [{ function: { name: "lookup", arguments: { q: "x" } } }], thinking: "hmm" },
      { role: "tool", content: "found", tool_name: "lookup" },
    ]);
  });

  it("maps NDJSON error lines and HTTP 404 model not found", async () => {
    const c = createClient("ollama", { baseUrl: srv.url }, {});
    srv.once("POST", "/api/chat", { chunks: ndjsonLines([{ message: { content: "a" }, done: false }, { error: "an error was encountered while running the model" }]) });
    expect((await collect(c.chatStream({ model: "m", messages: [user("x")] }))).at(-1)).toMatchObject({ type: "error", error: { code: "unavailable", midStream: true } });
    srv.once("POST", "/api/chat", { status: 404, body: { error: "model 'nope' not found" } });
    await expect(c.chat({ model: "nope", messages: [user("x")] })).rejects.toMatchObject({ code: "model_not_found" });
  });

  it("lists, probes and embeds", async () => {
    srv.on("GET", "/api/tags", { body: { models: [{ name: "qwen3:8b", model: "qwen3:8b", details: { family: "qwen3" } }, { name: "bge-m3", model: "bge-m3:latest", details: { family: "bert" } }] } });
    srv.on("GET", "/api/version", { body: { version: "0.40.6" } });
    srv.on("POST", "/api/embed", (req) => ({ body: { embeddings: req.json.input.map(() => [1, 1]), prompt_eval_count: 2 } }));
    const c = createClient("ollama", { baseUrl: srv.url, numCtx: 4096 }, {});
    expect((await c.listModels()).map((m) => [m.id, m.kind])).toEqual([
      ["qwen3:8b", "chat"],
      ["bge-m3:latest", "embedding"],
    ]);
    expect(await c.probe()).toMatchObject({ ok: true, modelCount: 2 });
    const r = await c.embed({ model: "bge-m3", inputs: ["a"], inputType: "document" });
    expect(r.vectors[0]![0]).toBeCloseTo(Math.SQRT1_2);
    expect(srv.last().json).toMatchObject({ model: "bge-m3", input: ["a"], truncate: true, options: { num_ctx: 4096 } });
  });
});

// ---------------------------------------------------------------- Cohere

describe("cohere codec", () => {
  it("streams v2 events with tool plan and tool calls", async () => {
    srv.once("POST", "/v2/chat", {
      chunks: sseNamed([
        ["message-start", { type: "message-start", id: "m1", delta: { message: { role: "assistant" } } }],
        ["tool-plan-delta", { type: "tool-plan-delta", delta: { message: { tool_plan: "I will look it up." } } }],
        ["tool-call-start", { type: "tool-call-start", index: 0, delta: { message: { tool_calls: { id: "lookup_abc", type: "function", function: { name: "lookup", arguments: "" } } } } }],
        ["tool-call-delta", { type: "tool-call-delta", index: 0, delta: { message: { tool_calls: { function: { arguments: '{"q": "x"}' } } } } }],
        ["tool-call-end", { type: "tool-call-end", index: 0 }],
        ["message-end", { type: "message-end", delta: { finish_reason: "TOOL_CALL", usage: { billed_units: { input_tokens: 5, output_tokens: 9 }, tokens: { input_tokens: 70, output_tokens: 9 } } } }],
      ]),
    });
    const c = createClient("cohere", { baseUrl: srv.url }, { apiKey: "co" });
    const tools = [{ name: "lookup", inputSchema: { type: "object" } }];
    const r = await c.chat({ model: "command-a", tools, toolChoice: "required", messages: [user("go")], topP: 0.5 });
    expect(r).toMatchObject({ stopReason: "tool_use", reasoning: "I will look it up.", toolCalls: [{ id: "lookup_abc", input: { q: "x" } }], usage: { inputTokens: 70, outputTokens: 9 } });
    expect(srv.last().json).toMatchObject({ tool_choice: "REQUIRED", p: 0.5, tools: [{ type: "function", function: { name: "lookup" } }] });

    srv.once("POST", "/v2/chat", {
      chunks: sseNamed([
        ["content-delta", { type: "content-delta", index: 0, delta: { message: { content: { text: "Done" } } } }],
        ["message-end", { type: "message-end", delta: { finish_reason: "COMPLETE", usage: {} } }],
      ]),
    });
    await c.chat({ model: "command-a", tools, messages: [user("go"), r.message, { role: "tool", content: [{ type: "tool_result", tool_use_id: "lookup_abc", content: "found" }] }] });
    expect(srv.last().json.messages.slice(1)).toEqual([
      { role: "assistant", tool_calls: [{ id: "lookup_abc", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } }], tool_plan: "I will look it up." },
      { role: "tool", tool_call_id: "lookup_abc", content: "found" },
    ]);
    srv.once("POST", "/v2/chat", { chunks: sseNamed([["message-end", { type: "message-end", delta: { finish_reason: "ERROR", error: "internal" } }]]) });
    await expect(c.chat({ model: "command-a", messages: [user("x")] })).rejects.toMatchObject({ code: "unavailable", midStream: true });
  });

  it("embeds with input_type and output_dimension (native v2)", async () => {
    srv.on("POST", "/v2/embed", (req) => ({ body: { embeddings: { float: req.json.texts.map(() => [0, 0, 5]) }, meta: { billed_units: { input_tokens: 4 } } } }));
    const r = await createClient("cohere", { baseUrl: srv.url }, { apiKey: "co" }).embed({ model: "embed-v4.0", inputs: ["q"], inputType: "query", dimensions: 3 });
    expect(r).toMatchObject({ vectors: [[0, 0, 1]], usage: { inputTokens: 4 } });
    expect(srv.last().json).toEqual({ model: "embed-v4.0", texts: ["q"], input_type: "search_query", embedding_types: ["float"], truncate: "END", output_dimension: 3 });
  });
});

// ---------------------------------------------------------------- embedding-only vendors

describe("embedding-only codecs", () => {
  it("voyage: input_type, output_dimension, probe", async () => {
    srv.on("POST", "/v1/embeddings", (req) => ({ body: { data: req.json.input.map((_: string, i: number) => ({ embedding: [1, 0], index: i })), model: req.json.model, usage: { total_tokens: 3 } } }));
    const c = createClient("voyage", { baseUrl: `${srv.url}/v1` }, { apiKey: "v" });
    const r = await c.embed({ model: "voyage-4", inputs: ["a"], inputType: "document", dimensions: 512 });
    expect(r).toMatchObject({ model: "voyage-4", dims: 2, usage: { inputTokens: 3 } });
    expect(srv.last().json).toEqual({ model: "voyage-4", input: ["a"], input_type: "document", truncation: true, output_dimension: 512 });
    expect(c.capabilities.chat).toBe(false);
    await expect(c.chat({ model: "x", messages: [user("x")] })).rejects.toMatchObject({ code: "unsupported" });
    expect(await c.probe()).toMatchObject({ ok: true });
    expect(srv.last().json.model).toBe("voyage-4-lite");
  });

  it("voyage error detail → context_too_long", async () => {
    srv.on("POST", "/v1/embeddings", { status: 400, body: { detail: "Request to model 'voyage-4' failed. The max allowed tokens per submitted batch is 320000." } });
    await expect(createClient("voyage", { baseUrl: `${srv.url}/v1` }, { apiKey: "v" }).embed({ model: "voyage-4", inputs: ["a"], inputType: "query" })).rejects.toMatchObject({ code: "context_too_long" });
  });

  it("jina: retrieval task names", async () => {
    srv.on("POST", "/v1/embeddings", (req) => ({ body: { data: req.json.input.map((_: string, i: number) => ({ embedding: [0, 1], index: i })), usage: { total_tokens: 1 } } }));
    await createClient("jina", { baseUrl: `${srv.url}/v1` }, { apiKey: "j" }).embed({ model: "jina-embeddings-v5-text-small", inputs: ["q"], inputType: "query" });
    expect(srv.last().json).toMatchObject({ task: "retrieval.query", normalized: true, embedding_type: "float" });
  });

  it("tei: native /embed with prompt_name, /info listing, health probe", async () => {
    srv.on("POST", "/embed", (req) => ({ body: req.json.inputs.map(() => [2, 0]) }));
    srv.on("GET", "/info", { body: { model_id: "Qwen/Qwen3-Embedding-0.6B", max_client_batch_size: 32, max_input_length: 32768 } });
    srv.on("GET", "/health", { body: "" });
    const c = createClient("tei", { baseUrl: srv.url, queryPromptName: "query", batchSize: 1 }, {});
    const r = await c.embed({ model: "x", inputs: ["a", "b"], inputType: "query" });
    expect(r.vectors).toEqual([
      [1, 0],
      [1, 0],
    ]);
    expect(srv.requests.filter((x) => x.path === "/embed").map((x) => x.json)).toEqual([
      { inputs: ["a"], normalize: true, truncate: true, prompt_name: "query" },
      { inputs: ["b"], normalize: true, truncate: true, prompt_name: "query" },
    ]);
    expect(await c.listModels()).toEqual([{ id: "Qwen/Qwen3-Embedding-0.6B", kind: "embedding", contextWindow: 32768 }]);
    expect(await c.probe()).toMatchObject({ ok: true, modelCount: 1 });
  });
});
