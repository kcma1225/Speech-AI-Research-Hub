/** DB access for the AI platform configuration (providers, model profiles, groups, role bindings). */
import type { Queryable } from "../../db.js";
import { decryptJson, secretsAad } from "./crypto.js";
import { AI_ROLES, type AiRole, type RouteCapability } from "./roles.js";
import { loadModelRows, withProfile, type ModelRecord } from "./models.js";

export type ProviderFamily = "llm" | "asr";
export type ProviderCategory = "external" | "local" | "subscription";
/** Router strategies; `single` is internal (a direct model binding). */
export type Strategy = "single" | "fallback" | "round_robin" | "load_balance";
export type OAuthMeta = { status: "none" | "connected" | "needs_reauth"; email?: string; planType?: string; expiresAt?: number; connectedAt?: number };
export type ProbeSummary = { ok: boolean; latencyMs: number; detail_zh: string; code?: string; modelCount?: number; /** Next step when the probe failed. */ hint_zh?: string };

export type ProviderRecord = {
  id: string;
  family: ProviderFamily;
  kind: string;
  category: ProviderCategory;
  name: string;
  base_url: string | null;
  auth_type: string;
  config: Record<string, unknown>;
  secrets: Buffer | null;
  secret_keys: string[];
  oauth_tokens: Buffer | null;
  oauth_meta: OAuthMeta;
  enabled: boolean;
  last_probe: ProbeSummary | null;
  last_probe_at: Date | null;
  /** When the model list was last read into profiles. */
  models_synced_at?: Date | null;
  updated_at: Date;
  created_at: Date;
};

export type GroupStrategy = "fallback" | "round_robin" | "load_balance";

export type GroupMemberRecord = {
  id: string;
  group_id: string;
  position: number;
  model_ref: string | null;
  child_group_id: string | null;
  weight: number;
  params: Record<string, unknown>;
  enabled: boolean;
};

export type GroupRecord = {
  id: string;
  name: string;
  capability: RouteCapability;
  strategy: GroupStrategy;
  description: string;
  created_at: Date;
  updated_at: Date;
  members: GroupMemberRecord[];
};

/** A role's target: one model profile or one group. */
export type BindingRecord = {
  role: AiRole;
  model_ref: string | null;
  group_id: string | null;
  params: Record<string, unknown>;
  updated_at: Date;
};

/** Everything the router needs, loaded in one go and cached by the platform. */
export type ConfigSnapshot = {
  providers: Map<string, ProviderRecord>;
  /** Model profiles (effective profile resolved with the current catalog). */
  models: Map<string, ModelRecord>;
  groups: Map<string, GroupRecord>;
  bindings: Map<AiRole, BindingRecord>;
  loadedAt: number;
};

export const PROVIDER_COLUMNS =
  "id,family,kind,category,name,base_url,auth_type,config,secrets,secret_keys,oauth_tokens,oauth_meta,enabled,last_probe,last_probe_at,models_synced_at,updated_at,created_at";

export async function loadSnapshot(db: Queryable): Promise<ConfigSnapshot> {
  // Sequential: `db` may be a transaction client (one query at a time).
  const p = await db.query<ProviderRecord>(`SELECT ${PROVIDER_COLUMNS} FROM ai_providers`);
  const models = await loadModelRows(db);
  const g = await db.query<Omit<GroupRecord, "members">>("SELECT id,name,capability,strategy,description,created_at,updated_at FROM ai_groups");
  const m = await db.query<GroupMemberRecord>("SELECT id,group_id,position,model_ref,child_group_id,weight,params,enabled FROM ai_group_members ORDER BY group_id,position");
  const b = await db.query<BindingRecord>("SELECT role,model_ref,group_id,params,updated_at FROM ai_role_bindings");
  const providers = new Map(p.rows.map((row) => [row.id, row]));
  const groups = new Map<string, GroupRecord>(g.rows.map((row) => [row.id, { ...row, members: [] }]));
  for (const mem of m.rows) groups.get(mem.group_id)?.members.push(mem);
  const modelMap = new Map<string, ModelRecord>();
  for (const row of models) {
    const prov = providers.get(row.provider_id);
    if (prov) modelMap.set(row.id, withProfile(prov, row));
  }
  return {
    providers,
    models: modelMap,
    groups,
    bindings: new Map(b.rows.filter((row) => (AI_ROLES as readonly string[]).includes(row.role)).map((row) => [row.role, row])),
    loadedAt: Date.now(),
  };
}

/** Plaintext secrets of a provider (empty object when none are stored). */
export function providerSecrets(p: Pick<ProviderRecord, "id" | "secrets">): Record<string, string> {
  return p.secrets ? decryptJson<Record<string, string>>(p.secrets, secretsAad(p.id)) : {};
}

/** Notifies every process (backend replicas, ai-worker) that the configuration changed. */
export async function notifyConfigChanged(db: Queryable) {
  await db.query("SELECT pg_notify('ai_config', '')");
}
