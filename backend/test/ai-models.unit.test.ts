/** Model profiles: catalog matching, merge precedence, per-vendor listing metadata, v1 → v2 settings upgrade. */
import { describe, expect, it } from "vitest";
import { catalogLookup, cleanFields, looksNonText, normalizeModelId } from "../src/ai/catalog/index.js";
import { parseModelList } from "../src/ai/codecs/openai-chat.js";
import { parseOllamaShow } from "../src/ai/codecs/ollama-native.js";
import { createClient } from "../src/ai/providers/index.js";
import { apiFieldsFromInfo, applyOverridePatch, mergeProfile, resolveProfile } from "../src/ai/platform/models.js";
import { upgradeV1 } from "../src/ai/platform/admin-service.js";

const fakeFetch = (routes: Record<string, unknown>) =>
  (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    if (!hit) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(hit[1]), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

describe("model catalog", () => {
  it("normalises vendor spellings", () => {
    expect(normalizeModelId("glm/glm-5.3-flash")).toBe("glm-5.3-flash");
    expect(normalizeModelId("openrouter/anthropic/claude-sonnet-4.5")).toBe("claude-sonnet-4-5");
    expect(normalizeModelId("us.anthropic.claude-3-5-haiku-20241022-v1:0")).toBe("claude-3-5-haiku-20241022-v1");
    expect(normalizeModelId("accounts/fireworks/models/llama-v3p1-70b-instruct")).toBe("llama-3.1-70b-instruct");
    expect(normalizeModelId("models/gemini-2.5-flash")).toBe("gemini-2.5-flash");
    expect(normalizeModelId("qwen3:30b")).toBe("qwen3-30b");
    expect(normalizeModelId("llama3.1:latest")).toBe("llama3.1");
    expect(normalizeModelId("deepseek-v3")).toBe("deepseek-v3");
  });

  it("matches well-known families with sensible defaults", () => {
    const f = (id: string) => catalogLookup(id, "llm");
    expect(f("gpt-4o-mini")).toMatchObject({ entry: { id: "openai.gpt-4o" }, fields: { capability: "chat", context_window: 128000, max_output_tokens: 16384, vision: true, tools: true } });
    expect(f("openai/gpt-5.1").fields).toMatchObject({ context_window: 400000, reasoning: true, vision: true });
    expect(f("o3-mini").fields).toMatchObject({ vision: false, reasoning: true });
    expect(f("claude-sonnet-4-5-20250929").entry?.id).toBe("anthropic.claude-sonnet-4");
    expect(f("anthropic/claude-3.5-sonnet").entry?.id).toBe("anthropic.claude-3.5-sonnet");
    expect(f("us.anthropic.claude-opus-4-1-20250805-v1:0").fields.max_output_tokens).toBe(32000);
    expect(f("gemini-2.5-pro").fields).toMatchObject({ context_window: 1048576, max_output_tokens: 65536 });
    expect(f("deepseek-reasoner").fields).toMatchObject({ reasoning: true });
    expect(f("glm/glm-5.3-flash").entry?.id).toBe("zhipu.glm-5");
    expect(f("glm-4.6v").fields.vision).toBe(true);
    expect(f("kimi-k2-0905-preview").entry?.id).toBe("moonshot.kimi-k2");
    expect(f("qwen3-vl-plus").fields.vision).toBe(true);
    expect(f("accounts/fireworks/models/llama-v3p1-70b-instruct").entry?.id).toBe("meta.llama-3.x");
    expect(f("llama3.2-vision:11b").fields.vision).toBe(true);
    expect(f("mistral-small-latest").fields.vision).toBe(true);
    expect(f("grok-4").fields.reasoning).toBe(true);
  });

  it("knows embedding and speech models, and guesses the rest", () => {
    expect(catalogLookup("text-embedding-3-small", "llm").fields).toMatchObject({ capability: "embedding", embedding_dims: 1536 });
    expect(catalogLookup("Qwen/Qwen3-Embedding-8B", "llm").fields).toMatchObject({ capability: "embedding", embedding_dims: 4096 });
    expect(catalogLookup("bge-m3", "llm").fields.embedding_dims).toBe(1024);
    expect(catalogLookup("nomic-embed-text:latest", "llm").fields.embedding_dims).toBe(768);
    expect(catalogLookup("my-custom-embedder", "llm")).toMatchObject({ entry: null, fields: { capability: "embedding" } });
    expect(catalogLookup("whisper-large-v3", "llm").fields.capability).toBe("asr");
    expect(catalogLookup("nova-3", "asr")).toMatchObject({ entry: { id: "deepgram.nova" }, fields: { capability: "asr" } });
    expect(catalogLookup("totally-unknown", "llm")).toEqual({ entry: null, fields: { capability: "chat" } });
    expect(looksNonText("dall-e-3")).toBe(true);
    expect(looksNonText("gpt-4o-mini-tts")).toBe(true);
    expect(looksNonText("omni-moderation-latest")).toBe(true);
    expect(looksNonText("gpt-4o-mini")).toBe(false);
  });
});

describe("profile merge", () => {
  it("manual > provider_api > catalog, per field, with sources", () => {
    const r = mergeProfile({ capability: "chat", context_window: 128000, max_output_tokens: 4096, vision: false }, { context_window: 200000, vision: true }, { max_output_tokens: 1000 });
    expect(r.fields).toEqual({ capability: "chat", context_window: 200000, max_output_tokens: 1000, vision: true });
    expect(r.sources).toEqual({ capability: "catalog", context_window: "provider_api", max_output_tokens: "manual", vision: "provider_api" });
    // false is a value (not "missing").
    expect(mergeProfile({ vision: true }, {}, { vision: false }).fields.vision).toBe(false);
  });

  it("resolves a stored row against the catalog; ASR accounts are always speech", () => {
    const p = resolveProfile({ family: "llm" }, { model_id: "gpt-4o", api: { context_window: 64000 }, overrides: {} });
    expect(p.catalog_id).toBe("openai.gpt-4o");
    expect(p.fields).toMatchObject({ context_window: 64000, max_output_tokens: 16384, vision: true });
    expect(p.sources).toMatchObject({ context_window: "provider_api", max_output_tokens: "catalog" });
    expect(resolveProfile({ family: "asr" }, { model_id: "anything", api: {}, overrides: { capability: "chat" } }).fields.capability).toBe("asr");
  });

  it("cleans junk and applies override patches (null clears)", () => {
    expect(cleanFields({ context_window: "8192", vision: "yes", bogus: 1, max_output_tokens: -5, capability: "image", input_price: 0.15 })).toEqual({ context_window: 8192, input_price: 0.15 });
    expect(applyOverridePatch({ context_window: 1000, vision: true }, { context_window: null, tools: false, nope: 1 })).toEqual({ vision: true, tools: false });
  });
});

describe("listing metadata per vendor", () => {
  it("OpenAI-compatible gateways (9Router, OpenRouter, Groq, Together, Fireworks, LM Studio, vLLM, Mistral, Moonshot)", () => {
    const list = parseModelList({
      data: [
        // 9Router
        { id: "glm/glm-5.3-flash", capabilities: { vision: true, tools: true, reasoning: true, contextWindow: 1000000, maxOutput: 131072 }, context_length: 1000000, max_completion_tokens: 131072 },
        // OpenRouter
        {
          id: "openai/gpt-4o-mini",
          name: "OpenAI: GPT-4o-mini",
          context_length: 128000,
          architecture: { input_modalities: ["text", "image"] },
          top_provider: { max_completion_tokens: 16384 },
          pricing: { prompt: "0.00000015", completion: "0.0000006" },
          supported_parameters: ["tools", "structured_outputs", "temperature"],
        },
        // Groq
        { id: "llama-3.3-70b-versatile", context_window: 131072, max_completion_tokens: 32768 },
        // Together
        { id: "BAAI/bge-large-en-v1.5", type: "embedding", context_length: 512, pricing: { input: 0.02, output: 0 } },
        { id: "openai/whisper-large-v3", type: "transcribe" },
        // Fireworks
        { id: "accounts/fireworks/models/qwen2p5-vl-32b-instruct", context_length: 128000, supports_chat: true, supports_image_input: true, supports_tools: false },
        // LM Studio /api/v0/models
        { id: "qwen2-vl-7b-instruct", type: "vlm", max_context_length: 32768 },
        { id: "text-embedding-nomic-embed-text-v1.5", type: "embeddings", max_context_length: 2048 },
        // vLLM
        { id: "Qwen/Qwen3-8B", max_model_len: 40960 },
        // Mistral
        { id: "pixtral-large-latest", max_context_length: 131072, capabilities: { completion_chat: true, function_calling: true, vision: true } },
        // Moonshot
        { id: "kimi-latest", context_length: 131072, supports_image_in: true, supports_reasoning: false },
      ],
    });
    const by = (id: string) => apiFieldsFromInfo(list.find((m) => m.id === id)!);
    expect(by("glm/glm-5.3-flash")).toEqual({ context_window: 1000000, max_output_tokens: 131072, vision: true, tools: true, reasoning: true });
    expect(by("openai/gpt-4o-mini")).toMatchObject({ display_name: "OpenAI: GPT-4o-mini", context_window: 128000, max_output_tokens: 16384, vision: true, tools: true, json_schema: true, input_price: 0.15, output_price: 0.6 });
    expect(by("llama-3.3-70b-versatile")).toEqual({ context_window: 131072, max_output_tokens: 32768 });
    expect(by("BAAI/bge-large-en-v1.5")).toMatchObject({ capability: "embedding", context_window: 512, input_price: 0.02 });
    expect(by("openai/whisper-large-v3")).toEqual({ capability: "asr" });
    expect(by("accounts/fireworks/models/qwen2p5-vl-32b-instruct")).toMatchObject({ capability: "chat", vision: true, tools: false, context_window: 128000 });
    expect(by("qwen2-vl-7b-instruct")).toMatchObject({ capability: "chat", vision: true, context_window: 32768 });
    expect(by("text-embedding-nomic-embed-text-v1.5")).toMatchObject({ capability: "embedding" });
    expect(by("Qwen/Qwen3-8B")).toEqual({ context_window: 40960 });
    expect(by("pixtral-large-latest")).toMatchObject({ capability: "chat", vision: true, tools: true, context_window: 131072 });
    expect(by("kimi-latest")).toMatchObject({ vision: true, reasoning: false });
  });

  it("Anthropic models API: max input/output tokens and capabilities", async () => {
    const c = createClient(
      "anthropic",
      {},
      { apiKey: "k" },
      {
        fetch: fakeFetch({
          "/models": {
            data: [{ id: "claude-sonnet-4-5", display_name: "Claude Sonnet 4.5", max_input_tokens: 200000, max_tokens: 64000, capabilities: { image_input: {}, thinking: {}, structured_outputs: {} } }],
            has_more: false,
          },
        }),
      },
    );
    const [m] = await c.listModels();
    expect(apiFieldsFromInfo(m!)).toEqual({ display_name: "Claude Sonnet 4.5", capability: "chat", context_window: 200000, max_output_tokens: 64000, vision: true, tools: true, reasoning: true, json_schema: true });
  });

  it("Gemini models.list: token limits and generation methods", async () => {
    const c = createClient(
      "gemini",
      {},
      { apiKey: "k" },
      {
        fetch: fakeFetch({
          "/models": {
            models: [
              { name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ["generateContent", "countTokens"], thinking: true },
              { name: "models/gemini-embedding-001", inputTokenLimit: 2048, supportedGenerationMethods: ["embedContent"] },
            ],
          },
        }),
      },
    );
    const ms = await c.listModels();
    expect(apiFieldsFromInfo(ms[0]!)).toEqual({ display_name: "Gemini 2.5 Flash", capability: "chat", context_window: 1048576, max_output_tokens: 65536, reasoning: true });
    expect(apiFieldsFromInfo(ms[1]!)).toMatchObject({ capability: "embedding", context_window: 2048 });
  });

  it("Ollama /api/show: context length, embedding size, capabilities", () => {
    expect(parseOllamaShow({ model_info: { "general.architecture": "qwen3", "qwen3.context_length": 40960 }, capabilities: ["completion", "tools", "thinking"] })).toEqual({
      contextWindow: 40960,
      kind: "chat",
      hints: { vision: false, tools: true, reasoning: true },
    });
    expect(parseOllamaShow({ model_info: { "general.architecture": "nomic-bert", "nomic-bert.context_length": 2048, "nomic-bert.embedding_length": 768 }, capabilities: ["embedding"] })).toMatchObject({
      kind: "embedding",
      dims: 768,
    });
    expect(parseOllamaShow({})).toEqual({});
  });
});

describe("settings file v1 → v2", () => {
  it("bound single-model routes become direct bindings; others become groups; vision params move to profiles", () => {
    const prov = { family: "llm", name: "閘道" };
    const v2 = upgradeV1({
      format: "speech-ai-hub.ai-settings",
      version: 1,
      providers: [{ family: "llm", kind: "openai-compatible", name: "閘道", config: {} }],
      routes: [
        { name: "便宜", capability: "chat", strategy: "single", members: [{ provider: prov, model: "a", child_route: null, weight: 1, params: { temperature: 0.2, max_tokens: 100 } }] },
        {
          name: "主要",
          capability: "chat",
          strategy: "fallback",
          members: [
            { provider: prov, model: "b", child_route: null, weight: 1, params: { vision: "yes" } },
            { provider: null, model: null, child_route: "便宜", weight: 1, params: {} },
          ],
        },
      ],
      roles: { writing: "便宜", assistant: "主要" },
    });
    expect(v2.version).toBe(2);
    expect(v2.groups.map((g) => g.name)).toEqual(["主要"]);
    expect(v2.groups[0]!.members.map((m) => m.model?.model_id)).toEqual(["b", "a"]);
    expect(v2.groups[0]!.members[0]!.params).toEqual({});
    expect(v2.bindings.writing).toEqual({ model: { provider: prov, model_id: "a" }, params: { temperature: 0.2 } });
    expect(v2.bindings.assistant).toEqual({ group: "主要" });
    expect(v2.models).toEqual([{ provider: prov, model_id: "b", enabled: true, overrides: { vision: true } }]);
  });
});
