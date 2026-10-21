import { requestJson, sharedLimiter, userAgent, type RateLimiter } from "../http.js";
import { cleanAbstract, cleanText, finalizeRecord, normalizeDoi, splitParticle, titleSimilarity } from "../normalize.js";
import { cslDateParts } from "../csl.js";
import type { PaperAuthor, PaperRecord, PaperType } from "../types.js";
import { clampLimit, trimSlash, type SearchOptions, type SourceOptions } from "./common.js";

// Crossref REST API. https://api.crossref.org/swagger-ui/index.html
// Polite pool (mailto): singleton 10/s, list 3/s, concurrency 3 (since Dec 2025).

export interface CrossrefWork {
  DOI: string;
  title?: string[];
  subtitle?: string[];
  author?: { given?: string; family?: string; name?: string; sequence?: string; suffix?: string }[];
  editor?: { given?: string; family?: string; name?: string }[];
  "container-title"?: string[];
  "short-container-title"?: string[];
  issued?: { "date-parts"?: (number | null)[][] };
  published?: { "date-parts"?: (number | null)[][] };
  type?: string;
  page?: string;
  volume?: string;
  issue?: string;
  publisher?: string;
  "publisher-location"?: string;
  ISBN?: string[];
  ISSN?: string[];
  abstract?: string;
  URL?: string;
  subject?: string[];
  language?: string;
  event?: { name?: string };
  score?: number;
}

const TYPES: Record<string, PaperType> = {
  "journal-article": "article-journal",
  "proceedings-article": "paper-conference",
  "posted-content": "article",
  "book-chapter": "chapter",
  "book-section": "chapter",
  "book-part": "chapter",
  "reference-entry": "chapter",
  book: "book",
  monograph: "book",
  "edited-book": "book",
  "reference-book": "book",
  proceedings: "book",
  dissertation: "thesis",
  report: "report",
  "report-component": "report",
  standard: "report",
  dataset: "dataset",
};

const crName = (a: { given?: string; family?: string; name?: string; suffix?: string }): PaperAuthor | undefined => {
  if (a.name && !a.family) return { literal: a.name };
  if (!a.family) return undefined;
  const sp = splitParticle(a.family);
  return { ...sp, ...(a.given ? { given: a.given } : {}), ...(a.suffix ? { suffix: a.suffix } : {}) };
};

export function crossrefWorkToRecord(w: CrossrefWork): PaperRecord {
  const date = cslDateParts((w.issued ?? w.published) as { "date-parts"?: (number | string)[][] });
  const title = [w.title?.[0], w.subtitle?.[0]].filter(Boolean).map((t) => cleanText(t)).join(": ");
  return finalizeRecord({
    type: TYPES[w.type ?? ""] ?? "document",
    title,
    authors: (w.author ?? []).map(crName).filter((a): a is PaperAuthor => !!a),
    editors: (w.editor ?? []).map(crName).filter((a): a is PaperAuthor => !!a),
    ...date,
    containerTitle: cleanText(w["container-title"]?.[0]) ?? (w.type === "proceedings-article" ? w.event?.name : undefined),
    volume: w.volume,
    issue: w.issue,
    pages: w.page,
    publisher: w.publisher,
    publisherPlace: w["publisher-location"],
    isbn: w.ISBN?.[0],
    issn: w.ISSN?.[0],
    doi: w.DOI,
    url: w.URL,
    abstract: cleanAbstract(w.abstract),
    keywords: w.subject,
    language: w.language,
  });
}

export class CrossrefClient {
  readonly source = "crossref" as const;
  private base: string;
  private limiter: RateLimiter;

  constructor(private opts: SourceOptions = {}) {
    this.base = trimSlash(opts.baseUrl ?? "https://api.crossref.org");
    this.limiter = opts.limiter ?? sharedLimiter("crossref");
  }

  private url(path: string, params: Record<string, string | undefined> = {}): string {
    const u = new URL(this.base + path);
    for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
    if (this.opts.contactEmail) u.searchParams.set("mailto", this.opts.contactEmail);
    return u.toString();
  }

  private get<T>(url: string, signal?: AbortSignal) {
    return requestJson<T>(url, {
      source: "crossref",
      limiter: this.limiter,
      headers: { "user-agent": userAgent(this.opts.contactEmail) },
      timeoutMs: this.opts.timeoutMs,
      signal,
    });
  }

  private filters(opts: SearchOptions): string | undefined {
    const f: string[] = [];
    if (opts.yearFrom) f.push(`from-pub-date:${opts.yearFrom}-01-01`);
    if (opts.yearTo) f.push(`until-pub-date:${opts.yearTo}-12-31`);
    return f.join(",") || undefined;
  }

  async search(query: string, opts: SearchOptions = {}): Promise<PaperRecord[]> {
    const { data } = await this.get<{ message?: { items?: CrossrefWork[] } }>(
      this.url("/works", { query, rows: String(clampLimit(opts.limit, 100)), filter: this.filters(opts) }),
      opts.signal,
    );
    return (data?.message?.items ?? []).map(crossrefWorkToRecord).filter((r) => r.title);
  }

  async getByDoi(doi: string, signal?: AbortSignal): Promise<PaperRecord | null> {
    const d = normalizeDoi(doi);
    if (!d) return null;
    const { data } = await this.get<{ message?: CrossrefWork }>(this.url(`/works/${encodeURIComponent(d)}`), signal);
    return data?.message?.DOI ? crossrefWorkToRecord(data.message) : null;
  }

  /** Bibliographic match (title + first author), accepted when title similarity ≥ minScore (default 0.9). */
  async matchBibliographic(title: string, author?: string, opts: { minScore?: number; signal?: AbortSignal } = {}): Promise<{ record: PaperRecord; score: number } | null> {
    const { data } = await this.get<{ message?: { items?: CrossrefWork[] } }>(
      this.url("/works", { "query.bibliographic": [title, author].filter(Boolean).join(" "), rows: "3" }),
      opts.signal,
    );
    let best: { record: PaperRecord; score: number } | null = null;
    for (const w of data?.message?.items ?? []) {
      const r = crossrefWorkToRecord(w);
      const score = titleSimilarity(title, r.title);
      if (!best || score > best.score) best = { record: r, score };
    }
    return best && best.score >= (opts.minScore ?? 0.9) ? best : null;
  }
}
