import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LightMyRequestResponse } from "fastify";
import { aiFor, type AiPlatform } from "../src/ai/platform/index.js";
import { registerEmbeddingSource } from "../src/ai/embedding/sources.js";
import { searchSpace, getSpace } from "../src/ai/embedding/spaces.js";
import "../src/ai/embedding/reindex-job.js";
import { registerAiJob } from "../src/ai-worker/registry.js";
import { AiJobRunner } from "../src/ai-worker/runner.js";
import { enqueueJob } from "../src/jobs/queue.js";
import { createTestContext, hasTestDb, ORIGIN, type TestContext } from "./helpers.js";
import { MockServer, sse } from "./ai-providers-mock.js";

process.env.PROVIDER_TOKEN_KEY ??= randomBytes(32).toString("base64");

type Session = { id: string; cookie: string };
const DIMS = 16;
const h = (s: string) => parseInt(createHash("sha1").update(s).digest("hex").slice(0, 8), 16) / 0xffffffff;
const fakeVec = (model: string, text: string) => Array.from({ length: DIMS }, (_, j) => Math.sin(h(model) * 97 * (j + 1) + h(text) * 13));

// Uses the deprecated v1 admin shape (routes / roles) on purpose: it must keep working for scripts and callers.
describe.skipIf(!hasTestDb)("AI platform API (v1 routes API compatibility)", () => {
  let t: TestContext;
  let admin: Session;
  let student: Session;
  let platform: AiPlatform;
  const A = new MockServer();
  const B = new MockServer();
  let aDown = true;
  const json = (r: LightMyRequestResponse) => r.json() as Record<string, any>;
  const send = (who: Session | null, method: "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: object) =>
    t.app.inject({ method, url, headers: { origin: ORIGIN, ...(who ? { cookie: who.cookie } : {}) }, ...(payload ? { payload } : {}) });
  const get = (who: Session | null, url: string) => t.app.inject({ method: "GET", url, headers: who ? { cookie: who.cookie } : {} });

  const ok = (text: string) => ({
    chunks: sse([
      { choices: [{ index: 0, delta: { role: "assistant", content: text } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } },
    ]),
  });

  beforeAll(async () => {
    for (const [srv, label] of [[A, "A"], [B, "B"]] as const) {
      await srv.start();
      srv.on("GET", "/v1/models", { body: { object: "list", data: [{ id: `model-${label.toLowerCase()}` }, { id: "emb-1" }, { id: "emb-2" }] } });
      srv.on("POST", "/v1/chat/completions", () => (label === "A" && aDown ? { status: 503, body: { error: { message: "down" } } } : ok(`來自 ${label}`)));
      srv.on("POST", "/v1/embeddings", (req) => ({
        body: { object: "list", model: req.json.model, data: (req.json.input as string[]).map((x, index) => ({ index, embedding: fakeVec(req.json.model, x) })), usage: { prompt_tokens: 3 } },
      }));
    }
    t = await createTestContext();
    platform = aiFor(t.app);
    admin = await t.ownerCookie();
    student = await t.login("student", "Stu");
  });
  afterAll(async () => {
    await platform?.logger.flush();
    await t?.close();
    await A.stop();
    await B.stop();
  });

  const ids: Record<string, string> = {};

  it("requires an admin and answers with code + hint", async () => {
    const r = await get(student, "/api/admin/ai/providers");
    expect(r.statusCode).toBe(403);
    expect(json(r)).toMatchObject({ code: "forbidden" });
    expect(json(r).hint).toBeTruthy();
    expect((await get(null, "/api/admin/ai/registry")).statusCode).toBe(401);
    const reg = json(await get(admin, "/api/admin/ai/registry"));
    expect(reg.llm.map((e: { id: string }) => e.id)).toEqual(expect.arrayContaining(["openai", "chatgpt", "claude-oauth", "claude-cli", "openai-compatible"]));
    expect(reg.asr.length).toBeGreaterThan(5);
    expect(reg.secrets_key_configured).toBe(true);
  });

  it("creates providers with write-only secrets and tests them", async () => {
    const bad = await send(admin, "POST", "/api/admin/ai/providers", { family: "llm", kind: "openai-compatible", name: "壞的", config: {} });
    expect(bad.statusCode).toBe(400);
    expect(json(bad)).toMatchObject({ code: "provider_invalid" });
    for (const [key, srv] of [["A", A], ["B", B]] as const) {
      const r = await send(admin, "POST", "/api/admin/ai/providers", {
        family: "llm",
        kind: "openai-compatible",
        name: `閘道 ${key}`,
        config: { baseUrl: `${srv.url}/v1` },
        secrets: { apiKey: `sk-secret-${key}` },
      });
      expect(r.statusCode).toBe(201);
      expect(r.body).not.toContain("sk-secret");
      expect(json(r).provider.secrets_set).toEqual({ apiKey: true });
      ids[key] = json(r).provider.id;
    }
    const row = (await t.db.query("SELECT secrets FROM ai_providers WHERE id=$1", [ids.A])).rows[0];
    expect(Buffer.from(row.secrets).toString("latin1")).not.toContain("sk-secret");
    const test = json(await send(admin, "POST", `/api/admin/ai/providers/${ids.A}/test`, {}));
    expect(test.probe.ok).toBe(true);
    expect(test.models.map((m: { id: string }) => m.id)).toContain("model-a");
    expect(A.requests.some((q) => q.headers.authorization === "Bearer sk-secret-A")).toBe(true);
    const renamed = await send(admin, "PATCH", `/api/admin/ai/providers/${ids.A}`, { name: "閘道 A（主）" });
    expect(json(renamed).provider.secrets_set.apiKey).toBe(true);
    const list = await get(admin, "/api/admin/ai/providers");
    expect(list.body).not.toContain("sk-secret");
  });

  it("saves routes with nested members and rejects cycles", async () => {
    const sub = await send(admin, "POST", "/api/admin/ai/routes", { name: "備援", capability: "chat", strategy: "fallback", members: [{ provider_id: ids.B, model: "model-b" }] });
    expect(sub.statusCode).toBe(201);
    ids.sub = json(sub).route.id;
    const main = await send(admin, "POST", "/api/admin/ai/routes", {
      name: "主要",
      capability: "chat",
      strategy: "fallback",
      members: [{ provider_id: ids.A, model: "model-a", params: { temperature: 0.3, max_retries: 0 } }, { child_route_id: ids.sub }],
    });
    expect(main.statusCode).toBe(201);
    ids.main = json(main).route.id;
    const cyc = await send(admin, "PUT", `/api/admin/ai/routes/${ids.sub}`, { name: "備援", capability: "chat", strategy: "fallback", members: [{ child_route_id: ids.main }] });
    expect(cyc.statusCode).toBe(400);
    expect(json(cyc).code).toBe("route_cycle");
    const badParam = await send(admin, "POST", "/api/admin/ai/routes", { name: "x", capability: "chat", strategy: "single", members: [{ provider_id: ids.A, model: "m", params: { bogus: 1 } }] });
    expect(json(badParam).code).toBe("route_invalid");
    const bind = await send(admin, "PUT", "/api/admin/ai/roles/writing", { route_id: ids.main });
    expect(bind.statusCode).toBe(200);
    const mismatch = await send(admin, "PUT", "/api/admin/ai/roles/asr", { route_id: ids.main });
    expect(json(mismatch).code).toBe("capability_mismatch");
    expect(json(await send(admin, "DELETE", `/api/admin/ai/routes/${ids.sub}`)).code).toBe("route_in_use");
    expect(json(await send(admin, "DELETE", `/api/admin/ai/providers/${ids.B}`)).code).toBe("provider_in_use");
  });

  it("routes chat with fallback, logs calls without content, and derives health", async () => {
    aDown = true;
    const r = await platform.chat("writing", { messages: [{ role: "user", content: "秘密內容 12345" }], maxTokens: 20 }, { userId: student.id });
    expect(r.text).toBe("來自 B");
    expect(r.route).toMatchObject({ providerId: ids.B, model: "model-b", fallbackIndex: 1 });
    expect(A.requests.find((q) => q.path === "/v1/chat/completions")?.json.temperature).toBe(0.3);
    await platform.logger.flush();
    const rows = (await t.db.query("SELECT * FROM ai_call_log ORDER BY id")).rows;
    expect(rows.map((x) => [x.provider_id, x.ok, x.final, x.error_code])).toEqual([
      [ids.A, false, false, "overloaded"],
      [ids.B, true, true, null],
    ]);
    expect(rows[1].tokens_in).toBe(7);
    expect(JSON.stringify(rows)).not.toContain("12345");
    const status = json(await get(student, "/api/ai/status"));
    expect(status.roles.writing.state).toBe("degraded");
    expect(status.roles.assistant.state).toBe("unconfigured");
    expect(JSON.stringify(status)).not.toMatch(/model-|閘道|provider/);
    expect(status.search_mode).toBe("keyword_only");

    const stats = json(await get(admin, "/api/admin/ai/stats?window=1h"));
    expect(stats.roles.find((x: { role: string }) => x.role === "writing")).toMatchObject({ calls: 1, ok: 1, fallbacks: 1 });
    expect(stats.members.find((x: { provider_id: string }) => x.provider_id === ids.A)).toMatchObject({ calls: 1, ok: 0 });
    expect(stats.errors).toEqual([{ error_code: "overloaded", count: 1 }]);
    const calls = json(await get(admin, `/api/admin/ai/calls?ok=false&provider_id=${ids.A}`));
    expect(calls.calls).toHaveLength(1);
    expect(calls.calls[0]).toMatchObject({ provider_name: "閘道 A（主）", user_name: "Stu" });

    aDown = false;
    const again = await platform.chat("writing", { messages: [{ role: "user", content: "hi" }] });
    expect(again.text).toBe("來自 A");
    expect((await platform.recompute()).find((s) => s.role === "writing")?.state).toBe("ok");
  });

  it("raises llm_unavailable when unconfigured or every member fails", async () => {
    await expect(platform.chat("assistant", { messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ code: "llm_unavailable" });
    aDown = true;
    B.reset();
    B.on("POST", "/v1/chat/completions", { status: 500, body: { error: { message: "boom" } } });
    const err = await platform.chat("writing", { messages: [{ role: "user", content: "x" }] }).catch((e) => e);
    expect(err.code).toBe("llm_unavailable");
    expect(err.detail.attempts.map((a: { code: string }) => a.code)).toEqual(["overloaded", "unavailable"]);
    const st = await platform.recompute();
    expect(st.find((s) => s.role === "writing")?.state).toBe("unavailable");
    B.reset();
    B.on("GET", "/v1/models", { body: { data: [{ id: "model-b" }] } });
    B.on("POST", "/v1/chat/completions", () => ok("來自 B"));
    B.on("POST", "/v1/embeddings", (req) => ({ body: { data: (req.json.input as string[]).map((x, index) => ({ index, embedding: fakeVec(req.json.model, x) })) } }));
    aDown = false;
  });

  it("pauses ai-worker jobs on llm_unavailable and resumes them", async () => {
    let ran = 0;
    registerAiJob<{ n: number }>("ai_test_llm", {
      roles: ["analysis"],
      async run({ ai, job, signal }) {
        ran++;
        const r = await ai.chat("analysis", { messages: [{ role: "user", content: String(job.payload.n) }] }, { jobId: job.id, signal });
        return { text: r.text };
      },
    });
    const jobId = await enqueueJob(t.db, "ai_test_llm", { n: 1 }, null, 2);
    const runner = new AiJobRunner(t.db, t.storage, platform, t.app.log, { heartbeatMs: 60_000 });
    const claimed = (await runner.claim())!;
    expect(claimed.id).toBe(jobId);
    expect(await runner.execute(claimed)).toBe("waiting_llm");
    const row = (await t.db.query("SELECT status, attempts, stage, run_after > now() + interval '100 seconds' AS later FROM jobs WHERE id=$1", [jobId])).rows[0];
    expect(row).toMatchObject({ status: "queued", attempts: 0, stage: "waiting_llm", later: true });
    expect((await t.db.query("SELECT llm_waits FROM ai_job_state WHERE job_id=$1", [jobId])).rows[0].llm_waits).toBe(1);
    expect(runner.pausedRoles()).toEqual(["analysis"]);
    expect(runner.claimableKinds()).not.toContain("ai_test_llm");
    expect(await runner.claim()).toBeNull();

    await send(admin, "PUT", "/api/admin/ai/roles/analysis", { route_id: ids.main });
    await runner.resume("analysis");
    const again = (await runner.claim())!;
    expect(again.id).toBe(jobId);
    expect(await runner.execute(again)).toBe("succeeded");
    expect(ran).toBe(2);
    const done = (await t.db.query("SELECT status, attempts, result FROM jobs WHERE id=$1", [jobId])).rows[0];
    expect(done).toMatchObject({ status: "succeeded", attempts: 1, result: { text: "來自 A" } });

    // Regression: a restarted worker has no pause state, yet jobs requeued by the old process still wait.
    const waiting = await enqueueJob(t.db, "ai_test_llm", { n: 2 }, null, 2);
    await t.db.query("UPDATE jobs SET stage='waiting_llm', run_after=now() + interval '20 minutes' WHERE id=$1", [waiting]);
    const fresh = new AiJobRunner(t.db, t.storage, platform, t.app.log, { heartbeatMs: 60_000 });
    expect(fresh.pausedRoles()).toEqual([]);
    await fresh.resume("analysis");
    expect((await t.db.query("SELECT run_after <= now() AS due FROM jobs WHERE id=$1", [waiting])).rows[0].due).toBe(true);
    await t.db.query("DELETE FROM jobs WHERE id=$1", [waiting]);
  });

  it("guards the embedding identity and runs the switch wizard", async () => {
    const docs = [
      { id: "11111111-1111-4111-8111-111111111111", text: "語音情緒辨識" },
      { id: "22222222-2222-4222-8222-222222222222", text: "會議逐字稿" },
    ];
    registerEmbeddingSource("test_doc", {
      count: async () => docs.length,
      async *iterate() {
        for (const d of docs) yield { ownerId: d.id, chunks: [{ index: 0, text: d.text }] };
      },
    });
    const mk = async (name: string, members: object[]) => json(await send(admin, "POST", "/api/admin/ai/routes", { name, capability: "embedding", strategy: "fallback", members })).route.id as string;
    // Same model on two servers (failover) vs a different model.
    const e1 = await mk("嵌入一", [{ provider_id: ids.A, model: "emb-1" }, { provider_id: ids.B, model: "emb-1" }]);
    const e2 = await mk("嵌入二", [{ provider_id: ids.B, model: "emb-2" }]);
    const mixed = await mk("混合", [{ provider_id: ids.A, model: "emb-1" }, { provider_id: ids.B, model: "emb-2" }]);

    expect(json(await send(admin, "PUT", "/api/admin/ai/roles/embedding", { route_id: mixed })).code).toBe("route_invalid");
    const first = json(await send(admin, "PUT", "/api/admin/ai/roles/embedding", { route_id: e1 }));
    expect(first.created_space).toMatchObject({ status: "active", dims: DIMS, model: "emb-1" });
    const conflict = await send(admin, "PUT", "/api/admin/ai/roles/embedding", { route_id: e2 });
    expect(conflict.statusCode).toBe(409);
    expect(json(conflict).code).toBe("embedding_model_change_requires_switch");
    // Editing the bound route to another model is caught too.
    const edit = await send(admin, "PUT", `/api/admin/ai/routes/${e1}`, { name: "嵌入一", capability: "embedding", strategy: "fallback", members: [{ provider_id: ids.A, model: "emb-2" }] });
    expect(json(edit).code).toBe("embedding_model_change_requires_switch");
    const pre = json(await send(admin, "POST", "/api/admin/ai/embedding/precheck", { route_id: e2 }));
    expect(pre).toMatchObject({ same_identity: false, action: "switch" });
    expect(pre.comparison.minCosine).toBeLessThan(0.95);

    const runner = new AiJobRunner(t.db, t.storage, platform, t.app.log, { heartbeatMs: 60_000 });
    const job1 = (await runner.claim())!;
    expect(job1.kind).toBe("ai_embedding_reindex");
    expect(await runner.execute(job1)).toBe("succeeded");
    const active = await getSpace(t.db, first.created_space.id);
    expect(active).toMatchObject({ status: "active", items_done: 2 });

    const sw = await send(admin, "POST", "/api/admin/ai/embedding/switch", { route_id: e2 });
    expect(sw.statusCode).toBe(201);
    const space = json(sw).space;
    expect(json(await send(admin, "POST", `/api/admin/ai/embedding/spaces/${space.id}/flip`)).code).toBe("route_invalid");
    expect(json(await send(admin, "POST", "/api/admin/ai/embedding/switch", { route_id: e2 })).code).toBe("embedding_switch_in_progress");
    // Indexers write into both live spaces meanwhile.
    expect((await platform.embedForIndex(["新內容"])).map((x) => x.space.id).sort()).toEqual([first.created_space.id, space.id].sort());
    const job2 = (await runner.claim())!;
    expect(await runner.execute(job2)).toBe("succeeded");
    expect((await getSpace(t.db, space.id))?.status).toBe("ready");
    const flipped = json(await send(admin, "POST", `/api/admin/ai/embedding/spaces/${space.id}/flip`));
    expect(flipped.activeSpaceId).toBe(space.id);
    expect(flipped.spaces.find((s: { id: string }) => s.id === first.created_space.id).status).toBe("retired");
    expect(json(await get(admin, "/api/admin/ai/roles")).roles.find((r: { role: string }) => r.role === "embedding").route_id).toBe(e2);

    const q = await platform.embed(["語音情緒辨識"], "query");
    expect(q.spaceId).toBe(space.id);
    const hits = await searchSpace(t.db, { id: space.id, dims: DIMS }, q.vectors[0]!, { limit: 2 });
    expect(hits[0]).toMatchObject({ owner_type: "test_doc", owner_id: docs[0]!.id });
    expect(hits[0]!.distance).toBeLessThan(0.01);
    expect((await platform.embeddingState()).mode).toBe("semantic");
    expect(json(await send(admin, "DELETE", `/api/admin/ai/embedding/spaces/${first.created_space.id}`)).spaces).toHaveLength(2 - 1);
  });

  it("exports without secrets unless asked, and imports idempotently", async () => {
    const plain = await get(admin, "/api/admin/ai/export");
    expect(plain.statusCode).toBe(200);
    expect(plain.body).not.toContain("sk-secret");
    const file = json(plain);
    expect(file).toMatchObject({ format: "speech-ai-hub.ai-settings", version: 2, secret: false });
    const secret = json(await get(admin, "/api/admin/ai/export?include_secrets=1"));
    expect(JSON.stringify(secret)).toContain("sk-secret-A");
    const imp = json(await send(admin, "POST", "/api/admin/ai/import", { file: secret, include_secrets: true }));
    expect(imp).toMatchObject({ providers_created: 0, providers_updated: 2, groups_created: 0 });
    expect(imp.warnings).toEqual([]);
    expect(json(await send(admin, "POST", "/api/admin/ai/import", { file: { format: "nope" } })).code).toBe("import_invalid");
    const r = await platform.chat("writing", { messages: [{ role: "user", content: "hi" }] });
    expect(r.text).toBe("來自 A");
    expect(json(await send(student, "POST", "/api/admin/ai/import", { file: secret })).code).toBe("forbidden");
  });
});
