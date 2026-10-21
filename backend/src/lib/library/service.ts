import { dedupeRecords, mergeRecords } from "./dedupe.js";
import { GrobidClient } from "./grobid.js";
import { SourceError, sourceLabel, type LimiterName, type RateLimiter } from "./http.js";
import { arxivIdFromDoi, authorFamily, normalizeArxivId, normalizeDoi } from "./normalize.js";
import { downloadPdf, extractIdentifiers, extractPdfText, type DownloadedPdf, type DownloadPdfOptions, type PdfIdentifiers } from "./pdf.js";
import { AclAnthologyClient, parseAclId } from "./sources/acl.js";
import { ArxivClient } from "./sources/arxiv.js";
import { CrossrefClient } from "./sources/crossref.js";
import { IscaArchiveClient } from "./sources/isca.js";
import { OpenAlexClient } from "./sources/openalex.js";
import { SemanticScholarClient } from "./sources/semantic-scholar.js";
import { UnpaywallClient } from "./sources/unpaywall.js";
import type { PaperRecord, SourceName } from "./types.js";

export interface LibraryConfig {
  /** Lab contact address: Crossref mailto, Unpaywall email, User-Agent. */
  contactEmail?: string;
  /** Unpaywall `email` parameter (default: contactEmail). */
  unpaywallEmail?: string;
  openalexApiKey?: string;
  s2ApiKey?: string;
  /** e.g. "http://grobid:8070" — GROBID is used only when set. */
  grobidUrl?: string;
  /** Per-request timeout, ms (default 20 s; arXiv/ISCA 30 s). */
  timeoutMs?: number;
  /** Tests: API base URL overrides. */
  baseUrls?: Partial<Record<"openalex" | "s2" | "arxiv" | "crossref" | "acl" | "isca" | "unpaywall", string>>;
  /** Tests: limiter overrides (default: process-wide shared limiters). */
  limiters?: Partial<Record<LimiterName, RateLimiter>>;
  /** Tests: allow PDF downloads from private addresses. */
  allowPrivateDownloads?: boolean;
}

export type SearchSource = "openalex" | "s2" | "arxiv" | "crossref" | "acl" | "isca";
export const DEFAULT_SEARCH_SOURCES: SearchSource[] = ["openalex", "s2", "arxiv", "crossref"];

export interface PaperSearchOptions {
  sources?: SearchSource[];
  /** Max merged results (default 20); each source is asked for the same number. */
  limit?: number;
  yearFrom?: number;
  yearTo?: number;
  /** Keep only these short venue labels (e.g. ["Interspeech", "ICASSP"]), matched case-insensitively. */
  venues?: string[];
  signal?: AbortSignal;
}

export interface PaperSearchHit {
  record: PaperRecord;
  /** Sources that returned this work (first = the one whose metadata won). */
  sources: SearchSource[];
}

export interface PaperSearchResult {
  hits: PaperSearchHit[];
  /** Sources that failed (繁中 message). */
  errors: { source: SearchSource; status: number; message: string }[];
  /** Sources not queried (missing key, no search API). */
  skipped: { source: SearchSource; reason: string }[];
}

export type IdentifierKind = "doi" | "arxiv" | "acl" | "openalex" | "s2" | "isca";

export interface ParsedIdentifier {
  kind: IdentifierKind;
  value: string;
}

export interface ResolveResult {
  record: PaperRecord;
  /** Where the metadata came from (first = primary). */
  sources: SourceName[];
  identifier: ParsedIdentifier;
}

export interface OpenAccessPdf {
  url: string;
  source: "arxiv" | "acl" | "isca" | "unpaywall" | "openalex" | "s2" | "arxiv-title";
  license?: string;
  /** Set when the PDF was found through an arXiv title match (store it on the paper). */
  arxivId?: string;
}

export interface PdfImportResult {
  record: PaperRecord | null;
  method: "doi" | "arxiv" | "title-match" | "grobid" | "guess" | "none";
  identifiers: PdfIdentifiers;
  titleGuess?: string;
  /** 繁中 notes for the UI (e.g. "無法自動辨識，請確認資料"). */
  warnings: string[];
}

/** Recognize a DOI, arXiv id, ACL id, OpenAlex W-id, S2 paper id, ISCA paper, or one of their URLs. */
export function parseIdentifier(input: string): ParsedIdentifier | null {
  const s = input.trim();
  if (!s) return null;
  const isca = /isca-archive\.org\/(interspeech_\d{4})\/([a-z0-9]+_interspeech)/i.exec(s);
  if (isca) return { kind: "isca", value: `${isca[1]}/${isca[2]}` };
  if (/aclanthology\.org\//i.test(s)) {
    const id = parseAclId(s);
    if (id) return { kind: "acl", value: id };
  }
  const oa = /(?:openalex\.org\/(?:works\/)?|^)(W\d{4,})$/i.exec(s);
  if (oa) return { kind: "openalex", value: oa[1]!.toUpperCase() };
  const s2 = /(?:semanticscholar\.org\/paper\/(?:[^/]+\/)?|^)([0-9a-f]{40})(?:[?#].*)?$/i.exec(s);
  if (s2) return { kind: "s2", value: s2[1]!.toLowerCase() };
  if (/arxiv\.org\//i.test(s) || /^arxiv:/i.test(s)) {
    const a = normalizeArxivId(s);
    if (a) return { kind: "arxiv", value: a };
  }
  const doi = normalizeDoi(s);
  if (doi) {
    const ax = arxivIdFromDoi(doi);
    if (ax) return { kind: "arxiv", value: ax };
    return { kind: "doi", value: doi };
  }
  const ax = normalizeArxivId(s);
  if (ax && /^(\d{4}\.\d{4,5}|[a-z-]+(\.[A-Z]{2})?\/\d{7})(v\d+)?$/i.test(s)) return { kind: "arxiv", value: ax };
  const acl = parseAclId(s);
  if (acl) return { kind: "acl", value: acl };
  return null;
}

export function createLibraryService(config: LibraryConfig = {}) {
  const common = { contactEmail: config.contactEmail, timeoutMs: config.timeoutMs };
  const lim = config.limiters ?? {};
  const urls = config.baseUrls ?? {};
  const clients = {
    openalex: new OpenAlexClient({ ...common, apiKey: config.openalexApiKey, baseUrl: urls.openalex, limiter: lim.openalex }),
    s2: new SemanticScholarClient({ ...common, apiKey: config.s2ApiKey, baseUrl: urls.s2, limiter: lim.s2 }),
    arxiv: new ArxivClient({ ...common, baseUrl: urls.arxiv, limiter: lim.arxiv }),
    crossref: new CrossrefClient({ ...common, baseUrl: urls.crossref, limiter: lim.crossref }),
    acl: new AclAnthologyClient({ ...common, baseUrl: urls.acl, limiter: lim.acl }),
    isca: new IscaArchiveClient({ ...common, baseUrl: urls.isca, limiter: lim.isca }),
    unpaywall: new UnpaywallClient({ ...common, contactEmail: config.unpaywallEmail ?? config.contactEmail, baseUrl: urls.unpaywall, limiter: lim.unpaywall }),
    grobid: config.grobidUrl ? new GrobidClient({ url: config.grobidUrl, limiter: lim.grobid }) : null,
  };

  // Errors from optional lookups should not break the chain.
  const quiet = async <T>(p: Promise<T>): Promise<T | null> => {
    try {
      return await p;
    } catch (e) {
      if (e instanceof SourceError) return null;
      throw e;
    }
  };

  async function searchPapers(query: string, opts: PaperSearchOptions = {}): Promise<PaperSearchResult> {
    const q = query.trim();
    const sources = [...new Set(opts.sources ?? DEFAULT_SEARCH_SOURCES)];
    const limit = Math.max(1, Math.min(100, opts.limit ?? 20));
    const skipped: PaperSearchResult["skipped"] = [];
    const errors: PaperSearchResult["errors"] = [];
    if (!q) return { hits: [], errors, skipped };
    const sub = { limit, yearFrom: opts.yearFrom, yearTo: opts.yearTo, signal: opts.signal };
    const jobs: { source: SearchSource; run: () => Promise<PaperRecord[]> }[] = [];
    for (const s of sources) {
      if (s === "openalex" && !clients.openalex.hasKey) skipped.push({ source: s, reason: "未設定 OpenAlex API key" });
      else if (s === "s2" && !clients.s2.hasKey) skipped.push({ source: s, reason: "未設定 Semantic Scholar API key" });
      else if (s === "acl") skipped.push({ source: s, reason: "ACL Anthology 沒有搜尋 API，ACL 論文已包含在 OpenAlex 與 Semantic Scholar 的結果中" });
      else jobs.push({ source: s, run: () => clients[s as Exclude<SearchSource, "acl">].search(q, sub) });
    }
    const settled = await Promise.allSettled(jobs.map((j) => j.run()));
    const lists: { source: SearchSource; records: PaperRecord[] }[] = [];
    settled.forEach((r, i) => {
      const source = jobs[i]!.source;
      if (r.status === "fulfilled") lists.push({ source, records: r.value });
      else {
        const e = r.reason as Error;
        errors.push({ source, status: e instanceof SourceError ? e.status : 0, message: e instanceof SourceError ? e.message : `${sourceLabel(source)} 搜尋失敗` });
      }
    });
    // Interleave by rank so every source contributes its best hits first.
    const flat: { record: PaperRecord; source: SearchSource }[] = [];
    const maxLen = Math.max(0, ...lists.map((l) => l.records.length));
    for (let i = 0; i < maxLen; i++) for (const l of lists) if (l.records[i]) flat.push({ record: l.records[i]!, source: l.source });
    const groups = dedupeRecords(flat.map((f) => f.record));
    let hits: PaperSearchHit[] = groups.map((g) => ({ record: g.record, sources: [...new Set(g.members.map((m) => flat[m]!.source))] }));
    if (opts.venues?.length) {
      const want = new Set(opts.venues.map((v) => v.toLowerCase()));
      hits = hits.filter((h) => h.record.venue && want.has(h.record.venue.toLowerCase()));
    }
    return { hits: hits.slice(0, limit), errors, skipped };
  }

  async function resolveIdentifier(input: string | ParsedIdentifier, opts: { enrich?: boolean; signal?: AbortSignal } = {}): Promise<ResolveResult | null> {
    const id = typeof input === "string" ? parseIdentifier(input) : input;
    if (!id) return null;
    const signal = opts.signal;
    const enrich = opts.enrich ?? true;
    let record: PaperRecord | null = null;
    const sources: SourceName[] = [];
    const add = (r: PaperRecord | null | undefined, s: SourceName) => {
      if (!r) return;
      record = record ? mergeRecords(record, r) : r;
      sources.push(s);
    };
    switch (id.kind) {
      case "doi": {
        add(await quiet(clients.crossref.getByDoi(id.value, signal)), "crossref");
        if (!record || enrich) add((await quiet(clients.openalex.getByDoi(id.value, signal)))?.record, "openalex");
        const acl = parseAclId(id.value);
        if (!record && acl) add(await quiet(clients.acl.getById(acl, signal)), "acl");
        break;
      }
      case "arxiv":
        add(await clients.arxiv.getById(id.value, signal), "arxiv");
        break;
      case "acl":
        add(await clients.acl.getById(id.value, signal), "acl");
        break;
      case "openalex":
        add((await clients.openalex.getById(id.value, signal))?.record, "openalex");
        break;
      case "s2":
        add((await clients.s2.getPaper(id.value, signal))?.record, "s2");
        break;
      case "isca":
        add(await clients.isca.getPaper(id.value, signal), "isca");
        break;
    }
    const rec = record as PaperRecord | null;
    return rec ? { record: rec, sources, identifier: id } : null;
  }

  async function findOpenAccessPdf(r: PaperRecord, opts: { titleMatch?: boolean; signal?: AbortSignal } = {}): Promise<OpenAccessPdf | null> {
    const signal = opts.signal;
    const arxivId = normalizeArxivId(r.arxivId) ?? arxivIdFromDoi(r.doi);
    // 1. arXiv
    if (arxivId) return { url: `https://arxiv.org/pdf/${arxivId}`, source: "arxiv" };
    // 2. ACL Anthology
    const acl = r.ids?.acl ?? parseAclId(r.doi);
    if (acl) return { url: clients.acl.pdfUrl(acl), source: "acl" };
    // 3. ISCA Archive (Interspeech)
    if (r.ids?.isca) return { url: clients.isca.pdfUrl(r.ids.isca), source: "isca" };
    const isInterspeech = r.doi?.toLowerCase().startsWith("10.21437/interspeech") || r.venue === "Interspeech";
    if (isInterspeech && r.year && r.title) {
      const hit = await quiet(clients.isca.findByTitle(r.title, r.year, { signal }));
      if (hit) return { url: hit.entry.pdfUrl, source: "isca" };
    }
    // 4. Unpaywall
    if (r.doi && clients.unpaywall.available) {
      const u = await quiet(clients.unpaywall.pdfUrl(r.doi, signal));
      if (u) return { url: u.url, source: "unpaywall", ...(u.license ? { license: u.license } : {}) };
    }
    // 5. OpenAlex (free singleton)
    const oa = r.ids?.openalex ? await quiet(clients.openalex.getById(r.ids.openalex, signal)) : r.doi ? await quiet(clients.openalex.getByDoi(r.doi, signal)) : null;
    if (oa) {
      const loc = oa.work.best_oa_location;
      const url = loc?.pdf_url ?? (oa.work.open_access?.oa_url?.toLowerCase().includes(".pdf") ? oa.work.open_access.oa_url : null);
      if (oa.record.arxivId) return { url: `https://arxiv.org/pdf/${oa.record.arxivId}`, source: "arxiv", arxivId: oa.record.arxivId };
      if (url) return { url, source: "openalex", ...(loc?.license ? { license: loc.license } : {}) };
    }
    // 6. Semantic Scholar
    if (clients.s2.hasKey || r.ids?.s2) {
      const s = await quiet(clients.s2.getForRecord(r, signal));
      if (s?.record.arxivId) return { url: `https://arxiv.org/pdf/${s.record.arxivId}`, source: "arxiv", arxivId: s.record.arxivId };
      const url = s?.paper.openAccessPdf?.url;
      if (url) return { url, source: "s2", ...(s?.paper.openAccessPdf?.license ? { license: s.paper.openAccessPdf.license } : {}) };
    }
    // 7. arXiv title match (closed venues such as ICASSP usually have a preprint)
    if (opts.titleMatch !== false && r.title) {
      const m = await quiet(clients.arxiv.matchTitle(r.title, { signal }));
      const family = authorFamily(r.authors[0]).toLowerCase();
      const authorOk = !family || !m || m.record.authors.slice(0, 3).some((a) => authorFamily(a).toLowerCase() === family);
      if (m && authorOk && m.record.arxivId) return { url: `https://arxiv.org/pdf/${m.record.arxivId}`, source: "arxiv-title", arxivId: m.record.arxivId };
    }
    return null;
  }

  async function extractPdfRecord(pdf: Uint8Array, opts: { useGrobid?: boolean; signal?: AbortSignal } = {}): Promise<PdfImportResult> {
    const signal = opts.signal;
    const text = await extractPdfText(pdf);
    const identifiers = extractIdentifiers(text);
    const titleGuess = text.titleGuess;
    const warnings: string[] = [];
    const base = { identifiers, ...(titleGuess ? { titleGuess } : {}), warnings };
    if (identifiers.doi) {
      const res = await quiet(resolveIdentifier({ kind: "doi", value: identifiers.doi }, { signal }));
      if (res) {
        const rec = identifiers.arxivId && !res.record.arxivId ? { ...res.record, arxivId: identifiers.arxivId } : res.record;
        return { ...base, record: rec, method: "doi" };
      }
      warnings.push(`找到 DOI ${identifiers.doi}，但查不到對應的資料`);
    }
    if (identifiers.arxivId) {
      const r = await quiet(clients.arxiv.getById(identifiers.arxivId, signal));
      if (r) return { ...base, record: r, method: "arxiv" };
      warnings.push(`找到 arXiv 編號 ${identifiers.arxivId}，但 arXiv 查不到`);
    }
    if (titleGuess) {
      const m = await quiet(clients.crossref.matchBibliographic(titleGuess, undefined, { signal }));
      if (m) return { ...base, record: m.record, method: "title-match" };
    }
    if (clients.grobid && opts.useGrobid !== false) {
      const g = await quiet(clients.grobid.processHeader(pdf, signal));
      if (g?.title) {
        if (g.doi) {
          const res = await quiet(resolveIdentifier({ kind: "doi", value: g.doi }, { signal }));
          if (res) return { ...base, record: mergeRecords(res.record, g), method: "grobid" };
        }
        warnings.push("由 GROBID 從 PDF 內容辨識，請確認資料是否正確");
        return { ...base, record: g, method: "grobid" };
      }
    }
    if (titleGuess) {
      warnings.push("無法自動辨識這份 PDF，已用頁首最大字體的文字當作標題，請確認資料");
      return { ...base, record: { type: "document", title: titleGuess, authors: [] }, method: "guess" };
    }
    warnings.push("無法從 PDF 辨識出文獻資料，請手動輸入");
    return { ...base, record: null, method: "none" };
  }

  return {
    clients,
    searchPapers,
    resolveIdentifier,
    findOpenAccessPdf,
    extractPdfRecord,
    downloadPdf: (url: string, opts: DownloadPdfOptions = {}): Promise<DownloadedPdf> =>
      downloadPdf(url, { contactEmail: config.contactEmail, allowPrivate: config.allowPrivateDownloads, limiter: lim.download, ...opts }),
  };
}

export type LibraryService = ReturnType<typeof createLibraryService>;
