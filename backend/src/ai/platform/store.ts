/** DB access for the AI platform configuration (providers, routes, members, role bindings). */
import type { Queryable } from "../../db.js";
import { decryptJson, secretsAad } from "./crypto.js";
import { AI_ROLES, type AiRole, type RouteCapability } from "./roles.js";

export type ProviderFamily = "llm" | "asr";
export type ProviderCategory = "external" | "local" | "subscription";
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
  updated_at: Date;
  created_at: Date;
};

export type MemberRecord = {
  id: string;
  route_id: string;
  position: number;
  provider_id: string | null;
  model: string | null;
  child_route_id: string | null;
  weight: number;
  params: Record<string, unknown>;
  enabled: boolean;
};

export type RouteRecord = {
  id: string;
  name: string;
  capability: RouteCapability;
  strategy: Strategy;
  description: string;
  updated_at: Date;
  members: MemberRecord[];
};

/** Everything the router needs, loaded in one go and cached by the platform. */
export type ConfigSnapshot = {
  providers: Map<string, ProviderRecord>;
  routes: Map<string, RouteRecord>;
  roles: Map<AiRole, string>;
  loadedAt: number;
};

export const PROVIDER_COLUMNS =
  "id,family,kind,category,name,base_url,auth_type,config,secrets,secret_keys,oauth_tokens,oauth_meta,enabled,last_probe,last_probe_at,updated_at,created_at";

export async function loadSnapshot(db: Queryable): Promise<ConfigSnapshot> {
  // Sequential: `db` may be a transaction client (one query at a time).
  const p = await db.query<ProviderRecord>(`SELECT ${PROVIDER_COLUMNS} FROM ai_providers`);
  const r = await db.query<Omit<RouteRecord, "members">>("SELECT id,name,capability,strategy,description,updated_at FROM ai_routes");
  const m = await db.query<MemberRecord>("SELECT id,route_id,position,provider_id,model,child_route_id,weight,params,enabled FROM ai_route_members ORDER BY route_id,position");
  const b = await db.query<{ role: AiRole; route_id: string }>("SELECT role,route_id FROM ai_role_routes");
  const routes = new Map<string, RouteRecord>(r.rows.map((row) => [row.id, { ...row, members: [] }]));
  for (const mem of m.rows) routes.get(mem.route_id)?.members.push(mem);
  return {
    providers: new Map(p.rows.map((row) => [row.id, row])),
    routes,
    roles: new Map(b.rows.filter((row) => (AI_ROLES as readonly string[]).includes(row.role)).map((row) => [row.role, row.route_id])),
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
