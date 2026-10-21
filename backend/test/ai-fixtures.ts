/** In-memory routing fixtures (providers, model profiles, groups, bindings) for router/health unit tests. */
import { withProfile, type ModelRecord } from "../src/ai/platform/models.js";
import type { AiRole } from "../src/ai/platform/roles.js";
import type { BindingRecord, ConfigSnapshot, GroupMemberRecord, GroupRecord, ProviderRecord } from "../src/ai/platform/store.js";
import type { ProfileFields } from "../src/ai/catalog/index.js";

let n = 0;
export const fid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

export function provider(over: Partial<ProviderRecord> = {}): ProviderRecord {
  const id = fid();
  return {
    id,
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

export function model(p: ProviderRecord, modelId: string, o: { api?: ProfileFields; overrides?: ProfileFields } = {}): ModelRecord {
  return withProfile(p, {
    id: fid(),
    provider_id: p.id,
    model_id: modelId,
    origin: "sync",
    listed: true,
    enabled: true,
    api: o.api ?? {},
    overrides: o.overrides ?? {},
    refreshed_at: null,
    created_at: new Date(),
    updated_at: new Date(),
  });
}

/** Member spec: a model record, `{ group: id }` for a child group, plus optional weight/params/enabled. */
export type MemberSpec = (ModelRecord | { group: string }) & { weight?: number; params?: Record<string, unknown>; enabled?: boolean };

export function group(gid: string, strategy: GroupRecord["strategy"], members: MemberSpec[], capability: GroupRecord["capability"] = "chat"): GroupRecord {
  return {
    id: gid,
    name: gid,
    capability,
    strategy,
    description: "",
    created_at: new Date(),
    updated_at: new Date(),
    members: members.map(
      (m, i): GroupMemberRecord => ({
        id: `${gid}-m${i}`,
        group_id: gid,
        position: i,
        model_ref: "group" in m ? null : m.id,
        child_group_id: "group" in m ? m.group : null,
        weight: m.weight ?? 1,
        params: m.params ?? {},
        enabled: m.enabled ?? true,
      }),
    ),
  };
}

export type BindSpec = { group: string } | { model: ModelRecord; params?: Record<string, unknown> };

export function snapshot(o: { providers: ProviderRecord[]; models?: ModelRecord[]; groups?: GroupRecord[]; bindings?: Partial<Record<AiRole, BindSpec>> }): ConfigSnapshot {
  const groups = o.groups ?? [];
  const models = new Map<string, ModelRecord>((o.models ?? []).map((m) => [m.id, m]));
  for (const g of groups) for (const m of g.members) if (m.model_ref && !models.has(m.model_ref)) throw new Error("fixture: add the model to `models`");
  const bindings = new Map<AiRole, BindingRecord>();
  for (const [role, b] of Object.entries(o.bindings ?? {}) as Array<[AiRole, BindSpec]>) {
    bindings.set(role, "group" in b ? { role, model_ref: null, group_id: b.group, params: {}, updated_at: new Date() } : { role, model_ref: b.model.id, group_id: null, params: b.params ?? {}, updated_at: new Date() });
  }
  return { providers: new Map(o.providers.map((p) => [p.id, p])), models, groups: new Map(groups.map((g) => [g.id, g])), bindings, loadedAt: Date.now() };
}
