import { requestText, sharedLimiter, SourceError, userAgent, type RateLimiter } from "../http.js";
import { cleanText, finalizeRecord, normalizeArxivId, parseDate, parseName, titleSimilarity } from "../normalize.js";
import type { PaperAuthor, PaperRecord } from "../types.js";
import { parseXml, xAttr, xKid, xKids, xTrim } from "../xml.js";
import { clampLimit, trimSlash, type SearchOptions, type SourceOptions } from "./common.js";

// arXiv API (Atom). https://info.arxiv.org/help/api/user-manual.html
// Terms: at most 1 request every 3 seconds, a single connection — the shared limiter enforces it process-wide.

export function parseArxivAtom(xml: string): PaperRecord[] {
  const doc = parseXml(xml);
  const feed = doc.feed?.[0];
  const out: PaperRecord[] = [];
  for (const e of xKids(feed, "entry")) {
    const idUrl = xTrim(xKid(e, "id")) ?? "";
    if (/\/api\/errors/.test(idUrl)) {
      throw new SourceError("arxiv", 400, `arXiv 查詢錯誤：${xTrim(xKid(e, "summary")) ?? ""}`);
    }
    const arxivId = normalizeArxivId(idUrl);
    const title = cleanText(xTrim(xKid(e, "title")));
    if (!arxivId || !title) continue;
    const date = parseDate(xTrim(xKid(e, "published")));
    const journalRef = xTrim(xKid(e, "arxiv:journal_ref"));
    const doi = xTrim(xKid(e, "arxiv:doi"));
    const links = xKids(e, "link");
    const pdf = links.find((l) => xAttr(l, "title") === "pdf" || xAttr(l, "type") === "application/pdf");
    const primary = xAttr(xKid(e, "arxiv:primary_category"), "term");
    const cats = xKids(e, "category").map((c) => xAttr(c, "term")).filter((c): c is string => !!c);
    out.push(
      finalizeRecord({
        type: "article",
        title,
        authors: xKids(e, "author").map((a) => parseName(xTrim(xKid(a, "name")) ?? "")).filter((a): a is PaperAuthor => !!a),
        year: date.year,
        month: date.month,
        day: date.day,
        doi,
        arxivId,
        url: `https://arxiv.org/abs/${arxivId}`,
        abstract: xTrim(xKid(e, "summary")),
        keywords: primary ? [primary, ...cats.filter((c) => c !== primary)] : cats,
        note: journalRef,
        oaPdfUrl: xAttr(pdf, "href")?.replace(/^http:/, "https:") ?? `https://arxiv.org/pdf/${arxivId}`,
      }),
    );
  }
  return out;
}

/** Turn free text into an arXiv search_query: every word must appear (all:), quotes kept as phrases. */
export function arxivQuery(q: string, opts: { yearFrom?: number; yearTo?: number; field?: "all" | "ti" } = {}): string {
  const field = opts.field ?? "all";
  const parts: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  for (let m = re.exec(q); m; m = re.exec(q)) {
    const term = (m[1] ?? m[2] ?? "").replace(/[():"\[\]]/g, " ").trim();
    if (!term) continue;
    parts.push(/\s/.test(term) || m[1] ? `${field}:"${term}"` : `${field}:${term}`);
  }
  let s = parts.join(" AND ");
  if (opts.yearFrom || opts.yearTo) {
    const from = `${opts.yearFrom ?? 1991}01010000`;
    const to = `${opts.yearTo ?? 2100}12312359`;
    s = `${s ? `(${s}) AND ` : ""}submittedDate:[${from} TO ${to}]`;
  }
  return s;
}

export class ArxivClient {
  readonly source = "arxiv" as const;
  private base: string;
  private limiter: RateLimiter;

  constructor(private opts: SourceOptions = {}) {
    this.base = trimSlash(opts.baseUrl ?? "https://export.arxiv.org/api");
    this.limiter = opts.limiter ?? sharedLimiter("arxiv");
  }

  private async query(params: Record<string, string>, signal?: AbortSignal): Promise<PaperRecord[]> {
    const u = new URL(`${this.base}/query`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    const { text } = await requestText(u.toString(), {
      source: "arxiv",
      limiter: this.limiter,
      headers: { "user-agent": userAgent(this.opts.contactEmail), accept: "application/atom+xml" },
      timeoutMs: this.opts.timeoutMs ?? 30_000,
      signal,
    });
    return text ? parseArxivAtom(text) : [];
  }

  async search(query: string, opts: SearchOptions = {}): Promise<PaperRecord[]> {
    const q = arxivQuery(query, opts);
    if (!q) return [];
    return this.query({ search_query: q, start: "0", max_results: String(clampLimit(opts.limit, 100)), sortBy: "relevance" }, opts.signal);
  }

  async getByIds(ids: string[], signal?: AbortSignal): Promise<PaperRecord[]> {
    const clean = ids.map(normalizeArxivId).filter((x): x is string => !!x);
    if (!clean.length) return [];
    return this.query({ id_list: clean.join(","), max_results: String(clean.length) }, signal);
  }

  async getById(id: string, signal?: AbortSignal): Promise<PaperRecord | null> {
    return (await this.getByIds([id], signal))[0] ?? null;
  }

  /** Find the arXiv version of a (closed) paper by exact-ish title. */
  async matchTitle(title: string, opts: { minScore?: number; signal?: AbortSignal } = {}): Promise<{ record: PaperRecord; score: number } | null> {
    const words = (cleanText(title) ?? "").replace(/["]/g, " ").trim();
    if (!words) return null;
    const hits = await this.query({ search_query: `ti:"${words}"`, start: "0", max_results: "5" }, opts.signal);
    let best: { record: PaperRecord; score: number } | null = null;
    for (const r of hits) {
      const score = titleSimilarity(title, r.title);
      if (!best || score > best.score) best = { record: r, score };
    }
    return best && best.score >= (opts.minScore ?? 0.9) ? best : null;
  }
}
