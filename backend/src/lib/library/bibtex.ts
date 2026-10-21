import { parse as parseBib, type Creator, type Entry } from "@retorquere/bibtex-parser";
import { assignCiteKeys } from "./citekey.js";
import { cleanText, compact, finalizeRecord, hasCjk, normalizeArxivId, parseDate, parseMonth } from "./normalize.js";
import type { ImportResult, ImportWarning, PaperAuthor, PaperRecord, PaperType } from "./types.js";

// ---------------------------------------------------------------- import

const TYPE_FROM_BIB: Record<string, PaperType> = {
  article: "article-journal",
  inproceedings: "paper-conference",
  conference: "paper-conference",
  proceedings: "book",
  book: "book",
  mvbook: "book",
  booklet: "book",
  collection: "book",
  inbook: "chapter",
  incollection: "chapter",
  bookinbook: "chapter",
  phdthesis: "thesis",
  mastersthesis: "thesis",
  thesis: "thesis",
  techreport: "report",
  report: "report",
  online: "webpage",
  www: "webpage",
  electronic: "webpage",
  unpublished: "manuscript",
  dataset: "dataset",
  data: "dataset",
  software: "software",
  patent: "patent",
  manual: "report",
  misc: "document",
};

/** Fields mapped onto PaperRecord; everything else non-empty goes to `extra`. */
const MAPPED = new Set([
  "title", "author", "editor", "year", "date", "month", "journal", "journaltitle", "booktitle", "series", "volume",
  "number", "issue", "pages", "publisher", "institution", "school", "organization", "address", "location", "edition",
  "isbn", "issn", "doi", "eprint", "archiveprefix", "eprinttype", "eprintclass", "primaryclass", "url", "abstract",
  "keywords", "langid", "language", "note", "file", "urldate", "timestamp", "biburl", "bibsource", "shorttitle",
]);

function creatorToAuthor(c: Creator): PaperAuthor | undefined {
  if (c.name) return { literal: c.name };
  if (!c.lastName && !c.firstName) return undefined;
  if (c.lastName && !c.firstName && hasCjk(c.lastName) && !/\s/.test(c.lastName)) return { literal: c.lastName };
  return compact({ family: c.lastName, given: c.firstName, particle: c.prefix, suffix: c.suffix });
}

const str = (v: unknown): string | undefined => {
  if (v == null) return undefined;
  if (Array.isArray(v)) return v.map(String).join("; ") || undefined;
  return cleanText(String(v));
};

function entryToRecord(e: Entry): PaperRecord {
  const f = e.fields as Record<string, unknown>;
  const type0 = TYPE_FROM_BIB[e.type.toLowerCase()] ?? "document";
  const eprintType = (str(f.archiveprefix) ?? str(f.eprinttype) ?? "").toLowerCase();
  const journal = str(f.journal) ?? str(f.journaltitle);
  const arxivId =
    (eprintType === "arxiv" || (!eprintType && /^\d{4}\.\d{4,5}/.test(str(f.eprint) ?? "")) ? normalizeArxivId(str(f.eprint)) : undefined) ??
    (journal && /arxiv/i.test(journal) ? normalizeArxivId(journal) : undefined) ??
    (str(f.url)?.includes("arxiv.org") ? normalizeArxivId(str(f.url)) : undefined);
  let type: PaperType = type0;
  if (type0 === "document" && arxivId) type = "article";
  else if (type0 === "document" && !journal && str(f.url) && !str(f.publisher)) type = "webpage";
  else if (type0 === "article-journal" && arxivId && (!journal || /arxiv/i.test(journal))) type = "article";

  const date = parseDate(str(f.date));
  const year = date.year ?? (str(f.year) ? Number(/\d{4}/.exec(str(f.year)!)?.[0]) || undefined : undefined);
  const month = date.month ?? parseMonth(str(f.month));
  const publisher = str(f.publisher) ?? str(f.institution) ?? str(f.school) ?? str(f.organization);
  const containerTitle = type === "article" && journal && /arxiv/i.test(journal) ? undefined : (journal ?? str(f.booktitle));

  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(f)) {
    if (MAPPED.has(k)) continue;
    const s = Array.isArray(v) ? (v as unknown[]).map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join("; ") : String(v);
    if (s) extra[k] = s;
  }
  if (e.type.toLowerCase() === "mastersthesis") extra.type ??= "mastersthesis";
  if (e.type.toLowerCase() === "techreport" && str(f.number)) extra.number = str(f.number)!;

  const keywords = Array.isArray(f.keywords) ? (f.keywords as string[]) : str(f.keywords)?.split(/[,;]/);
  return finalizeRecord({
    type,
    title: str(f.title) ?? "",
    authors: ((f.author as Creator[] | undefined) ?? []).map(creatorToAuthor).filter((a): a is PaperAuthor => !!a),
    editors: ((f.editor as Creator[] | undefined) ?? []).map(creatorToAuthor).filter((a): a is PaperAuthor => !!a),
    year: year && Number.isFinite(year) ? year : undefined,
    month,
    day: date.day,
    containerTitle,
    collectionTitle: str(f.series),
    volume: str(f.volume),
    issue: e.type.toLowerCase() === "techreport" ? undefined : (str(f.number) ?? str(f.issue)),
    pages: str(f.pages),
    publisher,
    publisherPlace: str(f.address) ?? str(f.location),
    edition: str(f.edition),
    isbn: str(f.isbn),
    issn: str(f.issn),
    doi: str(f.doi),
    arxivId,
    url: str(f.url),
    abstract: str(f.abstract),
    keywords: keywords?.map((k) => k.trim()),
    language: str(f.langid) ?? str(f.language),
    note: str(f.note),
    citeKey: e.key || undefined,
    bibtex: e.input || undefined,
    extra,
  });
}

/** Parse BibTeX / BibLaTeX text. Bad entries are skipped with a 繁中 warning; the rest still import. */
export function importBibtex(text: string): ImportResult {
  const lib = parseBib(text, {
    english: false,
    sentenceCase: false,
    caseProtection: false,
    unsupported: "text",
    applyCrossRef: true,
  });
  const warnings: ImportWarning[] = [];
  for (const err of lib.errors) {
    const key = /@\w+\s*[{(]\s*([^,\s]+)\s*,/.exec(err.input ?? "")?.[1];
    warnings.push({ index: -1, ...(key ? { key } : {}), message: `BibTeX 語法錯誤，已略過此筆：${err.error}` });
  }
  const records: PaperRecord[] = [];
  lib.entries.forEach((e, index) => {
    if (Object.keys(e.fields).length === 0) return; // the parser keeps a stub for entries it reported in `errors`
    const r = entryToRecord(e);
    if (!r.title) {
      warnings.push({ index, key: e.key, message: "缺少標題，已略過此筆資料" });
      return;
    }
    if (r.authors.length === 0) warnings.push({ index, key: e.key, message: "沒有作者資料" });
    if (!r.year) warnings.push({ index, key: e.key, message: "沒有年份資料" });
    records.push(r);
  });
  return { format: "bibtex", records, warnings };
}

// ---------------------------------------------------------------- export

const TYPE_TO_BIB: Record<PaperType, string> = {
  "article-journal": "article",
  "paper-conference": "inproceedings",
  article: "misc",
  book: "book",
  chapter: "incollection",
  thesis: "phdthesis",
  report: "techreport",
  webpage: "misc",
  dataset: "misc",
  software: "misc",
  patent: "misc",
  manuscript: "unpublished",
  speech: "misc",
  document: "misc",
};

const MONTH_MACROS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const ACCENTS: Record<string, string> = {
  "́": "'", "̀": "`", "̂": "^", "̈": '"', "̃": "~", "̄": "=", "̇": ".",
  "̌": "v", "̆": "u", "̧": "c", "̋": "H", "̨": "k", "̊": "r",
};
const SPECIAL: Record<string, string> = {
  ß: "{\\ss}", æ: "{\\ae}", Æ: "{\\AE}", œ: "{\\oe}", Œ: "{\\OE}", ø: "{\\o}", Ø: "{\\O}", ł: "{\\l}", Ł: "{\\L}",
  å: "{\\aa}", Å: "{\\AA}", ı: "{\\i}", "–": "--", "—": "---", "“": "``", "”": "''", "‘": "`", "’": "'",
};

/** Convert accented Latin letters to LaTeX accent commands; other non-ASCII (CJK etc.) is kept as UTF-8. */
function latinToLatex(s: string): string {
  let out = "";
  for (const ch of s.normalize("NFC")) {
    if (ch.charCodeAt(0) < 128) {
      out += ch;
      continue;
    }
    if (SPECIAL[ch]) {
      out += SPECIAL[ch];
      continue;
    }
    const d = ch.normalize("NFD");
    const base = d[0]!;
    const marks = d.slice(1);
    if (base.charCodeAt(0) < 128 && marks.length === 1 && ACCENTS[marks]) {
      const b = base === "i" ? "\\i" : base === "j" ? "\\j" : base;
      out += /[a-zA-Z]/.test(ACCENTS[marks]!) ? `{\\${ACCENTS[marks]}{${b}}}` : `{\\${ACCENTS[marks]}${b}}`;
    } else out += ch;
  }
  return out;
}

/** Escape LaTeX special characters in a BibTeX field value. */
export function escapeBibtex(s: string, opts: { ascii?: boolean } = {}): string {
  let out = s
    .replace(/\\/g, "\u0000")
    .replace(/([{}&%$#_])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}")
    .replace(/\u0000/g, "\\textbackslash{}");
  if (opts.ascii) out = latinToLatex(out);
  return out;
}

/** Brace words that must keep their case (acronyms, CamelCase, words with digits+caps): "ASR" → "{ASR}". */
function protectCase(escaped: string): string {
  return escaped.replace(/(?<![\\\w{])([\p{L}\p{N}]+)/gu, (w) => {
    const rest = w.slice(1);
    return /\p{Lu}/u.test(rest) ? `{${w}}` : w;
  });
}

function nameToBib(a: PaperAuthor, opts: { ascii?: boolean }): string {
  const e = (s: string) => escapeBibtex(s, opts);
  if (a.literal || (!a.family && a.given)) return `{${e(a.literal ?? a.given!)}}`;
  let family = e(a.family ?? "");
  if (/,|\band\b/i.test(a.family ?? "") || (a.family ?? "").includes(" ")) family = `{${family}}`;
  const fam = a.particle ? `${e(a.particle)} ${family}` : family;
  const given = a.given ? e(a.given).replace(/\band\b/g, "{and}") : "";
  if (a.suffix) return `${fam}, ${e(a.suffix)}, ${given}`;
  return given ? `${fam}, ${given}` : fam;
}

export interface BibtexExportOptions {
  /** Convert accented Latin to LaTeX accent macros (pdfLaTeX + BibTeX). CJK always stays UTF-8. Default false. */
  ascii?: boolean;
  /** Include abstracts. Default false (keeps refs.bib small). */
  abstract?: boolean;
  /** Emit the original imported entry text (re-keyed) when a record has `bibtex`. Default false. */
  useOriginal?: boolean;
  /** Keys that are already taken (e.g. the project's .bib) — generated keys avoid them. */
  existingKeys?: Iterable<string>;
}

/** Serialize one record with the given key. */
export function recordToBibtex(r: PaperRecord, key: string, opts: BibtexExportOptions = {}): string {
  if (opts.useOriginal && r.bibtex) {
    return r.bibtex.trim().replace(/^(@\w+\s*[{(]\s*)[^,\s]*/, `$1${key}`);
  }
  const e = (s: string) => escapeBibtex(s, opts);
  let type = TYPE_TO_BIB[r.type] ?? "misc";
  if (r.type === "thesis" && r.extra?.type === "mastersthesis") type = "mastersthesis";
  const fields: [string, string][] = [];
  const add = (k: string, v: string | undefined, raw = false) => {
    if (v) fields.push([k, raw ? v : `{${v}}`]);
  };
  add("title", protectCase(e(r.title)));
  add("author", r.authors.map((a) => nameToBib(a, opts)).join(" and "));
  if (r.editors?.length) add("editor", r.editors.map((a) => nameToBib(a, opts)).join(" and "));
  const ct = r.containerTitle ? protectCase(e(r.containerTitle)) : undefined;
  if (type === "article") add("journal", ct);
  else if (type === "inproceedings" || type === "incollection") add("booktitle", ct);
  else if (ct && r.type !== "article") add("howpublished", ct);
  add("series", r.collectionTitle ? e(r.collectionTitle) : undefined);
  add("year", r.year ? String(r.year) : undefined);
  if (r.month) add("month", MONTH_MACROS[r.month - 1], true);
  add("volume", r.volume ? e(r.volume) : undefined);
  add("number", r.issue ? e(r.issue) : r.extra?.number ? e(r.extra.number) : undefined);
  add("pages", r.pages ? e(r.pages.replace(/–/g, "-")).replace(/-/g, "--") : undefined);
  const pubField = type === "techreport" ? "institution" : type === "phdthesis" || type === "mastersthesis" ? "school" : "publisher";
  add(pubField, r.publisher ? e(r.publisher) : undefined);
  add("address", r.publisherPlace ? e(r.publisherPlace) : undefined);
  add("edition", r.edition ? e(r.edition) : undefined);
  add("isbn", r.isbn);
  add("issn", r.issn);
  add("doi", r.doi?.replace(/[{}]/g, ""));
  if (r.arxivId) {
    add("eprint", r.arxivId);
    add("archiveprefix", "arXiv");
  }
  add("url", r.url?.replace(/[{}]/g, "").replace(/%/g, "\\%"));
  if (r.keywords?.length) add("keywords", e(r.keywords.join(", ")));
  if (opts.abstract && r.abstract) add("abstract", e(r.abstract));
  add("note", r.note ? e(r.note) : undefined);
  if (r.language && !/^en/i.test(r.language)) add("langid", e(r.language));
  const width = Math.max(...fields.map(([k]) => k.length));
  return `@${type}{${key},\n${fields.map(([k, v]) => `  ${k.padEnd(width)} = ${v}`).join(",\n")}\n}`;
}

/**
 * Serialize records to a .bib file. Records keep their `citeKey`; records without one get a generated
 * Better-BibTeX-style key unique within the file and `existingKeys`.
 */
export function exportBibtex(records: PaperRecord[], opts: BibtexExportOptions = {}): string {
  const keys = assignCiteKeys(records, opts.existingKeys);
  return records.map((r, i) => recordToBibtex(r, keys[i]!, opts)).join("\n\n") + "\n";
}

