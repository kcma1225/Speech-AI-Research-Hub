import { beforeEach, describe, expect, it, vi } from "vitest";

// A tiny fake of the admin API: routing lists + an overview with versions.
const server = vi.hoisted(() => ({
  routing: "r1",
  stats: "s1",
  bindings: [] as Array<Record<string, unknown>>,
  groups: [] as Array<Record<string, unknown>>,
  calls: 0,
  failPut: false,
  log: [] as string[],
}));

vi.mock("./admin.ts", async orig => {
  const real = await orig<typeof import("./admin.ts")>();
  const get = async (path: string) => {
    server.log.push(`GET ${path}`);
    if (path === "/admin/ai/registry") return { llm: [], asr: [] };
    if (path === "/admin/ai/providers") return { providers: [] };
    if (path === "/admin/ai/models") return { models: [{ id: "m1", model_id: "glm/glm-5.3-flash", provider_id: "p1" }] };
    if (path === "/admin/ai/groups") return { groups: structuredClone(server.groups) };
    if (path === "/admin/ai/bindings") return { bindings: structuredClone(server.bindings) };
    if (path.startsWith("/admin/ai/overview")) {
      const version = `${server.routing}.${server.stats}`;
      const head = { version, routing_version: server.routing, stats_version: server.stats };
      if (path.endsWith(`since=${encodeURIComponent(version)}`)) return { ...head, unchanged: true };
      return { ...head, window: "24h", models: [], roles: [{ role: "assistant", calls: server.calls, ok: server.calls, success_rate: 1, p50_ms: 10, p95_ms: 10 }] };
    }
    throw new Error(`unexpected ${path}`);
  };
  const put = async (path: string, body: { roles?: string[]; target?: { model_id?: string } | null; members?: unknown[] }) => {
    server.log.push(`PUT ${path}`);
    await new Promise(r => setTimeout(r, 5));
    if (server.failPut) throw new real.AiApiError(409, { error: "衝突", code: "conflict" });
    if (path === "/admin/ai/bindings") {
      server.bindings = server.bindings.map(b => (body.roles!.includes(b.role as string) ? { ...b, target: body.target ? { type: "model", model_id: body.target.model_id, name: "srv" } : null } : b));
      server.routing = `r${Math.random()}`;
      return { bindings: structuredClone(server.bindings), warnings: [], created_space: null };
    }
    return { group: {}, warnings: [] };
  };
  return { ...real, aiApi: { get, put, post: put, patch: put, del: get } };
});

const { adminStore } = await import("./admin-store.svelte.ts");
const tick = () => new Promise(r => setTimeout(r, 20));

describe("adminStore live sync", () => {
  beforeEach(async () => {
    server.routing = "r1";
    server.stats = "s1";
    server.calls = 0;
    server.failPut = false;
    server.bindings = [{ role: "assistant", target: null, params: {}, updated_at: null, status: null }];
    server.groups = [];
    await adminStore.load();
    await tick();
    server.log = [];
  });

  it("an unchanged poll touches nothing; a traffic change only replaces stats", async () => {
    const bindings = adminStore.bindings;
    const stats = adminStore.stats;
    await adminStore.sync();
    expect(server.log).toEqual(["GET /admin/ai/overview?since=r1.s1"]);
    expect(adminStore.stats).toBe(stats);
    expect(adminStore.syncedAt).not.toBeNull();
    server.stats = "s2";
    server.calls = 3;
    await adminStore.sync();
    expect(adminStore.stats?.roles[0]?.calls).toBe(3);
    expect(adminStore.bindings).toBe(bindings);
    expect(server.log.some(l => l.includes("/bindings"))).toBe(false);
  });

  it("a routing change by someone else refetches the lists; equal data keeps identity", async () => {
    const groups = adminStore.groups;
    server.routing = "r2";
    server.bindings = [{ ...server.bindings[0], target: { type: "model", model_id: "m1", name: "x" } }];
    await adminStore.sync();
    expect(server.log).toContain("GET /admin/ai/bindings");
    expect(adminStore.binding("assistant")?.target).toMatchObject({ model_id: "m1" });
    expect(adminStore.groups).toBe(groups);
    server.log = [];
    await adminStore.sync();
    expect(server.log).toEqual(["GET /admin/ai/overview?since=r2.s1"]);
  });

  it("binds optimistically and rolls back on error", async () => {
    const p = adminStore.bind(["assistant"], { model_id: "m1" });
    expect(adminStore.binding("assistant")?.target).toEqual({ type: "model", model_id: "m1", name: "glm/glm-5.3-flash" });
    await p;
    expect(adminStore.binding("assistant")?.target).toMatchObject({ model_id: "m1", name: "srv" });

    server.failPut = true;
    const q = adminStore.bind(["assistant"], null);
    expect(adminStore.binding("assistant")?.target).toBeNull();
    await expect(q).rejects.toThrow();
    expect(adminStore.binding("assistant")?.target).toMatchObject({ model_id: "m1" });
  });

  it("optimistic group edits keep member ids and roll back", async () => {
    server.groups = [{ id: "g1", name: "G", capability: "chat", strategy: "fallback", description: "", members: [{ id: "a", model_ref: "m1", child_group_id: null, weight: 1, params: {}, enabled: true }] }];
    await adminStore.reloadGroups();
    server.failPut = true;
    const p = adminStore.saveGroup(adminStore.group("g1")!, [
      { model_ref: "m2", child_group_id: null, weight: 1, params: {}, enabled: true },
      { model_ref: "m1", child_group_id: null, weight: 1, params: {}, enabled: true },
    ]);
    expect(adminStore.group("g1")!.members.map(m => [m.id, m.model_ref])).toEqual([
      [undefined, "m2"],
      ["a", "m1"],
    ]);
    await expect(p).rejects.toThrow();
    expect(adminStore.group("g1")!.members.map(m => m.model_ref)).toEqual(["m1"]);
  });

  it("does not overwrite an in-flight optimistic edit with an older poll", async () => {
    server.routing = "r9";
    const p = adminStore.bind(["assistant"], { model_id: "m1" });
    await adminStore.sync();
    expect(adminStore.binding("assistant")?.target).toMatchObject({ model_id: "m1" });
    await p;
  });
});
