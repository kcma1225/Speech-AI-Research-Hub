import { requestJson, sharedLimiter, userAgent, type RateLimiter } from "../http.js";
import { cleanText, finalizeRecord, normalizeArxivId, normalizeDoi, parseDate, parseName } from "../normalize.js";
import type { PaperAuthor, PaperRecord, PaperType } from "../types.js";
import { clampLimit, trimSlash, type SearchOptions, type SourceOptions } from "./common.js";

// Semantic Scholar Academic Graph API. https://api.semanticscholar.org/api-docs/graph
// With a key: 1 request/second on all endpoints (header x-api-key).

export interface S2Options extends SourceOptions {
  apiKey?: string;
}

export interface S2Paper {
  paperId: string;
  externalIds?: { DOI?: string; ArXiv?: string; ACL?: string; DBLP?: string; CorpusId?: number | string; PubMed?: string } | null;
  url?: string;
  title?: string;
  abstract?: string | null;
  venue?: string | null;
  publicationVenue?: { name?: string; type?: string } | null;
  year?: number | null;
  publicationDate?: string | null;
  journal?: { name?: string; volume?: string; pages?: string } | null;
  authors?: { authorId?: string | null; name?: string }[];
  publicationTypes?: string[] | null;
  openAccessPdf?: { url?: string; status?: string | null; license?: string | null } | null;
  matchScore?: number;
}

export const S2_FIELDS =
  "title,authors,year,venue,publicationVenue,externalIds,abstract,openAccessPdf,publicationDate,journal,publicationTypes,url";

function mapType(p: S2Paper): PaperType {
  const t = p.publicationTypes ?? [];
  const vt = p.publicationVenue?.type;
  if (t.includes("Conference") || vt === "conference") return "paper-conference";
  if (t.includes("JournalArticle") || t.includes("Review") || vt === "journal") {
    return p.externalIds?.ArXiv && !p.journal?.name && !p.venue ? "article" : "article-journal";
  }
  if (t.includes("Book")) return "book";
  if (t.includes("BookSection")) return "chapter";
  if (t.includes("Dataset")) return "dataset";
  if (p.externalIds?.ArXiv) return "article";
  return "document";
}

export function s2PaperToRecord(p: S2Paper): PaperRecord {
  const date = parseDate(p.publicationDate ?? undefined);
  const venue = p.publicationVenue?.name ?? p.venue ?? undefined;
  const journalName = p.journal?.name && !/^arxiv/i.test(p.journal.name) ? p.journal.name : undefined;
  const container = journalName ?? (venue && !/^arxiv/i.test(venue) ? venue : undefined);
  const ext = p.externalIds ?? {};
  const pdf = p.openAccessPdf?.url;
  return finalizeRecord({
    type: mapType(p),
    title: cleanText(p.title) ?? "",
    authors: (p.authors ?? []).map((a) => parseName(a.name ?? "")).filter((a): a is PaperAuthor => !!a),
    year: p.year ?? date.year,
    month: date.month,
    day: date.day,
    containerTitle: container,
    volume: p.journal?.volume?.trim() || undefined,
    pages: p.journal?.pages?.trim() || undefined,
    doi: normalizeDoi(ext.DOI),
    arxivId: normalizeArxivId(ext.ArXiv),
    url: p.url,
    abstract: p.abstract ?? undefined,
    ids: {
      s2: p.paperId,
      s2Corpus: ext.CorpusId != null ? String(ext.CorpusId) : undefined,
      acl: ext.ACL,
      dblp: ext.DBLP,
      pmid: ext.PubMed,
    },
    oaPdfUrl: pdf && /^https?:/.test(pdf) ? pdf : undefined,
  });
}

export class SemanticScholarClient {
  readonly source = "s2" as const;
  private base: string;
  private limiter: RateLimiter;

  constructor(private opts: S2Options = {}) {
    this.base = trimSlash(opts.baseUrl ?? "https://api.semanticscholar.org/graph/v1");
    this.limiter = opts.limiter ?? sharedLimiter("s2");
  }

  get hasKey(): boolean {
    return !!this.opts.apiKey;
  }

  private headers(): Record<string, string> {
    return { "user-agent": userAgent(this.opts.contactEmail), ...(this.opts.apiKey ? { "x-api-key": this.opts.apiKey } : {}) };
  }

  private req<T>(path: string, params: Record<string, string | undefined>, signal?: AbortSignal) {
    const u = new URL(this.base + path);
    for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
    return requestJson<T>(u.toString(), {
      source: "s2",
      limiter: this.limiter,
      headers: this.headers(),
      timeoutMs: this.opts.timeoutMs,
      okStatuses: [404, 400],
      signal,
    });
  }

  async search(query: string, opts: SearchOptions = {}): Promise<PaperRecord[]> {
    const year = opts.yearFrom || opts.yearTo ? `${opts.yearFrom ?? ""}-${opts.yearTo ?? ""}` : undefined;
    const { data } = await this.req<{ data?: S2Paper[] }>(
      "/paper/search",
      { query, limit: String(clampLimit(opts.limit, 100)), fields: S2_FIELDS, year },
      opts.signal,
    );
    return (data?.data ?? []).map(s2PaperToRecord).filter((r) => r.title);
  }

  /** Lookup by S2 id or prefixed id: "DOI:10.…", "ARXIV:2005.08100", "ACL:…", "CorpusId:…". */
  async getPaper(id: string, signal?: AbortSignal): Promise<{ record: PaperRecord; paper: S2Paper } | null> {
    const { data } = await this.req<S2Paper>(`/paper/${encodeURIComponent(id).replace(/%3A/gi, ":")}`, { fields: S2_FIELDS }, signal);
    if (!data?.paperId) return null;
    return { record: s2PaperToRecord(data), paper: data };
  }

  async getForRecord(r: PaperRecord, signal?: AbortSignal) {
    const id = r.ids?.s2 ?? (r.doi ? `DOI:${r.doi}` : r.arxivId ? `ARXIV:${r.arxivId}` : r.ids?.acl ? `ACL:${r.ids.acl}` : undefined);
    return id ? this.getPaper(id, signal) : null;
  }

  /** Best title match (`/paper/search/match`); null when S2 finds none. */
  async matchTitle(title: string, signal?: AbortSignal): Promise<{ record: PaperRecord; score?: number } | null> {
    const { data } = await this.req<{ data?: S2Paper[] }>("/paper/search/match", { query: title, fields: S2_FIELDS }, signal);
    const p = data?.data?.[0];
    return p?.paperId ? { record: s2PaperToRecord(p), score: p.matchScore } : null;
  }
}
