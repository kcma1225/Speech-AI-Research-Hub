import { arxivIdFromDoi, compact, doiKey, familyKey, normalizeArxivId, normalizeDoi, normalizeTitle, titleSimilarity } from "./normalize.js";
import type { PaperAuthor, PaperIds, PaperRecord } from "./types.js";

/**
 * - `same`: an identifier matches (DOI, arXiv, S2, OpenAlex, ACL, DBLP, PMID, ISCA) → same work, safe to merge.
 * - `likely`: identical normalized title, |Δyear| ≤ 1, same first-author surname → duplicate (merge in search results;
 *   ask before merging in the library).
 * - `possible`: title similarity ≥ threshold (default 0.93, pg_trgm-compatible) and first author compatible → show as 「可能重複」.
 * - `none`.
 * A preprint (arXiv) and its conference version are matched by arXiv id only when a source links them
 * (e.g. S2 externalIds); otherwise title tiers apply.
 */
export type MatchLevel = "same" | "likely" | "possible" | "none";

export interface MatchResult {
  level: MatchLevel;
  /** Which signal decided: "doi", "arxiv", "s2", …, "title", "fuzzy-title". */
  reason?: string;
  /** Title similarity 0..1. */
  score: number;
}

export interface MatchOptions {
  /** Fuzzy title threshold, default 0.93. */
  threshold?: number;
  /** Allowed |year difference| for title tiers, default 1. */
  maxYearGap?: number;
}

const ID_KEYS: (keyof PaperIds)[] = ["s2", "openalex", "acl", "dblp", "pmid", "isca", "s2Corpus"];

function arxivOf(r: PaperRecord): string | undefined {
  return normalizeArxivId(r.arxivId) ?? arxivIdFromDoi(normalizeDoi(r.doi));
}

function firstAuthorsCompatible(a: PaperAuthor[], b: PaperAuthor[]): boolean {
  if (!a.length || !b.length) return true; // unknown → do not block
  const fa = familyKey(a[0]);
  const fb = familyKey(b[0]);
  if (!fa || !fb) return true;
  if (fa === fb) return true;
  // Author order differs between sources sometimes: accept if fa appears among the first 3 of b and vice versa.
  return b.slice(0, 3).some((x) => familyKey(x) === fa) || a.slice(0, 3).some((x) => familyKey(x) === fb);
}

export function compareRecords(a: PaperRecord, b: PaperRecord, opts: MatchOptions = {}): MatchResult {
  const threshold = opts.threshold ?? 0.93;
  const maxGap = opts.maxYearGap ?? 1;
  const da = doiKey(a.doi);
  const db = doiKey(b.doi);
  if (da && db && da === db) return { level: "same", reason: "doi", score: 1 };
  const xa = arxivOf(a);
  const xb = arxivOf(b);
  if (xa && xb && xa === xb) return { level: "same", reason: "arxiv", score: 1 };
  for (const k of ID_KEYS) {
    const va = a.ids?.[k];
    const vb = b.ids?.[k];
    if (va && vb && va.toLowerCase() === vb.toLowerCase()) return { level: "same", reason: k, score: 1 };
  }
  const score = titleSimilarity(a.title, b.title);
  // Two different non-arXiv DOIs are two different publications (e.g. journal vs conference version).
  const doiConflict = !!(da && db && da !== db && !arxivIdFromDoi(da) && !arxivIdFromDoi(db));
  if (doiConflict) return { level: score >= threshold ? "possible" : "none", reason: "fuzzy-title", score };
  const yearOk = !a.year || !b.year || Math.abs(a.year - b.year) <= maxGap;
  const authorsOk = firstAuthorsCompatible(a.authors, b.authors);
  if (!yearOk || !authorsOk) return { level: "none", score };
  const exact = normalizeTitle(a.title) !== "" && normalizeTitle(a.title) === normalizeTitle(b.title);
  if (exact) return { level: "likely", reason: "title", score: 1 };
  if (score >= threshold) return { level: "possible", reason: "fuzzy-title", score };
  return { level: "none", score };
}

export interface DuplicateCandidate<T> {
  item: T;
  match: MatchResult;
}

/** Candidates (e.g. rows pre-filtered in SQL by pg_trgm) that match `record`, best first. */
export function findDuplicates<T extends PaperRecord>(record: PaperRecord, candidates: T[], opts?: MatchOptions): DuplicateCandidate<T>[] {
  const order: Record<MatchLevel, number> = { same: 0, likely: 1, possible: 2, none: 3 };
  return candidates
    .map((item) => ({ item, match: compareRecords(record, item, opts) }))
    .filter((c) => c.match.level !== "none")
    .sort((x, y) => order[x.match.level] - order[y.match.level] || y.match.score - x.match.score);
}

// ---------------------------------------------------------------- merge

function authorRichness(list: PaperAuthor[] | undefined): number {
  if (!list?.length) return 0;
  // Prefer lists with split names and full given names over initials.
  return list.length * 10 + list.filter((a) => a.family && a.given && a.given.replace(/\W/g, "").length > 2).length;
}

const longer = (a?: string, b?: string): string | undefined => (!a ? b : !b ? a : b.length > a.length * 1.2 ? b : a);

/**
 * Merge `other` into `primary`: fill missing fields, prefer the richer value for abstract/authors,
 * union ids and keywords. Keeps the primary's citeKey and bibtex text (pinned keys).
 */
export function mergeRecords(primary: PaperRecord, other: PaperRecord): PaperRecord {
  const out: PaperRecord = { ...other, ...compact(primary) };
  out.authors = authorRichness(other.authors) > authorRichness(primary.authors) ? other.authors : primary.authors;
  if (authorRichness(other.editors) > authorRichness(primary.editors)) out.editors = other.editors;
  out.abstract = longer(primary.abstract, other.abstract);
  // Keep the primary title unless it is ALL CAPS and the other one is not.
  const shouting = (t: string) => /\p{Lu}/u.test(t) && !/\p{Ll}/u.test(t);
  out.title = primary.title && !(shouting(primary.title) && other.title && !shouting(other.title)) ? primary.title : other.title || primary.title;
  // A published version beats the preprint for type / container.
  if (primary.type === "article" && other.type !== "article" && other.containerTitle) {
    out.type = other.type;
    out.containerTitle = other.containerTitle;
    out.venue = other.venue ?? out.venue;
  }
  if (primary.doi && arxivIdFromDoi(primary.doi) && other.doi && !arxivIdFromDoi(other.doi)) out.doi = other.doi;
  if (!out.month && other.month && out.year === other.year) out.month = other.month;
  const ids = compact({ ...other.ids, ...primary.ids });
  if (Object.keys(ids).length) out.ids = ids;
  const kw = [...(primary.keywords ?? []), ...(other.keywords ?? [])];
  if (kw.length) {
    const seen = new Set<string>();
    out.keywords = kw.filter((k) => !seen.has(k.toLowerCase()) && seen.add(k.toLowerCase()));
  }
  if (primary.extra || other.extra) out.extra = { ...other.extra, ...primary.extra };
  out.citeKey = primary.citeKey ?? other.citeKey;
  out.bibtex = primary.bibtex ?? (primary.citeKey ? undefined : other.bibtex);
  return { ...compact(out), title: out.title, authors: out.authors };
}

/**
 * Group a list (e.g. search results from several sources) and merge `same`/`likely` duplicates.
 * Returns the merged records with the indices of the inputs merged into each.
 */
export function dedupeRecords(records: PaperRecord[], opts?: MatchOptions): { record: PaperRecord; members: number[] }[] {
  const groups: { record: PaperRecord; members: number[] }[] = [];
  records.forEach((r, i) => {
    const g = groups.find((x) => {
      const lvl = compareRecords(x.record, r, opts).level;
      return lvl === "same" || lvl === "likely";
    });
    if (g) {
      g.record = mergeRecords(g.record, r);
      g.members.push(i);
    } else groups.push({ record: r, members: [i] });
  });
  return groups;
}
