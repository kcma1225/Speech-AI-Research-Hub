import { aiApi, type Provider, type Registry, type RegistryEntry, type Route, type RoleBinding, type Family } from "./admin.ts";

/** Shared state of /admin/models: registry, accounts, routes, bindings (each panel reloads what it changed). */
let registry = $state<Registry | null>(null);
let providers = $state<Provider[] | null>(null);
let routes = $state<Route[] | null>(null);
let roles = $state<RoleBinding[] | null>(null);
let error = $state<unknown>(null);
/** Model lists fetched by "test" per provider id (offered in the route editor). */
let models = $state<Record<string, string[]>>({});

export const adminStore = {
  get registry() {
    return registry;
  },
  get providers() {
    return providers;
  },
  get routes() {
    return routes;
  },
  get roles() {
    return roles;
  },
  get error() {
    return error;
  },
  get models() {
    return models;
  },
  entry(family: Family, kind: string): RegistryEntry | undefined {
    return (family === "llm" ? registry?.llm : registry?.asr)?.find(e => e.id === kind);
  },
  setModels(providerId: string, list: string[]) {
    models = { ...models, [providerId]: list };
  },
  async load() {
    error = null;
    try {
      const [reg, p, r, b] = await Promise.all([
        registry ? Promise.resolve(registry) : aiApi.get<Registry>("/admin/ai/registry"),
        aiApi.get<{ providers: Provider[] }>("/admin/ai/providers"),
        aiApi.get<{ routes: Route[] }>("/admin/ai/routes"),
        aiApi.get<{ roles: RoleBinding[] }>("/admin/ai/roles"),
      ]);
      registry = reg;
      providers = p.providers;
      routes = r.routes;
      roles = b.roles;
    } catch (e) {
      error = e;
    }
  },
  async reloadProviders() {
    providers = (await aiApi.get<{ providers: Provider[] }>("/admin/ai/providers")).providers;
  },
  async reloadRoutes() {
    routes = (await aiApi.get<{ routes: Route[] }>("/admin/ai/routes")).routes;
  },
  async reloadRoles() {
    roles = (await aiApi.get<{ roles: RoleBinding[] }>("/admin/ai/roles")).roles;
  },
  async reloadAll() {
    await Promise.all([this.reloadProviders(), this.reloadRoutes(), this.reloadRoles()]);
  },
};
