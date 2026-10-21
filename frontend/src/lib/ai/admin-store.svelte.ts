import { aiApi, type Binding, type Family, type Group, type LiveStats, type ModelProfile, type Provider, type Registry, type RegistryEntry, type TargetInput } from "./admin.ts";
import type { AiRole } from "./status.svelte.ts";

/** Shared state of /admin/models: registry, accounts, model profiles, groups, role bindings, live stats. */
let registry = $state<Registry | null>(null);
let providers = $state<Provider[] | null>(null);
let models = $state<ModelProfile[] | null>(null);
let groups = $state<Group[] | null>(null);
let bindings = $state<Binding[] | null>(null);
let stats = $state<LiveStats | null>(null);
let error = $state<unknown>(null);

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
      providers = p.providers;
      models = m.models;
      groups = g.groups;
      bindings = b.bindings;
    } catch (e) {
      error = e;
    }
    void this.reloadStats();
  },
  async reloadProviders() {
    providers = (await aiApi.get<{ providers: Provider[] }>("/admin/ai/providers")).providers;
  },
  async reloadModels() {
    models = (await aiApi.get<{ models: ModelProfile[] }>("/admin/ai/models")).models;
  },
  async reloadGroups() {
    groups = (await aiApi.get<{ groups: Group[] }>("/admin/ai/groups")).groups;
  },
  async reloadBindings() {
    bindings = (await aiApi.get<{ bindings: Binding[] }>("/admin/ai/bindings")).bindings;
  },
  async reloadStats() {
    try {
      stats = await aiApi.get<LiveStats>("/admin/ai/overview");
    } catch {
      /* chips are optional */
    }
  },
  /** After any routing change: everything that shows usage or health. */
  async reloadRouting() {
    await Promise.all([this.reloadGroups(), this.reloadBindings(), this.reloadModels(), this.reloadProviders()]);
  },
  setModels(list: ModelProfile[]) {
    models = list;
  },
  /** Replaces one profile in place (after a PATCH). */
  putModel(m: ModelProfile) {
    models = models ? models.map(x => (x.id === m.id ? m : x)) : [m];
  },
  setBindings(list: Binding[]) {
    bindings = list;
  },
  /** Bulk bind (or unbind with `target` null); returns warnings. Throws AiApiError. */
  async bind(roles: AiRole[], target: TargetInput | null, params?: Record<string, unknown>) {
    const r = await aiApi.put<{ bindings: Binding[]; warnings: string[]; created_space: unknown }>("/admin/ai/bindings", { roles, target, ...(params ? { params } : {}) });
    bindings = r.bindings;
    await Promise.all([this.reloadGroups(), this.reloadModels()]);
    return r;
  },
  /** Saves a group's members (used by drag/keyboard moves in the diagram and the editor). */
  async saveGroup(g: Pick<Group, "id" | "name" | "capability" | "strategy" | "description">, members: Array<Pick<Group["members"][number], "model_ref" | "child_group_id" | "weight" | "params" | "enabled">>) {
    const body = {
      name: g.name,
      capability: g.capability,
      strategy: g.strategy,
      description: g.description,
      members: members.map(m => (m.child_group_id ? { child_group_id: m.child_group_id, weight: m.weight, enabled: m.enabled } : { model_id: m.model_ref, weight: m.weight, params: m.params, enabled: m.enabled })),
    };
    const r = await aiApi.put<{ group: Group; warnings: string[] }>(`/admin/ai/groups/${g.id}`, body);
    await Promise.all([this.reloadGroups(), this.reloadBindings(), this.reloadModels()]);
    return r;
  },
};
