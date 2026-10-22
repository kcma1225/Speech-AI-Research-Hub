/**
 * The /library 「我的研究 / 全部文獻」 switch. `mine` (the page default) = papers linked to a study I own; `all` = the
 * whole lab library. `?scope=` in the URL wins; otherwise the viewer's last choice (localStorage, per browser).
 */
export type LibraryScope = "mine" | "all";
export type LibraryScopeCounts = { mine: number; all: number };

const KEY = "hub.library.scope";

export function parseLibraryScope(value: string | null | undefined): LibraryScope | null {
  return value === "mine" || value === "all" ? value : null;
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;
function storage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** URL `scope` → remembered choice → `mine`. Storage that throws (private mode, blocked site data) is ignored. */
export function initialLibraryScope(params: { get(name: string): string | null }, store: StorageLike | null = storage()): LibraryScope {
  const explicit = parseLibraryScope(params.get("scope"));
  if (explicit) return explicit;
  try {
    return parseLibraryScope(store?.getItem(KEY)) ?? "mine";
  } catch {
    return "mine";
  }
}

export function rememberLibraryScope(scope: LibraryScope, store: StorageLike | null = storage()) {
  try {
    store?.setItem(KEY, scope);
  } catch {
    /* not remembered: fine */
  }
}
