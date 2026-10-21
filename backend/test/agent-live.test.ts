/**
 * Live agent loop against the test gateway (cheapest model only: glm/glm-5.3-flash, fallback glm/glm-5-turbo).
 * Skipped unless TEST_LLM_BASE_URL / TEST_LLM_API_KEY are set. One short conversation: a read tool, then a write
 * tool that waits for approval, approve, and the final answer.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aiFor } from "../src/ai/platform/index.js";
import { agentFor } from "../src/agent/runtime.js";
import { createTestContext, hasTestDb, ORIGIN, type TestContext } from "./helpers.js";
import { insertStudy } from "./study-fixtures.js";

process.env.PROVIDER_TOKEN_KEY ??= randomBytes(32).toString("base64");
const llmBase = process.env.TEST_LLM_BASE_URL;
const llmKey = process.env.TEST_LLM_API_KEY;

describe.skipIf(!hasTestDb || !llmBase || !llmKey)("agent (live, cheapest model)", () => {
  let t: TestContext;
  let alice: { id: string; cookie: string };
  let study: { id: string; slug: string };
  const send = (who: { cookie: string }, url: string, payload: object, method: "POST" | "PUT" | "PATCH" = "POST") => t.app.inject({ method, url, headers: { origin: ORIGIN, cookie: who.cookie }, payload });

  beforeAll(async () => {
    t = await createTestContext();
    const owner = await t.ownerCookie();
    alice = await t.login("student", "Alice");
    study = await insertStudy(t.db, alice.id, "中文語音情緒辨識");
    const p = (await send(owner, "/api/admin/ai/providers", { family: "llm", kind: "openai-compatible", name: "test gateway", config: { baseUrl: llmBase, timeoutMs: 90_000 }, secrets: { apiKey: llmKey } })).json();
    const route = (await send(owner, "/api/admin/ai/routes", { name: "助理（測試）", capability: "chat", strategy: "fallback", members: [{ provider_id: p.provider.id, model: "glm/glm-5.3-flash" }, { provider_id: p.provider.id, model: "glm/glm-5-turbo" }] })).json();
    for (const role of ["assistant", "fast"]) expect((await send(owner, `/api/admin/ai/roles/${role}`, { route_id: route.route.id }, "PUT")).statusCode).toBe(200);
    aiFor(t.app).invalidate();
    agentFor(t.app).options.maxOutputTokens = 600;
  });
  afterAll(async () => {
    await agentFor(t.app).settle();
    await aiFor(t.app).logger.flush().catch(() => {});
    await t?.close();
  });

  it("reads, asks before writing, writes after approval", async () => {
    const conv = (await send(alice, "/api/agent/conversations", {})).json().conversation.id;
    const r = await send(alice, `/api/agent/conversations/${conv}/messages`, {
      text: `請先用 get_study 讀取研究 ${study.slug}，然後在這個研究用 create_task 新增一個待辦「整理 baseline 結果」。回答一句話就好。`,
    });
    expect(r.statusCode, r.body).toBe(202);
    await agentFor(t.app).settle();
    let s = (await t.app.inject({ method: "GET", url: `/api/agent/conversations/${conv}`, headers: { cookie: alice.cookie } })).json();
    const tools = s.toolCalls.map((c: { tool: string; status: string }) => `${c.tool}:${c.status}`);
    expect(tools, JSON.stringify(s.run)).toContain("get_study:done");
    const pending = s.toolCalls.find((c: { tool: string; status: string }) => c.tool === "create_task" && c.status === "pending_approval");
    expect(pending, JSON.stringify(tools)).toBeTruthy();
    expect(s.run.status).toBe("awaiting_approval");
    await send(alice, `/api/agent/tool-calls/${pending.id}/decision`, { decision: "approve" });
    await agentFor(t.app).settle();
    s = (await t.app.inject({ method: "GET", url: `/api/agent/conversations/${conv}`, headers: { cookie: alice.cookie } })).json();
    expect(s.run.status, JSON.stringify(s.run)).toBe("done");
    expect((await t.db.query("SELECT source FROM tasks WHERE study_id=$1", [study.id])).rows).toEqual([{ source: "ai" }]);
    expect(s.messages.at(-1).text.length).toBeGreaterThan(0);
  });
});
