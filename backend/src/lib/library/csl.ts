import { cleanAbstract, cleanText, compact, finalizeRecord, normalizeArxivId, parseDate, splitParticle } from "./normalize.js";
import { LibraryImportError, PAPER_TYPES, type ImportResult, type ImportWarning, type PaperAuthor, type PaperRecord, type PaperType } from "./types.js";

/** A CSL-JSON item (loose: only the fields we read/write are typed). */
export interface CslItem {
  id?: string | number;
  type?: string;
  title?: string;
  author?: CslName[];
  editor?: CslName[];
  issued?: CslDate;
  "container-title"?: string | string[];
  "collection-title"?: string;
  volume?: string | number;
  issue?: string | number;
  page?: string;
  publisher?: string;
  "publisher-place"?: string;
  edition?: string | number;
  ISBN?: string | string[];
  ISSN?: string | string[];
  DOI?: string;
  URL?: string;
  abstract?: string;
  keyword?: string;
  language?: string;
  note?: string;
  number?: string | number;
  "citation-key"?: string;
  [k: string]: unknown;
}
export interface CslName {
  family?: string;
  given?: string;
  literal?: string;
  "non-dropping-particle"?: string;
  "dropping-particle"?: string;
  suffix?: string;
}
export interface CslDate {
  "date-parts"?: (number | string)[][];
  raw?: string;
  literal?: string;
}

/** CSL types that are not ours, mapped to the closest PaperType. */
const CSL_TYPE_MAP: Record<string, PaperType> = {
  "article-magazine": "article-journal",
  "article-newspaper": "article-journal",
  "posted-content": "article",
  preprint: "article",
  "proceedings-article": "paper-conference",
  "journal-article": "article-journal",
  "book-chapter": "chapter",
  "entry-encyclopedia": "chapter",
  "entry-dictionary": "chapter",
  "post-weblog": "webpage",
  post: "webpage",
  dissertation: "thesis",
  standard: "report",
  "monograph": "book",
  "edited-book": "book",
  "reference-book": "book",
  "proceedings": "book",
  "presentation": "speech",
  "personal_communication": "document",
};

export function mapCslType(t: string | undefined): PaperType {
  if (!t) return "document";
  if ((PAPER_TYPES as readonly string[]).includes(t)) return t as PaperType;
  return CSL_TYPE_MAP[t] ?? "document";
}

const one = (v: string | string[] | number | undefined): string | undefined =>
  v == null ? undefined : Array.isArray(v) ? (v[0] != null ? String(v[0]) : undefined) : String(v);

export function cslNameToAuthor(n: CslName): PaperAuthor | undefined {
  if (n.literal) return { literal: n.literal.trim() };
  if (!n.family && !n.given) return undefined;
  let particle = [n["dropping-particle"], n["non-dropping-particle"]].filter(Boolean).join(" ") || undefined;
  let family = n.family?.trim();
  if (family && !particle) {
    const sp = splitParticle(family);
    family = sp.family;
    particle = sp.particle;
  }
  return compact({ family, given: n.given?.trim(), particle, suffix: n.suffix });
}

export function cslDateParts(d: CslDate | undefined): { year?: number; month?: number; day?: number } {
  const p = d?.["date-parts"]?.[0];
  if (p && p.length && p[0] != null && String(p[0]) !== "") {
    const [y, m, dd] = p.map((x) => Number(x));
    return compact({ year: y || undefined, month: m && m >= 1 && m <= 12 ? m : undefined, day: m && dd ? dd : undefined });
  }
  return parseDate(d?.raw ?? d?.literal);
}

/** CSL-JSON item → PaperRecord. */
export function fromCslJson(item: CslItem): PaperRecord {
  const type = mapCslType(item.type);
  const date = cslDateParts(item.issued);
  const url = item.URL;
  const arxivId =
    normalizeArxivId(typeof item.arxiv === "string" ? item.arxiv : undefined) ??
    (url?.includes("arxiv.org") ? normalizeArxivId(url) : undefined) ??
    normalizeArxivId(item.number && String(item.number).toLowerCase().startsWith("arxiv") ? String(item.number) : undefined);
  const container = one(item["container-title"]);
  return finalizeRecord({
    type,
    title: cleanText(item.title) ?? "",
    authors: (item.author ?? []).map(cslNameToAuthor).filter((a): a is PaperAuthor => !!a),
    editors: (item.editor ?? []).map(cslNameToAuthor).filter((a): a is PaperAuthor => !!a),
    ...date,
    containerTitle: container ? cleanText(container) : undefined,
    collectionTitle: item["collection-title"],
    volume: one(item.volume),
    issue: one(item.issue),
    pages: item.page,
    publisher: item.publisher,
    publisherPlace: item["publisher-place"],
    edition: one(item.edition),
    isbn: one(item.ISBN),
    issn: one(item.ISSN),
    doi: item.DOI,
    arxivId,
    url,
    abstract: cleanAbstract(item.abstract),
    keywords: item.keyword ? String(item.keyword).split(/[,;]\s*/) : undefined,
    language: item.language,
    note: item.note,
    citeKey: item["citation-key"] ?? (typeof item.id === "string" && /^[A-Za-z][\w:.-]*$/.test(item.id) ? item.id : undefined),
  });
}

function authorToCsl(a: PaperAuthor): CslName {
  if (a.literal) return { literal: a.literal };
  return compact({ family: a.family, given: a.given, "non-dropping-particle": a.particle, suffix: a.suffix });
}

/** PaperRecord → CSL-JSON item. Ids not in CSL go to `custom` (citeproc ignores it). */
export function toCslJson(r: PaperRecord, id?: string): CslItem {
  const dateParts = r.year ? [[r.year, ...(r.month ? [r.month, ...(r.day ? [r.day] : [])] : [])]] : undefined;
  return compact({
    id: id ?? r.citeKey,
    "citation-key": id ?? r.citeKey,
    type: r.type,
    title: r.title,
    author: r.authors.map(authorToCsl),
    editor: r.editors?.map(authorToCsl),
    issued: dateParts ? { "date-parts": dateParts } : undefined,
    "container-title": r.containerTitle,
    "collection-title": r.collectionTitle,
    volume: r.volume,
    issue: r.issue,
    page: r.pages,
    publisher: r.publisher,
    "publisher-place": r.publisherPlace,
    edition: r.edition,
    ISBN: r.isbn,
    ISSN: r.issn,
    DOI: r.doi,
    URL: r.url ?? (r.arxivId ? `https://arxiv.org/abs/${r.arxivId}` : undefined),
    number: r.type === "article" && r.arxivId ? `arXiv:${r.arxivId}` : undefined,
    abstract: r.abstract,
    keyword: r.keywords?.join(", "),
    language: r.language,
    note: r.note,
    custom: r.ids || r.arxivId ? compact({ ...r.ids, arxiv: r.arxivId }) : undefined,
  });
}

export function importCslJson(text: string): ImportResult {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    throw new LibraryImportError("CSL-JSON 格式錯誤：不是有效的 JSON");
  }
  const items: unknown[] = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { items?: unknown }).items)
      ? (data as { items: unknown[] }).items
      : data && typeof data === "object"
        ? [data]
        : [];
  if (items.length === 0) throw new LibraryImportError("CSL-JSON 裡沒有任何文獻");
  const warnings: ImportWarning[] = [];
  const records: PaperRecord[] = [];
  items.forEach((it, index) => {
    if (!it || typeof it !== "object" || Array.isArray(it)) {
      warnings.push({ index, message: "不是 CSL 物件，已略過" });
      return;
    }
    const item = it as CslItem;
    const key = item.id != null ? String(item.id) : undefined;
    const r = fromCslJson(item);
    // custom ids written by toCslJson
    const custom = (item as { custom?: Record<string, string> }).custom;
    if (custom && typeof custom === "object") {
      const { arxiv, ...ids } = custom;
      if (arxiv && !r.arxivId) r.arxivId = normalizeArxivId(arxiv);
      const keep = Object.fromEntries(Object.entries(ids).filter(([k, v]) => typeof v === "string" && ["s2", "s2Corpus", "openalex", "dblp", "acl", "pmid", "isca"].includes(k)));
      if (Object.keys(keep).length) r.ids = { ...keep, ...r.ids };
    }
    if (!r.title) {
      warnings.push({ index, ...(key ? { key } : {}), message: "缺少標題，已略過此筆資料" });
      return;
    }
    if (item.type && mapCslType(item.type) === "document" && item.type !== "document") {
      warnings.push({ index, ...(key ? { key } : {}), message: `不認得的類型「${item.type}」，當作一般文件匯入` });
    }
    records.push(r);
  });
  return { format: "csl-json", records, warnings };
}

export function exportCslJson(records: PaperRecord[], keys?: string[]): string {
  return JSON.stringify(records.map((r, i) => toCslJson(r, keys?.[i])), null, 2) + "\n";
}
