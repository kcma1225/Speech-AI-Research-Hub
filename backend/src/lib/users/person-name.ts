import { pinyin } from "pinyin-pro";
import { z } from "zod";
import type { Db } from "../../db.js";
import { foldAscii, hasHan } from "../library/normalize.js";

/**
 * Structured person names (migration 0112_person_names.sql). Every account has a Chinese name (中文姓 + 中文名, both
 * required), an English name (family name required, given name optional) and an optional 稱謂 (title code).
 * `users.real_name` is derived from the Chinese parts on every API write (`composeZhName`) and `users.name` stays its
 * generated copy, so server-side text (notifications, audit, AI prompts) keeps the Chinese full name.
 * `users.name_en` is a generated column: "Given Family" (or "Family"), NULL when the English name is unknown.
 */
export const TITLES = ["mr", "ms", "mx", "dr", "prof"] as const;
export type Title = (typeof TITLES)[number];
export const TITLE_EN: Record<Title, string> = { mr: "Mr.", ms: "Ms.", mx: "Mx.", dr: "Dr.", prof: "Prof." };
export const TITLE_ZH: Record<Title, string> = { mr: "先生", ms: "女士", mx: "", dr: "博士", prof: "教授" };

export type PersonNames = {
  zh_family: string | null;
  zh_given: string | null;
  en_family: string | null;
  en_given: string | null;
  title: Title | null;
};

export const ZH_PART_HINT = "中文姓與中文名各需 1–20 個字，只能使用文字、空格、「·」、連字號或撇號。";
export const EN_FAMILY_HINT = "英文姓（Family name）需為 1–40 個英文字母，可含空格、連字號、撇號或句點。";
export const EN_GIVEN_HINT = "英文名（Given name）可留空；若填寫需為 1–40 個英文字母，可含空格、連字號、撇號或句點。";
export const NAMES_HINT = "請填寫中文姓、中文名與英文姓（英文名與稱謂可留空）。";

const collapse = (value: string) => value.normalize("NFC").replace(/\s+/g, " ").trim();
const ZH_PART_RE = /^[\p{L}\p{M}](?:[\p{L}\p{M} ·・'’-]*[\p{L}\p{M}])?$/u;
const EN_PART_RE = /^[A-Za-zÀ-ɏ](?:[A-Za-zÀ-ɏ .'’-]*[A-Za-zÀ-ɏ.])?$/;
const len = (value: string) => [...value].length;

export const zhPartSchema = z
  .string()
  .max(200)
  .transform(collapse)
  .refine(v => len(v) >= 1 && len(v) <= 20 && ZH_PART_RE.test(v), { message: ZH_PART_HINT });
export const enFamilySchema = z
  .string()
  .max(200)
  .transform(collapse)
  .refine(v => len(v) >= 1 && len(v) <= 40 && EN_PART_RE.test(v), { message: EN_FAMILY_HINT });
/** Optional: "", whitespace or null all mean "no given name". */
export const enGivenSchema = z
  .union([z.string().max(200), z.null()])
  .transform(v => (v === null ? null : collapse(v) || null))
  .refine(v => v === null || (len(v) <= 40 && EN_PART_RE.test(v)), { message: EN_GIVEN_HINT });
export const titleSchema = z.union([z.enum(TITLES), z.literal(""), z.null()]).transform(v => (v ? v : null));

/** API input (camelCase) for join / profile / admin edit; output is the column shape. */
export const personNamesSchema = z
  .object({
    zhFamily: zhPartSchema,
    zhGiven: zhPartSchema,
    enFamily: enFamilySchema,
    enGiven: enGivenSchema.optional(),
    title: titleSchema.optional(),
  })
  .transform(
    (v): PersonNames => ({ zh_family: v.zhFamily, zh_given: v.zhGiven, en_family: v.enFamily, en_given: v.enGiven ?? null, title: v.title ?? null }),
  );

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Chinese-UI full name: CJK names are family + given without a space (林雅婷); others are "Given Family". */
export function composeZhName(family: string, given: string): string {
  if (!given) return family;
  if (!family) return given;
  return CJK_RE.test(family) || CJK_RE.test(given) ? `${family}${given}` : `${given} ${family}`;
}

/** English display without a title: "Given Family", or "Family" alone. */
export function composeEnName(family: string | null, given: string | null): string | null {
  if (!family) return null;
  return given ? `${given} ${family}` : family;
}

export type NameStyle = "full" | "formal";

/**
 * Locale display of a person. `fallback` (normally `users.name`) is used when the structured fields are missing.
 * zh-TW → 中文全名 in every style (Chinese lists never carry a title; `formalZhAddress` gives 王教授-style address);
 * en → "Given Family" (formal prefixes the title abbreviation: "Dr. Ya-Ting Lin").
 */
export function formatPersonName(person: Partial<PersonNames> & { name?: string | null }, locale: "zh-TW" | "en", style: NameStyle = "full"): string {
  const fallback = person.name ?? "";
  if (locale === "en") {
    const en = composeEnName(person.en_family ?? null, person.en_given ?? null);
    if (!en) return fallback;
    return style === "formal" && person.title ? `${TITLE_EN[person.title]} ${en}` : en;
  }
  return person.zh_family && person.zh_given ? composeZhName(person.zh_family, person.zh_given) : fallback;
}

/** Formal Chinese address: family name + 先生/女士/博士/教授 (王教授); the full name when there is no (zh) title. */
export function formalZhAddress(person: Partial<PersonNames> & { name?: string | null }): string {
  const suffix = person.title ? TITLE_ZH[person.title] : "";
  if (suffix && person.zh_family) return `${person.zh_family}${suffix}`;
  return formatPersonName(person, "zh-TW");
}

/** Two-character (and Taiwanese double) surnames, Traditional and Simplified. */
export const COMPOUND_SURNAMES = new Set(
  "歐陽 欧阳 司馬 司马 諸葛 诸葛 上官 東方 东方 皇甫 尉遲 尉迟 公孫 公孙 慕容 長孫 长孙 宇文 司徒 司空 令狐 夏侯 澹臺 澹台 軒轅 轩辕 端木 南宮 南宫 西門 西门 申屠 呼延 獨孤 独孤 聞人 闻人 赫連 赫连 范姜 張簡 张简 張廖 张廖 簡李 简李 周黃 周黄".split(" "),
);

const capitalise = (syllable: string) => (syllable ? syllable[0]!.toUpperCase() + syllable.slice(1) : syllable);
const romanise = (syllables: string[]) => syllables.map(s => foldAscii(s.replace(/ü/g, "yu")).replace(/[^a-z]/gi, ""));

/** Han text → pinyin syllables (surname readings for the first characters when `surname`). */
function syllables(text: string, surname: boolean): string[] {
  return romanise(pinyin(text, { toneType: "none", type: "array", surname: surname ? "head" : "off" }) as string[]).filter(Boolean);
}

/**
 * Best-effort split of a legacy single real name into structured parts (migration 0112 backfill):
 * Han names → first character (or a known compound surname) is the family name, the rest the given name; the English
 * name is pinyin (歐陽娜娜 → Ouyang / Na-Na). Other names split on the last space ("Alice Wang" → Wang / Alice).
 */
export function splitLegacyName(realName: string): Omit<PersonNames, "title"> {
  const name = collapse(realName);
  const han = [...name].filter(c => hasHan(c));
  if (han.length >= 2 && han.length === [...name.replace(/[ ·・]/g, "")].length) {
    const familyLen = COMPOUND_SURNAMES.has(han.slice(0, 2).join("")) && han.length >= 3 ? 2 : 1;
    const zhFamily = han.slice(0, familyLen).join("");
    const zhGiven = han.slice(familyLen).join("");
    const all = syllables(han.join(""), true);
    const familySyl = all.slice(0, familyLen);
    const givenSyl = all.slice(familyLen);
    // Over-long romanisations (never valid input) are left for the user, so the 1–40 column CHECKs always hold.
    const fit = (v: string | null) => (v && len(v) <= 40 && EN_PART_RE.test(v) ? v : null);
    const enFamily = fit(familySyl.length ? capitalise(familySyl.join("").toLowerCase()) : null);
    return {
      zh_family: zhFamily,
      zh_given: zhGiven,
      en_family: enFamily,
      en_given: enFamily ? fit(givenSyl.length ? givenSyl.map(s => capitalise(s.toLowerCase())).join("-") : null) : null,
    };
  }
  const parts = name.split(" ").filter(Boolean);
  const zhFamily = parts.length > 1 ? parts.at(-1)! : name;
  const zhGiven = parts.length > 1 ? parts.slice(0, -1).join(" ") : "";
  // Only parts that already are valid English names are copied; anything else (digits, symbols) is left for the user.
  const latin = (s: string) => (s && EN_PART_RE.test(s) && len(s) <= 40 ? s : null);
  const enFamily = latin(zhFamily);
  return { zh_family: zhFamily, zh_given: zhGiven, en_family: enFamily, en_given: enFamily && zhGiven ? latin(zhGiven) : null };
}

/** SET clause + params for writing structured names; `real_name` is recomputed from the Chinese parts. */
export function personNamesUpdate(names: PersonNames, firstParam: number) {
  const p = (i: number) => `$${firstParam + i}`;
  return {
    sql: `zh_family=${p(0)},zh_given=${p(1)},en_family=${p(2)},en_given=${p(3)},title=${p(4)},real_name=${p(5)}`,
    params: [names.zh_family, names.zh_given, names.en_family, names.en_given, names.title, composeZhName(names.zh_family!, names.zh_given!)],
  };
}

/** Columns describing a person (alias `u`); `toPerson` turns a row into the API `person` object. */
export const PERSON_COLUMNS = "u.zh_family,u.zh_given,u.en_family,u.en_given,u.title";
export const toPerson = (row: Partial<PersonNames>): PersonNames => ({
  zh_family: row.zh_family ?? null,
  zh_given: row.zh_given ?? null,
  en_family: row.en_family ?? null,
  en_given: row.en_given ?? null,
  title: (row.title as Title | null | undefined) ?? null,
});

/** True when two structured name sets are identical. */
export const sameNames = (a: PersonNames, b: Partial<PersonNames>) =>
  a.zh_family === (b.zh_family ?? null) && a.zh_given === (b.zh_given ?? null) && a.en_family === (b.en_family ?? null) && a.en_given === (b.en_given ?? null) && a.title === (b.title ?? null);

/**
 * Data step of migration 0112_person_names.sql: splits every existing real name into structured parts. The initial
 * admin named 系統管理員 becomes 系統 / 管理員 / Admin and counts as confirmed; everyone else is asked (once, by a
 * banner) to confirm the result in Settings (`names_confirmed_at` stays NULL).
 */
export async function backfillPersonNames(client: Pick<Db, "query">) {
  const rows = (await client.query<{ id: string; real_name: string; is_owner: boolean }>("SELECT id,real_name,is_owner FROM users WHERE zh_family IS NULL")).rows;
  for (const row of rows) {
    const owner = row.is_owner && row.real_name === "系統管理員";
    const parts = owner ? { zh_family: "系統", zh_given: "管理員", en_family: "Admin", en_given: null } : splitLegacyName(row.real_name);
    await client.query(
      `UPDATE users SET zh_family=$1,zh_given=$2,en_family=$3,en_given=$4,names_confirmed_at=CASE WHEN $5 THEN now() END WHERE id=$6`,
      [parts.zh_family, parts.zh_given, parts.en_family, parts.en_given, owner, row.id],
    );
  }
}
