/**
 * Admin-side logic for /api/admin/ai/*: provider accounts (secrets write-only), model profiles, groups (nesting
 * member trees), role bindings (bulk), export/import. Route handlers in routes/ai-admin.ts stay thin.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { transaction, type Db, type Queryable } from "../../db.js";
import { getAsrEntry, liveKinds, publicAsrRegistry } from "../asr/index.js";
import { getProvider, publicProviders, validateAccount, type FormField, type ProviderEntry } from "../providers/index.js";
import { applyEmbeddingBinding, checkEmbeddingBinding } from "../embedding/switch.js";
import { findCycle, groupDepth, groupIdsIn, leaves, MAX_GROUP_DEPTH, resolveGroup, resolveRole, resolveTarget, type GroupNode } from "../router/index.js";
import { catalogLookup, cleanFields, type ModelCapability, type ProfileField } from "../catalog/index.js";
import { applyOverridePatch, ensureModel, MODEL_COLUMNS, resolveProfile, withProfile, type ModelRecord, type ModelRow } from "./models.js";
import { modelVision } from "./vision.js";
import { modelAudio } from "./audio.js";
import { decryptJson, encryptJson, hasProviderKey, oauthAad, secretsAad } from "./crypto.js";
import { PlatformError } from "./errors.js";
import { CHAT_PLATFORM_PARAMS, EMBED_PLATFORM_PARAMS, memberParamFields, validateMemberParams } from "./params.js";
import type { AiPlatform } from "./platform.js";
import { AI_ROLES, ROLE_CAPABILITY, ROLE_LABEL_ZH, type AiRole, type RouteCapability } from "./roles.js";
import { loadSnapshot, notifyConfigChanged, PROVIDER_COLUMNS, providerSecrets, type BindingRecord, type ConfigSnapshot, type GroupMemberRecord, type GroupRecord, type GroupStrategy, type ProviderFamily, type ProviderRecord } from "./store.js";
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
    platform_params: { chat: CHAT_PLATFORM_PARAMS, embedding: EMBED_PLATFORM_PARAMS, asr: memberParamFields("asr", "openai"), asr_llm: memberParamFields("asr", "openai-compatible") },
    live_kinds: liveKinds(),
    secrets_key_configured: hasProviderKey(),
  };
}

// ---------------------------------------------------------------- providers

export type UsageRef = { kind: "group" | "role"; id: string; name: string };
export type PublicProvider = Omit<ProviderRecord, "secrets" | "oauth_tokens"> & {
  label: { zh: string; en: string } | null;
  secrets_set: Record<string, boolean>;
  /** Groups and roles that use one of this account's models. */
  used_by: UsageRef[];
  model_count: number;
  warnings_zh: string[];
};

/** Where a model profile is used (group members, direct role bindings). */
export function modelUsage(snap: ConfigSnapshot, modelRef: string): UsageRef[] {
  const out: UsageRef[] = [];
  for (const g of snap.groups.values()) if (g.members.some((m) => m.model_ref === modelRef)) out.push({ kind: "group", id: g.id, name: g.name });
  for (const [role, b] of snap.bindings) if (b.model_ref === modelRef) out.push({ kind: "role", id: role, name: ROLE_LABEL_ZH[role] });
  return out;
}

export function publicProvider(p: ProviderRecord, snap?: ConfigSnapshot): PublicProvider {
  const { secrets: _s, oauth_tokens: _o, ...rest } = p;
  const spec = formSpec(p.family, p.kind);
  const secretFields = spec?.fields.filter((f) => f.type === "secret").map((f) => f.key) ?? [];
  const used_by: UsageRef[] = [];
  let model_count = 0;
  if (snap) {
    const seen = new Set<string>();
    for (const m of snap.models.values()) {
      if (m.provider_id !== p.id) continue;
      model_count++;
      for (const u of modelUsage(snap, m.id)) if (!seen.has(`${u.kind}:${u.id}`)) (seen.add(`${u.kind}:${u.id}`), used_by.push(u));
    }
  }
  const label = p.family === "llm" ? (getProvider(p.kind)?.label ?? null) : (getAsrEntry(p.kind)?.label ?? null);
  return {
    ...rest,
    label,
    secrets_set: Object.fromEntries(secretFields.map((k) => [k, p.secret_keys.includes(k)])),
    used_by,
    model_count,
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
  const snap = await loadSnapshot(db);
  const used = [...snap.models.values()].filter((m) => m.provider_id === id).flatMap((m) => modelUsage(snap, m.id));
  if (used.length) throw new PlatformError("provider_in_use", { detail: { used_by: used.map((u) => u.name) } });
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


// ---------------------------------------------------------------- model profiles

const familyFor = (c: ModelCapability): ProviderFamily => (c === "asr" ? "asr" : "llm");
/** Accounts usable for a capability: speech roles also take multimodal chat models with audio input (LLM accounts). */
const familyOk = (family: ProviderFamily, c: ModelCapability) => family === familyFor(c) || (c === "asr" && family === "llm");

const FIELD_LABEL_ZH: Record<ProfileField, string> = {
  display_name: "顯示名稱",
  capability: "類型",
  context_window: "上下文長度",
  max_output_tokens: "最大輸出",
  vision: "視覺",
  audio_input: "音訊輸入",
  tools: "工具呼叫",
  reasoning: "推理",
  json_schema: "結構化輸出",
  embedding_dims: "向量維度",
  input_price: "輸入價格",
  output_price: "輸出價格",
};

export type PublicModel = ReturnType<typeof publicModel>;

export function publicModel(m: ModelRecord, snap: ConfigSnapshot) {
  const p = snap.providers.get(m.provider_id);
  return {
    id: m.id,
    provider_id: m.provider_id,
    provider_name: p?.name ?? null,
    provider_kind: p?.kind ?? null,
    provider_family: p?.family ?? null,
    model_id: m.model_id,
    origin: m.origin,
    listed: m.listed,
    enabled: m.enabled,
    refreshed_at: m.refreshed_at,
    updated_at: m.updated_at,
    fields: m.profile.fields,
    sources: m.profile.sources,
    api: cleanFields(m.api),
    overrides: cleanFields(m.overrides),
    /** Built-in catalog defaults (what remains when the listing and overrides say nothing). */
    catalog: p ? catalogLookup(m.model_id, p.family).fields : {},
    catalog_id: m.profile.catalog_id,
    vision: p ? modelVision(p, m.model_id, m.profile) : null,
    /** Audio input (speech-to-text by a multimodal chat model; see audio.ts). */
    audio: p ? modelAudio(p, m.model_id, m.profile) : null,
    used_by: modelUsage(snap, m.id),
  };
}

export async function addModel(platform: AiPlatform, input: { provider_id: string; model_id: string; overrides?: Record<string, unknown> }) {
  const p = await getProviderRow(platform.db, input.provider_id);
  const row = await ensureModel(platform.db, p, input.model_id);
  if (input.overrides && Object.keys(input.overrides).length) await patchModel(platform, row.id, { overrides: input.overrides });
  await notifyConfigChanged(platform.db);
  platform.invalidate();
  const snap = await loadSnapshot(platform.db);
  return publicModel(snap.models.get(row.id)!, snap);
}

/** `overrides`: field → value (manual), `null` clears a field back to provider/catalog data. */
export async function patchModel(platform: AiPlatform, id: string, input: { enabled?: boolean; overrides?: Record<string, unknown> }) {
  const db = platform.db;
  const row = (await db.query<ModelRow>(`SELECT ${MODEL_COLUMNS} FROM ai_models WHERE id=$1`, [id])).rows[0];
  if (!row) throw new PlatformError("not_found");
  if (input.overrides) {
    const ok = cleanFields(input.overrides) as Record<string, unknown>;
    const bad = Object.entries(input.overrides).filter(([k, v]) => v !== null && ok[k] === undefined);
    if (bad.length)
      throw new PlatformError("route_invalid", {
        message_zh: `「${FIELD_LABEL_ZH[bad[0]![0] as ProfileField] ?? bad[0]![0]}」的值不正確。`,
        detail: { issues: bad.map(([k]) => ({ index: 0, key: `overrides.${k}`, message_zh: "格式不正確。" })) },
      });
  }
  const overrides = input.overrides ? applyOverridePatch(row.overrides, input.overrides) : row.overrides;
  if (input.overrides?.capability !== undefined) {
    // A model in use must keep the capability its groups and roles expect.
    const snap = await loadSnapshot(db);
    const p = snap.providers.get(row.provider_id)!;
    const next = resolveProfile(p, { ...row, overrides }).fields.capability;
    const cur = snap.models.get(id)?.profile.fields.capability;
    if (next !== cur && modelUsage(snap, id).length) throw new PlatformError("capability_mismatch", { message_zh: "這個模型正在使用中，不能改變類型。", hint_zh: "請先從功能綁定與群組移除它。" });
  }
  await db.query("UPDATE ai_models SET enabled=$2, overrides=$3, updated_at=now() WHERE id=$1", [id, input.enabled ?? row.enabled, JSON.stringify(overrides)]);
  await notifyConfigChanged(db);
  platform.invalidate();
  const snap = await loadSnapshot(db);
  return publicModel(snap.models.get(id)!, snap);
}

export async function deleteModel(platform: AiPlatform, id: string) {
  const snap = await loadSnapshot(platform.db);
  const m = snap.models.get(id);
  if (!m) throw new PlatformError("not_found");
  const used = modelUsage(snap, id);
  const space = (await platform.db.query("SELECT 1 FROM embedding_spaces WHERE model_ref=$1 AND status IN ('active','building','ready')", [id])).rowCount;
  if (used.length || space) throw new PlatformError("route_in_use", { message_zh: "這個模型仍在使用中。", detail: { used_by: used.map((u) => u.name) } });
  await platform.db.query("DELETE FROM ai_models WHERE id=$1", [id]);
  await notifyConfigChanged(platform.db);
  platform.invalidate();
}

// ---------------------------------------------------------------- groups

/** A member names a profile (`model_id` = ai_models.id), an account + vendor model id (profile auto-created), or a child group. */
export type MemberInput = {
  model_id?: string | null;
  provider_id?: string | null;
  model?: string | null;
  child_group_id?: string | null;
  weight?: number;
  params?: Record<string, unknown>;
  enabled?: boolean;
};
export type GroupInput = { name: string; capability: ModelCapability; strategy: GroupStrategy; description?: string; members: MemberInput[] };
type Issue = { index: number; key: string; message_zh: string };
type DraftMember = Omit<GroupMemberRecord, "id" | "group_id">;

export function publicGroup(g: GroupRecord, snap: ConfigSnapshot) {
  const bound_roles = AI_ROLES.filter((role) => snap.bindings.get(role)?.group_id === g.id);
  const parents = [...snap.groups.values()].filter((x) => x.members.some((m) => m.child_group_id === g.id)).map((x) => ({ id: x.id, name: x.name }));
  return {
    ...g,
    members: g.members.map((m) => {
      const model = m.model_ref ? snap.models.get(m.model_ref) : undefined;
      const p = model ? snap.providers.get(model.provider_id) : undefined;
      const child = m.child_group_id ? snap.groups.get(m.child_group_id) : undefined;
      return {
        ...m,
        model_id: model?.model_id ?? null,
        provider_id: model?.provider_id ?? null,
        provider_name: p?.name ?? null,
        provider_kind: p?.kind ?? null,
        child_group_name: child?.name ?? null,
      };
    }),
    bound_roles,
    used_by: parents,
  };
}

/** Problems with using `model` for `capability` (account family, vendor support, profile capability). */
function modelIssues(snap: ConfigSnapshot, m: ModelRecord, capability: ModelCapability): string[] {
  const p = snap.providers.get(m.provider_id);
  if (!p) return ["找不到這個模型的供應商帳號。"];
  const out: string[] = [];
  if (!familyOk(p.family, capability)) out.push(`「${p.name}」不能用在${capability === "asr" ? "語音" : "文字"}功能。`);
  else if (p.family === "llm" && capability === "asr") {
    // Speech-to-text by a multimodal chat model: needs a chat model whose protocol and profile accept audio.
    const a = modelAudio(p, m.model_id, m.profile);
    if (!a.codec_ok) out.push(`「${p.name}」的連線方式無法傳送音訊（目前支援 OpenAI 相容 Chat Completions 與 Gemini），不能用在語音轉文字。`);
    else if (m.profile.fields.capability === "asr")
      out.push(`「${m.model_id}」是語音轉文字模型，但「${p.name}」是聊天模型帳號，只能用支援音訊輸入的多模態聊天模型轉錄。Whisper 等語音模型請新增「語音轉文字」帳號後再綁定。`);
    else if (m.profile.fields.capability !== "chat") out.push(`「${m.model_id}」是${capLabel(m.profile.fields.capability)}模型，不能用在語音轉文字。`);
    else if (!a.audio) out.push(`「${m.model_id}」不支援音訊輸入，不能用在語音轉文字。若確定支援，可在「模型」分頁開啟「音訊輸入」。`);
  } else if (p.family === "llm") {
    const caps = getProvider(p.kind)?.capabilities;
    if (capability === "chat" && !caps?.chat) out.push(`「${p.name}」不支援聊天。`);
    if (capability === "embedding" && !caps?.embeddings) out.push(`「${p.name}」不支援 embedding。`);
    if (m.profile.fields.capability !== capability)
      out.push(`「${m.model_id}」是${capLabel(m.profile.fields.capability)}模型，不能用在${capLabel(capability)}。可在「模型」分頁修改它的類型。`);
  }
  return out;
}
const capLabel = (c: ModelCapability) => (c === "chat" ? "聊天" : c === "embedding" ? "embedding" : "語音轉文字");

/**
 * Resolves member inputs (creating profiles for `provider_id + model` members) and validates them against the
 * snapshot. Throws PlatformError with `detail.issues` (index = member position).
 */
async function prepareMembers(client: Queryable, snap: ConfigSnapshot, groupId: string, input: GroupInput): Promise<{ members: DraftMember[]; warnings: string[] }> {
  const issues: Issue[] = [];
  const warnings: string[] = [];
  const members: DraftMember[] = [];
  for (const [index, m] of input.members.entries()) {
    const weight = m.weight ?? 1;
    const enabled = m.enabled ?? true;
    if (m.child_group_id) {
      if (m.model_id || m.provider_id || m.model) issues.push({ index, key: "child_group_id", message_zh: "成員只能是「模型」或「子群組」其中一種。" });
      const child = snap.groups.get(m.child_group_id);
      if (!child) issues.push({ index, key: "child_group_id", message_zh: "找不到子群組。" });
      else if (child.capability !== input.capability) issues.push({ index, key: "child_group_id", message_zh: `子群組「${child.name}」的類型不同。` });
      if (m.child_group_id === groupId) issues.push({ index, key: "child_group_id", message_zh: "群組不能包含自己。" });
      members.push({ position: index, model_ref: null, child_group_id: m.child_group_id, weight, params: {}, enabled });
      continue;
    }
    let model: ModelRecord | undefined;
    if (m.model_id) {
      model = snap.models.get(m.model_id);
      if (!model) issues.push({ index, key: "model_id", message_zh: "找不到這個模型。" });
    } else {
      const p = m.provider_id ? snap.providers.get(m.provider_id) : undefined;
      const id = m.model?.trim();
      if (!p) issues.push({ index, key: "provider_id", message_zh: "請選擇供應商帳號。" });
      else if (!id) issues.push({ index, key: "model", message_zh: "請填寫模型。" });
      else if (!familyOk(p.family, input.capability)) issues.push({ index, key: "provider_id", message_zh: `「${p.name}」不能用在${input.capability === "asr" ? "語音" : "文字"}功能。` });
      else {
        const row = await ensureModel(client, p, id, input.capability);
        model = withProfile(p, row);
        snap.models.set(model.id, model);
      }
    }
    if (!model) continue;
    for (const msg of modelIssues(snap, model, input.capability)) issues.push({ index, key: "model_id", message_zh: msg });
    const p = snap.providers.get(model.provider_id)!;
    if (p.kind === "claude-cli") warnings.push("Claude Code CLI 不支援工具呼叫，不適合綁定給 AI 助理（assistant）。");
    const v = validateMemberParams(input.capability, p.kind, m.params ?? {});
    for (const i of v.issues) issues.push({ index, key: `params.${i.key}`, message_zh: i.message_zh });
    members.push({ position: index, model_ref: model.id, child_group_id: null, weight, params: v.params, enabled });
  }
  if (issues.length) throw new PlatformError("route_invalid", { message_zh: issues[0]!.message_zh, detail: { issues } });
  const childIds = members.flatMap((m) => (m.child_group_id ? [m.child_group_id] : []));
  const cycle = findCycle(snap.groups, groupId, childIds);
  if (cycle) throw new PlatformError("route_cycle", { detail: { path: cycle.map((id) => snap.groups.get(id)?.name ?? (id === groupId ? input.name : id)) } });
  // Depth: every group (this one and its ancestors) must stay within MAX_GROUP_DEPTH levels.
  const draft = new Map(snap.groups);
  draft.set(groupId, { id: groupId, members: members.map((m, i) => ({ ...m, id: `${groupId}:${i}`, group_id: groupId })) } as GroupRecord);
  for (const g of draft.values()) {
    if (groupDepth(draft, g.id, draft.get(g.id)!.members.flatMap((m) => (m.child_group_id ? [m.child_group_id] : []))) > MAX_GROUP_DEPTH)
      throw new PlatformError("route_invalid", { message_zh: `群組最多 ${MAX_GROUP_DEPTH} 層。`, hint_zh: "請減少巢狀的子群組。" });
  }
  return { members, warnings: [...new Set(warnings)] };
}

function withGroup(snap: ConfigSnapshot, groupId: string, input: GroupInput, members: DraftMember[]): ConfigSnapshot {
  const groups = new Map(snap.groups);
  const now = new Date();
  groups.set(groupId, {
    id: groupId,
    name: input.name,
    capability: input.capability,
    strategy: input.strategy,
    description: input.description ?? "",
    created_at: snap.groups.get(groupId)?.created_at ?? now,
    updated_at: now,
    members: members.map((m, i) => ({ ...m, id: snap.groups.get(groupId)?.members[i]?.id ?? `${groupId}:${i}`, group_id: groupId })),
  });
  return { ...snap, groups };
}

/** Roles whose tree contains `groupId` must stay valid after the edit (capability, live support, embedding identity). */
async function checkBoundRoles(platform: AiPlatform, next: ConfigSnapshot, groupId: string) {
  for (const role of AI_ROLES) {
    let tree: GroupNode | null;
    try {
      tree = resolveRole(next, role);
    } catch (e) {
      if (next.bindings.get(role)) throw e;
      continue;
    }
    if (!tree || !groupIdsIn(tree).includes(groupId)) continue;
    if (tree.capability !== ROLE_CAPABILITY[role]) throw new PlatformError("capability_mismatch");
    if (role === "asr_live") assertLive(tree);
    if (role === "embedding") await checkEmbeddingBinding(platform, tree);
  }
}

function assertLive(tree: GroupNode) {
  const bad = leaves(tree).find((l) => !liveKinds().includes(l.provider.kind));
  if (bad) throw new PlatformError("route_invalid", { message_zh: `「${bad.provider.name}」不支援即時字幕。`, hint_zh: `即時字幕目前支援：${liveKinds().join("、")}。` });
}

async function writeMembers(client: Queryable, groupId: string, members: DraftMember[]) {
  await client.query("DELETE FROM ai_group_members WHERE group_id=$1", [groupId]);
  for (const m of members) {
    await client.query("INSERT INTO ai_group_members(group_id,position,model_ref,child_group_id,weight,params,enabled) VALUES($1,$2,$3,$4,$5,$6,$7)", [
      groupId,
      m.position,
      m.model_ref,
      m.child_group_id,
      m.weight,
      JSON.stringify(m.params),
      m.enabled,
    ]);
  }
}

export async function saveGroup(platform: AiPlatform, id: string | null, input: GroupInput) {
  const groupId = id ?? randomUUID();
  let warnings: string[] = [];
  try {
    await transaction(platform.db, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(473941)");
      const snap = await loadSnapshot(client);
      const existing = id ? snap.groups.get(id) : undefined;
      if (id && !existing) throw new PlatformError("not_found");
      if (existing && existing.capability !== input.capability && AI_ROLES.some((r) => snap.bindings.get(r)?.group_id === id))
        throw new PlatformError("capability_mismatch", { message_zh: "這個群組已綁定功能，不能改變類型。" });
      const prepared = await prepareMembers(client, snap, groupId, input);
      warnings = prepared.warnings;
      if (existing) await checkBoundRoles(platform, withGroup(snap, groupId, input, prepared.members), groupId);
      if (existing) {
        await client.query("UPDATE ai_groups SET name=$2, capability=$3, strategy=$4, description=$5, updated_at=now() WHERE id=$1", [groupId, input.name.trim(), input.capability, input.strategy, input.description ?? ""]);
      } else {
        await client.query("INSERT INTO ai_groups(id,name,capability,strategy,description) VALUES($1,$2,$3,$4,$5)", [groupId, input.name.trim(), input.capability, input.strategy, input.description ?? ""]);
      }
      await writeMembers(client, groupId, prepared.members);
      await notifyConfigChanged(client);
    });
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new PlatformError("route_invalid", { message_zh: "已經有同名的群組。", detail: { issues: [{ index: -1, key: "name", message_zh: "名稱重複。" }] } });
    throw e;
  }
  platform.invalidate();
  const after = await loadSnapshot(platform.db);
  return { group: publicGroup(after.groups.get(groupId)!, after), warnings };
}

export async function deleteGroup(platform: AiPlatform, id: string) {
  const snap = await loadSnapshot(platform.db);
  const g = snap.groups.get(id);
  if (!g) throw new PlatformError("not_found");
  const pub = publicGroup(g, snap);
  const spaces = (await platform.db.query("SELECT 1 FROM embedding_spaces WHERE group_id=$1 AND status IN ('active','building','ready')", [id])).rowCount;
  if (pub.bound_roles.length || pub.used_by.length || spaces)
    throw new PlatformError("route_in_use", { detail: { roles: pub.bound_roles.map((role) => ROLE_LABEL_ZH[role]), parents: pub.used_by.map((p) => p.name) } });
  await platform.db.query("DELETE FROM ai_groups WHERE id=$1", [id]);
  await notifyConfigChanged(platform.db);
  platform.invalidate();
}

// ---------------------------------------------------------------- role bindings

/** A binding target: a model profile, a vendor model on an account (profile auto-created) or a group. */
export type TargetInput = { model_id?: string; provider_id?: string; model?: string; group_id?: string };

export function publicBinding(role: AiRole, snap: ConfigSnapshot) {
  const b = snap.bindings.get(role);
  if (!b) return { role, target: null, params: {}, updated_at: null };
  const target = b.group_id ? { type: "group" as const, group_id: b.group_id, name: snap.groups.get(b.group_id)?.name ?? null } : { type: "model" as const, model_id: b.model_ref!, name: snap.models.get(b.model_ref!)?.model_id ?? null };
  return { role, target, params: b.params, updated_at: b.updated_at };
}

/**
 * Binds every role in `roles` to one target (or unbinds them with `target` null), in one transaction.
 * All roles must need the target's capability. Embedding keeps the identity guard (first setup creates the
 * space; a different model answers 409 and needs the switch wizard).
 */
export async function bindRoles(platform: AiPlatform, roles: AiRole[], target: TargetInput | null, params: Record<string, unknown> | undefined, userId: string) {
  const unique = [...new Set(roles)];
  if (!unique.length) throw new PlatformError("route_invalid", { message_zh: "請至少選擇一個功能。" });
  if (target === null) {
    await transaction(platform.db, async (client) => {
      await client.query("DELETE FROM ai_role_bindings WHERE role = ANY($1::text[])", [unique]);
      await notifyConfigChanged(client);
    });
    platform.invalidate();
    return { space: null, warnings: [] as string[] };
  }
  const caps = new Set(unique.map((r) => ROLE_CAPABILITY[r]));
  if (caps.size > 1) throw new PlatformError("capability_mismatch", { message_zh: "選取的功能需要不同類型的模型，請分開綁定。", hint_zh: "聊天功能、語意搜尋與語音需要不同類型的模型。" });
  const capability = [...caps][0]!;
  const warnings: string[] = [];
  let snap = await loadSnapshot(platform.db);
  let record: Pick<BindingRecord, "model_ref" | "group_id" | "params">;
  if (target.group_id) {
    const g = snap.groups.get(target.group_id);
    if (!g) throw new PlatformError("not_found");
    if (g.capability !== capability) throw new PlatformError("capability_mismatch");
    record = { model_ref: null, group_id: g.id, params: {} };
  } else {
    let modelRef = target.model_id;
    if (!modelRef) {
      const p = target.provider_id ? snap.providers.get(target.provider_id) : undefined;
      if (!p || !target.model?.trim()) throw new PlatformError("route_invalid", { message_zh: "請選擇模型。" });
      if (!familyOk(p.family, capability)) throw new PlatformError("capability_mismatch");
      modelRef = (await ensureModel(platform.db, p, target.model, capability)).id;
      snap = await loadSnapshot(platform.db);
    }
    const m = snap.models.get(modelRef);
    if (!m) throw new PlatformError("not_found");
    const problems = modelIssues(snap, m, capability);
    if (problems.length) throw new PlatformError("capability_mismatch", { message_zh: problems[0]! });
    const p = snap.providers.get(m.provider_id)!;
    const v = validateMemberParams(capability, p.kind, params ?? {});
    if (v.issues.length) throw new PlatformError("route_invalid", { message_zh: v.issues[0]!.message_zh, detail: { issues: v.issues.map((i) => ({ index: 0, key: `params.${i.key}`, message_zh: i.message_zh })) } });
    record = { model_ref: m.id, group_id: null, params: v.params };
  }
  const tree = resolveTarget(snap, record, unique[0]!, capability);
  if (!leaves(tree).length) throw new PlatformError("route_invalid", { message_zh: "這個群組沒有啟用中的成員。" });
  if (unique.includes("asr_live")) assertLive(tree);
  if (unique.includes("assistant") && leaves(tree).some((l) => l.provider.kind === "claude-cli" || l.profile.fields.tools === false))
    warnings.push("有成員不支援工具呼叫：AI 助理需要工具，請改用支援工具的模型。");
  const check = unique.includes("embedding") ? await checkEmbeddingBinding(platform, tree) : null;
  const space = await transaction(platform.db, async (client) => {
    for (const role of unique) {
      await client.query(
        `INSERT INTO ai_role_bindings(role,model_ref,group_id,params,updated_by) VALUES($1,$2,$3,$4,$5)
         ON CONFLICT (role) DO UPDATE SET model_ref=EXCLUDED.model_ref, group_id=EXCLUDED.group_id, params=EXCLUDED.params, updated_by=EXCLUDED.updated_by, updated_at=now()`,
        [role, record.model_ref, record.group_id, JSON.stringify(record.params), userId],
      );
    }
    const s = check ? await applyEmbeddingBinding(client, tree, record, check, userId) : null;
    await notifyConfigChanged(client);
    return s;
  });
  platform.invalidate();
  return { space, warnings };
}

// ---------------------------------------------------------------- export / import

export const EXPORT_FORMAT = "speech-ai-hub.ai-settings";
export const EXPORT_VERSION = 2;

type ProviderRef = { family: string; name: string };
type ModelRefOut = { provider: ProviderRef; model_id: string };

export async function exportSettings(db: Db, includeSecrets: boolean) {
  const snap = await loadSnapshot(db);
  const pref = (providerId: string): ProviderRef => {
    const p = snap.providers.get(providerId)!;
    return { family: p.family, name: p.name };
  };
  const mref = (id: string): ModelRefOut | null => {
    const m = snap.models.get(id);
    return m ? { provider: pref(m.provider_id), model_id: m.model_id } : null;
  };
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
  // Only profiles an admin touched or something uses (listings are re-read on sync).
  const models = [...snap.models.values()]
    .filter((m) => m.origin === "manual" || !m.enabled || Object.keys(cleanFields(m.overrides)).length || modelUsage(snap, m.id).length)
    .map((m) => ({ provider: pref(m.provider_id), model_id: m.model_id, enabled: m.enabled, overrides: cleanFields(m.overrides) }));
  const groups = [...snap.groups.values()].map((g) => ({
    name: g.name,
    capability: g.capability,
    strategy: g.strategy,
    description: g.description,
    members: g.members.map((m) => ({
      model: m.model_ref ? mref(m.model_ref) : null,
      child_group: m.child_group_id ? (snap.groups.get(m.child_group_id)?.name ?? null) : null,
      weight: m.weight,
      params: m.params,
      enabled: m.enabled,
    })),
  }));
  const bindings: Record<string, { model?: ModelRefOut | null; group?: string; params?: Record<string, unknown> }> = {};
  for (const [role, b] of snap.bindings) bindings[role] = b.group_id ? { group: snap.groups.get(b.group_id)?.name ?? "" } : { model: mref(b.model_ref!), params: b.params };
  return { format: EXPORT_FORMAT, version: EXPORT_VERSION, secret: includeSecrets, exported_at: new Date().toISOString(), providers, models, groups, bindings };
}

type V2File = Awaited<ReturnType<typeof exportSettings>>;
type V1Route = { name: string; capability: ModelCapability; strategy: string; description?: string; members?: Array<{ provider: ProviderRef | null; model: string | null; child_route: string | null; weight?: number; params?: Record<string, unknown>; enabled?: boolean }> };

/** Converts a version-1 file (named routes) into the version-2 shape (single-model bound routes → direct bindings). */
export function upgradeV1(f: Record<string, unknown>): V2File {
  const routes = (Array.isArray(f.routes) ? f.routes : []) as V1Route[];
  const roles = (f.roles && typeof f.roles === "object" ? f.roles : {}) as Record<string, string>;
  const single = new Map<string, NonNullable<V1Route["members"]>[number]>();
  for (const r of routes) if (r.members?.length === 1 && r.members[0]!.provider && r.members[0]!.model) single.set(r.name, r.members[0]!);
  const stripParams = (p?: Record<string, unknown>) => {
    const { vision: _v, max_tokens: _m, ...rest } = p ?? {};
    return rest;
  };
  const models: V2File["models"] = [];
  for (const r of routes)
    for (const m of r.members ?? [])
      if (m.provider && m.model && (m.params?.vision === "yes" || m.params?.vision === "no"))
        models.push({ provider: m.provider, model_id: m.model, enabled: true, overrides: { vision: m.params.vision === "yes" } });
  const groups: V2File["groups"] = routes
    .filter((r) => !single.has(r.name))
    .map((r) => ({
      name: r.name,
      capability: r.capability,
      strategy: (r.strategy === "single" ? "fallback" : r.strategy) as GroupStrategy,
      description: r.description ?? "",
      members: (r.members ?? []).map((m) => {
        const inline = m.child_route ? single.get(m.child_route) : undefined;
        const src = inline ?? m;
        return {
          model: src.provider && src.model ? { provider: src.provider, model_id: src.model } : null,
          child_group: !inline && m.child_route ? m.child_route : null,
          weight: m.weight ?? 1,
          params: stripParams(src.params),
          enabled: m.enabled !== false && (inline?.enabled ?? true) !== false,
        };
      }),
    }));
  const bindings: V2File["bindings"] = {};
  for (const [role, name] of Object.entries(roles)) {
    const s = single.get(name);
    bindings[role] = s ? { model: { provider: s.provider!, model_id: s.model! }, params: stripParams(s.params) } : { group: name };
  }
  return { format: EXPORT_FORMAT, version: EXPORT_VERSION, secret: f.secret === true, exported_at: String(f.exported_at ?? ""), providers: (f.providers ?? []) as V2File["providers"], models, groups, bindings };
}

/** Upserts providers (by family + name), model profiles, groups (by name), then role bindings. Imports versions 1 and 2. */
export async function importSettings(platform: AiPlatform, file: unknown, opts: { includeSecrets: boolean; userId: string }) {
  const raw = file as Record<string, unknown> | null;
  if (!raw || raw.format !== EXPORT_FORMAT || !Array.isArray(raw.providers)) throw new PlatformError("import_invalid");
  let f: V2File;
  if (raw.version === 1) {
    if (!Array.isArray(raw.routes) || typeof raw.roles !== "object") throw new PlatformError("import_invalid");
    f = upgradeV1(raw);
  } else if (raw.version === 2) {
    if (!Array.isArray(raw.groups) || typeof raw.bindings !== "object") throw new PlatformError("import_invalid");
    f = raw as unknown as V2File;
  } else throw new PlatformError("import_invalid");
  const useSecrets = opts.includeSecrets && f.secret === true;
  const warnings: string[] = [];
  if (opts.includeSecrets && !f.secret) warnings.push("這個設定檔沒有包含密鑰，已匯入的帳號需要重新輸入 API 金鑰。");
  const counts = { providers_created: 0, providers_updated: 0, models_updated: 0, groups_created: 0, groups_updated: 0, roles_bound: 0 };
  await transaction(platform.db, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(473941)");
    const ids = new Map<string, string>();
    for (const p of f.providers) {
      const family = p.family === "asr" ? "asr" : "llm";
      const spec = formSpec(family, String(p.kind));
      if (!spec || typeof p.name !== "string" || !p.name.trim()) {
        warnings.push(`略過不支援的帳號「${String(p.name ?? p.kind)}」。`);
        continue;
      }
      const existing = (await client.query<ProviderRecord>(`SELECT ${PROVIDER_COLUMNS} FROM ai_providers WHERE family=$1 AND name=$2 FOR UPDATE`, [family, p.name])).rows[0];
      if (existing && existing.kind !== p.kind) throw new PlatformError("import_invalid", { message_zh: `帳號「${p.name}」的類型和現有的不同。`, hint_zh: "請先改名或刪除現有帳號再匯入。" });
      const ps = p as { secrets?: unknown; oauth_tokens?: unknown };
      const secrets = useSecrets && ps.secrets && typeof ps.secrets === "object" ? (ps.secrets as Record<string, string>) : undefined;
      const id = existing?.id ?? randomUUID();
      const cfg = { ...((p.config ?? {}) as Record<string, unknown>) };
      delete cfg.numCtx;
      delete cfg.defaultMaxTokens;
      const config = validateAccount((spec.entry ?? ({ fields: spec.fields, auth: { type: "none" } } as unknown as ProviderEntry)) as ProviderEntry, cfg, {}, spec.fields.map((x) => x.key)).config;
      const merged = { ...(existing ? providerSecrets(existing) : {}), ...(secrets ?? {}) };
      const blob = Object.keys(merged).length ? encryptJson(merged, secretsAad(id)) : null;
      const tokens = useSecrets && ps.oauth_tokens ? encryptJson(ps.oauth_tokens, oauthAad(id)) : (existing?.oauth_tokens ?? null);
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
    let snap = await loadSnapshot(client);
    const providerId = (ref: ProviderRef | null | undefined) => {
      if (!ref) return null;
      const hit = ids.get(`${ref.family}\u0000${ref.name}`);
      if (hit) return hit;
      for (const p of snap.providers.values()) if (p.family === ref.family && p.name === ref.name) return p.id;
      return null;
    };
    const modelRefOf = async (ref: ModelRefOut | null | undefined, capability?: ModelCapability) => {
      const pid = providerId(ref?.provider);
      const p = pid ? snap.providers.get(pid) : undefined;
      if (!p || !ref?.model_id) return null;
      return (await ensureModel(client, p, ref.model_id, capability)).id;
    };
    for (const m of f.models ?? []) {
      const id = await modelRefOf(m);
      if (!id) {
        warnings.push(`略過找不到帳號的模型「${m.model_id}」。`);
        continue;
      }
      const row = (await client.query<ModelRow>(`SELECT ${MODEL_COLUMNS} FROM ai_models WHERE id=$1`, [id])).rows[0]!;
      await client.query("UPDATE ai_models SET enabled=$2, overrides=$3, updated_at=now() WHERE id=$1", [id, m.enabled !== false, JSON.stringify({ ...cleanFields(row.overrides), ...cleanFields(m.overrides) })]);
      counts.models_updated++;
    }
    // Groups: create/rename pass first so child references resolve, then members.
    const groupIds = new Map<string, string>();
    for (const g of f.groups) {
      if (typeof g.name !== "string" || !["chat", "embedding", "asr"].includes(g.capability) || !["fallback", "round_robin", "load_balance"].includes(g.strategy))
        throw new PlatformError("import_invalid", { message_zh: `群組「${String(g.name)}」格式不正確。` });
      const existing = (await client.query<{ id: string; capability: string }>("SELECT id, capability FROM ai_groups WHERE name=$1", [g.name])).rows[0];
      if (existing && existing.capability !== g.capability) throw new PlatformError("import_invalid", { message_zh: `群組「${g.name}」的類型和現有的不同。` });
      const id = existing?.id ?? randomUUID();
      if (existing) {
        await client.query("UPDATE ai_groups SET strategy=$2, description=$3, updated_at=now() WHERE id=$1", [id, g.strategy, g.description ?? ""]);
        counts.groups_updated++;
      } else {
        await client.query("INSERT INTO ai_groups(id,name,capability,strategy,description) VALUES($1,$2,$3,$4,$5)", [id, g.name, g.capability, g.strategy, g.description ?? ""]);
        counts.groups_created++;
      }
      groupIds.set(g.name, id);
    }
    snap = await loadSnapshot(client);
    for (const g of f.groups) {
      const groupId = groupIds.get(g.name)!;
      const members: MemberInput[] = [];
      for (const m of g.members ?? []) {
        const childId = m.child_group ? (groupIds.get(m.child_group) ?? [...snap.groups.values()].find((x) => x.name === m.child_group)?.id ?? null) : null;
        const modelId = m.model ? await modelRefOf(m.model, g.capability) : null;
        if (!childId && !modelId) {
          warnings.push(`群組「${g.name}」有成員找不到對應的帳號或子群組，已略過。`);
          continue;
        }
        members.push({ model_id: modelId, child_group_id: childId, weight: m.weight, params: m.params, enabled: m.enabled });
      }
      snap = await loadSnapshot(client);
      const { members: valid } = await prepareMembers(client, snap, groupId, { name: g.name, capability: g.capability, strategy: g.strategy, description: g.description, members });
      await writeMembers(client, groupId, valid);
    }
    snap = await loadSnapshot(client);
    for (const [role, b] of Object.entries(f.bindings ?? {})) {
      if (!(AI_ROLES as readonly string[]).includes(role)) continue;
      const label = ROLE_LABEL_ZH[role as AiRole];
      const cap = ROLE_CAPABILITY[role as AiRole];
      let record: { model_ref: string | null; group_id: string | null; params: Record<string, unknown> } | null = null;
      if (b.group) {
        const gid = groupIds.get(b.group) ?? [...snap.groups.values()].find((x) => x.name === b.group)?.id;
        if (gid && snap.groups.get(gid)!.capability === cap) record = { model_ref: null, group_id: gid, params: {} };
      } else if (b.model) {
        const mid = await modelRefOf(b.model, cap);
        snap = await loadSnapshot(client);
        const m = mid ? snap.models.get(mid) : undefined;
        if (m && !modelIssues(snap, m, cap).length) record = { model_ref: m.id, group_id: null, params: validateMemberParams(cap, snap.providers.get(m.provider_id)!.kind, b.params ?? {}).params };
      }
      if (!record) {
        warnings.push(`「${label}」的綁定找不到相符的模型或群組，已略過。`);
        continue;
      }
      if (role === "embedding") {
        const cur = snap.bindings.get("embedding");
        if (cur?.model_ref !== record.model_ref || cur?.group_id !== record.group_id) warnings.push("語意搜尋的綁定沒有匯入：更換 embedding 模型請使用「Embedding → 切換精靈」。");
        continue;
      }
      await client.query(
        `INSERT INTO ai_role_bindings(role,model_ref,group_id,params,updated_by) VALUES($1,$2,$3,$4,$5)
         ON CONFLICT (role) DO UPDATE SET model_ref=EXCLUDED.model_ref, group_id=EXCLUDED.group_id, params=EXCLUDED.params, updated_by=EXCLUDED.updated_by, updated_at=now()`,
        [role, record.model_ref, record.group_id, JSON.stringify(record.params), opts.userId],
      );
      counts.roles_bound++;
    }
    await notifyConfigChanged(client);
  });
  platform.invalidate();
  return { ...counts, warnings };
}

// ---------------------------------------------------------------- legacy "routes" API (deprecated)

/**
 * The v1 admin API had named routes. `POST/PUT /admin/ai/routes` and `PUT /admin/ai/roles/:role {route_id}` still
 * work (scripts and older tests): a route is a group, `single` maps to `fallback`, members `{provider_id, model}`
 * get profiles automatically.
 */
export function routeInputToGroup(input: { name: string; capability: ModelCapability; strategy: string; description?: string; members: Array<MemberInput & { child_route_id?: string | null }> }): GroupInput {
  return {
    name: input.name,
    capability: input.capability,
    strategy: (input.strategy === "single" ? "fallback" : input.strategy) as GroupStrategy,
    description: input.description,
    members: input.members.map(({ child_route_id, ...m }) => ({ ...m, child_group_id: m.child_group_id ?? child_route_id ?? null })),
  };
}

export function groupAsRoute(g: ReturnType<typeof publicGroup>) {
  return { ...g, members: g.members.map((m) => ({ ...m, model: m.model_id, child_route_id: m.child_group_id, child_route_name: m.child_group_name })) };
}
