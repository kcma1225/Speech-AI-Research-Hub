/**
 * Live smoke test of the generic OpenAI-compatible codec. Skipped unless
 *   TEST_LLM_BASE_URL=https://.../v1 TEST_LLM_API_KEY=... [TEST_LLM_MODEL=...] [TEST_LLM_EMBED_MODEL=...]
 * Uses the cheapest model with tiny prompts / max_tokens.
 */
import { describe, expect, it } from "vitest";
import { AiError, createClient } from "../src/ai/providers/index.js";

const base = process.env.TEST_LLM_BASE_URL;
const key = process.env.TEST_LLM_API_KEY;
const live = Boolean(base && key);
const MODELS = (process.env.TEST_LLM_MODEL ?? "glm/glm-5.3-flash,glm/glm-5-turbo").split(",");

describe.skipIf(!live)("live OpenAI-compatible endpoint", () => {
  const client = createClient("openai-compatible", { baseUrl: base, timeoutMs: 60_000 }, { apiKey: key! });
  let model = MODELS[0]!;

  it("lists models and probes", async () => {
    const models = await client.listModels();
    expect(models.length).toBeGreaterThan(0);
    const ids = new Set(models.map((m) => m.id));
    model = MODELS.find((m) => ids.has(m)) ?? model;
    const probe = await client.probe();
    expect(probe.ok).toBe(true);
  });

  it("streams a short reply", async () => {
    const events: string[] = [];
    let text = "";
    for await (const ev of client.chatStream({ model, maxTokens: 256, messages: [{ role: "user", content: "Reply with the single word: pong" }] })) {
      events.push(ev.type);
      if (ev.type === "text_delta") text += ev.text;
      if (ev.type === "error") throw ev.error;
    }
    expect(events.at(-1)).toBe("done");
    expect(text.toLowerCase()).toContain("pong");
  });

  it("makes a tool call and round-trips the result", async () => {
    const tools = [
      {
        name: "get_weather",
        description: "Get the weather for a city",
        inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      },
    ];
    const messages = [{ role: "user" as const, content: "What is the weather in Taipei? Use the tool." }];
    const r1 = await client.chat({ model, maxTokens: 512, tools, toolChoice: "auto", messages });
    expect(r1.stopReason).toBe("tool_use");
    const call = r1.toolCalls[0]!;
    expect(call.name).toBe("get_weather");
    expect(String((call.input as { city?: string }).city).toLowerCase()).toContain("taipei");
    const r2 = await client.chat({
      model,
      maxTokens: 256,
      tools,
      messages: [...messages, r1.message, { role: "tool", content: [{ type: "tool_result", tool_use_id: call.id, content: "Sunny, 25°C" }] }],
    });
    expect(r2.text).toMatch(/25|sunny|晴/i);
  });

  it("maps an unknown model to an AiError", async () => {
    await expect(client.chat({ model: "definitely-not-a-model-xyz", maxTokens: 8, messages: [{ role: "user", content: "hi" }] })).rejects.toBeInstanceOf(AiError);
  });

  it.skipIf(!process.env.TEST_LLM_EMBED_MODEL)("embeds", async () => {
    const r = await client.embed({ model: process.env.TEST_LLM_EMBED_MODEL!, inputs: ["hello"], inputType: "query" });
    expect(r.dims).toBeGreaterThan(0);
  });
});
