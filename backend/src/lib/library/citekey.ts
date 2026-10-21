import { createHash } from "node:crypto";
import { pinyin } from "pinyin-pro";
import { authorFamily, foldAscii, hasCjk, hasHan, normalizeTitle } from "./normalize.js";
import type { PaperRecord } from "./types.js";

// Better BibTeX-style keys: auth.lower + year + shorttitle(1), e.g. "gulati2020conformer".

const STOPWORDS = new Set(
  ("a an and are as at be but by for from has have how in into is it its of on or over the their this to towards toward " +
    "under upon via vs what when where which while who why with without using based").split(" "),
);

// pinyin-pro is tuned for simplified Chinese; fix common traditional-character readings it gets wrong.
const READING_FIX: Record<string, string> = { 於: "yu" };
const SURNAME_FIX: Record<string, string> = { 單: "shan", 曾: "zeng", 區: "ou", 仇: "qiu", 解: "xie", 樂: "yue", 查: "zha", 繆: "miao", 尉: "yu", 蓋: "ge", 樸: "piao", 員: "yun" };

/** Romanize: Han characters via pinyin, Latin via accent folding; anything else is dropped. */
export function romanize(s: string): string {
  let out = "";
  if (hasHan(s)) {
    const parts = pinyin(s, { toneType: "none", type: "array", nonZh: "consecutive", v: true }) as string[];
    out = parts.join("");
  } else out = s;
  return foldAscii(out).replace(/[^A-Za-z0-9]+/g, "");
}

function shortHash(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 6);
}

/** First author's surname for the key ("van der Berg" → "berg", "王小明" → "wang"). */
export function keyAuthor(r: Pick<PaperRecord, "authors">): string {
  const a = r.authors[0];
  if (!a) return "anon";
  const fam = authorFamily(a);
  if (hasHan(fam)) {
    // Surnames read with the surname pronunciation (e.g. 單 → shan).
    const fix = SURNAME_FIX[Array.from(fam)[0]!];
    const parts = fix && Array.from(fam).length === 1 ? [fix] : (pinyin(fam, { toneType: "none", type: "array", surname: "head", v: true }) as string[]);
    const p = foldAscii(parts.join("")).replace(/[^A-Za-z0-9]+/g, "").toLowerCase();
    if (p) return p;
  }
  const rom = romanize(fam).toLowerCase();
  if (rom) return rom;
  // Kana / Hangul / other scripts without a romanizer: stable "zh" + hash fallback.
  return hasCjk(fam) ? `zh${shortHash(fam)}` : `a${shortHash(fam || JSON.stringify(a))}`;
}

/** First non-stopword of the title, lower-case ("Conformer: …" → "conformer"). CJK titles: pinyin of the first 2 Han characters. */
export function keyShortTitle(title: string, words = 1): string {
  const t = normalizeTitle(title);
  if (!t) return "";
  if (hasHan(t)) {
    // Romanize the whole title so polyphonic characters get their in-context reading (基於 → jiyu).
    const chars = Array.from(t.replace(/\s+/g, ""));
    const readings = pinyin(chars.join(""), { toneType: "none", type: "array", v: true }) as string[];
    const picked: string[] = [];
    chars.forEach((c, i) => {
      if (picked.length < 2 && hasHan(c) && readings[i]) picked.push(READING_FIX[c] ?? readings[i]!);
    });
    return foldAscii(picked.join("")).replace(/[^A-Za-z0-9]+/g, "").toLowerCase();
  }
  const ws = t.split(" ").map((w) => romanize(w).toLowerCase()).filter((w) => w && !STOPWORDS.has(w));
  return ws.slice(0, words).join("");
}

/** Base key without the clash suffix. Only `[a-z0-9]` characters. */
export function generateCiteKey(r: Pick<PaperRecord, "authors" | "year" | "title">): string {
  return `${keyAuthor(r)}${r.year ?? ""}${keyShortTitle(r.title)}`;
}

/** a, b, …, z, aa, ab, … */
function suffix(n: number): string {
  let s = "";
  let x = n;
  do {
    s = String.fromCharCode(97 + (x % 26)) + s;
    x = Math.floor(x / 26) - 1;
  } while (x >= 0);
  return s;
}

/**
 * Make `base` unique against `taken` (case-insensitive, as BibTeX treats keys): base, basea, baseb, …
 * `taken` can be a Set/array of keys or a predicate.
 */
export function uniqueCiteKey(base: string, taken: Iterable<string> | ((key: string) => boolean)): string {
  const has =
    typeof taken === "function"
      ? (k: string) => taken(k)
      : (() => {
          const set = new Set(Array.from(taken, (k) => k.toLowerCase()));
          return (k: string) => set.has(k.toLowerCase());
        })();
  if (!has(base)) return base;
  for (let i = 0; ; i++) {
    const k = base + suffix(i);
    if (!has(k)) return k;
  }
}

/** Valid citation key characters (BBT/biber safe). */
export const CITE_KEY_RE = /^[A-Za-z0-9_:\-.]+$/;

/**
 * Keys for a batch: a record's own `citeKey` is kept when valid and not yet used in the batch (keys are pinned);
 * otherwise a generated key, unique within the batch and `existing`.
 */
export function assignCiteKeys(records: Pick<PaperRecord, "authors" | "year" | "title" | "citeKey">[], existing?: Iterable<string>): string[] {
  const used = new Set(Array.from(existing ?? [], (k) => k.toLowerCase()));
  const out: string[] = [];
  // Pass 1: pinned keys win over generated ones.
  const pinned = records.map((r) => (r.citeKey && CITE_KEY_RE.test(r.citeKey) ? r.citeKey : undefined));
  const pinnedSeen = new Set<string>();
  pinned.forEach((k, i) => {
    if (!k) return;
    if (pinnedSeen.has(k.toLowerCase())) pinned[i] = undefined;
    else pinnedSeen.add(k.toLowerCase());
  });
  for (const k of pinnedSeen) used.add(k);
  records.forEach((r, i) => {
    const k = pinned[i] ?? uniqueCiteKey(generateCiteKey(r), (x) => used.has(x.toLowerCase()));
    used.add(k.toLowerCase());
    out.push(k);
  });
  return out;
}
