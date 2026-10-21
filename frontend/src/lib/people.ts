// Structured person names (backend lib/users/person-name.ts is the source of truth for validation).
// API objects that describe a person carry `name` (Chinese full name, always present) and, where a screen needs the
// English form, `person` / `name_en`. Display goes through `formatPersonName` (or `displayName` in people.svelte.ts,
// which also resolves people by id/name from the directory).
import type { Locale } from "./types.ts";

export const TITLES = ["mr", "ms", "mx", "dr", "prof"] as const;
export type Title = (typeof TITLES)[number];
export const TITLE_EN: Record<Title, string> = { mr: "Mr.", ms: "Ms.", mx: "Mx.", dr: "Dr.", prof: "Prof." };
export const TITLE_ZH: Record<Title, string> = { mr: "先生", ms: "女士", mx: "", dr: "博士", prof: "教授" };

export type Person = {
  zh_family: string | null;
  zh_given: string | null;
  en_family: string | null;
  en_given: string | null;
  title: Title | null;
};
/** `full` = everyday display; `formal` adds the English title (lists of people, meeting participants). */
export type NameStyle = "full" | "formal";

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
export const collapse = (value: string) => value.normalize("NFC").replace(/\s+/g, " ").trim();

/** Chinese-UI full name: CJK family + given without a space (林雅婷); other scripts "Given Family". */
export function composeZhName(family: string, given: string): string {
  if (!given) return family;
  if (!family) return given;
  return CJK_RE.test(family) || CJK_RE.test(given) ? `${family}${given}` : `${given} ${family}`;
}

export function composeEnName(family: string | null | undefined, given: string | null | undefined): string | null {
  if (!family) return null;
  return given ? `${given} ${family}` : family;
}

type Named = { name?: string | null; name_en?: string | null; person?: Partial<Person> | null };

/**
 * zh-TW → 中文全名 (titles are never shown in Chinese lists); en → "Given Family", "Dr. Given Family" when formal.
 * Falls back to `name_en` / `name` when the structured parts are unknown.
 */
export function formatPersonName(who: Named, locale: Locale, style: NameStyle = "full"): string {
  const p = who.person ?? {};
  const fallback = who.name ?? "";
  if (locale === "en") {
    const en = composeEnName(p.en_family, p.en_given) ?? who.name_en ?? null;
    if (!en) return fallback;
    return style === "formal" && p.title ? `${TITLE_EN[p.title]} ${en}` : en;
  }
  return p.zh_family && p.zh_given ? composeZhName(p.zh_family, p.zh_given) : fallback;
}

/** 王教授-style Chinese address (family name + 先生/女士/博士/教授); the full name without a Chinese title. */
export function formalZhAddress(who: Named): string {
  const p = who.person ?? {};
  const suffix = p.title ? TITLE_ZH[p.title] : "";
  return suffix && p.zh_family ? `${p.zh_family}${suffix}` : formatPersonName(who, "zh-TW");
}

/** Avatar initials: the last two CJK characters (given name), or the first letters of the first and last word. */
export function initialsOf(name: string): string {
  const trimmed = name.trim();
  if (CJK_RE.test(trimmed)) return trimmed.replace(/\s/g, "").slice(-2);
  const parts = trimmed.split(/[\s]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts.at(-1)![0] : (parts[0]?.[1] ?? ""))).toUpperCase();
}

/** Picker search: real name, every name part, the English display and the username (with or without "@"). */
export function personMatches(who: Named & { username?: string | null }, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const handle = q.replace(/^@/, "");
  const p = who.person ?? {};
  const fields = [who.name, who.name_en, p.zh_family, p.zh_given, p.en_family, p.en_given, composeEnName(p.en_family, p.en_given), composeEnName(p.en_given, p.en_family)];
  if (fields.some(f => f && f.toLowerCase().replace(/\s+/g, " ").includes(q))) return true;
  // "yating" finds "Ya-Ting"; "林雅" finds 林雅婷 already above.
  const squash = (s: string) => s.toLowerCase().replace(/[\s.'’-]+/g, "");
  if (fields.some(f => f && squash(f).includes(squash(q)))) return true;
  return !!handle && !!who.username && who.username.includes(handle);
}

// Validation mirrors the backend (messages come from i18n in the form component).
const ZH_PART_RE = /^[\p{L}\p{M}](?:[\p{L}\p{M} ·・'’-]*[\p{L}\p{M}])?$/u;
const EN_PART_RE = /^[A-Za-zÀ-ɏ](?:[A-Za-zÀ-ɏ .'’-]*[A-Za-zÀ-ɏ.])?$/;
const len = (s: string) => [...s].length;
export const validZhPart = (v: string) => {
  const c = collapse(v);
  return len(c) >= 1 && len(c) <= 20 && ZH_PART_RE.test(c);
};
export const validEnFamily = (v: string) => {
  const c = collapse(v);
  return len(c) >= 1 && len(c) <= 40 && EN_PART_RE.test(c);
};
export const validEnGiven = (v: string) => {
  const c = collapse(v);
  return !c || (len(c) <= 40 && EN_PART_RE.test(c));
};

/** Form state of the name fields (strings; "" = empty / no title). */
export type NameForm = { zhFamily: string; zhGiven: string; enFamily: string; enGiven: string; title: Title | "" };
export const emptyNameForm = (): NameForm => ({ zhFamily: "", zhGiven: "", enFamily: "", enGiven: "", title: "" });
export const nameFormFrom = (p: Partial<Person> | null | undefined): NameForm => ({
  zhFamily: p?.zh_family ?? "",
  zhGiven: p?.zh_given ?? "",
  enFamily: p?.en_family ?? "",
  enGiven: p?.en_given ?? "",
  title: p?.title ?? "",
});
export const nameFormValid = (f: NameForm) => validZhPart(f.zhFamily) && validZhPart(f.zhGiven) && validEnFamily(f.enFamily) && validEnGiven(f.enGiven);
/** API body (`names`) for join / profile / admin edit. */
export const nameFormPayload = (f: NameForm) => ({
  zhFamily: collapse(f.zhFamily),
  zhGiven: collapse(f.zhGiven),
  enFamily: collapse(f.enFamily),
  enGiven: collapse(f.enGiven) || null,
  title: f.title || null,
});
export const nameFormPerson = (f: NameForm): Person => {
  const b = nameFormPayload(f);
  return { zh_family: b.zhFamily || null, zh_given: b.zhGiven || null, en_family: b.enFamily || null, en_given: b.enGiven, title: b.title };
};
export const sameNameForm = (a: NameForm, b: NameForm) => JSON.stringify(nameFormPayload(a)) === JSON.stringify(nameFormPayload(b));
