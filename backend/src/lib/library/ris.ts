import { finalizeRecord, normalizeArxivId, parseDate, parseName } from "./normalize.js";
import type { ImportResult, ImportWarning, PaperAuthor, PaperRecord, PaperType } from "./types.js";

// RIS (Research Information Systems) tagged format. Own parser: the `ris` npm package is GPL.
// Spec: https://en.wikipedia.org/wiki/RIS_(file_format) — lines "TY  - JOUR", records end with "ER  -".

const TYPE_FROM_RIS: Record<string, PaperType> = {
  JOUR: "article-journal", JFULL: "article-journal", MGZN: "article-journal", NEWS: "article-journal", EJOUR: "article-journal",
  CONF: "paper-conference", CPAPER: "paper-conference",
  BOOK: "book", EBOOK: "book", EDBOOK: "book",
  CHAP: "chapter", ECHAP: "chapter",
  THES: "thesis",
  RPRT: "report", GOVDOC: "report",
  ELEC: "webpage", WEB: "webpage", BLOG: "webpage",
  DATA: "dataset", DBASE: "dataset",
  COMP: "software",
  PAT: "patent",
  UNPB: "manuscript", MANSCPT: "manuscript",
  SLIDE: "speech",
  GEN: "document",
};

const TYPE_TO_RIS: Record<PaperType, string> = {
  "article-journal": "JOUR", "paper-conference": "CPAPER", article: "UNPB", book: "BOOK", chapter: "CHAP",
  thesis: "THES", report: "RPRT", webpage: "ELEC", dataset: "DATA", software: "COMP", patent: "PAT",
  manuscript: "UNPB", speech: "SLIDE", document: "GEN",
};

const LINE_RE = /^([A-Z][A-Z0-9])  -(?: (.*))?$/;

type Tags = Map<string, string[]>;

function parseRecords(text: string): { tags: Tags; line: number }[] {
  const out: { tags: Tags; line: number }[] = [];
  let cur: Tags | null = null;
  let last: string | null = null;
  let startLine = 0;
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.replace(/\s+$/, "");
    const m = LINE_RE.exec(line);
    if (!m) {
      // Continuation of a long value (some exporters wrap abstracts).
      if (cur && last && line.trim()) {
        const arr = cur.get(last)!;
        arr[arr.length - 1] = `${arr[arr.length - 1]} ${line.trim()}`;
      }
      return;
    }
    const tag = m[1]!;
    const value = (m[2] ?? "").trim();
    if (tag === "TY") {
      cur = new Map([["TY", [value]]]);
      startLine = i + 1;
      last = "TY";
      return;
    }
    if (tag === "ER") {
      if (cur) out.push({ tags: cur, line: startLine });
      cur = null;
      last = null;
      return;
    }
    if (!cur) return;
    if (!cur.has(tag)) cur.set(tag, []);
    cur.get(tag)!.push(value);
    last = tag;
  });
  const pending = cur as Tags | null;
  if (pending) out.push({ tags: pending, line: -startLine }); // unterminated record
  return out;
}

const first = (t: Tags, ...tags: string[]): string | undefined => {
  for (const k of tags) {
    const v = t.get(k)?.find((x) => x);
    if (v) return v;
  }
  return undefined;
};
const all = (t: Tags, ...tags: string[]): string[] => tags.flatMap((k) => t.get(k) ?? []).filter(Boolean);

function tagsToRecord(t: Tags): PaperRecord {
  const ty = (first(t, "TY") ?? "GEN").toUpperCase();
  let type = TYPE_FROM_RIS[ty] ?? "document";
  const names = (tags: string[]) => all(t, ...tags).map(parseName).filter((a): a is PaperAuthor => !!a);
  const date = parseDate(first(t, "PY", "Y1", "DA"));
  // "PY  - 2020///" and "DA  - 2020/10/25/" formats
  const da = parseDate(first(t, "DA")?.replace(/\/+$/, ""));
  const doi = first(t, "DO") ?? all(t, "M3", "N1", "UR").find((v) => /^(https?:\/\/(dx\.)?doi\.org\/|10\.\d{4,})/i.test(v));
  const urls = all(t, "UR", "L2");
  const arxivId = urls.map(normalizeArxivId).find(Boolean) ?? normalizeArxivId(first(t, "AN") ?? "");
  if (type === "document" && arxivId) type = "article";
  const sp = first(t, "SP");
  const ep = first(t, "EP");
  const pages = sp && ep && !sp.includes("-") ? `${sp}–${ep}` : sp;
  const container =
    type === "book" ? undefined : first(t, "T2", "JF", "JO", "BT", "J2", "JA", "J1");
  const pdf = all(t, "L1").find((v) => /^https?:/i.test(v));
  return finalizeRecord({
    type,
    title: first(t, "TI", "T1", "CT", ...(type === "book" ? ["BT"] : [])) ?? "",
    authors: names(["AU", "A1"]),
    editors: names(type === "chapter" || type === "paper-conference" ? ["A2", "ED", "A3"] : ["ED", "A3"]),
    year: date.year ?? da.year,
    month: date.month ?? da.month,
    day: date.day ?? da.day,
    containerTitle: container,
    collectionTitle: first(t, "T3"),
    volume: first(t, "VL"),
    issue: first(t, "IS", "CP"),
    pages,
    publisher: first(t, "PB"),
    publisherPlace: first(t, "CY", "PP"),
    edition: first(t, "ET"),
    isbn: type === "book" || type === "chapter" ? first(t, "SN") : undefined,
    issn: type === "book" || type === "chapter" ? undefined : first(t, "SN"),
    doi,
    arxivId,
    url: urls.find((u) => !/doi\.org\//i.test(u)) ?? urls[0],
    abstract: first(t, "AB", "N2"),
    keywords: all(t, "KW").flatMap((k) => k.split(/;\s*/)),
    language: first(t, "LA"),
    note: first(t, "N1"),
    citeKey: first(t, "ID"),
    oaPdfUrl: pdf,
  });
}

export function importRis(text: string): ImportResult {
  const warnings: ImportWarning[] = [];
  const records: PaperRecord[] = [];
  parseRecords(text).forEach(({ tags, line }, index) => {
    const key = first(tags, "ID");
    if (line < 0) warnings.push({ index, ...(key ? { key } : {}), message: `第 ${-line} 行開始的資料缺少結尾的「ER  -」，仍嘗試匯入` });
    const r = tagsToRecord(tags);
    if (!r.title) {
      warnings.push({ index, ...(key ? { key } : {}), message: "缺少標題（TI/T1），已略過此筆資料" });
      return;
    }
    if (!TYPE_FROM_RIS[(first(tags, "TY") ?? "").toUpperCase()]) {
      warnings.push({ index, ...(key ? { key } : {}), message: `不認得的類型「${first(tags, "TY") ?? ""}」，當作一般文件匯入` });
    }
    records.push(r);
  });
  return { format: "ris", records, warnings };
}

function risName(a: PaperAuthor): string {
  if (a.literal) return a.literal;
  const fam = [a.particle, a.family].filter(Boolean).join(" ");
  return [fam, a.given, a.suffix].filter(Boolean).join(", ");
}

export function exportRis(records: PaperRecord[], keys?: string[]): string {
  return records
    .map((r, i) => {
      const lines: string[] = [];
      const add = (tag: string, v: string | undefined) => {
        if (v) lines.push(`${tag}  - ${v.replace(/\r?\n/g, " ")}`);
      };
      add("TY", TYPE_TO_RIS[r.type] ?? "GEN");
      add("ID", keys?.[i] ?? r.citeKey);
      add("TI", r.title);
      for (const a of r.authors) add("AU", risName(a));
      for (const a of r.editors ?? []) add("A2", risName(a));
      if (r.type === "article-journal") add("JO", r.containerTitle);
      else add("T2", r.containerTitle);
      add("T3", r.collectionTitle);
      if (r.year) add("PY", String(r.year));
      if (r.year) add("DA", [r.year, r.month ? String(r.month).padStart(2, "0") : "", r.day ? String(r.day).padStart(2, "0") : ""].join("/").replace(/\/+$/, "") + "/");
      add("VL", r.volume);
      add("IS", r.issue);
      if (r.pages) {
        const [sp, ep] = r.pages.split("–");
        add("SP", sp);
        add("EP", ep);
      }
      add("PB", r.publisher);
      add("CY", r.publisherPlace);
      add("ET", r.edition);
      add("SN", r.isbn ?? r.issn);
      add("DO", r.doi);
      add("UR", r.url ?? (r.arxivId ? `https://arxiv.org/abs/${r.arxivId}` : undefined));
      add("L1", r.oaPdfUrl);
      add("AB", r.abstract);
      for (const k of r.keywords ?? []) add("KW", k);
      add("LA", r.language);
      add("N1", r.note);
      lines.push("ER  - ");
      return lines.join("\r\n");
    })
    .join("\r\n\r\n") + "\r\n";
}
