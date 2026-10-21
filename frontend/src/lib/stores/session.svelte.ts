import { api, ApiError } from "#lib/api.ts";
import { i18n } from "#lib/i18n.svelte.ts";
import { theme } from "#lib/theme.svelte.ts";
import { jobsStore } from "#lib/stores/jobs.svelte.ts";
import { notificationsStore } from "#lib/stores/notifications.svelte.ts";
import type { ClientConfig, CurrentUser, Locale, Preferences, ThemePref } from "#lib/types.ts";

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

let user = $state<CurrentUser | null>(null);
let config = $state<ClientConfig>({ latexUrl: null, pushPublicKey: null });
let loaded = $state(false);

function adopt(next: CurrentUser | null) {
  user = next;
  if (next) {
    theme.set(next.theme, { animate: false });
    i18n.set(next.locale ?? "zh-TW", { animate: false });
  }
}

export const session = {
  get user() {
    return user;
  },
  get config() {
    return config;
  },
  get loaded() {
    return loaded;
  },
  /** System admin (accounts, invitations, models, templates). */
  get isAdmin() {
    return !!user?.is_admin;
  },
  async load() {
    // Transient failures (429/5xx/network) are retried: they must not look like a logged-out session.
    const me = await retry(() => api.get<{ user: CurrentUser | null }>("/auth/me"));
    const cfg = await api.get<ClientConfig>("/config").catch(() => config);
    adopt(me.user);
    config = cfg;
    loaded = true;
  },
  async login(credentials: { userId?: string; name?: string; password: string }) {
    const result = await api.post<{ account: { id: string; name: string } }>("/auth/login", credentials);
    rememberAccount(result.account.id);
    await this.load();
  },
  async logout() {
    await api.post("/auth/logout").catch(() => {});
    jobsStore.stop();
    notificationsStore.stop();
    user = null;
  },
  /** PATCH /auth/profile; the server returns the updated user. Optimistic for theme/locale. */
  async update(patch: { name?: string; theme?: ThemePref; locale?: Locale; preferences?: DeepPartial<Preferences>; currentPassword?: string; newPassword?: string }) {
    if (patch.theme) theme.set(patch.theme);
    if (patch.locale) i18n.set(patch.locale);
    const result = await api.patch<{ user: CurrentUser } | CurrentUser>("/auth/profile", patch);
    const next = "user" in result ? result.user : result;
    if (next && user) user = { ...user, ...next };
  },
};

async function retry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i + 1 >= attempts || (e instanceof ApiError && e.status !== 0 && e.status < 500 && e.status !== 429)) throw e;
      await new Promise(r => setTimeout(r, 400 * 2 ** i));
    }
  }
}

const ACCOUNTS_KEY = "hub-accounts";
export function rememberedAccounts(): string[] {
  try {
    return JSON.parse(localStorage.getItem(ACCOUNTS_KEY) ?? "[]").filter((x: unknown) => typeof x === "string").slice(0, 5);
  } catch {
    return [];
  }
}
function rememberAccount(id: string) {
  try {
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify([id, ...rememberedAccounts().filter(x => x !== id)].slice(0, 5)));
  } catch {}
}
export function forgetAccount(id: string) {
  try {
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(rememberedAccounts().filter(x => x !== id)));
  } catch {}
}
