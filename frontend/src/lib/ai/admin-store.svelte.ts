import { aiApi, type Binding, type Family, type Group, type LiveStats, type ModelProfile, type Provider, type Registry, type RegistryEntry, type Target, type TargetInput } from "./admin.ts";
import { sameJson } from "./live-poll.ts";
import type { AiRole } from "./status.svelte.ts";

/** `GET /admin/ai/overview?since=`: versions always, stats only when something changed. */
export type OverviewResponse = Partial<LiveStats> & { version?: string; routing_version?: string; stats_version?: string; unchanged?: boolean };
type MemberInput = Pick<Group["members"][number], "model_ref" | "child_group_id" | "weight" | "params" | "enabled">;

/**
 * Shared state of /admin/models: registry, accounts, model profiles, groups, role bindings, live stats. Every panel
 * mutates through here (or reloads here after its own API call), so the overview diagram always shows the same
 * data. `sync()` polls the overview version: unchanged → nothing is touched; a changed routing half (another admin,
 * a health change) refetches the routing lists, and refetches that return equal data keep object identity so the
 * diagram does not re-render. Diagram edits are optimistic (`mutate`) and roll back on error.
 */
let registry = $state<Registry | null>(null);
let providers = $state<Provider[] | null>(null);
let models = $state<ModelProfile[] | null>(null);
let groups = $state<Group[] | null>(null);
let bindings = $state<Binding[] | null>(null);
let stats = $state<LiveStats | null>(null);
let error = $state<unknown>(null);
let syncedAt = $state<number | null>(null);
let syncing = $state(false);
let syncFailed = $state(false);
let version: string | null = null;
let routingVersion: string | null = null;
/** Optimistic mutations in flight: a poll then must not overwrite local state with older server data. */
let pending = 0;

/** Assigns only when the payload differs, so unchanged refetches keep identity (no re-render). */
const keep = <T>(cur: T | null, next: T): T => (cur !== null && sameJson(cur, next) ? cur : next);

export const adminStore = {
  get registry() {
    return registry;
  },
  get providers() {
    return providers;
  },
  get models() {
    return models;
  },
  get groups() {
    return groups;
  },
  get bindings() {
    return bindings;
  },
  get stats() {
    return stats;
  },
  get error() {
    return error;
  },
  /** When the overview last confirmed it is current (ms epoch). */
  get syncedAt() {
    return syncedAt;
  },
  get syncing() {
    return syncing;
  },
  get syncFailed() {
    return syncFailed;
  },
  entry(family: Family, kind: string): RegistryEntry | undefined {
    return (family === "llm" ? registry?.llm : registry?.asr)?.find(e => e.id === kind);
  },
  model(id: string | null | undefined) {
    return id ? models?.find(m => m.id === id) : undefined;
  },
  group(id: string | null | undefined) {
    return id ? groups?.find(g => g.id === id) : undefined;
  },
  provider(id: string | null | undefined) {
    return id ? providers?.find(p => p.id === id) : undefined;
  },
  binding(role: AiRole) {
    return bindings?.find(b => b.role === role);
  },
  async load() {
    error = null;
    try {
      const [reg, p, m, g, b] = await Promise.all([
        registry ? Promise.resolve(registry) : aiApi.get<Registry>("/admin/ai/registry"),
        aiApi.get<{ providers: Provider[] }>("/admin/ai/providers"),
        aiApi.get<{ models: ModelProfile[] }>("/admin/ai/models"),
        aiApi.get<{ groups: Group[] }>("/admin/ai/groups"),
        aiApi.get<{ bindings: Binding[] }>("/admin/ai/bindings"),
      ]);
      registry = reg;
      providers = keep(providers, p.providers);
      models = keep(models, m.models);
      groups = keep(groups, g.groups);
      bindings = keep(bindings, b.bindings);
    } catch (e) {
      error = e;
    }
    // Lists are fresh: adopt whatever routing version the server reports now.
    routingVersion = null;
    version = null;
    void this.sync();
  },
  async reloadProviders() {
    providers = keep(providers, (await aiApi.get<{ providers: Provider[] }>("/admin/ai/providers")).providers);
  },
  async reloadModels() {
    models = keep(models, (await aiApi.get<{ models: ModelProfile[] }>("/admin/ai/models")).models);
  },
  async reloadGroups() {
    groups = keep(groups, (await aiApi.get<{ groups: Group[] }>("/admin/ai/groups")).groups);
  },
  async reloadBindings() {
    bindings = keep(bindings, (await aiApi.get<{ bindings: Binding[] }>("/admin/ai/bindings")).bindings);
  },
  /** Live chips and change detection (see `sync`). */
  reloadStats() {
    return this.sync();
  },
  /**
   * One live poll: asks the overview with the last version. Unchanged → only `syncedAt` moves. Changed traffic →
   * new stats. Changed routing (someone else edited, or role health moved) → refetch the routing lists, unless an
   * optimistic edit is in flight (then the next poll does it).
   */
  async sync() {
    syncing = true;
    try {
      const r = await aiApi.get<OverviewResponse>(`/admin/ai/overview${version ? `?since=${encodeURIComponent(version)}` : ""}`);
      if (!r.unchanged) {
        const next = r.routing_version ?? null;
        const routingChanged = routingVersion !== null && next !== routingVersion;
        let adopt = true;
        if (routingChanged) {
          if (pending > 0) adopt = false;
          else await this.reloadRouting();
        }
        if (r.models && r.roles) stats = keep(stats, { window: r.window ?? "24h", models: r.models, roles: r.roles });
        if (adopt) {
          routingVersion = next;
          version = r.version ?? null;
        } else version = null;
      }
      syncedAt = Date.now();
      syncFailed = false;
    } catch {
      syncFailed = true; /* chips are optional; the next poll retries */
    } finally {
      syncing = false;
    }
  },
  /** Manual refresh: refetch everything routing-related, then a full (non-incremental) live sync. */
  async refresh() {
    await this.reloadRouting().catch(() => {});
    routingVersion = null;
    version = null;
    await this.sync();
  },
  /** After any routing change: everything that shows usage or health. */
  async reloadRouting() {
    await Promise.all([this.reloadGroups(), this.reloadBindings(), this.reloadModels(), this.reloadProviders()]);
  },
  setModels(list: ModelProfile[]) {
    models = keep(models, list);
  },
  /** Replaces one profile in place (after a PATCH). */
  putModel(m: ModelProfile) {
    models = models ? models.map(x => (x.id === m.id ? m : x)) : [m];
  },
  setBindings(list: Binding[]) {
    bindings = list;
  },
  /**
   * Applies `local` right away and runs `remote`; on error restores the previous lists (then refetches the truth)
   * and rethrows. Success triggers a live sync so stats and health follow.
   */
  async mutate<T>(local: () => void, remote: () => Promise<T>): Promise<T> {
    const snap = { groups, bindings, models };
    pending++;
    try {
      local();
      const r = await remote();
      pending--;
      void this.sync();
      return r;
    } catch (e) {
      pending--;
      groups = snap.groups;
      bindings = snap.bindings;
      models = snap.models;
      if (pending === 0) void this.reloadRouting().catch(() => {});
      throw e;
    }
  },
  /** Local-only: point `roles` at `target` (optimistic part of `bind`). */
  localBind(roles: AiRole[], target: TargetInput | null) {
    if (!bindings) return;
    const t: Target | null = !target ? null : "model_id" in target ? { type: "model", model_id: target.model_id, name: this.model(target.model_id)?.model_id ?? null } : { type: "group", group_id: target.group_id, name: this.group(target.group_id)?.name ?? null };
    bindings = bindings.map(b => (roles.includes(b.role) ? { ...b, target: t } : b));
  },
  /** Local-only: replace a group's members (optimistic part of `saveGroup`); keeps member ids where it can. */
  localMembers(groupId: string, list: MemberInput[]) {
    if (!groups) return;
    groups = groups.map(g => {
      if (g.id !== groupId) return g;
      const old = [...g.members];
      const members = list.map((m, i) => {
        const at = old.findIndex(o => o.model_ref === m.model_ref && o.child_group_id === m.child_group_id);
        const prev = at >= 0 ? old.splice(at, 1)[0] : undefined;
        const model = this.model(m.model_ref);
        return {
          ...prev,
          ...m,
          position: i,
          model_id: model?.model_id ?? prev?.model_id ?? null,
          provider_id: model?.provider_id ?? prev?.provider_id ?? null,
          provider_name: model?.provider_name ?? prev?.provider_name ?? null,
          provider_kind: model?.provider_kind ?? prev?.provider_kind ?? null,
          child_group_name: this.group(m.child_group_id)?.name ?? prev?.child_group_name ?? null,
        };
      });
      return { ...g, members };
    });
  },
  /** Bulk bind (or unbind with `target` null), optimistic; returns warnings. Throws AiApiError. */
  bind(roles: AiRole[], target: TargetInput | null, params?: Record<string, unknown>) {
    return this.mutate(
      () => this.localBind(roles, target),
      async () => {
        const r = await aiApi.put<{ bindings: Binding[]; warnings: string[]; created_space: unknown }>("/admin/ai/bindings", { roles, target, ...(params ? { params } : {}) });
        bindings = keep(bindings, r.bindings);
        await Promise.all([this.reloadGroups(), this.reloadModels()]);
        return r;
      },
    );
  },
  /** Saves a group's members, optimistic (drag/keyboard moves in the diagram and the editor). */
  saveGroup(g: Pick<Group, "id" | "name" | "capability" | "strategy" | "description">, members: MemberInput[]) {
    return this.mutate(
      () => this.localMembers(g.id, members),
      () => this.putGroup(g, members),
    );
  },
  /** The PUT behind `saveGroup`, without the optimistic step (for multi-step moves wrapped in one `mutate`). */
  async putGroup(g: Pick<Group, "id" | "name" | "capability" | "strategy" | "description">, members: MemberInput[], reload = true) {
    const body = {
      name: g.name,
      capability: g.capability,
      strategy: g.strategy,
      description: g.description,
      members: members.map(m => (m.child_group_id ? { child_group_id: m.child_group_id, weight: m.weight, enabled: m.enabled } : { model_id: m.model_ref, weight: m.weight, params: m.params, enabled: m.enabled })),
    };
    const r = await aiApi.put<{ group: Group; warnings: string[] }>(`/admin/ai/groups/${g.id}`, body);
    if (reload) await Promise.all([this.reloadGroups(), this.reloadBindings(), this.reloadModels()]);
    return r;
  },
};
