import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { AiError } from "../src/ai/errors.js";
import { compareFingerprints, cosine, probesFor } from "../src/ai/embedding/fingerprint.js";
import { decryptJson, encryptJson, secretsAad } from "../src/ai/platform/crypto.js";
import { deriveRoleStatus, type RecentCall } from "../src/ai/platform/health.js";
import { memberParamFields, splitChatParams, validateMemberParams } from "../src/ai/platform/params.js";
import type { ConfigSnapshot, MemberRecord, ProviderRecord, RouteRecord } from "../src/ai/platform/store.js";
import { findCycle, orderMembers, resetRoundRobin, resolveRoute, RouteExhausted, runRoute, type ModelLeaf } from "../src/ai/router/index.js";
import { llmBackoffMs } from "../src/ai-worker/runner.js";
import { PlatformError } from "../src/ai/platform/errors.js";

process.env.PROVIDER_TOKEN_KEY = randomBytes(32).toString("base64");

let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

function provider(over: Partial<ProviderRecord> = {}): ProviderRecord {
  return {
    id: id(),
    family: "llm",
    kind: "openai-compatible",
    category: "local",
    name: `p${n}`,
    base_url: "http://x",
    auth_type: "api_key",
    config: {},
    secrets: null,
    secret_keys: [],
    oauth_tokens: null,
    oauth_meta: { status: "none" },
    enabled: true,
    last_probe: null,
    last_probe_at: null,
    updated_at: new Date(),
    created_at: new Date(),
    ...over,
  };
}

function snapshot(routes: RouteRecord[], providers: ProviderRecord[], roles: Record<string, string> = {}): ConfigSnapshot {
  return {
    providers: new Map(providers.map((p) => [p.id, p])),
    routes: new Map(routes.map((r) => [r.id, r])),
    roles: new Map(Object.entries(roles)) as ConfigSnapshot["roles"],
    loadedAt: Date.now(),
  };
}

function route(rid: string, strategy: RouteRecord["strategy"], members: Array<Partial<MemberRecord>>, capability: RouteRecord["capability"] = "chat"): RouteRecord {
  return {
    id: rid,
    name: rid,
    capability,
    strategy,
    description: "",
    updated_at: new Date(),
    members: members.map((m, i) => ({ id: `${rid}-m${i}`, route_id: rid, position: i, provider_id: null, model: null, child_route_id: null, weight: 1, params: {}, enabled: true, ...m })),
  };
}

describe("crypto", () => {
  it("round-trips and binds the ciphertext to its AAD", () => {
    const blob = encryptJson({ apiKey: "sk-test" }, secretsAad("a"));
    expect(decryptJson(blob, secretsAad("a"))).toEqual({ apiKey: "sk-test" });
    expect(() => decryptJson(blob, secretsAad("b"))).toThrow(PlatformError);
    expect(blob.toString("utf8")).not.toContain("sk-test");
  });
});

describe("route trees", () => {
  const a = provider();
  const b = provider();
  it("resolves nested routes and rejects cycles", () => {
    const child = route("child", "fallback", [{ provider_id: b.id, model: "m2" }]);
    const parent = route("parent", "fallback", [{ provider_id: a.id, model: "m1" }, { child_route_id: "child" }]);
    const snap = snapshot([parent, child], [a, b]);
    const tree = resolveRoute(snap, "parent");
    expect(tree.members).toHaveLength(2);
    expect(tree.members[1]!.node.type).toBe("route");
    const loop = route("child", "fallback", [{ child_route_id: "parent" }]);
    expect(() => resolveRoute(snapshot([parent, loop], [a, b]), "parent")).toThrowError(expect.objectContaining({ code: "route_cycle" }));
    expect(findCycle(snap.routes, "child", ["parent"])).toEqual(["child", "parent", "child"]);
    expect(findCycle(snap.routes, "child", [])).toBeNull();
  });

  it("orders members per strategy", () => {
    resetRoundRobin();
    const ps = [provider(), provider(), provider()];
    const mk = (s: RouteRecord["strategy"], weights = [1, 1, 1]) =>
      resolveRoute(snapshot([route(`r-${s}`, s, ps.map((p, i) => ({ provider_id: p.id, model: `m${i}`, weight: weights[i] })))], ps), `r-${s}`);
    const models = (ms: ReturnType<typeof orderMembers>) => ms.map((m) => (m.node as ModelLeaf).model);
    expect(models(orderMembers(mk("single")))).toEqual(["m0"]);
    expect(models(orderMembers(mk("fallback")))).toEqual(["m0", "m1", "m2"]);
    const rr = mk("round_robin");
    expect(models(orderMembers(rr))[0]).toBe("m0");
    expect(models(orderMembers(rr))[0]).toBe("m1");
    expect(models(orderMembers(rr))[0]).toBe("m2");
    expect(models(orderMembers(rr))[0]).toBe("m0");
    const lb = mk("load_balance", [1, 1, 98]);
    let heavy = 0;
    for (let i = 0; i < 200; i++) if (models(orderMembers(lb))[0] === "m2") heavy++;
    expect(heavy).toBeGreaterThan(170);
    expect(new Set(models(orderMembers(lb)))).toEqual(new Set(["m0", "m1", "m2"]));
  });
});

describe("runRoute", () => {
  const a = provider({ name: "A" });
  const b = provider({ name: "B" });
  const c = provider({ name: "C" });
  const tree = () =>
    resolveRoute(
      snapshot(
        [route("main", "fallback", [{ provider_id: a.id, model: "a" }, { child_route_id: "sub" }]), route("sub", "fallback", [{ provider_id: b.id, model: "b" }, { provider_id: c.id, model: "c" }])],
        [a, b, c],
      ),
      "main",
    );
  const sleep = async () => {};

  it("falls back on pre-stream failures through child routes", async () => {
    const calls: string[] = [];
    const r = await runRoute(
      tree(),
      async (leaf) => {
        calls.push(leaf.model);
        if (leaf.model === "a") throw new AiError("auth_failed");
        if (leaf.model === "b") throw new AiError("model_not_found");
        return "ok";
      },
      { sleep },
    );
    expect(r.value).toBe("ok");
    expect(r.leaf.model).toBe("c");
    expect(r.fallbackIndex).toBe(2);
    expect(r.failures.map((f) => f.error?.code)).toEqual(["auth_failed", "model_not_found"]);
    expect(calls).toEqual(["a", "b", "c"]);
  });

  it("retries transient errors on the same member before falling back", async () => {
    let n = 0;
    const r = await runRoute(
      tree(),
      async (leaf) => {
        if (leaf.model === "a" && n++ < 1) throw new AiError("rate_limited", { retryAfterMs: 5 });
        return leaf.model;
      },
      { sleep },
    );
    expect(r.value).toBe("a");
    expect(r.retries).toBe(1);
  });

  it("does not fall back on content errors and reports exhaustion", async () => {
    await expect(runRoute(tree(), async () => Promise.reject(new AiError("context_too_long")), { sleep })).rejects.toMatchObject({ code: "context_too_long" });
    const err = await runRoute(tree(), async () => Promise.reject(new AiError("unavailable")), { sleep, defaultRetries: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(RouteExhausted);
    expect((err as RouteExhausted).attempts().map((x) => x.code)).toEqual(["unavailable", "unavailable", "unavailable"]);
  });

  it("skips disabled members", async () => {
    const r = await runRoute(tree(), async (leaf) => leaf.model, { sleep, skip: (l) => (l.model === "a" ? "disabled" : null) });
    expect(r.value).toBe("b");
    expect(r.failures[0]!.skipped).toBe("disabled");
  });
});

describe("health derivation", () => {
  const a = provider({ name: "A" });
  const b = provider({ name: "B" });
  const snap = snapshot([route("r", "fallback", [{ provider_id: a.id, model: "a" }, { provider_id: b.id, model: "b" }])], [a, b], { writing: "r" });
  const recent = (entries: Array<[ProviderRecord, string, boolean, string | null]>) =>
    new Map<string, RecentCall>(entries.map(([p, m, ok, code]) => [`${p.id}\u0000${m}`, { provider_id: p.id, model: m, ok, error_code: code, started_at: new Date() }]));

  it("ok / degraded / unavailable / unconfigured", () => {
    expect(deriveRoleStatus("assistant", snap, new Map()).state).toBe("unconfigured");
    expect(deriveRoleStatus("writing", snap, new Map()).state).toBe("ok");
    expect(deriveRoleStatus("writing", snap, recent([[a, "a", false, "unavailable"]])).state).toBe("degraded");
    expect(deriveRoleStatus("writing", snap, recent([[a, "a", false, "unavailable"], [b, "b", false, "auth_failed"]])).state).toBe("unavailable");
    // A caller mistake does not mark the member down.
    expect(deriveRoleStatus("writing", snap, recent([[a, "a", false, "context_too_long"]])).state).toBe("ok");
    const s = deriveRoleStatus("writing", snap, new Map(), { role: "writing", ok: false, error_code: "llm_unavailable", started_at: new Date() });
    expect(s.state).toBe("unavailable");
    expect(s.message_zh).toContain("維護中");
  });

  it("uses probes when there are no recent calls", () => {
    const down = provider({ last_probe: { ok: false, latencyMs: 1, detail_zh: "x", code: "auth_failed" }, last_probe_at: new Date() });
    const s2 = snapshot([route("r", "single", [{ provider_id: down.id, model: "x" }])], [down], { fast: "r" });
    expect(deriveRoleStatus("fast", s2, new Map()).state).toBe("unavailable");
  });
});

describe("member params", () => {
  it("validates against the entry whitelist plus platform knobs", () => {
    const fields = memberParamFields("chat", "openai-compatible").map((f) => f.key);
    expect(fields).toEqual(expect.arrayContaining(["temperature", "max_tokens", "timeout_ms", "top_k", "chat_template_kwargs"]));
    const ok = validateMemberParams("chat", "openai-compatible", { temperature: 0.2, top_k: 40, max_tokens: "512" });
    expect(ok.issues).toEqual([]);
    expect(ok.params).toEqual({ temperature: 0.2, top_k: 40, max_tokens: 512 });
    const bad = validateMemberParams("chat", "openai-compatible", { temperature: 9, nope: 1 });
    expect(bad.issues.map((i) => i.key)).toEqual(["temperature", "nope"]);
    const split = splitChatParams("chat", "openai-compatible", ok.params);
    expect(split.temperature).toBe(0.2);
    expect(split.passthrough).toEqual({ top_k: 40 });
    expect(memberParamFields("asr", "openai").map((f) => f.key)).toEqual(expect.arrayContaining(["language", "diarization", "convert_script", "max_retries"]));
  });
});

describe("embedding fingerprint", () => {
  const vecs = probesFor().map((_, i) => Array.from({ length: 8 }, (_, j) => Math.sin(i * 7 + j)));
  it("same model ≈ 1, different model / dims rejected", () => {
    const noisy = vecs.map((v) => v.map((x) => x + 0.001));
    expect(compareFingerprints(vecs, noisy).same).toBe(true);
    const other = vecs.map((v) => [...v].reverse());
    expect(compareFingerprints(vecs, other).same).toBe(false);
    expect(compareFingerprints(vecs, vecs.map((v) => v.slice(0, 4))).sameDims).toBe(false);
    expect(cosine([1, 0], [0, 1])).toBe(0);
  });
});

describe("ai-worker backoff", () => {
  beforeEach(() => undefined);
  it("2 min doubling to 30 min", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map((w) => llmBackoffMs(w) / 60_000)).toEqual([2, 4, 8, 16, 30, 30, 30]);
  });
});
