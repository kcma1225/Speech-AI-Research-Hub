/**
 * Admin-side logic for /api/admin/ai/*: provider accounts (secrets write-only), routes with member trees,
 * role bindings, export/import. Route handlers in routes/ai-admin.ts stay thin.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { transaction, type Db, type Queryable } from "../../db.js";
import { getAsrEntry, liveKinds, publicAsrRegistry } from "../asr/index.js";
import { getProvider, publicProviders, validateAccount, type FormField, type ProviderEntry } from "../providers/index.js";
import { applyEmbeddingBinding, checkEmbeddingBinding } from "../embedding/switch.js";
import { findCycle, leaves, resolveRole, resolveRoute, type RouteNode } from "../router/index.js";
import { decryptJson, encryptJson, hasProviderKey, oauthAad, secretsAad } from "./crypto.js";
import { PlatformError } from "./errors.js";
import { CHAT_PLATFORM_PARAMS, EMBED_PLATFORM_PARAMS, memberParamFields, validateMemberParams } from "./params.js";
import type { AiPlatform } from "./platform.js";
import { AI_ROLES, ROLE_CAPABILITY, ROLE_LABEL_ZH, type AiRole, type RouteCapability } from "./roles.js";
import { loadSnapshot, notifyConfigChanged, PROVIDER_COLUMNS, providerSecrets, type ConfigSnapshot, type MemberRecord, type ProviderFamily, type ProviderRecord, type RouteRecord, type Strategy } from "./store.js";
import { isSubscriptionKind } from "./subscriptions.js";

// ---------------------------------------------------------------- registry

type FormSpec = { fields: FormField[]; category: "external" | "local" | "subscription"; authType: ProviderRecord["auth_type"]; defaultBaseUrl?: string; entry?: ProviderEntry };

function authTypeOf(e: ProviderEntry): ProviderRecord["auth_type"] {
  switch (e.auth.type) {
    case "google_service_account":
      return "service_account";
    case "api_key":
    case "none":
    case "azure":
    case "aws":
    case "oauth":
      return e.auth.type;
  }
}

export function formSpec(family: ProviderFamily, kind: string): FormSpec | null {
  if (family === "llm") {
    const e = getProvider(kind);
    if (!e) return null;
    return { fields: e.fields, category: isSubscriptionKind(kind) ? "subscription" : e.category, authType: authTypeOf(e), defaultBaseUrl: e.defaultBaseUrl, entry: e };
  }
  const a = getAsrEntry(kind);
  if (!a) return null;
  const secrets = a.fields.filter((f) => f.type === "secret").map((f) => f.key);
  const authType: ProviderRecord["auth_type"] = kind === "google_stt" ? "service_account" : kind === "aws_transcribe" ? "aws" : secrets.length ? "api_key" : "none";
  return { fields: a.fields, category: a.category, authType };
}

export function registryPayload() {
  const llm = publicProviders().map((e) => ({ ...e, category: isSubscriptionKind(e.id) ? "subscription" : e.category, subscription: isSubscriptionKind(e.id) }));
  const asr = publicAsrRegistry().map((e) => ({ ...e, category: e.category, subscription: false }));
  return {
    llm,
    asr,
    roles: AI_ROLES.map((role) => ({ role, capability: ROLE_CAPABILITY[role], label_zh: ROLE_LABEL_ZH[role] })),
    platform_params: { chat: CHAT_PLATFORM_PARAMS, embedding: EMBED_PLATFORM_PARAMS, asr: memberParamFields("asr", "openai") },
    live_kinds: liveKinds(),
    secrets_key_configured: hasProviderKey(),
  };
}

// ---------------------------------------------------------------- providers

export type PublicProvider = Omit<ProviderRecord, "secrets" | "oauth_tokens"> & {
  label: { zh: string; en: string } | null;
  secrets_set: Record<string, boolean>;
  used_by: Array<{ route_id: string; route_name: string }>;
  warnings_zh: string[];
};

export function publicProvider(p: ProviderRecord, snap?: ConfigSnapshot): PublicProvider {
  const { secrets: _s, oauth_tokens: _o, ...rest } = p;
  const spec = formSpec(p.family, p.kind);
  const secretFields = spec?.fields.filter((f) => f.type === "secret").map((f) => f.key) ?? [];
  const used_by: PublicProvider["used_by"] = [];
  for (const r of snap?.routes.values() ?? []) if (r.members.some((m) => m.provider_id === p.id)) used_by.push({ route_id: r.id, route_name: r.name });
  const label = p.family === "llm" ? (getProvider(p.kind)?.label ?? null) : (getAsrEntry(p.kind)?.label ?? null);
  return {
    ...rest,
    label,
    secrets_set: Object.fromEntries(secretFields.map((k) => [k, p.secret_keys.includes(k)])),
    used_by,
    warnings_zh: (p.family === "llm" ? getProvider(p.kind)?.quirks.warnings_zh : undefined) ?? [],
  };
}

function validationError(issues: Array<{ key: string; message_zh: string }>) {
  return new PlatformError("provider_invalid", { message_zh: issues[0]?.message_zh ?? "供應商帳號的欄位不正確。", detail: { issues } });
}

function validateForm(spec: FormSpec, config: Record<string, unknown>, secrets: Record<string, string>, existing: string[]) {
  const entry = (spec.entry ?? ({ fields: spec.fields, auth: { type: "none" } } as unknown as ProviderEntry)) as ProviderEntry;
  const r = validateAccount(entry, config, secrets, existing);
  if (r.issues.length) throw validationError(r.issues);
  return r.config;
}

const baseUrlOf = (family: ProviderFamily, config: Record<string, unknown>, spec: FormSpec) =>
  (typeof config.baseUrl === "string" && config.baseUrl) || (typeof config.base_url === "string" && config.base_url) || (family === "llm" ? (spec.defaultBaseUrl ?? null) : null);

export type ProviderInput = { family: ProviderFamily; kind: string; name: string; config?: Record<string, unknown>; secrets?: Record<string, string | null>; enabled?: boolean };

export async function createProvider(db: Db, input: ProviderInput, userId: string): Promise<ProviderRecord> {
  const spec = formSpec(input.family, input.kind);
  if (!spec) throw new PlatformError("provider_invalid", { message_zh: "不支援的供應商類型。" });
  const secrets = cleanSecrets(input.secrets);
  const config = validateForm(spec, input.config ?? {}, secrets, []);
  const id = randomUUID();
  const blob = Object.keys(secrets).length ? encryptJson(secrets, secretsAad(id)) : null;
  try {
    const row = (
      await db.query<ProviderRecord>(
        `INSERT INTO ai_providers(id,family,kind,category,name,base_url,auth_type,config,secrets,secret_keys,enabled,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING ${PROVIDER_COLUMNS}`,
        [id, input.family, input.kind, spec.category, input.name.trim(), baseUrlOf(input.family, config, spec), spec.authType, JSON.stringify(config), blob, Object.keys(secrets), input.enabled ?? true, userId],
      )
    ).rows[0]!;
    await notifyConfigChanged(db);
    return row;
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new PlatformError("provider_invalid", { message_zh: "已經有同名的供應商帳號。", detail: { issues: [{ key: "name", message_zh: "名稱重複。" }] } });
    throw e;
  }
}

function cleanSecrets(input?: Record<string, string | null>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input ?? {})) if (typeof v === "string" && v.trim()) out[k] = v.trim();
  return out;
}

export async function getProviderRow(db: Queryable, id: string): Promise<ProviderRecord> {
  const row = (await db.query<ProviderRecord>(`SELECT ${PROVIDER_COLUMNS} FROM ai_providers WHERE id=$1`, [id])).rows[0];
  if (!row) throw new PlatformError("not_found");
  return row;
}

/** `secrets`: only keys being changed; `null` removes a stored secret. */
export async function updateProvider(db: Db, id: string, input: Partial<Omit<ProviderInput, "family" | "kind">>): Promise<ProviderRecord> {
  return transaction(db, async (client) => {
    const p = (await client.query<ProviderRecord>(`SELECT ${PROVIDER_COLUMNS} FROM ai_providers WHERE id=$1 FOR UPDATE`, [id])).rows[0];
    if (!p) throw new PlatformError("not_found");
    const spec = formSpec(p.family, p.kind);
    if (!spec) throw new PlatformError("provider_invalid", { message_zh: "不支援的供應商類型。" });
    const current = providerSecrets(p);
    const changes = input.secrets ?? {};
    for (const [k, v] of Object.entries(changes)) {
      if (v === null) delete current[k];
      else if (typeof v === "string" && v.trim()) current[k] = v.trim();
    }
    const secretKeys = Object.keys(current);
    const config = input.config ? validateForm(spec, input.config, cleanSecrets(changes), secretKeys) : p.config;
    if (!input.config) {
      // Still check required secrets when only secrets changed.
      validateForm(spec, p.config, {}, secretKeys);
    }
    try {
      const row = (
        await client.query<ProviderRecord>(
          `UPDATE ai_providers SET name=$2, config=$3, base_url=$4, secrets=$5, secret_keys=$6, enabled=$7, updated_at=now() WHERE id=$1 RETURNING ${PROVIDER_COLUMNS}`,
          [id, input.name?.trim() || p.name, JSON.stringify(config), baseUrlOf(p.family, config, spec), secretKeys.length ? encryptJson(current, secretsAad(id)) : null, secretKeys, input.enabled ?? p.enabled],
        )
      ).rows[0]!;
      await notifyConfigChanged(client);
      return row;
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new PlatformError("provider_invalid", { message_zh: "已經有同名的供應商帳號。" });
      throw e;
    }
  });
}

export async function deleteProvider(db: Db, id: string) {
  const used = (await db.query<{ name: string }>("SELECT DISTINCT r.name FROM ai_route_members m JOIN ai_routes r ON r.id=m.route_id WHERE m.provider_id=$1", [id])).rows;
  if (used.length) throw new PlatformError("provider_in_use", { detail: { routes: used.map((r) => r.name) } });
  const r = await db.query("DELETE FROM ai_providers WHERE id=$1", [id]);
  if (!r.rowCount) throw new PlatformError("not_found");
  await notifyConfigChanged(db);
}

/** A transient record for testing an unsaved form (secrets of `baseId` fill keys the form left empty). */
export async function draftProvider(db: Db, input: ProviderInput & { base_id?: string }): Promise<ProviderRecord> {
  const spec = formSpec(input.family, input.kind);
  if (!spec) throw new PlatformError("provider_invalid", { message_zh: "不支援的供應商類型。" });
  let secrets = cleanSecrets(input.secrets);
  if (input.base_id) {
    const base = await getProviderRow(db, input.base_id);
    secrets = { ...providerSecrets(base), ...secrets };
  }
  const config = validateForm(spec, input.config ?? {}, secrets, []);
  const id = randomUUID();
  const now = new Date();
  return {
    id,
    family: input.family,
    kind: input.kind,
    category: spec.category,
    name: input.name || "draft",
    base_url: baseUrlOf(input.family, config, spec),
    auth_type: spec.authType,
    config,
    secrets: Object.keys(secrets).length ? encryptJson(secrets, secretsAad(id)) : null,
    secret_keys: Object.keys(secrets),
    oauth_tokens: null,
    oauth_meta: { status: "none" },
    enabled: true,
    last_probe: null,
    last_probe_at: null,
    created_at: now,
    updated_at: now,
  };
}

// ---------------------------------------------------------------- routes

export type MemberInput = { provider_id?: string | null; model?: string | null; child_route_id?: string | null; weight?: number; params?: Record<string, unknown>; enabled?: boolean };
export type RouteInput = { name: string; capability: RouteCapability; strategy: Strategy; description?: string; members: MemberInput[] };

const familyFor = (c: RouteCapability): ProviderFamily => (c === "asr" ? "asr" : "llm");

export function publicRoute(r: RouteRecord, snap: ConfigSnapshot) {
  const bound_roles = AI_ROLES.filter((role) => snap.roles.get(role) === r.id);
  const parents = [...snap.routes.values()].filter((x) => x.members.some((m) => m.child_route_id === r.id)).map((x) => ({ route_id: x.id, route_name: x.name }));
  return {
    ...r,
    members: r.members.map((m) => {
      const p = m.provider_id ? snap.providers.get(m.provider_id) : undefined;
      const child = m.child_route_id ? snap.routes.get(m.child_route_id) : undefined;
      return { ...m, provider_name: p?.name ?? null, provider_kind: p?.kind ?? null, child_route_name: child?.name ?? null };
    }),
    bound_roles,
    used_by: parents,
  };
}

/** Validates members against the snapshot; returns normalised members + warnings. Throws PlatformError. */
export function validateRouteInput(snap: ConfigSnapshot, routeId: string, input: RouteInput) {
  const issues: Array<{ index: number; key: string; message_zh: string }> = [];
  const warnings: string[] = [];
  const members: Omit<MemberRecord, "id" | "route_id">[] = [];
  input.members.forEach((m, index) => {
    const weight = m.weight ?? 1;
    if (m.child_route_id) {
      if (m.provider_id || m.model) issues.push({ index, key: "child_route_id", message_zh: "成員只能是「模型」或「子路由」其中一種。" });
      const child = snap.routes.get(m.child_route_id);
      if (!child) issues.push({ index, key: "child_route_id", message_zh: "找不到子路由。" });
      else if (child.capability !== input.capability) issues.push({ index, key: "child_route_id", message_zh: `子路由「${child.name}」的能力不同。` });
      if (m.child_route_id === routeId) issues.push({ index, key: "child_route_id", message_zh: "路由不能包含自己。" });
      members.push({ position: index, provider_id: null, model: null, child_route_id: m.child_route_id, weight, params: {}, enabled: m.enabled ?? true });
      return;
    }
    const p = m.provider_id ? snap.providers.get(m.provider_id) : undefined;
    const model = m.model?.trim();
    if (!p) {
      issues.push({ index, key: "provider_id", message_zh: "請選擇供應商帳號。" });
      return;
    }
    if (!model) issues.push({ index, key: "model", message_zh: "請填寫模型。" });
    if (p.family !== familyFor(input.capability)) issues.push({ index, key: "provider_id", message_zh: `「${p.name}」不能用在${input.capability === "asr" ? "語音" : "文字"}路由。` });
    if (p.family === "llm") {
      const caps = getProvider(p.kind)?.capabilities;
      if (input.capability === "chat" && !caps?.chat) issues.push({ index, key: "provider_id", message_zh: `「${p.name}」不支援聊天。` });
      if (input.capability === "embedding" && !caps?.embeddings) issues.push({ index, key: "provider_id", message_zh: `「${p.name}」不支援 embedding。` });
      if (p.kind === "claude-cli") warnings.push("Claude Code CLI 不支援工具呼叫，不適合綁定給 AI 助理（assistant）。");
    }
    const v = validateMemberParams(input.capability, p.kind, m.params ?? {});
    for (const i of v.issues) issues.push({ index, key: `params.${i.key}`, message_zh: i.message_zh });
    members.push({ position: index, provider_id: p.id, model: model ?? "", child_route_id: null, weight, params: v.params, enabled: m.enabled ?? true });
  });
  if (input.strategy === "single" && input.members.length > 1) warnings.push("「單一」策略只會使用第一個成員，其餘成員不會被呼叫。");
  if (issues.length) throw new PlatformError("route_invalid", { message_zh: issues[0]!.message_zh, detail: { issues } });
  const cycle = findCycle(snap.routes, routeId, members.flatMap((m) => (m.child_route_id ? [m.child_route_id] : [])));
  if (cycle) throw new PlatformError("route_cycle", { detail: { path: cycle.map((id) => snap.routes.get(id)?.name ?? (id === routeId ? input.name : id)) } });
  return { members, warnings };
}

/** Snapshot with `routeId` replaced by the edited version (to validate bindings before saving). */
function withRoute(snap: ConfigSnapshot, routeId: string, input: RouteInput, members: Omit<MemberRecord, "id" | "route_id">[]): ConfigSnapshot {
  const routes = new Map(snap.routes);
  routes.set(routeId, {
    id: routeId,
    name: input.name,
    capability: input.capability,
    strategy: input.strategy,
    description: input.description ?? "",
    updated_at: new Date(),
    members: members.map((m, i) => ({ ...m, id: `${routeId}:${i}`, route_id: routeId })),
  });
  return { ...snap, routes };
}

const routeIdsIn = (tree: RouteNode): string[] => [tree.id, ...tree.members.flatMap((m) => (m.node.type === "route" ? routeIdsIn(m.node) : []))];

/** Bindings the edit would affect must stay valid (capability, live support, embedding identity). */
async function checkBoundRoles(platform: AiPlatform, next: ConfigSnapshot, routeId: string) {
  for (const role of AI_ROLES) {
    let tree: RouteNode | null;
    try {
      tree = resolveRole(next, role);
    } catch (e) {
      if (next.roles.get(role)) throw e;
      continue;
    }
    if (!tree || !routeIdsIn(tree).includes(routeId)) continue;
    if (tree.capability !== ROLE_CAPABILITY[role]) throw new PlatformError("capability_mismatch");
    if (role === "asr_live") assertLive(tree);
    if (role === "embedding") await checkEmbeddingBinding(platform, tree);
  }
}

function assertLive(tree: RouteNode) {
  const bad = leaves(tree).find((l) => !liveKinds().includes(l.provider.kind));
  if (bad) throw new PlatformError("route_invalid", { message_zh: `「${bad.provider.name}」不支援即時字幕。`, hint_zh: `即時字幕目前支援：${liveKinds().join("、")}。` });
}

async function writeMembers(client: pg.PoolClient, routeId: string, members: Omit<MemberRecord, "id" | "route_id">[]) {
  await client.query("DELETE FROM ai_route_members WHERE route_id=$1", [routeId]);
  for (const m of members) {
    await client.query(
      "INSERT INTO ai_route_members(route_id,position,provider_id,model,child_route_id,weight,params,enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [routeId, m.position, m.provider_id, m.model, m.child_route_id, m.weight, JSON.stringify(m.params), m.enabled],
    );
  }
}

export async function saveRoute(platform: AiPlatform, id: string | null, input: RouteInput) {
  const snap = await loadSnapshot(platform.db);
  const routeId = id ?? randomUUID();
  const existing = id ? snap.routes.get(id) : undefined;
  if (id && !existing) throw new PlatformError("not_found");
  const { members, warnings } = validateRouteInput(snap, routeId, input);
  const next = withRoute(snap, routeId, input, members);
  if (existing) await checkBoundRoles(platform, next, routeId);
  try {
    await transaction(platform.db, async (client) => {
      if (existing) {
        await client.query("UPDATE ai_routes SET name=$2, capability=$3, strategy=$4, description=$5, updated_at=now() WHERE id=$1", [routeId, input.name.trim(), input.capability, input.strategy, input.description ?? ""]);
      } else {
        await client.query("INSERT INTO ai_routes(id,name,capability,strategy,description) VALUES($1,$2,$3,$4,$5)", [routeId, input.name.trim(), input.capability, input.strategy, input.description ?? ""]);
      }
      await writeMembers(client, routeId, members);
      await notifyConfigChanged(client);
    });
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new PlatformError("route_invalid", { message_zh: "已經有同名的路由。" });
    throw e;
  }
  platform.invalidate();
  const after = await loadSnapshot(platform.db);
  return { route: publicRoute(after.routes.get(routeId)!, after), warnings };
}

export async function deleteRoute(platform: AiPlatform, id: string) {
  const snap = await loadSnapshot(platform.db);
  const r = snap.routes.get(id);
  if (!r) throw new PlatformError("not_found");
  const pub = publicRoute(r, snap);
  if (pub.bound_roles.length || pub.used_by.length)
    throw new PlatformError("route_in_use", { detail: { roles: pub.bound_roles.map((role) => ROLE_LABEL_ZH[role]), parents: pub.used_by.map((p) => p.route_name) } });
  await platform.db.query("DELETE FROM ai_routes WHERE id=$1", [id]);
  await notifyConfigChanged(platform.db);
  platform.invalidate();
}

// ---------------------------------------------------------------- role bindings

export async function bindRole(platform: AiPlatform, role: AiRole, routeId: string | null, userId: string) {
  const snap = await loadSnapshot(platform.db);
  if (routeId === null) {
    await platform.db.query("DELETE FROM ai_role_routes WHERE role=$1", [role]);
    await notifyConfigChanged(platform.db);
    platform.invalidate();
    return { space: null };
  }
  const route = snap.routes.get(routeId);
  if (!route) throw new PlatformError("not_found");
  if (route.capability !== ROLE_CAPABILITY[role]) throw new PlatformError("capability_mismatch");
  const tree = resolveRoute(snap, routeId);
  if (role === "asr_live") assertLive(tree);
  const check = role === "embedding" ? await checkEmbeddingBinding(platform, tree) : null;
  const space = await transaction(platform.db, async (client) => {
    await client.query(
      `INSERT INTO ai_role_routes(role,route_id,updated_by) VALUES($1,$2,$3)
       ON CONFLICT (role) DO UPDATE SET route_id=EXCLUDED.route_id, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [role, routeId, userId],
    );
    const s = check ? await applyEmbeddingBinding(client, tree, check, userId) : null;
    await notifyConfigChanged(client);
    return s;
  });
  platform.invalidate();
  return { space };
}

// ---------------------------------------------------------------- export / import

export const EXPORT_FORMAT = "speech-ai-hub.ai-settings";

export async function exportSettings(db: Db, includeSecrets: boolean) {
  const snap = await loadSnapshot(db);
  const providers = [...snap.providers.values()].map((p) => ({
    family: p.family,
    kind: p.kind,
    name: p.name,
    config: p.config,
    enabled: p.enabled,
    ...(includeSecrets
      ? {
          secrets: providerSecrets(p),
          ...(p.oauth_tokens ? { oauth_tokens: decryptJson(p.oauth_tokens, oauthAad(p.id)) } : {}),
        }
      : {}),
  }));
  const routes = [...snap.routes.values()].map((r) => ({
    name: r.name,
    capability: r.capability,
    strategy: r.strategy,
    description: r.description,
    members: r.members.map((m) => {
      const p = m.provider_id ? snap.providers.get(m.provider_id) : undefined;
      return {
        provider: p ? { family: p.family, name: p.name } : null,
        model: m.model,
        child_route: m.child_route_id ? (snap.routes.get(m.child_route_id)?.name ?? null) : null,
        weight: m.weight,
        params: m.params,
        enabled: m.enabled,
      };
    }),
  }));
  const roles: Record<string, string> = {};
  for (const [role, id] of snap.roles) roles[role] = snap.routes.get(id)?.name ?? "";
  return { format: EXPORT_FORMAT, version: 1, secret: includeSecrets, exported_at: new Date().toISOString(), providers, routes, roles };
}

type ImportFile = Awaited<ReturnType<typeof exportSettings>>;

/** Upserts providers (by family + name) and routes (by name), then role bindings. Returns counts and warnings. */
export async function importSettings(platform: AiPlatform, file: unknown, opts: { includeSecrets: boolean; userId: string }) {
  const f = file as Partial<ImportFile>;
  if (!f || f.format !== EXPORT_FORMAT || f.version !== 1 || !Array.isArray(f.providers) || !Array.isArray(f.routes) || typeof f.roles !== "object")
    throw new PlatformError("import_invalid");
  const useSecrets = opts.includeSecrets && f.secret === true;
  const warnings: string[] = [];
  if (opts.includeSecrets && !f.secret) warnings.push("這個設定檔沒有包含密鑰，已匯入的帳號需要重新輸入 API 金鑰。");
  const counts = { providers_created: 0, providers_updated: 0, routes_created: 0, routes_updated: 0, roles_bound: 0 };
  await transaction(platform.db, async (client) => {
    const ids = new Map<string, string>();
    for (const p of f.providers!) {
      const family = p.family === "asr" ? "asr" : "llm";
      const spec = formSpec(family, String(p.kind));
      if (!spec || typeof p.name !== "string" || !p.name.trim()) {
        warnings.push(`略過不支援的帳號「${String(p.name ?? p.kind)}」。`);
        continue;
      }
      const existing = (await client.query<ProviderRecord>(`SELECT ${PROVIDER_COLUMNS} FROM ai_providers WHERE family=$1 AND name=$2 FOR UPDATE`, [family, p.name])).rows[0];
      if (existing && existing.kind !== p.kind) throw new PlatformError("import_invalid", { message_zh: `帳號「${p.name}」的類型和現有的不同。`, hint_zh: "請先改名或刪除現有帳號再匯入。" });
      const secrets = useSecrets && p.secrets && typeof p.secrets === "object" ? (p.secrets as Record<string, string>) : undefined;
      const id = existing?.id ?? randomUUID();
      const config = validateAccount((spec.entry ?? ({ fields: spec.fields, auth: { type: "none" } } as unknown as ProviderEntry)) as ProviderEntry, (p.config ?? {}) as Record<string, unknown>, {}, spec.fields.map((x) => x.key)).config;
      const merged = { ...(existing ? providerSecrets(existing) : {}), ...(secrets ?? {}) };
      const blob = Object.keys(merged).length ? encryptJson(merged, secretsAad(id)) : null;
      const tokens = useSecrets && (p as { oauth_tokens?: unknown }).oauth_tokens ? encryptJson((p as { oauth_tokens: unknown }).oauth_tokens, oauthAad(id)) : (existing?.oauth_tokens ?? null);
      if (existing) {
        await client.query("UPDATE ai_providers SET config=$2, base_url=$3, secrets=$4, secret_keys=$5, enabled=$6, oauth_tokens=$7, updated_at=now() WHERE id=$1", [
          id, JSON.stringify(config), baseUrlOf(family, config, spec), blob, Object.keys(merged), p.enabled !== false, tokens,
        ]);
        counts.providers_updated++;
      } else {
        await client.query(
          `INSERT INTO ai_providers(id,family,kind,category,name,base_url,auth_type,config,secrets,secret_keys,enabled,oauth_tokens,oauth_meta,created_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [id, family, p.kind, spec.category, p.name.trim(), baseUrlOf(family, config, spec), spec.authType, JSON.stringify(config), blob, Object.keys(merged), p.enabled !== false, tokens, JSON.stringify({ status: tokens ? "connected" : "none" }), opts.userId],
        );
        counts.providers_created++;
      }
      ids.set(`${family}\u0000${p.name}`, id);
    }
    // Routes: create/rename pass first so child references resolve, then members.
    const routeIds = new Map<string, string>();
    for (const r of f.routes!) {
      if (typeof r.name !== "string" || !["chat", "embedding", "asr"].includes(r.capability) || !["single", "fallback", "round_robin", "load_balance"].includes(r.strategy))
        throw new PlatformError("import_invalid", { message_zh: `路由「${String(r.name)}」格式不正確。` });
      const existing = (await client.query<{ id: string; capability: string }>("SELECT id, capability FROM ai_routes WHERE name=$1", [r.name])).rows[0];
      if (existing && existing.capability !== r.capability) throw new PlatformError("import_invalid", { message_zh: `路由「${r.name}」的能力和現有的不同。` });
      const id = existing?.id ?? randomUUID();
      if (existing) {
        await client.query("UPDATE ai_routes SET strategy=$2, description=$3, updated_at=now() WHERE id=$1", [id, r.strategy, r.description ?? ""]);
        counts.routes_updated++;
      } else {
        await client.query("INSERT INTO ai_routes(id,name,capability,strategy,description) VALUES($1,$2,$3,$4,$5)", [id, r.name, r.capability, r.strategy, r.description ?? ""]);
        counts.routes_created++;
      }
      routeIds.set(r.name, id);
    }
    const snap = await loadSnapshot(client);
    for (const r of f.routes!) {
      const routeId = routeIds.get(r.name)!;
      const members: MemberInput[] = (r.members ?? []).map((m) => ({
        provider_id: m.provider ? (ids.get(`${m.provider.family}\u0000${m.provider.name}`) ?? snapProviderId(snap, m.provider)) : null,
        model: m.model,
        child_route_id: m.child_route ? (routeIds.get(m.child_route) ?? null) : null,
        weight: m.weight,
        params: m.params,
        enabled: m.enabled,
      }));
      const { members: valid } = validateRouteInput(snap, routeId, { name: r.name, capability: r.capability, strategy: r.strategy, description: r.description, members });
      await writeMembers(client, routeId, valid);
    }
    const after = await loadSnapshot(client);
    for (const [role, name] of Object.entries(f.roles ?? {})) {
      if (!(AI_ROLES as readonly string[]).includes(role)) continue;
      const routeId = routeIds.get(name) ?? [...after.routes.values()].find((x) => x.name === name)?.id;
      if (!routeId) {
        warnings.push(`找不到「${ROLE_LABEL_ZH[role as AiRole]}」綁定的路由「${name}」。`);
        continue;
      }
      if (after.routes.get(routeId)!.capability !== ROLE_CAPABILITY[role as AiRole]) {
        warnings.push(`「${ROLE_LABEL_ZH[role as AiRole]}」綁定的路由能力不符，已略過。`);
        continue;
      }
      if (role === "embedding") {
        const current = after.roles.get("embedding");
        if (current !== routeId) warnings.push("語意搜尋的綁定沒有匯入：更換 embedding 模型請使用「Embedding → 切換精靈」。");
        continue;
      }
      await client.query(
        `INSERT INTO ai_role_routes(role,route_id,updated_by) VALUES($1,$2,$3)
         ON CONFLICT (role) DO UPDATE SET route_id=EXCLUDED.route_id, updated_by=EXCLUDED.updated_by, updated_at=now()`,
        [role, routeId, opts.userId],
      );
      counts.roles_bound++;
    }
    await notifyConfigChanged(client);
  });
  platform.invalidate();
  return { ...counts, warnings };
}

function snapProviderId(snap: ConfigSnapshot, ref: { family: string; name: string }) {
  for (const p of snap.providers.values()) if (p.family === ref.family && p.name === ref.name) return p.id;
  return null;
}
