/**
 * AI platform v2 routing API: model profiles (sync, sources, overrides, visibility), nested groups (cycles,
 * depth, strategies), bulk role binding, limits from profiles, export v2 / import v1, and callers' API unchanged.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LightMyRequestResponse } from "fastify";
import { aiFor, type AiPlatform } from "../src/ai/platform/index.js";
import { createTestContext, hasTestDb, ORIGIN, type TestContext } from "./helpers.js";
import { MockServer, sse } from "./ai-providers-mock.js";

process.env.PROVIDER_TOKEN_KEY ??= randomBytes(32).toString("base64");

type Session = { id: string; cookie: string };

describe.skipIf(!hasTestDb)("AI routing v2 (profiles, groups, bulk bindings)", () => {
  let t: TestContext;
  let admin: Session;
  let student: Session;
  let platform: AiPlatform;
  const G = new MockServer();
  const down = new Set<string>();
  const json = (r: LightMyRequestResponse) => r.json() as Record<string, any>;
  const send = (who: Session, method: "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: object) =>
    t.app.inject({ method, url, headers: { origin: ORIGIN, cookie: who.cookie }, ...(payload ? { payload } : {}) });
  const get = (who: Session, url: string) => t.app.inject({ method: "GET", url, headers: { cookie: who.cookie } });
  const ids: Record<string, string> = {};
  const modelId = async (name: string) => (json(await get(admin, `/api/admin/ai/models?provider_id=${ids.p}`)).models as Array<{ id: string; model_id: string }>).find((m) => m.model_id === name)!.id;

  beforeAll(async () => {
    await G.start();
    G.on("GET", "/v1/models", {
      body: {
        data: [
          { id: "glm/glm-5.3-flash", capabilities: { vision: true, tools: true, reasoning: true, contextWindow: 1000000, maxOutput: 131072 }, context_length: 1000000, max_completion_tokens: 131072 },
          { id: "glm/glm-5-turbo", capabilities: { vision: false, tools: true }, context_length: 200000 },
          { id: "gpt-4o-mini" },
          { id: "dall-e-3" },
        ],
      },
    });
    G.on("POST", "/v1/chat/completions", (req) =>
      down.has(req.json.model)
        ? { status: 503, body: { error: { message: "down" } } }
        : { chunks: sse([{ choices: [{ index: 0, delta: { role: "assistant", content: `來自 ${req.json.model}` } }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }]) },
    );
    t = await createTestContext();
    platform = aiFor(t.app);
    admin = await t.ownerCookie();
    student = await t.login("student", "Stu");
    const p = await send(admin, "POST", "/api/admin/ai/providers", { family: "llm", kind: "openai-compatible", name: "閘道", config: { baseUrl: `${G.url}/v1` }, secrets: { apiKey: "k" } });
    ids.p = json(p).provider.id;
  });
  afterAll(async () => {
    await platform?.logger.flush();
    await t?.close();
    await G.stop();
  });

  it("syncs the account's models into profiles with per-field sources; non-text models start hidden", async () => {
    const r = json(await send(admin, "POST", `/api/admin/ai/providers/${ids.p}/sync`));
    expect(r.count).toBe(4);
    const by = (id: string) => r.models.find((m: { model_id: string }) => m.model_id === id);
    expect(by("glm/glm-5.3-flash")).toMatchObject({
      enabled: true,
      listed: true,
      fields: { capability: "chat", context_window: 1000000, max_output_tokens: 131072, vision: true, tools: true },
      sources: { context_window: "provider_api", vision: "provider_api", capability: "catalog" },
      catalog_id: "zhipu.glm-5",
    });
    // Nothing from the listing: the catalog fills in.
    expect(by("gpt-4o-mini")).toMatchObject({ fields: { context_window: 128000, vision: true }, sources: { context_window: "catalog" } });
    expect(by("dall-e-3").enabled).toBe(false);
    expect((await get(student, "/api/admin/ai/models")).statusCode).toBe(403);
  });

  it("manual overrides win and can be cleared; visibility can be toggled in bulk", async () => {
    const id = await modelId("gpt-4o-mini");
    const r = json(await send(admin, "PATCH", `/api/admin/ai/models/${id}`, { overrides: { context_window: 64000, tools: false } }));
    expect(r.model).toMatchObject({ fields: { context_window: 64000, tools: false }, sources: { context_window: "manual", tools: "manual" } });
    const cleared = json(await send(admin, "PATCH", `/api/admin/ai/models/${id}`, { overrides: { context_window: null } }));
    expect(cleared.model).toMatchObject({ fields: { context_window: 128000, tools: false }, sources: { context_window: "catalog" } });
    expect(json(await send(admin, "PATCH", `/api/admin/ai/models/${id}`, { overrides: { context_window: "lots" } })).code).toBe("route_invalid");
    const vis = json(await send(admin, "POST", "/api/admin/ai/models/visibility", { ids: [id], enabled: false }));
    expect(vis.updated).toBe(1);
    await send(admin, "POST", "/api/admin/ai/models/visibility", { ids: [id], enabled: true });
    // A model id the listing does not show.
    const added = await send(admin, "POST", "/api/admin/ai/models", { provider_id: ids.p, model_id: "my-finetune", overrides: { max_output_tokens: 2048 } });
    expect(added.statusCode).toBe(201);
    expect(json(added).model).toMatchObject({ origin: "manual", listed: false, fields: { capability: "chat", max_output_tokens: 2048 } });
    // A re-sync keeps manual rows and overrides.
    await send(admin, "POST", `/api/admin/ai/providers/${ids.p}/sync`);
    const after = json(await get(admin, `/api/admin/ai/models?provider_id=${ids.p}`)).models;
    expect(after.find((m: { model_id: string }) => m.model_id === "my-finetune")).toBeTruthy();
    expect(after.find((m: { model_id: string }) => m.model_id === "gpt-4o-mini").overrides).toEqual({ tools: false });
  });

  it("nests groups, rejects cycles and over-deep nesting", async () => {
    const flash = await modelId("glm/glm-5.3-flash");
    const turbo = await modelId("glm/glm-5-turbo");
    const inner = await send(admin, "POST", "/api/admin/ai/groups", { name: "備援", capability: "chat", strategy: "fallback", members: [{ model_id: turbo }] });
    expect(inner.statusCode).toBe(201);
    ids.inner = json(inner).group.id;
    const outer = await send(admin, "POST", "/api/admin/ai/groups", { name: "主要", capability: "chat", strategy: "fallback", members: [{ model_id: flash, params: { max_retries: 0 } }, { child_group_id: ids.inner }] });
    expect(outer.statusCode).toBe(201);
    ids.outer = json(outer).group.id;
    expect(json(outer).group.members.map((m: { model_id: string | null; child_group_name: string | null }) => m.model_id ?? m.child_group_name)).toEqual(["glm/glm-5.3-flash", "備援"]);
    const cyc = await send(admin, "PUT", `/api/admin/ai/groups/${ids.inner}`, { name: "備援", capability: "chat", strategy: "fallback", members: [{ child_group_id: ids.outer }] });
    expect(json(cyc).code).toBe("route_cycle");
    // Embedding model in a chat group: refused with the reason.
    const emb = await send(admin, "POST", "/api/admin/ai/groups", { name: "x", capability: "embedding", strategy: "fallback", members: [{ model_id: flash }] });
    expect(json(emb).code).toBe("route_invalid");
    // Limits are not params.
    expect(json(await send(admin, "POST", "/api/admin/ai/groups", { name: "y", capability: "chat", strategy: "fallback", members: [{ model_id: flash, params: { max_tokens: 5 } }] })).code).toBe("route_invalid");
    // Depth: a chain of 7 levels is refused.
    let prev = ids.inner!;
    let deepErr: Record<string, any> | null = null;
    for (let i = 0; i < 7; i++) {
      const r = await send(admin, "POST", "/api/admin/ai/groups", { name: `層${i}`, capability: "chat", strategy: "fallback", members: [{ child_group_id: prev }] });
      if (r.statusCode !== 201) {
        deepErr = json(r);
        break;
      }
      prev = json(r).group.id;
    }
    expect(deepErr?.message ?? deepErr?.error).toContain("最多 6 層");
  });

  it("bulk-binds several roles to one target, rejects mixed capabilities, unbinds", async () => {
    const r = await send(admin, "PUT", "/api/admin/ai/bindings", { roles: ["assistant", "writing", "slides", "analysis", "fast"], target: { group_id: ids.outer } });
    expect(r.statusCode).toBe(200);
    const b = json(r).bindings as Array<{ role: string; target: { type: string; group_id?: string } | null; status: { state: string } | null }>;
    expect(b.filter((x) => x.target?.group_id === ids.outer).map((x) => x.role)).toEqual(["assistant", "writing", "slides", "analysis", "fast"]);
    expect(b.find((x) => x.role === "writing")!.status!.state).toBe("ok");
    const mixed = await send(admin, "PUT", "/api/admin/ai/bindings", { roles: ["writing", "embedding"], target: { group_id: ids.outer } });
    expect(json(mixed).code).toBe("capability_mismatch");
    // Direct model binding with request params (quick change for one role).
    const turbo = await modelId("glm/glm-5-turbo");
    const one = json(await send(admin, "PUT", "/api/admin/ai/bindings/fast", { target: { model_id: turbo }, params: { temperature: 0.1 } }));
    expect(one.bindings.find((x: { role: string }) => x.role === "fast")).toMatchObject({ target: { type: "model", model_id: turbo }, params: { temperature: 0.1 } });
    // Binding by account + vendor model id creates the profile.
    const byName = json(await send(admin, "PUT", "/api/admin/ai/bindings/analysis", { target: { provider_id: ids.p, model: "glm/glm-5" } }));
    expect(byName.bindings.find((x: { role: string }) => x.role === "analysis").target).toMatchObject({ type: "model", name: "glm/glm-5" });
    // Deleting a used group / model is refused.
    expect(json(await send(admin, "DELETE", `/api/admin/ai/groups/${ids.inner}`)).code).toBe("route_in_use");
    expect(json(await send(admin, "DELETE", `/api/admin/ai/models/${turbo}`)).code).toBe("route_in_use");
    expect(json(await send(admin, "PATCH", `/api/admin/ai/models/${turbo}`, { overrides: { capability: "embedding" } })).code).toBe("capability_mismatch");
    // Unbind several at once.
    await send(admin, "PUT", "/api/admin/ai/bindings", { roles: ["analysis", "fast"], target: null });
    const after = json(await get(admin, "/api/admin/ai/bindings")).bindings;
    expect(after.filter((x: { target: unknown }) => x.target === null).map((x: { role: string }) => x.role)).toEqual(expect.arrayContaining(["analysis", "fast"]));
  });

  it("callers keep the same API: ai.chat(role) falls back through nested groups and logs group + model", async () => {
    down.add("glm/glm-5.3-flash");
    const r = await platform.chat("writing", { messages: [{ role: "user", content: "hi" }], maxTokens: 50 }, { userId: student.id });
    expect(r.text).toBe("來自 glm/glm-5-turbo");
    expect(r.route).toMatchObject({ model: "glm/glm-5-turbo", groupId: ids.inner, routeId: ids.inner, fallbackIndex: 1 });
    down.clear();
    await platform.logger.flush();
    const rows = (await t.db.query("SELECT group_id, model_ref, ok, final FROM ai_call_log WHERE role='writing' ORDER BY id")).rows;
    expect(rows.map((x) => [x.group_id, x.ok])).toEqual([
      [ids.outer, false],
      [ids.inner, true],
    ]);
    expect(rows[1].model_ref).toBe(await modelId("glm/glm-5-turbo"));
    const calls = json(await get(admin, "/api/admin/ai/calls?role=writing")).calls;
    expect(calls[0]).toMatchObject({ group_name: "備援", model: "glm/glm-5-turbo" });
    const ov = json(await get(admin, "/api/admin/ai/overview"));
    expect(ov.models.find((m: { model: string }) => m.model === "glm/glm-5-turbo")).toMatchObject({ calls: 1, ok: 1 });
  });

  it("overview carries a version: unchanged polls are cheap, routing and traffic changes bump their half", async () => {
    expect((await get(student, "/api/admin/ai/overview")).statusCode).toBe(403);
    const a = json(await get(admin, "/api/admin/ai/overview"));
    expect(a.version).toBe(`${a.routing_version}.${a.stats_version}`);
    expect(a.roles).toBeInstanceOf(Array);
    const same = json(await get(admin, `/api/admin/ai/overview?since=${a.version}`));
    expect(same).toEqual({ version: a.version, routing_version: a.routing_version, stats_version: a.stats_version, unchanged: true });
    // A call changes only the traffic half.
    await platform.chat("writing", { messages: [{ role: "user", content: "hi" }], maxTokens: 20 }, { userId: student.id });
    await platform.logger.flush();
    const b = json(await get(admin, `/api/admin/ai/overview?since=${a.version}`));
    expect(b.unchanged).toBeUndefined();
    expect(b.stats_version).not.toBe(a.stats_version);
    expect(b.models.length).toBeGreaterThan(0);
    // A binding change (another admin) changes the routing half.
    await send(admin, "PUT", "/api/admin/ai/bindings", { roles: ["fast"], target: { group_id: ids.inner } });
    const c = json(await get(admin, `/api/admin/ai/overview?since=${b.version}`));
    expect(c.routing_version).not.toBe(b.routing_version);
    await send(admin, "PUT", "/api/admin/ai/bindings", { roles: ["fast"], target: null });
  });

  it("limits come from the model profile (max output clamp, role limits)", async () => {
    const id = await modelId("glm/glm-5.3-flash");
    await send(admin, "PATCH", `/api/admin/ai/models/${id}`, { overrides: { max_output_tokens: 64 } });
    G.requests.length = 0;
    await platform.chat("slides", { messages: [{ role: "user", content: "hi" }], maxTokens: 5000 });
    const body = G.requests.find((q) => q.path === "/v1/chat/completions")!.json;
    expect(body.max_tokens ?? body.max_completion_tokens).toBe(64);
    expect(await platform.limits("slides")).toEqual({ contextWindow: 200000, maxOutputTokens: 64 });
    await send(admin, "PATCH", `/api/admin/ai/models/${id}`, { overrides: { max_output_tokens: null } });
  });

  it("exports version 2 and imports version 1 files (routes → groups / direct bindings)", async () => {
    const file = json(await get(admin, "/api/admin/ai/export"));
    expect(file).toMatchObject({ version: 2 });
    expect(file.groups.map((g: { name: string }) => g.name)).toEqual(expect.arrayContaining(["主要", "備援"]));
    expect(file.bindings.writing).toEqual({ group: "主要" });
    expect(file.models.find((m: { model_id: string }) => m.model_id === "gpt-4o-mini")).toMatchObject({ overrides: { tools: false } });
    const again = json(await send(admin, "POST", "/api/admin/ai/import", { file }));
    expect(again).toMatchObject({ providers_updated: 1, groups_created: 0, groups_updated: file.groups.length });
    const v1 = {
      format: "speech-ai-hub.ai-settings",
      version: 1,
      secret: false,
      providers: [{ family: "llm", kind: "openai-compatible", name: "閘道", config: { baseUrl: `${G.url}/v1` } }],
      routes: [
        { name: "舊單一", capability: "chat", strategy: "single", members: [{ provider: { family: "llm", name: "閘道" }, model: "glm/glm-5-turbo", child_route: null, weight: 1, params: { vision: "no" }, enabled: true }] },
        { name: "舊備援", capability: "chat", strategy: "fallback", members: [{ provider: { family: "llm", name: "閘道" }, model: "gpt-4o-mini", child_route: null, weight: 1, params: {}, enabled: true }, { provider: null, model: null, child_route: "舊單一", weight: 1, params: {}, enabled: true }] },
      ],
      roles: { fast: "舊單一", analysis: "舊備援" },
    };
    const r = json(await send(admin, "POST", "/api/admin/ai/import", { file: v1 }));
    expect(r).toMatchObject({ groups_created: 1, roles_bound: 2 });
    const b = json(await get(admin, "/api/admin/ai/bindings")).bindings;
    expect(b.find((x: { role: string }) => x.role === "fast").target).toMatchObject({ type: "model", name: "glm/glm-5-turbo" });
    expect(b.find((x: { role: string }) => x.role === "analysis").target).toMatchObject({ type: "group", name: "舊備援" });
    const groups = json(await get(admin, "/api/admin/ai/groups")).groups;
    expect(groups.find((g: { name: string }) => g.name === "舊備援").members.map((m: { model_id: string }) => m.model_id)).toEqual(["gpt-4o-mini", "glm/glm-5-turbo"]);
    const turbo = json(await get(admin, `/api/admin/ai/models?provider_id=${ids.p}`)).models.find((m: { model_id: string }) => m.model_id === "glm/glm-5-turbo");
    expect(turbo.overrides).toEqual({ vision: false });
  });
});
