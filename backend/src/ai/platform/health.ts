/**
 * Health per role: `ok` (preferred member healthy) / `degraded` (running on a fallback member) / `unavailable` /
 * `unconfigured`. Inputs: the provider's last probe (every 60 s, one process) and recent call outcomes.
 */
import type { Queryable } from "../../db.js";
import { probeAsr } from "../asr/index.js";
import { fromThrown } from "../errors.js";
import { leaves, resolveRole, type ModelLeaf, type RouteNode } from "../router/index.js";
import { asrConfig, llmClient, type ClientFactoryOptions } from "./clients.js";
import type { Db } from "../../db.js";
import { isPlatformError } from "./errors.js";
import { AI_ROLES, ROLE_LABEL_ZH, type AiRole, type RoleState } from "./roles.js";
import { providerSecrets, type ConfigSnapshot, type ProbeSummary, type ProviderRecord } from "./store.js";

export type MemberHealth = "up" | "down" | "unknown";
export type RecentCall = { provider_id: string; model: string; ok: boolean; error_code: string | null; started_at: Date };
export type RoleFailure = { role: AiRole; ok: boolean; error_code: string | null; started_at: Date };

export type RoleStatus = {
  role: AiRole;
  state: RoleState;
  message_zh: string;
  /** Admin-only detail (never sent by the public status endpoint). */
  detail: {
    /** `model` (direct binding) or `group`. */
    target?: "model" | "group";
    groupId?: string;
    groupName?: string;
    /** Direct binding: the bound model profile. */
    modelRef?: string;
    members?: Array<{ memberId: string; modelRef: string; groupId: string | null; providerId: string; providerName: string; model: string; health: MemberHealth; reason?: string; vision?: boolean; vision_source?: string }>;
    activeIndex?: number;
    error?: string;
    /** An image request can be served: some member that is not down supports images (see vision.ts). */
    vision?: boolean;
  };
};

/** Codes that mean "this member cannot serve right now" (not caller mistakes). */
const DOWN_CODES = new Set(["unavailable", "timeout", "auth_failed", "quota_exhausted", "model_not_found", "overloaded", "needs_reauth", "disabled", "unsupported"]);
const PROBE_FRESH_MS = 5 * 60_000;
const CALL_WINDOW_MS = 10 * 60_000;

export function memberHealth(leaf: ModelLeaf, recent: Map<string, RecentCall>, now = Date.now()): { health: MemberHealth; reason?: string } {
  const p = leaf.provider;
  if (!p.enabled) return { health: "down", reason: "disabled" };
  if (p.oauth_meta?.status === "needs_reauth") return { health: "down", reason: "needs_reauth" };
  const call = recent.get(`${p.id}\u0000${leaf.model}`);
  const probeAt = p.last_probe_at ? new Date(p.last_probe_at).getTime() : 0;
  const callAt = call ? new Date(call.started_at).getTime() : 0;
  if (call && callAt >= probeAt && now - callAt < CALL_WINDOW_MS) {
    if (call.ok) return { health: "up" };
    if (call.error_code && DOWN_CODES.has(call.error_code)) return { health: "down", reason: call.error_code };
    return { health: "up" };
  }
  if (p.last_probe && now - probeAt < PROBE_FRESH_MS) return p.last_probe.ok ? { health: "up" } : { health: "down", reason: p.last_probe.code ?? "unavailable" };
  return { health: "unknown" };
}

function messageFor(role: AiRole, state: RoleState): string {
  const label = ROLE_LABEL_ZH[role];
  switch (state) {
    case "ok":
      return `${label}運作正常。`;
    case "degraded":
      return `${label}的主要模型暫時無法使用，目前由備援模型提供服務。`;
    case "unavailable":
      return role === "embedding" ? "語意搜尋維護中，搜尋暫時改用關鍵字。" : `${label}維護中，服務恢復後會自動繼續。`;
    case "unconfigured":
      return role === "embedding" ? "尚未設定語意搜尋，目前使用關鍵字搜尋。" : `${label}尚未設定，請管理員到「模型設定 → 功能綁定」選擇模型或群組。`;
  }
}

/** Pure derivation for one role (exported for tests). */
export function deriveRoleStatus(
  role: AiRole,
  snap: ConfigSnapshot,
  recent: Map<string, RecentCall>,
  lastRoleCall?: RoleFailure,
  now = Date.now(),
): RoleStatus {
  let tree: RouteNode | null;
  try {
    tree = resolveRole(snap, role);
  } catch (e) {
    return { role, state: "unavailable", message_zh: messageFor(role, "unavailable"), detail: { error: isPlatformError(e) ? e.code : "route_invalid" } };
  }
  if (!tree) return { role, state: "unconfigured", message_zh: messageFor(role, "unconfigured"), detail: {} };
  const ls = leaves(tree);
  const members = ls.map((l) => {
    const h = memberHealth(l, recent, now);
    return { memberId: l.memberId, modelRef: l.modelRef, groupId: l.groupId, providerId: l.provider.id, providerName: l.provider.name, model: l.model, health: h.health, reason: h.reason };
  });
  const usable = members.map((m) => m.health !== "down");
  let state: RoleState;
  let activeIndex: number | undefined;
  if (!ls.length || !usable.some(Boolean)) state = "unavailable";
  else if (tree.strategy === "round_robin" || tree.strategy === "load_balance") state = usable.every(Boolean) ? "ok" : "degraded";
  else {
    activeIndex = usable.indexOf(true);
    state = activeIndex === 0 ? "ok" : "degraded";
  }
  // The latest real call of this role found every member down: trust it until a newer success.
  if (lastRoleCall && !lastRoleCall.ok && lastRoleCall.error_code === "llm_unavailable" && now - new Date(lastRoleCall.started_at).getTime() < 2 * 60_000) {
    const newerOk = members.some((m) => {
      const c = recent.get(`${m.providerId}\u0000${m.model}`);
      return c?.ok && new Date(c.started_at) > new Date(lastRoleCall.started_at);
    });
    if (!newerOk) state = "unavailable";
  }
  const target = tree.id ? { target: "group" as const, groupId: tree.id, groupName: tree.name } : { target: "model" as const, modelRef: ls[0]?.modelRef };
  return { role, state, message_zh: messageFor(role, state), detail: { ...target, members, activeIndex } };
}

export async function loadRecent(db: Queryable): Promise<{ recent: Map<string, RecentCall>; roleCalls: Map<AiRole, RoleFailure> }> {
  const [calls, roles] = await Promise.all([
    db.query<RecentCall>(
      `SELECT DISTINCT ON (provider_id, model) provider_id, model, ok, error_code, started_at FROM ai_call_log
        WHERE provider_id IS NOT NULL AND started_at > now() - interval '10 minutes' ORDER BY provider_id, model, started_at DESC`,
    ),
    db.query<RoleFailure>(
      `SELECT DISTINCT ON (role) role, ok, error_code, started_at FROM ai_call_log
        WHERE final AND role IS NOT NULL AND NOT probe AND started_at > now() - interval '10 minutes' ORDER BY role, started_at DESC`,
    ),
  ]);
  return {
    recent: new Map(calls.rows.map((r) => [`${r.provider_id}\u0000${r.model}`, r])),
    roleCalls: new Map(roles.rows.map((r) => [r.role, r])),
  };
}

export function deriveAll(snap: ConfigSnapshot, recent: Map<string, RecentCall>, roleCalls: Map<AiRole, RoleFailure>, now = Date.now()): RoleStatus[] {
  return AI_ROLES.map((role) => deriveRoleStatus(role, snap, recent, roleCalls.get(role), now));
}

/** Providers referenced by any bound role (the probe set). */
export function boundProviders(snap: ConfigSnapshot): ProviderRecord[] {
  const out = new Map<string, ProviderRecord>();
  for (const role of AI_ROLES) {
    try {
      const tree = resolveRole(snap, role);
      if (tree) for (const l of leaves(tree)) out.set(l.provider.id, l.provider);
    } catch {
      /* invalid bindings surface as unavailable */
    }
  }
  return [...out.values()];
}

/** Probes one account (cheap: model listing / health endpoint; never a paid generation). Never throws. */
export async function probeProvider(db: Db, p: ProviderRecord, opts: ClientFactoryOptions = {}): Promise<ProbeSummary & { models?: string[] }> {
  const t0 = Date.now();
  try {
    if (!p.enabled) return { ok: false, latencyMs: 0, detail_zh: "帳號已停用。", code: "disabled" };
    if (p.family === "asr") {
      const r = await probeAsr(asrConfig(p, String(p.config.model ?? ""), {}, opts.fetch));
      return { ok: r.ok, latencyMs: r.latencyMs, detail_zh: r.detail_zh, code: r.error?.code, hint_zh: r.error?.hint_zh };
    }
    if (p.kind === "claude-cli") {
      const ok = Boolean(providerSecrets(p).oauthToken);
      return { ok, latencyMs: Date.now() - t0, detail_zh: ok ? "已設定 setup-token（CLI 在 ai-worker 執行）。" : "尚未設定 setup-token。", code: ok ? undefined : "auth_failed" };
    }
    if (["chatgpt", "claude-oauth"].includes(p.kind) && p.oauth_meta?.status !== "connected") {
      return { ok: false, latencyMs: 0, detail_zh: p.oauth_meta?.status === "needs_reauth" ? "登入已失效，請重新登入。" : "尚未登入。", code: "auth_failed" };
    }
    const r = await llmClient(db, p, opts).probe();
    return { ok: r.ok, latencyMs: r.latencyMs, detail_zh: r.detail_zh, code: r.error?.code, hint_zh: r.error?.hint_zh, modelCount: r.modelCount };
  } catch (e) {
    const err = isPlatformError(e) ? null : fromThrown(e);
    return {
      ok: false,
      latencyMs: Date.now() - t0,
      detail_zh: isPlatformError(e) ? e.message_zh : err!.message_zh,
      code: isPlatformError(e) ? e.code : err!.code,
      hint_zh: isPlatformError(e) ? e.hint_zh : err!.hint_zh,
    };
  }
}
