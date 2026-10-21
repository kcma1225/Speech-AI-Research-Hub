// Registry of known people so any screen can show a person in the UI language, even when its API object only carries
// the Chinese `name` (most domain APIs). Filled from /users/directory (loaded once per session by the app layout),
// the current user, and any list that already has `person` (admin users). Lookup is by id, else by a unique name.
import { api } from "./api.ts";
import { i18n } from "./i18n.svelte.ts";
import { formatPersonName, initialsOf, type NameStyle, type Person } from "./people.ts";

type Entry = { id: string; name: string; name_en?: string | null; person?: Partial<Person> | null };
type Who = string | { id?: string | null; name?: string | null; name_en?: string | null; person?: Partial<Person> | null } | null | undefined;

let byId = $state.raw(new Map<string, Entry>());
let byName = $state.raw(new Map<string, Entry | null>()); // null = ambiguous (two people share the name)
let loaded: Promise<void> | null = null;

function rebuildNames(map: Map<string, Entry>) {
  const names = new Map<string, Entry | null>();
  for (const e of map.values()) {
    const prev = names.get(e.name);
    names.set(e.name, prev === undefined ? e : prev && formatPersonName(prev, "en") === formatPersonName(e, "en") ? prev : null);
  }
  byName = names;
}

export const people = {
  /** Adds or updates people (only entries with an id and a name). */
  register(list: readonly Entry[]) {
    if (!list.length) return;
    const next = new Map(byId);
    for (const e of list) if (e?.id && e.name) next.set(e.id, { ...next.get(e.id), ...e });
    byId = next;
    rebuildNames(next);
  },
  /** Loads the directory once per page load; `force` refreshes it (e.g. after a rename). */
  ensure(force = false) {
    if (loaded && !force) return loaded;
    loaded = api
      .get<{ users: Entry[] }>("/users/directory")
      .then(r => people.register(r.users))
      .catch(() => {
        loaded = null;
      });
    return loaded;
  },
  get(id: string | null | undefined) {
    return id ? byId.get(id) : undefined;
  },
  reset() {
    byId = new Map();
    byName = new Map();
    loaded = null;
  },
};

function resolve(who: Who): Entry | { name: string; name_en?: string | null; person?: Partial<Person> | null } {
  if (!who) return { name: "" };
  if (typeof who === "string") return byName.get(who) ?? { name: who };
  if (who.person) return { name: who.name ?? "", name_en: who.name_en, person: who.person };
  const known = (who.id && byId.get(who.id)) || (who.name ? byName.get(who.name) : undefined);
  return known ?? { name: who.name ?? "", name_en: who.name_en };
}

/** A person's name in the current UI language (reactive). Pass the API object (`{id, name}`) or just the name. */
export function displayName(who: Who, style: NameStyle = "full"): string {
  const locale = i18n.locale;
  if (locale !== "en" && (typeof who === "string" || !who?.person)) return typeof who === "string" ? who : (who?.name ?? "");
  return formatPersonName(resolve(who), locale, style);
}

/** Avatar initials from the locale-appropriate name. */
export const displayInitials = (who: Who) => initialsOf(displayName(who) || (typeof who === "string" ? who : (who?.name ?? "")) || "?");
