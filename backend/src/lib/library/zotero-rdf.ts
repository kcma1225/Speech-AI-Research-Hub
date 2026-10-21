import { finalizeRecord, normalizeArxivId, parseDate } from "./normalize.js";
import { LibraryImportError, type ImportResult, type ImportWarning, type PaperAuthor, type PaperRecord, type PaperType } from "./types.js";
import { parseXml, xAttr, xKid, xKids, xTrim, type XNode } from "./xml.js";

// Zotero RDF export ("Zotero RDF" format). Best effort: covers what Zotero writes for the common item types.

export const ZOTERO_TYPES: Record<string, PaperType> = {
  journalArticle: "article-journal", magazineArticle: "article-journal", newspaperArticle: "article-journal",
  conferencePaper: "paper-conference", preprint: "article", book: "book", bookSection: "chapter",
  encyclopediaArticle: "chapter", dictionaryEntry: "chapter", thesis: "thesis", report: "report", webpage: "webpage",
  blogPost: "webpage", forumPost: "webpage", dataset: "dataset", computerProgram: "software", patent: "patent",
  manuscript: "manuscript", presentation: "speech", document: "document", standard: "report",
};

function people(node: XNode | undefined): PaperAuthor[] {
  const out: PaperAuthor[] = [];
  for (const li of xKids(xKid(node, "rdf:Seq"), "rdf:li")) {
    const p = xKid(li, "foaf:Person") ?? xKid(li, "foaf:Organization");
    const family = xTrim(xKid(p, "foaf:surname"));
    const given = xTrim(xKid(p, "foaf:givenName")) ?? xTrim(xKid(p, "foaf:givenname"));
    const name = xTrim(xKid(p, "foaf:name"));
    if (family && given) out.push({ family, given });
    else if (family || name) out.push({ literal: (family ?? name)! });
  }
  return out;
}

/** Text of an element that is either literal or wraps an <rdf:value> (dc:identifier, dc:subject). */
function valueOf(n: XNode): string | undefined {
  if (typeof n === "string") return n.trim() || undefined;
  const inner = Object.entries(n).find(([k]) => !k.startsWith("@_") && k !== "#text");
  if (inner && Array.isArray(inner[1])) {
    const v = xTrim(xKid(inner[1][0], "rdf:value"));
    if (v) return v;
  }
  return xTrim(n);
}

export function importZoteroRdf(text: string): ImportResult {
  let doc: ReturnType<typeof parseXml>;
  try {
    doc = parseXml(text.replace(/^﻿/, ""));
  } catch (e) {
    throw new LibraryImportError(`Zotero RDF 格式錯誤：${(e as Error).message}`);
  }
  const root = doc["rdf:RDF"]?.[0];
  if (!root || typeof root === "string") throw new LibraryImportError("找不到 Zotero RDF 內容（<rdf:RDF>）");
  const byAbout = new Map<string, XNode>();
  const nodes: XNode[] = [];
  for (const [tag, list] of Object.entries(root)) {
    if (tag.startsWith("@_") || tag === "#text" || !Array.isArray(list)) continue;
    for (const n of list) {
      const about = xAttr(n, "rdf:about");
      if (about) byAbout.set(about, n);
      nodes.push(n);
    }
  }
  const warnings: ImportWarning[] = [];
  const records: PaperRecord[] = [];
  let index = 0;
  for (const n of nodes) {
    const itemType = xTrim(xKid(n, "z:itemType"));
    if (!itemType || itemType === "attachment" || itemType === "note") continue;
    const i = index++;
    const key = xAttr(n, "rdf:about");
    const type = ZOTERO_TYPES[itemType] ?? "document";
    if (!ZOTERO_TYPES[itemType]) warnings.push({ index: i, ...(key ? { key } : {}), message: `不認得的 Zotero 類型「${itemType}」，當作一般文件匯入` });
    let part = xKid(n, "dcterms:isPartOf");
    const ref = xAttr(part, "rdf:resource");
    if (ref && byAbout.has(ref)) part = byAbout.get(ref);
    const container = part && typeof part !== "string" ? (Object.entries(part).find(([k]) => k.startsWith("bib:"))?.[1] as XNode[] | undefined)?.[0] ?? part : undefined;
    const ids = xKids(n, "dc:identifier").map(valueOf).filter((v): v is string => !!v);
    const containerIds = xKids(container, "dc:identifier").map(valueOf).filter((v): v is string => !!v);
    const doi = ids.find((v) => /^doi\s/i.test(v))?.replace(/^doi\s+/i, "") ?? ids.find((v) => /doi\.org\//.test(v));
    const url = ids.find((v) => /^https?:/i.test(v) && !/doi\.org\//.test(v));
    const isbn = [...ids, ...containerIds].find((v) => /^isbn\s/i.test(v))?.replace(/^isbn\s+/i, "");
    const issn = [...ids, ...containerIds].find((v) => /^issn\s/i.test(v))?.replace(/^issn\s+/i, "");
    const publisher = xKid(n, "dc:publisher", "foaf:Organization") ?? xKid(n, "dc:publisher");
    const date = parseDate(xTrim(xKid(n, "dc:date")));
    const conference = xTrim(xKid(n, "bib:presentedAt", "bib:Conference", "dc:title"));
    const record = finalizeRecord({
      type,
      title: xTrim(xKid(n, "dc:title")) ?? "",
      authors: people(xKid(n, "bib:authors")),
      editors: people(xKid(n, "bib:editors")),
      ...date,
      containerTitle: (container ? xTrim(xKid(container, "dc:title")) : undefined) ?? conference,
      volume: xTrim(xKid(n, "prism:volume")) ?? xTrim(xKid(container, "prism:volume")),
      issue: xTrim(xKid(n, "prism:number")) ?? xTrim(xKid(container, "prism:number")),
      pages: xTrim(xKid(n, "bib:pages")),
      publisher: xTrim(xKid(publisher, "foaf:name")) ?? (typeof publisher === "string" ? publisher.trim() : undefined),
      publisherPlace: xTrim(xKid(publisher, "vcard:adr", "vcard:Address", "vcard:locality")),
      isbn,
      issn,
      doi,
      arxivId: normalizeArxivId(url?.includes("arxiv.org") ? url : undefined),
      url,
      abstract: xTrim(xKid(n, "dcterms:abstract")),
      keywords: xKids(n, "dc:subject").map(valueOf).filter((v): v is string => !!v),
      language: xTrim(xKid(n, "z:language")) ?? xTrim(xKid(n, "dc:language")),
      extra: xTrim(xKid(n, "dc:description")) ? { extra: xTrim(xKid(n, "dc:description"))! } : undefined,
    });
    if (!record.title) {
      warnings.push({ index: i, ...(key ? { key } : {}), message: "缺少標題，已略過此筆資料" });
      continue;
    }
    records.push(record);
  }
  if (index === 0) throw new LibraryImportError("Zotero RDF 裡沒有任何文獻");
  return { format: "zotero-rdf", records, warnings };
}
