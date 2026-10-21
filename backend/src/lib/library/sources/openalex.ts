import { requestJson, sharedLimiter, SourceError, userAgent, type RateLimiter } from "../http.js";
import { cleanText, finalizeRecord, normalizeArxivId, normalizeDoi, parseDate, parseName } from "../normalize.js";
import type { PaperAuthor, PaperRecord, PaperType } from "../types.js";
import { clampLimit, trimSlash, type SearchOptions, type SourceOptions } from "./common.js";

// OpenAlex works API. https://docs.openalex.org/api-entities/works
// 2026 pricing: key → $1/day; singleton lookups cost 0, `search` costs credits (see research doc C).

export interface OpenAlexOptions extends SourceOptions {
  apiKey?: string;
  /** Refuse further searches when the reported remaining daily budget drops below this (USD). Default 0.02. */
  minRemainingUsd?: number;
}

interface OaLocation {
  is_oa?: boolean;
  landing_page_url?: string | null;
  pdf_url?: string | null;
  license?: string | null;
  version?: string | null;
  source?: { id?: string; display_name?: string; type?: string; host_organization_name?: string; issn_l?: string | null } | null;
}

export interface OpenAlexWork {
  id: string;
  doi?: string | null;
  title?: string | null;
  display_name?: string | null;
  publication_year?: number | null;
  publication_date?: string | null;
  type?: string | null;
  type_crossref?: string | null;
  language?: string | null;
  ids?: { openalex?: string; doi?: string; pmid?: string; mag?: string };
  authorships?: { author_position?: string; author?: { id?: string; display_name?: string }; raw_author_name?: string }[];
  primary_location?: OaLocation | null;
  best_oa_location?: OaLocation | null;
  locations?: OaLocation[];
  open_access?: { is_oa?: boolean; oa_status?: string; oa_url?: string | null };
  biblio?: { volume?: string | null; issue?: string | null; first_page?: string | null; last_page?: string | null };
  abstract_inverted_index?: Record<string, number[]> | null;
  keywords?: { display_name?: string }[];
}

/** OpenAlex ships abstracts as an inverted index: word → positions. */
export function invertedIndexToText(idx: Record<string, number[]> | null | undefined): string | undefined {
  if (!idx) return undefined;
  const words: string[] = [];
  for (const [w, positions] of Object.entries(idx)) for (const p of positions) words[p] = w;
  const text = words.filter((w) => w !== undefined).join(" ");
  return text || undefined;
}

function mapType(w: OpenAlexWork): PaperType {
  const src = w.primary_location?.source?.type;
  if (w.type_crossref === "proceedings-article" || src === "conference") return "paper-conference";
  switch (w.type) {
    case "preprint":
      return "article";
    case "article":
    case "review":
    case "letter":
    case "editorial":
      return src === "repository" ? "article" : "article-journal";
    case "book-chapter":
      return "chapter";
    case "book":
      return "book";
    case "dissertation":
      return "thesis";
    case "dataset":
      return "dataset";
    case "report":
      return "report";
    case "standard":
      return "report";
    default:
      return "document";
  }
}

export function openAlexWorkToRecord(w: OpenAlexWork): PaperRecord {
  const doi = normalizeDoi(w.doi ?? w.ids?.doi ?? undefined);
  const arxivLoc = [w.primary_location, ...(w.locations ?? [])].find((l) => l?.landing_page_url?.includes("arxiv.org"));
  const arxivId = normalizeArxivId(arxivLoc?.landing_page_url ?? undefined);
  const date = parseDate(w.publication_date ?? undefined);
  const authors = (w.authorships ?? [])
    .map((a) => parseName(a.author?.display_name ?? a.raw_author_name ?? ""))
    .filter((a): a is PaperAuthor => !!a);
  const b = w.biblio ?? {};
  const pages = b.first_page ? (b.last_page && b.last_page !== b.first_page ? `${b.first_page}–${b.last_page}` : b.first_page) : undefined;
  const src = w.primary_location?.source;
  const pdf = w.best_oa_location?.pdf_url ?? w.open_access?.oa_url ?? undefined;
  const openalex = w.id?.replace(/^https?:\/\/openalex\.org\//, "");
  return finalizeRecord({
    type: mapType(w),
    title: cleanText(w.title ?? w.display_name) ?? "",
    authors,
    year: w.publication_year ?? date.year,
    month: date.month,
    day: date.day,
    containerTitle: src?.type === "repository" ? undefined : (src?.display_name ?? undefined),
    volume: b.volume ?? undefined,
    issue: b.issue ?? undefined,
    pages,
    publisher: src?.host_organization_name ?? undefined,
    doi,
    arxivId,
    url: w.primary_location?.landing_page_url ?? (doi ? `https://doi.org/${doi}` : undefined),
    abstract: invertedIndexToText(w.abstract_inverted_index),
    keywords: (w.keywords ?? []).map((k) => k.display_name ?? "").filter(Boolean),
    language: w.language ?? undefined,
    ids: { openalex, pmid: w.ids?.pmid?.replace(/^https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\//, "").replace(/\/$/, "") },
    oaPdfUrl: pdf && /^https?:/.test(pdf) ? pdf : undefined,
  });
}

export interface OpenAlexUsage {
  costUsd?: number;
  remainingUsd?: number;
}

export class OpenAlexClient {
  readonly source = "openalex" as const;
  private base: string;
  private limiter: RateLimiter;
  /** Usage reported by the last response (headers `X-RateLimit-Cost-USD` / `X-RateLimit-Remaining-USD`). */
  lastUsage: OpenAlexUsage = {};

  constructor(private opts: OpenAlexOptions = {}) {
    this.base = trimSlash(opts.baseUrl ?? "https://api.openalex.org");
    this.limiter = opts.limiter ?? sharedLimiter("openalex");
  }

  get hasKey(): boolean {
    return !!this.opts.apiKey;
  }

  private url(path: string, params: Record<string, string | undefined>): string {
    const u = new URL(this.base + path);
    for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
    if (this.opts.apiKey) u.searchParams.set("api_key", this.opts.apiKey);
    else if (this.opts.contactEmail) u.searchParams.set("mailto", this.opts.contactEmail);
    return u.toString();
  }

  private async get<T>(url: string, signal?: AbortSignal) {
    const res = await requestJson<T>(url, {
      source: "openalex",
      limiter: this.limiter,
      timeoutMs: this.opts.timeoutMs,
      headers: { "user-agent": userAgent(this.opts.contactEmail) },
      signal,
    });
    const cost = Number(res.headers.get("x-ratelimit-cost-usd"));
    const remaining = Number(res.headers.get("x-ratelimit-remaining-usd"));
    this.lastUsage = {
      ...(Number.isFinite(cost) && res.headers.has("x-ratelimit-cost-usd") ? { costUsd: cost } : {}),
      ...(Number.isFinite(remaining) && res.headers.has("x-ratelimit-remaining-usd") ? { remainingUsd: remaining } : {}),
    };
    return res;
  }

  async search(query: string, opts: SearchOptions = {}): Promise<PaperRecord[]> {
    const min = this.opts.minRemainingUsd ?? 0.02;
    if (this.lastUsage.remainingUsd !== undefined && this.lastUsage.remainingUsd < min) {
      throw new SourceError("openalex", 429, "OpenAlex 今日額度已用完，明天（UTC 午夜）重置");
    }
    const filters: string[] = [];
    if (opts.yearFrom || opts.yearTo) filters.push(`publication_year:${opts.yearFrom ?? ""}-${opts.yearTo ?? ""}`);
    const { data } = await this.get<{ results?: OpenAlexWork[] }>(
      this.url("/works", { search: query, per_page: String(clampLimit(opts.limit, 50)), filter: filters.join(",") || undefined }),
      opts.signal,
    );
    return (data?.results ?? []).map(openAlexWorkToRecord).filter((r) => r.title);
  }

  /** Singleton lookup by DOI (free). */
  async getByDoi(doi: string, signal?: AbortSignal): Promise<{ record: PaperRecord; work: OpenAlexWork } | null> {
    const d = normalizeDoi(doi);
    if (!d) return null;
    return this.getRaw(`/works/doi:${encodeURIComponent(d)}`, signal);
  }

  /** Singleton lookup by OpenAlex id ("W2963403868" or URL). */
  async getById(id: string, signal?: AbortSignal): Promise<{ record: PaperRecord; work: OpenAlexWork } | null> {
    const w = /W\d+/i.exec(id)?.[0];
    if (!w) return null;
    return this.getRaw(`/works/${w.toUpperCase()}`, signal);
  }

  private async getRaw(path: string, signal?: AbortSignal) {
    const { data } = await this.get<OpenAlexWork>(this.url(path, {}), signal);
    if (!data?.id) return null;
    return { record: openAlexWorkToRecord(data), work: data };
  }
}
