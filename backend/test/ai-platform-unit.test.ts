import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { AiError } from "../src/ai/errors.js";
import { compareFingerprints, cosine, probesFor } from "../src/ai/embedding/fingerprint.js";
import { decryptJson, encryptJson, secretsAad } from "../src/ai/platform/crypto.js";
import { deriveRoleStatus, type RecentCall } from "../src/ai/platform/health.js";
import { memberParamFields, splitChatParams, validateMemberParams } from "../src/ai/platform/params.js";
import type { ProviderRecord } from "../src/ai/platform/store.js";
import { findCycle, groupDepth, orderMembers, resetRoundRobin, resolveGroup, resolveRole, RouteExhausted, runRoute, type ModelLeaf } from "../src/ai/router/index.js";
import { llmBackoffMs } from "../src/ai-worker/runner.js";
import { PlatformError } from "../src/ai/platform/errors.js";
import { group, model, provider, snapshot } from "./ai-fixtures.js";

process.env.PROVIDER_TOKEN_KEY = randomBytes(32).toString("base64");

describe("crypto", () => {
  it("round-trips and binds the ciphertext to its AAD", () => {
    const blob = encryptJson({ apiKey: "sk-test" }, secretsAad("a"));
    expect(decryptJson(blob, secretsAad("a"))).toEqual({ apiKey: "sk-test" });
    expect(() => decryptJson(blob, secretsAad("b"))).toThrow(PlatformError);
    expect(blob.toString("utf8")).not.toContain("sk-test");
  });
});

describe("group trees", () => {
  const a = provider();
  const b = provider();
  const m1 = model(a, "m1");
  const m2 = model(b, "m2");
  it("resolves nested groups, rejects cycles and keeps capabilities consistent", () => {
    const child = group("child", "fallback", [m2]);
    const parent = group("parent", "fallback", [m1, { group: "child" }]);
    const snap = snapshot({ providers: [a, b], models: [m1, m2], groups: [parent, child] });
    const tree = resolveGroup(snap, "parent");
    expect(tree.members).toHaveLength(2);
    expect(tree.members[1]!.node.type).toBe("group");
    const leaf = tree.members[0]!.node as ModelLeaf;
    expect(leaf).toMatchObject({ model: "m1", modelRef: m1.id, groupId: "parent" });
    const loop = group("child", "fallback", [{ group: "parent" }]);
    expect(() => resolveGroup(snapshot({ providers: [a, b], models: [m1, m2], groups: [parent, loop] }), "parent")).toThrowError(expect.objectContaining({ code: "route_cycle" }));
    expect(findCycle(snap.groups, "child", ["parent"])).toEqual(["child", "parent", "child"]);
    expect(findCycle(snap.groups, "child", [])).toBeNull();
    const emb = group("emb", "fallback", [m2], "embedding");
    const mixed = group("mixed", "fallback", [{ group: "emb" }]);
    expect(() => resolveGroup(snapshot({ providers: [a, b], models: [m1, m2], groups: [emb, mixed] }), "mixed")).toThrowError(expect.objectContaining({ code: "capability_mismatch" }));
  });

  it("limits nesting depth", () => {
    const gs = Array.from({ length: 8 }, (_, i) => group(`g${i}`, "fallback", i < 7 ? [{ group: `g${i + 1}` }] : [m1]));
    const snap = snapshot({ providers: [a, b], models: [m1, m2], groups: gs });
    expect(groupDepth(snap.groups, "g0", ["g1"])).toBe(8);
    expect(groupDepth(snap.groups, "g6", ["g7"])).toBe(2);
    expect(() => resolveGroup(snap, "g0")).toThrowError(expect.objectContaining({ code: "route_invalid" }));
    expect(resolveGroup(snap, "g2").members).toHaveLength(1);
  });

  it("binds a role to a model directly or to a group", () => {
    const g = group("g", "fallback", [m1, m2]);
    const snap = snapshot({ providers: [a, b], models: [m1, m2], groups: [g], bindings: { writing: { model: m2, params: { temperature: 0.3 } }, fast: { group: "g" } } });
    const direct = resolveRole(snap, "writing")!;
    expect(direct).toMatchObject({ id: null, strategy: "single", capability: "chat" });
    expect(direct.members[0]!.node).toMatchObject({ model: "m2", groupId: null, memberId: "binding:writing", params: { temperature: 0.3 } });
    expect(resolveRole(snap, "fast")!.members.map((x) => (x.node as ModelLeaf).model)).toEqual(["m1", "m2"]);
    expect(resolveRole(snap, "assistant")).toBeNull();
  });

  it("orders members per strategy", () => {
    resetRoundRobin();
    const ps = [provider(), provider(), provider()];
    const ms = ps.map((p, i) => model(p, `m${i}`));
    const mk = (s: "fallback" | "round_robin" | "load_balance", weights = [1, 1, 1]) =>
      resolveGroup(snapshot({ providers: ps, models: ms, groups: [group(`r-${s}`, s, ms.map((m, i) => ({ ...m, weight: weights[i] })))] }), `r-${s}`);
    const models = (xs: ReturnType<typeof orderMembers>) => xs.map((m) => (m.node as ModelLeaf).model);
    const single = snapshot({ providers: ps, models: ms, bindings: { fast: { model: ms[0]! } } });
    expect(models(orderMembers(resolveRole(single, "fast")!))).toEqual(["m0"]);
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
  const ma = model(a, "a");
  const mb = model(b, "b");
  const mc = model(c, "c");
  const tree = () => resolveGroup(snapshot({ providers: [a, b, c], models: [ma, mb, mc], groups: [group("main", "fallback", [ma, { group: "sub" }]), group("sub", "fallback", [mb, mc])] }), "main");
  const sleep = async () => {};

  it("falls back on pre-stream failures through child groups", async () => {
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
    expect(r.leaf.groupId).toBe("sub");
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
  const ma = model(a, "a");
  const mb = model(b, "b");
  const snap = snapshot({ providers: [a, b], models: [ma, mb], groups: [group("r", "fallback", [ma, mb])], bindings: { writing: { group: "r" } } });
  const recent = (entries: Array<[ProviderRecord, string, boolean, string | null]>) =>
    new Map<string, RecentCall>(entries.map(([p, m, ok, code]) => [`${p.id}\u0000${m}`, { provider_id: p.id, model: m, ok, error_code: code, started_at: new Date() }]));

  it("ok / degraded / unavailable / unconfigured", () => {
    expect(deriveRoleStatus("assistant", snap, new Map()).state).toBe("unconfigured");
    const ok = deriveRoleStatus("writing", snap, new Map());
    expect(ok.state).toBe("ok");
    expect(ok.detail).toMatchObject({ target: "group", groupId: "r", groupName: "r" });
    expect(ok.detail.members!.map((m) => m.modelRef)).toEqual([ma.id, mb.id]);
    expect(deriveRoleStatus("writing", snap, recent([[a, "a", false, "unavailable"]])).state).toBe("degraded");
    expect(deriveRoleStatus("writing", snap, recent([[a, "a", false, "unavailable"], [b, "b", false, "auth_failed"]])).state).toBe("unavailable");
    // A caller mistake does not mark the member down.
    expect(deriveRoleStatus("writing", snap, recent([[a, "a", false, "context_too_long"]])).state).toBe("ok");
    const s = deriveRoleStatus("writing", snap, new Map(), { role: "writing", ok: false, error_code: "llm_unavailable", started_at: new Date() });
    expect(s.state).toBe("unavailable");
    expect(s.message_zh).toContain("維護中");
  });

  it("uses probes when there are no recent calls; direct model bindings report the model", () => {
    const down = provider({ last_probe: { ok: false, latencyMs: 1, detail_zh: "x", code: "auth_failed" }, last_probe_at: new Date() });
    const mx = model(down, "x");
    const s2 = snapshot({ providers: [down], models: [mx], bindings: { fast: { model: mx } } });
    const st = deriveRoleStatus("fast", s2, new Map());
    expect(st.state).toBe("unavailable");
    expect(st.detail).toMatchObject({ target: "model", modelRef: mx.id });
  });
});

describe("member params", () => {
  it("validates against the entry whitelist plus platform knobs", () => {
    const fields = memberParamFields("chat", "openai-compatible").map((f) => f.key);
    expect(fields).toEqual(expect.arrayContaining(["temperature", "timeout_ms", "top_k", "chat_template_kwargs", "reasoning_effort"]));
    // Limits and capabilities live in the model profile, not in params.
    expect(fields).not.toContain("max_tokens");
    expect(fields).not.toContain("vision");
    const ok = validateMemberParams("chat", "openai-compatible", { temperature: 0.2, top_k: 40, timeout_ms: "5000" });
    expect(ok.issues).toEqual([]);
    expect(ok.params).toEqual({ temperature: 0.2, top_k: 40, timeout_ms: 5000 });
    expect(validateMemberParams("chat", "openai-compatible", { max_tokens: 10 }).issues.map((i) => i.key)).toEqual(["max_tokens"]);
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
