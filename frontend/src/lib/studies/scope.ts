/**
 * The /studies 「我的研究 / 全實驗室」 switch: which studies a scope shows, the counts in the switch, and the default
 * (mine when I belong to any study, else the whole lab). Kept in the URL as `?scope=mine|lab`; the legacy
 * `?member=me` link means `mine`.
 */
export type StudyScope = "mine" | "lab";
export type ScopeCounts = { mine: number; lab: number };

export function parseScope(value: string | null | undefined): StudyScope | null {
  return value === "mine" || value === "lab" ? value : null;
}

/** Explicit `scope` wins, then legacy `member=me`, then "mine" if I belong to any listed study. */
export function resolveScope(params: { get(name: string): string | null }, counts: ScopeCounts | null): StudyScope | null {
  const explicit = parseScope(params.get("scope"));
  if (explicit) return explicit;
  if (params.get("member") === "me") return "mine";
  if (!counts) return null;
  return counts.mine > 0 ? "mine" : "lab";
}

export function scopeCounts(studies: { my_role: string | null }[]): ScopeCounts {
  return { mine: studies.filter(s => s.my_role !== null).length, lab: studies.length };
}

export function inScope<T extends { my_role: string | null }>(studies: T[], scope: StudyScope): T[] {
  return scope === "mine" ? studies.filter(s => s.my_role !== null) : studies;
}

/** The owner shown on a card (members are ordered owner first). */
export function ownerOf<T extends { role: string }>(members: T[]): T | null {
  return members.find(m => m.role === "owner") ?? null;
}
