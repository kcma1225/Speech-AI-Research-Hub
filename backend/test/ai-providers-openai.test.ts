import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AiError, createClient, type ChatEvent, type ChatMessage } from "../src/ai/providers/index.js";
import { collect, MockServer, sse } from "./ai-providers-mock.js";

const srv = new MockServer();
beforeAll(() => srv.start());
afterAll(() => srv.stop());
beforeEach(() => srv.reset());

const compat = (extra: Record<string, unknown> = {}, id = "openai-compatible") => createClient(id, { baseUrl: `${srv.url}/v1`, ...extra }, { apiKey: "sk-test" });
const user = (content: string): ChatMessage => ({ role: "user", content });

const chunk = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) => ({
  id: "c1",
  object: "chat.completion.chunk",
  model: "m",
  choices: [{ index: 0, delta, finish_reason: finish }],
  ...extra,
});

describe("openai-chat codec", () => {
  it("streams text + reasoning_content + usage and returns providerState", async () => {
    srv.on("POST", "/v1/chat/completions", {
      chunks: sse([
        chunk({ role: "assistant", reasoning_content: "think " }),
        chunk({ reasoning_content: "more" }),
        chunk({ content: "Hel" }),
        chunk({ content: "lo" }, "stop"),
        { id: "c1", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 3 } } },
      ]),
    });
    const r = await compat().chat({ model: "m", maxTokens: 50, temperature: 0.2, messages: [{ role: "system", content: "sys" }, user("hi")] });
    expect(r.text).toBe("Hello");
    expect(r.reasoning).toBe("think more");
    expect(r.stopReason).toBe("end_turn");
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 5, reasoningTokens: 3 });
    expect(r.providerState).toMatchObject({ codec: "openai-chat", data: { reasoningKey: "reasoning_content", reasoning: "think more" } });
    const req = srv.last();
    expect(req.headers.authorization).toBe("Bearer sk-test");
    expect(req.json).toMatchObject({ model: "m", stream: true, stream_options: { include_usage: true }, max_tokens: 50, temperature: 0.2 });
    expect(req.json.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]);
  });

  it("accumulates fragmented parallel tool calls and round-trips reasoning (DeepSeek)", async () => {
    srv.once("POST", "/v1/chat/completions", {
      chunks: sse([
        chunk({ reasoning_content: "need tools" }),
        chunk({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "get_weather", arguments: "" } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }),
        chunk({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "get_time", arguments: "{}" } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '"Taipei"}' } }] }, "tool_calls"),
      ]),
    });
    const client = createClient("deepseek", { baseUrl: `${srv.url}/v1` }, { apiKey: "k" });
    const tools = [
      { name: "get_weather", inputSchema: { type: "object", properties: { city: { type: "string" } } } },
      { name: "get_time", inputSchema: { type: "object" } },
    ];
    const events = await collect(client.chatStream({ model: "deepseek-flash", tools, messages: [user("weather?")], reasoning: { effort: "high" } }));
    const ends = events.filter((e): e is Extract<ChatEvent, { type: "tool_call_end" }> => e.type === "tool_call_end");
    expect(ends.map((e) => [e.id, e.name, e.input])).toEqual([
      ["call_a", "get_weather", { city: "Taipei" }],
      ["call_b", "get_time", {}],
    ]);
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "tool_use" });
    expect(srv.last().json).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "high", tools: [{ type: "function", function: { name: "get_weather" } }, {}] });

    // Next turn: history must carry tool_calls + reasoning_content + tool results.
    const done = events.at(-1) as Extract<ChatEvent, { type: "done" }>;
    srv.once("POST", "/v1/chat/completions", { chunks: sse([chunk({ content: "Sunny" }, "stop")]) });
    const r2 = await client.chat({
      model: "deepseek-flash",
      tools,
      messages: [
        user("weather?"),
        { role: "assistant", content: ends.map((e) => ({ type: "tool_use" as const, id: e.id, name: e.name, input: e.input })), providerState: done.providerState },
        {
          role: "tool",
          content: [
            { type: "tool_result", tool_use_id: "call_a", content: "25C" },
            { type: "tool_result", tool_use_id: "call_b", content: "noon" },
          ],
        },
      ],
    });
    expect(r2.text).toBe("Sunny");
    const msgs = srv.last().json.messages;
    expect(msgs[1]).toEqual({
      role: "assistant",
      content: null,
      reasoning_content: "need tools",
      tool_calls: [
        { id: "call_a", type: "function", function: { name: "get_weather", arguments: '{"city":"Taipei"}' } },
        { id: "call_b", type: "function", function: { name: "get_time", arguments: "{}" } },
      ],
    });
    expect(msgs.slice(2)).toEqual([
      { role: "tool", tool_call_id: "call_a", content: "25C" },
      { role: "tool", tool_call_id: "call_b", content: "noon" },
    ]);
  });

  it("drops providerState from another codec", async () => {
    srv.on("POST", "/v1/chat/completions", { chunks: sse([chunk({ content: "ok" }, "stop")]) });
    await compat().chat({ model: "m", messages: [user("a"), { role: "assistant", content: "b", providerState: { codec: "anthropic-messages", data: { thinking: [{}] } } }, user("c")] });
    expect(srv.last().json.messages[1]).toEqual({ role: "assistant", content: "b" });
  });

  it.each([
    [401, { error: { message: "bad key", type: "invalid_request_error", code: "invalid_api_key" } }, {}, "auth_failed", false],
    [429, { error: { message: "slow down", type: "rate_limit_error" } }, { "retry-after": "2" }, "rate_limited", true],
    [429, { error: { message: "You exceeded your current quota", type: "insufficient_quota", code: "insufficient_quota" } }, {}, "quota_exhausted", false],
    [400, { error: { message: "This model's maximum context length is 8192 tokens", code: "context_length_exceeded" } }, {}, "context_too_long", false],
    [400, { error: { message: "filtered", code: "content_filter" } }, {}, "content_filtered", false],
    [404, { error: { message: "The model `x` does not exist", code: "model_not_found" } }, {}, "model_not_found", false],
    [503, { error: { message: "overloaded" } }, {}, "overloaded", true],
    [500, "oops", {}, "unavailable", true],
    [400, { object: "error", message: "bad temperature", type: "BadRequestError", code: 400 }, {}, "bad_request", false],
  ])("HTTP %i → error code", async (status, body, headers, code, retryable) => {
    srv.on("POST", "/v1/chat/completions", { status, body, headers });
    const err = await compat()
      .chat({ model: "m", messages: [user("x")] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiError);
    const e = err as AiError;
    expect(e.code).toBe(code);
    expect(e.retryable).toBe(retryable);
    expect(e.midStream).toBe(false);
    expect(e.providerId).toBe("openai-compatible");
    expect(e.message_zh).toMatch(/[一-鿿]/);
    if (code === "rate_limited") expect(e.retryAfterMs).toBe(2000);
  });

  it("surfaces in-200 stream errors as a final error event (OpenRouter style)", async () => {
    srv.on("POST", "/api/v1/chat/completions", {
      chunks: [": OPENROUTER PROCESSING\n\n", ...sse([chunk({ content: "par" }), { error: { code: 502, message: "Provider returned error" }, choices: [{ index: 0, delta: {}, finish_reason: "error" }] }])],
    });
    const client = createClient("openrouter", { baseUrl: `${srv.url}/api/v1` }, { apiKey: "k" });
    const events = await collect(client.chatStream({ model: "a/b", messages: [user("x")] }));
    expect(events.map((e) => e.type)).toEqual(["text_delta", "error"]);
    const err = (events[1] as Extract<ChatEvent, { type: "error" }>).error;
    expect(err.code).toBe("unavailable");
    expect(err.midStream).toBe(true);
    await expect(client.chat({ model: "a/b", messages: [user("x")] })).rejects.toMatchObject({ code: "unavailable", midStream: true });
    expect(srv.last().headers["x-title"]).toBe("Speech-AI Research Hub");
  });

  it("treats a truncated stream as a mid-stream error", async () => {
    srv.on("POST", "/v1/chat/completions", { chunks: sse([chunk({ content: "half" })], false) });
    const events = await collect(compat().chatStream({ model: "m", messages: [user("x")] }));
    expect(events.at(-1)).toMatchObject({ type: "error", error: { code: "unavailable", midStream: true } });
  });

  it("tolerates a JSON (non-stream) body with a trailing data: [DONE] line", async () => {
    const body = JSON.stringify({
      id: "x",
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: "pong", reasoning_content: "r", tool_calls: [{ id: "t1", type: "function", function: { name: "f", arguments: '{"a":1}' } }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    });
    srv.on("POST", "/v1/chat/completions", { body: `${body}\n\ndata: [DONE]\n\n`, headers: { "content-type": "application/json" } });
    const r = await compat().chat({ model: "m", messages: [user("x")] });
    expect(r.text).toBe("pong");
    expect(r.reasoning).toBe("r");
    expect(r.toolCalls).toEqual([{ type: "tool_use", id: "t1", name: "f", input: { a: 1 } }]);
    expect(r.stopReason).toBe("tool_use");
  });

  it("maps Zhipu business codes regardless of HTTP status", async () => {
    const z = () => createClient("zhipu", { baseUrl: `${srv.url}/v4` }, { apiKey: "k" });
    srv.once("POST", "/v4/chat/completions", { status: 429, body: { error: { code: "1305", message: "busy" } } });
    await expect(z().chat({ model: "glm", messages: [user("x")] })).rejects.toMatchObject({ code: "overloaded", vendorCode: "1305" });
    srv.once("POST", "/v4/chat/completions", { status: 400, body: { error: { code: "1261", message: "Prompt 超长" } } });
    await expect(z().chat({ model: "glm", messages: [user("x")] })).rejects.toMatchObject({ code: "context_too_long" });
    srv.once("POST", "/v4/chat/completions", { status: 429, body: { error: { code: "1113", message: "余额不足" } } });
    await expect(z().chat({ model: "glm", messages: [user("x")] })).rejects.toMatchObject({ code: "quota_exhausted", retryable: false });
    srv.once("POST", "/v4/chat/completions", { chunks: sse([chunk({ content: "a" }), chunk({}, "network_error")]) });
    const events = await collect(z().chatStream({ model: "glm", messages: [user("x")] }));
    expect(events.at(-1)).toMatchObject({ type: "error", error: { code: "unavailable", midStream: true } });
  });

  it("sends Fireworks context_length_exceeded_behavior=error by default and filters params", async () => {
    srv.on("POST", "/inference/v1/chat/completions", { chunks: sse([chunk({ content: "ok" }, "stop")]) });
    const fw = createClient("fireworks", { baseUrl: `${srv.url}/inference/v1` }, { apiKey: "k" });
    await fw.chat({ model: "accounts/fireworks/models/x", messages: [user("x")], params: { top_k: 5, evil_field: 1 } });
    expect(srv.last().json).toMatchObject({ context_length_exceeded_behavior: "error", top_k: 5 });
    expect(srv.last().json.evil_field).toBeUndefined();
  });

  it("maps reasoning styles (DashScope / vLLM chat_template_kwargs / OpenRouter)", async () => {
    srv.on("POST", /chat\/completions$/, { chunks: sse([chunk({ content: "ok" }, "stop")]) });
    await createClient("dashscope-intl", { baseUrl: `${srv.url}/v1` }, { apiKey: "k" }).chat({ model: "qwen", messages: [user("x")], reasoning: { budgetTokens: 2000 } });
    expect(srv.last().json).toMatchObject({ enable_thinking: true, thinking_budget: 2000 });
    await createClient("vllm", { baseUrl: `${srv.url}/v1` }, {}).chat({ model: "q", messages: [user("x")], reasoning: { enabled: false } });
    expect(srv.last().json).toMatchObject({ chat_template_kwargs: { enable_thinking: false } });
    expect(srv.last().headers.authorization).toBeUndefined();
    await createClient("openrouter", { baseUrl: `${srv.url}/v1` }, { apiKey: "k" }).chat({ model: "q", messages: [user("x")], reasoning: { effort: "low" } });
    expect(srv.last().json).toMatchObject({ reasoning: { effort: "low" } });
  });

  it("refuses tools on a local server without tool support", async () => {
    const c = createClient("vllm", { baseUrl: `${srv.url}/v1` }, {});
    expect(c.capabilities.tools).toBe(false);
    await expect(c.chat({ model: "q", messages: [user("x")], tools: [{ name: "t", inputSchema: {} }] })).rejects.toMatchObject({ code: "unsupported" });
  });

  it("lists models with capability hints (gateway, OpenRouter, Together bare array)", async () => {
    srv.once("GET", "/v1/models", {
      body: {
        object: "list",
        data: [
          { id: "glm/glm-5.3", object: "model", capabilities: { tools: true, reasoning: true, vision: false, contextWindow: 1000000, maxOutput: 128000 } },
          { id: "or/x", context_length: 32000, supported_parameters: ["tools", "reasoning"], architecture: { input_modalities: ["text", "image"] } },
          { id: "text-embedding-3-small" },
        ],
      },
    });
    const models = await compat().listModels();
    expect(models[0]).toEqual({ id: "glm/glm-5.3", contextWindow: 1000000, maxOutputTokens: 128000, hints: { tools: true, vision: false, reasoning: true } });
    expect(models[1]).toMatchObject({ id: "or/x", contextWindow: 32000, hints: { tools: true, reasoning: true, vision: true, params: ["tools", "reasoning"] } });
    expect(models[2]!.kind).toBe("embedding");
    srv.once("GET", "/v1/models", { body: [{ id: "org/m", type: "chat", context_length: 8192 }] });
    expect(await compat().listModels()).toEqual([{ id: "org/m", kind: "chat", contextWindow: 8192 }]);
  });

  it("probes health path then models; reports failures without throwing", async () => {
    srv.once("GET", "/health", { body: "" });
    srv.once("GET", "/v1/models", { body: { data: [{ id: "a" }] } });
    const ok = await createClient("vllm", { baseUrl: `${srv.url}/v1` }, {}).probe();
    expect(ok).toMatchObject({ ok: true, modelCount: 1 });
    expect(srv.requests.map((r) => r.path)).toEqual(["/health", "/v1/models"]);
    srv.once("GET", "/health", { status: 503, body: { error: { code: 503, message: "Loading model", type: "unavailable_error" } } });
    const bad = await createClient("llamacpp", { baseUrl: `${srv.url}/v1` }, {}).probe();
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe("overloaded");
    expect(bad.detail_zh).toMatch(/忙碌/);
  });

  it("times out and cancels", async () => {
    srv.on("POST", "/v1/chat/completions", { delayMs: 500, chunks: sse([chunk({ content: "late" }, "stop")]) });
    await expect(compat({ timeoutMs: 100 }).chat({ model: "m", messages: [user("x")] })).rejects.toMatchObject({ code: "timeout", retryable: true });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    await expect(compat().chat({ model: "m", messages: [user("x")], signal: ac.signal })).rejects.toMatchObject({ code: "cancelled" });
  });

  it("maps a connection failure to unavailable", async () => {
    const c = createClient("openai-compatible", { baseUrl: "http://127.0.0.1:1/v1" }, {});
    await expect(c.chat({ model: "m", messages: [user("x")] })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("embeds with batching, index ordering, templates and normalisation", async () => {
    srv.on("POST", "/v1/embeddings", (req) => ({
      body: {
        model: "e",
        data: (req.json.input as string[]).map((_, i, a) => ({ index: a.length - 1 - i, embedding: [3, 4] })).reverse(),
        usage: { prompt_tokens: 2 },
      },
    }));
    const c = compat({ batchSize: 2, queryTemplate: "q: {text}", normalize: true });
    const r = await c.embed({ model: "e", inputs: ["a", "b", "c"], inputType: "query", dimensions: 2 });
    expect(r).toMatchObject({ dims: 2, usage: { inputTokens: 4 } });
    expect(r.vectors[0]).toEqual([0.6, 0.8]);
    expect(srv.requests.map((x) => x.json.input)).toEqual([["q: a", "q: b"], ["q: c"]]);
    expect(srv.requests[0]!.json.dimensions).toBeUndefined(); // generic endpoint: sendDimensions defaults off
  });
});

describe("openai-responses codec", () => {
  const ev = (type: string, extra: Record<string, unknown>) => ({ type, ...extra });

  it("streams text, reasoning summary, function call; replays encrypted reasoning", async () => {
    const reasoningItem = { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "plan" }], encrypted_content: "ENC" };
    srv.once("POST", "/v1/responses", {
      chunks: sse(
        [
          ev("response.created", { response: { id: "r1" } }),
          ev("response.output_item.added", { output_index: 0, item: { type: "reasoning", id: "rs_1" } }),
          ev("response.reasoning_summary_text.delta", { item_id: "rs_1", delta: "plan" }),
          ev("response.output_item.done", { output_index: 0, item: reasoningItem }),
          ev("response.output_text.delta", { delta: "Let me check." }),
          ev("response.output_item.added", { output_index: 2, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "" } }),
          ev("response.function_call_arguments.delta", { item_id: "fc_1", output_index: 2, delta: '{"q":' }),
          ev("response.function_call_arguments.delta", { item_id: "fc_1", output_index: 2, delta: '"x"}' }),
          ev("response.output_item.done", { output_index: 2, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: '{"q":"x"}' } }),
          ev("response.completed", { response: { status: "completed", model: "gpt-x", usage: { input_tokens: 9, output_tokens: 4, output_tokens_details: { reasoning_tokens: 2 } } } }),
        ],
        false,
      ),
    });
    const client = createClient("openai", { baseUrl: `${srv.url}/v1`, organization: "org-1" }, { apiKey: "sk" });
    const tools = [{ name: "lookup", inputSchema: { type: "object" } }];
    const r = await client.chat({ model: "gpt-x", tools, toolChoice: "required", messages: [{ role: "system", content: "S" }, user("go")], maxTokens: 100, reasoning: { effort: "low" } });
    expect(r).toMatchObject({ text: "Let me check.", reasoning: "plan", stopReason: "tool_use", toolCalls: [{ id: "call_1", name: "lookup", input: { q: "x" } }], usage: { inputTokens: 9, outputTokens: 4, reasoningTokens: 2 } });
    const req1 = srv.last();
    expect(req1.headers["openai-organization"]).toBe("org-1");
    expect(req1.json).toMatchObject({
      model: "gpt-x",
      instructions: "S",
      store: false,
      include: ["reasoning.encrypted_content"],
      max_output_tokens: 100,
      tool_choice: "required",
      reasoning: { effort: "low", summary: "auto" },
      tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
      input: [{ role: "user", content: [{ type: "input_text", text: "go" }] }],
    });

    srv.once("POST", "/v1/responses", { chunks: sse([ev("response.output_text.delta", { delta: "done" }), ev("response.completed", { response: { usage: {} } })], false) });
    await client.chat({ model: "gpt-x", tools, messages: [user("go"), r.message, { role: "tool", content: [{ type: "tool_result", tool_use_id: "call_1", content: "found" }] }] });
    expect(srv.last().json.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "go" }] },
      reasoningItem,
      { role: "assistant", content: "Let me check." },
      { type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"q":"x"}' },
      { type: "function_call_output", call_id: "call_1", output: "found" },
    ]);
  });

  it("maps response.failed and error events", async () => {
    const client = createClient("xai", { baseUrl: `${srv.url}/v1` }, { apiKey: "k" });
    srv.once("POST", "/v1/responses", { chunks: sse([ev("response.output_text.delta", { delta: "a" }), ev("response.failed", { response: { error: { code: "server_is_overloaded", message: "busy" } } })], false) });
    const events = await collect(client.chatStream({ model: "grok", messages: [user("x")] }));
    expect(events.at(-1)).toMatchObject({ type: "error", error: { code: "overloaded", midStream: true } });
    srv.once("POST", "/v1/responses", { chunks: sse([ev("error", { code: "rate_limit_exceeded", message: "slow" })], false) });
    await expect(client.chat({ model: "grok", messages: [user("x")] })).rejects.toMatchObject({ code: "rate_limited", midStream: true });
    srv.once("POST", "/v1/responses", { chunks: sse([ev("response.incomplete", { response: { incomplete_details: { reason: "max_output_tokens" }, usage: {} } })], false) });
    expect((await client.chat({ model: "grok", messages: [user("x")] })).stopReason).toBe("max_tokens");
  });

  // Event order recorded from the ChatGPT/Codex backend (gpt-5.6-luna, 2026-10): reasoning item, one `final_answer`
  // message with one output_text part streamed as ~4000 deltas, `response.metadata`, then `response.completed`.
  it("Codex recording: reasoning + final_answer message, metadata event, all deltas kept", async () => {
    const slides = Array.from({ length: 11 }, (_, i) => `## Slide ${i + 1}\n\nBody ${i + 1}\n\n::: {.notes}\n講稿\n:::\n\n`).join("");
    const deltas = slides.match(/[\s\S]{1,3}/g)!.map((delta) => ev("response.output_text.delta", { item_id: "msg_1", output_index: 1, content_index: 0, delta }));
    srv.once("POST", "/v1/responses", {
      chunks: sse(
        [
          ev("response.created", { response: { id: "r1", status: "in_progress" } }),
          ev("response.in_progress", { response: { id: "r1" } }),
          ev("response.output_item.added", { output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [] } }),
          ev("response.reasoning_summary_part.added", { item_id: "rs_1", output_index: 0, summary_index: 0, part: { type: "summary_text", text: "" } }),
          ev("response.reasoning_summary_text.delta", { item_id: "rs_1", output_index: 0, summary_index: 0, delta: "**Planning slides**" }),
          ev("response.reasoning_summary_text.done", { item_id: "rs_1", output_index: 0, summary_index: 0, text: "**Planning slides**" }),
          ev("response.reasoning_summary_part.done", { item_id: "rs_1", output_index: 0, summary_index: 0 }),
          ev("response.output_item.done", { output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "ENC" } }),
          ev("response.output_item.added", { output_index: 1, item: { type: "message", id: "msg_1", role: "assistant", phase: "final_answer", status: "in_progress", content: [] } }),
          ev("response.content_part.added", { item_id: "msg_1", output_index: 1, content_index: 0, part: { type: "output_text", text: "" } }),
          ...deltas,
          ev("response.metadata", { metadata: {} }),
          ev("response.output_text.done", { item_id: "msg_1", output_index: 1, content_index: 0, text: slides }),
          ev("response.content_part.done", { item_id: "msg_1", output_index: 1, content_index: 0, part: { type: "output_text", text: slides } }),
          ev("response.output_item.done", { output_index: 1, item: { type: "message", id: "msg_1", phase: "final_answer", status: "completed", content: [{ type: "output_text", text: slides }] } }),
          ev("response.completed", { response: { status: "completed", usage: { input_tokens: 6236, output_tokens: 4337, output_tokens_details: { reasoning_tokens: 97 } }, output: [{ type: "reasoning" }, { type: "message", phase: "final_answer", content: [{ type: "output_text", text: slides }] }] } }),
        ],
        false,
      ),
    });
    const client = createClient("openai", { baseUrl: `${srv.url}/v1` }, { apiKey: "sk" });
    const r = await client.chat({ model: "gpt-5.6-luna", messages: [user("deck")] });
    expect(r.text).toBe(slides); // not doubled by output_text.done / output_item.done / completed
    expect(r.stopReason).toBe("end_turn");
    expect(r.usage).toMatchObject({ outputTokens: 4337, reasoningTokens: 97 });
  });

  it("keeps text across several message items and content parts; takes whole items sent without deltas", async () => {
    srv.once("POST", "/v1/responses", {
      chunks: sse(
        [
          ev("response.output_item.added", { output_index: 0, item: { type: "message", id: "m0", phase: "commentary", content: [] } }),
          ev("response.output_text.delta", { item_id: "m0", output_index: 0, content_index: 0, delta: "A" }),
          ev("response.output_text.delta", { item_id: "m0", output_index: 0, content_index: 1, delta: "B" }),
          ev("response.output_item.done", { output_index: 0, item: { type: "message", id: "m0", content: [{ type: "output_text", text: "A" }, { type: "output_text", text: "B" }] } }),
          // Second message: no deltas, only the finished item (some gateways).
          ev("response.output_item.done", { output_index: 1, item: { type: "message", id: "m1", content: [{ type: "output_text", text: "C" }, { type: "output_text", text: "D" }] } }),
          ev("response.output_text.delta", { item_id: "m2", output_index: 2, content_index: 0, delta: "E" }),
          ev("response.completed", { response: { usage: {} } }),
        ],
        false,
      ),
    });
    const client = createClient("openai", { baseUrl: `${srv.url}/v1` }, { apiKey: "sk" });
    expect((await client.chat({ model: "m", messages: [user("x")] })).text).toBe("ABCDE");
    // Non-streaming proxy: only response.completed with the output array.
    srv.once("POST", "/v1/responses", { chunks: sse([ev("response.completed", { response: { usage: {}, output: [{ type: "message", content: [{ type: "output_text", text: "## A" }, { type: "output_text", text: "\n## B" }] }] } })], false) });
    expect((await client.chat({ model: "m", messages: [user("x")] })).text).toBe("## A\n## B");
  });

  it("reports response.incomplete reasons (content filter, max tokens) with the partial text", async () => {
    const client = createClient("openai", { baseUrl: `${srv.url}/v1` }, { apiKey: "sk" });
    srv.once("POST", "/v1/responses", {
      chunks: sse([ev("response.output_text.delta", { item_id: "m", output_index: 0, delta: "## One" }), ev("response.incomplete", { response: { status: "incomplete", incomplete_details: { reason: "content_filter" }, usage: { output_tokens: 418 } } })], false),
    });
    expect(await client.chat({ model: "m", messages: [user("x")] })).toMatchObject({ text: "## One", stopReason: "content_filter" });
    srv.once("POST", "/v1/responses", {
      chunks: sse([ev("response.output_text.delta", { item_id: "m", output_index: 0, delta: "## One" }), ev("response.incomplete", { response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: {} } })], false),
    });
    expect(await client.chat({ model: "m", messages: [user("x")] })).toMatchObject({ text: "## One", stopReason: "max_tokens" });
  });

  it("Azure: v1 path, api-key header, Entra token", async () => {
    srv.on("POST", "/openai/v1/responses", { chunks: sse([ev("response.output_text.delta", { delta: "hi" }), ev("response.completed", { response: { usage: {} } })], false) });
    const az = createClient("azure", { endpoint: `${srv.url}/` }, { apiKey: "az-key" });
    await az.chat({ model: "my-deployment", messages: [user("x")] });
    expect(srv.last().path).toBe("/openai/v1/responses");
    expect(srv.last().headers["api-key"]).toBe("az-key");
    expect(srv.last().headers.authorization).toBeUndefined();
    const azChat = createClient("azure", { endpoint: srv.url, apiStyle: "chat" }, { apiKey: "az-key" });
    expect(azChat.codecId).toBe("openai-chat");
  });

  it("Perplexity uses /agent and has no model list", async () => {
    srv.on("POST", "/v1/agent", { chunks: sse([ev("response.output_text.delta", { delta: "[1] answer" }), ev("response.completed", { response: { usage: {} } })], false) });
    const p = createClient("perplexity", { baseUrl: `${srv.url}/v1` }, { apiKey: "k" });
    expect((await p.chat({ model: "openai/gpt-5.6-luna", messages: [user("x")], params: { preset: "fast" } })).text).toBe("[1] answer");
    expect(srv.last().json).toMatchObject({ preset: "fast", store: false });
    expect(srv.last().json.include).toBeUndefined();
    expect((await p.listModels()).length).toBeGreaterThan(0);
  });
});
