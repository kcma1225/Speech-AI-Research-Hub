/**
 * Live router run against the user's test gateway (skipped unless TEST_LLM_BASE_URL / TEST_LLM_API_KEY and a test DB
 * are set). Cheapest models only: glm/glm-5.3-flash with glm/glm-5-turbo as fallback, tiny prompts.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aiFor } from "../src/ai/platform/index.js";
import { createTestContext, hasTestDb, ORIGIN, type TestContext } from "./helpers.js";

process.env.PROVIDER_TOKEN_KEY ??= randomBytes(32).toString("base64");
const base = process.env.TEST_LLM_BASE_URL;
const key = process.env.TEST_LLM_API_KEY;

describe.skipIf(!(base && key && hasTestDb))("live AI platform router", () => {
  let t: TestContext;
  let cookie = "";
  beforeAll(async () => {
    t = await createTestContext();
    cookie = (await t.ownerCookie()).cookie;
  });
  afterAll(async () => {
    await aiFor(t.app).logger.flush();
    await t?.close();
  });
  const send = (url: string, payload: object, method: "POST" | "PUT" = "POST") => t.app.inject({ method, url, headers: { origin: ORIGIN, cookie }, payload });

  it("routes the fast role through the gateway (cheapest model, fallback configured)", async () => {
    const p = (await send("/api/admin/ai/providers", { family: "llm", kind: "openai-compatible", name: "test gateway", config: { baseUrl: base, timeoutMs: 60_000 }, secrets: { apiKey: key } })).json();
    const r = (
      await send("/api/admin/ai/routes", {
        name: "測試（最便宜）",
        capability: "chat",
        strategy: "fallback",
        members: [{ provider_id: p.provider.id, model: "glm/glm-5.3-flash" }, { provider_id: p.provider.id, model: "glm/glm-5-turbo" }],
      })
    ).json();
    expect((await send("/api/admin/ai/roles/fast", { route_id: r.route.id }, "PUT")).statusCode).toBe(200);
    const platform = aiFor(t.app);
    const res = await platform.chat("fast", { messages: [{ role: "user", content: "Reply with the single word: pong" }], maxTokens: 256 });
    expect(res.text.toLowerCase()).toContain("pong");
    expect(res.route?.model).toMatch(/glm/);
    let streamed = "";
    for await (const ev of platform.chatStream("fast", { messages: [{ role: "user", content: "Say: ok" }], maxTokens: 128 })) {
      if (ev.type === "text_delta") streamed += ev.text;
      if (ev.type === "error") throw ev.error;
    }
    expect(streamed.length).toBeGreaterThan(0);
    await platform.logger.flush();
    const rows = (await t.db.query("SELECT ok, final, model, tokens_in, tokens_out, latency_ms FROM ai_call_log WHERE final ORDER BY id")).rows;
    expect(rows.every((x) => x.ok)).toBe(true);
    console.log("live call log:", JSON.stringify(rows));
    const test = (await send(`/api/admin/ai/providers/${p.provider.id}/test`, {})).json();
    expect(test.probe.ok).toBe(true);
  });
});
