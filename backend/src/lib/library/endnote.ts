import { finalizeRecord, normalizeArxivId, parseDate, parseName } from "./normalize.js";
import { LibraryImportError, type ImportResult, type ImportWarning, type PaperAuthor, type PaperRecord, type PaperType } from "./types.js";
import { parseXml, xAttr, xKid, xKids, xText, xTrim, type XNode } from "./xml.js";

// EndNote XML export (File → Export → "XML"). Own mapping on fast-xml-parser (MIT).
// Element names follow EndNote's RSXML DTD: <xml><records><record>…

const TYPE_BY_NUMBER: Record<string, PaperType> = {
  "17": "article-journal", "47": "paper-conference", "10": "book", "6": "book", "28": "book", "5": "chapter",
  "32": "thesis", "27": "report", "12": "webpage", "13": "document", "59": "dataset", "9": "software",
  "25": "patent", "36": "manuscript", "34": "manuscript", "19": "article-journal", "23": "article-journal",
};
const TYPE_BY_NAME: Record<string, PaperType> = {
  "journal article": "article-journal", "conference paper": "paper-conference", "conference proceedings": "paper-conference",
  book: "book", "edited book": "book", "book section": "chapter", thesis: "thesis", report: "report",
  "web page": "webpage", generic: "document", dataset: "dataset", "computer program": "software", patent: "patent",
  "unpublished work": "manuscript", manuscript: "manuscript", "electronic article": "article-journal",
  "magazine article": "article-journal", "newspaper article": "article-journal",
};

function recordToPaper(rec: XNode): { record: PaperRecord; typeKnown: boolean } {
  const refType = xKid(rec, "ref-type");
  const typeName = (xAttr(refType, "name") ?? "").toLowerCase();
  const typeNum = xTrim(refType) ?? "";
  const known = TYPE_BY_NAME[typeName] ?? TYPE_BY_NUMBER[typeNum];
  let type: PaperType = known ?? "document";
  const contrib = xKid(rec, "contributors");
  const names = (tag: string) =>
    xKids(xKid(contrib, tag), "author")
      .map((a) => parseName(xText(a)))
      .filter((a): a is PaperAuthor => !!a);
  const titles = xKid(rec, "titles");
  const periodical = xKid(rec, "periodical");
  const secondary = xTrim(xKid(titles, "secondary-title"));
  const container = type === "book" ? undefined : (secondary ?? xTrim(xKid(periodical, "full-title")) ?? xTrim(xKid(periodical, "abbr-1")));
  const dates = xKid(rec, "dates");
  const year = parseDate(xTrim(xKid(dates, "year"))).year;
  const pub = parseDate(xTrim(xKid(dates, "pub-dates", "date")));
  const urls = xKids(xKid(rec, "urls", "related-urls"), "url").map((u) => xTrim(u)).filter((u): u is string => !!u);
  const pdfUrls = xKids(xKid(rec, "urls", "pdf-urls"), "url").map((u) => xTrim(u)).filter((u): u is string => !!u);
  const doi = xTrim(xKid(rec, "electronic-resource-num")) ?? urls.find((u) => /doi\.org\//i.test(u));
  const arxivId = urls.map(normalizeArxivId).find(Boolean);
  if (type === "document" && arxivId) type = "article";
  const isbn = xTrim(xKid(rec, "isbn"));
  const record = finalizeRecord({
    type,
    title: xTrim(xKid(titles, "title")) ?? "",
    authors: names("authors"),
    editors: names("secondary-authors"),
    year: year ?? pub.year,
    month: pub.year === (year ?? pub.year) ? pub.month : undefined,
    containerTitle: container,
    collectionTitle: xTrim(xKid(titles, "tertiary-title")),
    volume: xTrim(xKid(rec, "volume")),
    issue: xTrim(xKid(rec, "number")) ?? xTrim(xKid(rec, "issue")),
    pages: xTrim(xKid(rec, "pages")),
    publisher: xTrim(xKid(rec, "publisher")),
    publisherPlace: xTrim(xKid(rec, "pub-location")),
    edition: xTrim(xKid(rec, "edition")),
    isbn: type === "book" || type === "chapter" ? isbn : undefined,
    issn: type === "book" || type === "chapter" ? undefined : isbn, // EndNote stores ISSN in <isbn> too
    doi,
    arxivId,
    url: urls.find((u) => !/doi\.org\//i.test(u)),
    abstract: xTrim(xKid(rec, "abstract")),
    keywords: xKids(xKid(rec, "keywords"), "keyword").map((k) => xTrim(k)).filter((k): k is string => !!k),
    language: xTrim(xKid(rec, "language")),
    note: xTrim(xKid(rec, "notes")),
    citeKey: xTrim(xKid(rec, "label")),
    oaPdfUrl: pdfUrls.find((u) => /^https?:/i.test(u)),
  });
  return { record, typeKnown: !!known };
}

export function importEndnoteXml(text: string): ImportResult {
  let doc: ReturnType<typeof parseXml>;
  try {
    doc = parseXml(text.replace(/^﻿/, ""));
  } catch (e) {
    throw new LibraryImportError(`EndNote XML 格式錯誤：${(e as Error).message}`);
  }
  const root = doc.xml?.[0];
  const recs = xKids(xKid(root, "records"), "record");
  if (!root || recs.length === 0) throw new LibraryImportError("找不到 EndNote 記錄（<xml><records><record>）");
  const warnings: ImportWarning[] = [];
  const records: PaperRecord[] = [];
  recs.forEach((rec, index) => {
    const key = xTrim(xKid(rec, "rec-number"));
    const { record, typeKnown } = recordToPaper(rec);
    if (!record.title) {
      warnings.push({ index, ...(key ? { key } : {}), message: "缺少標題，已略過此筆資料" });
      return;
    }
    if (!typeKnown) warnings.push({ index, ...(key ? { key } : {}), message: "不認得的文獻類型，當作一般文件匯入" });
    records.push(record);
  });
  return { format: "endnote-xml", records, warnings };
}
