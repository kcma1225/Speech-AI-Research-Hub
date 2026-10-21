import { importBibtex } from "../bibtex.js";
import { requestText, sharedLimiter, userAgent, type RateLimiter } from "../http.js";
import { cleanText, decodeEntities, finalizeRecord, normalizeTitle, parseName, titleSimilarity } from "../normalize.js";
import type { PaperAuthor, PaperRecord } from "../types.js";
import { clampLimit, trimSlash, type SearchOptions, type SourceOptions } from "./common.js";

// ISCA Archive (Interspeech). No API: each year has an index page listing every paper
// (`/interspeech_YYYY/index.html`, ~1 MB), and each paper page carries BibTeX + DOI.
// All Interspeech PDFs are open: `/interspeech_YYYY/<key>.pdf`.

export interface IscaIndexEntry {
  /** "interspeech_2020/gulati20_interspeech" */
  id: string;
  year: number;
  title: string;
  authors: string[];
  pageUrl: string;
  pdfUrl: string;
}

const FIRST_YEAR = 2005; // earlier years are archived as eurospeech_/icslp_

/** Parse the anchors of a year's index page. */
export function parseIscaIndex(html: string, year: number, base = "https://www.isca-archive.org"): IscaIndexEntry[] {
  const out: IscaIndexEntry[] = [];
  const re = /<a class="w3-text" href="([a-z0-9]+_interspeech)\.html">\s*<p>([\s\S]*?)<br>\s*<span[^>]*>([\s\S]*?)<\/span>/gi;
  const seen = new Set<string>();
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const key = m[1]!;
    if (seen.has(key)) continue;
    seen.add(key);
    const title = cleanText(m[2]) ?? "";
    const authors = decodeEntities(m[3]!.replace(/<[^>]*>/g, " "))
      .split(",")
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const dir = `interspeech_${year}`;
    out.push({ id: `${dir}/${key}`, year, title, authors, pageUrl: `${base}/${dir}/${key}.html`, pdfUrl: `${base}/${dir}/${key}.pdf` });
  }
  return out;
}

export function iscaEntryToRecord(e: IscaIndexEntry): PaperRecord {
  return finalizeRecord({
    type: "paper-conference",
    title: e.title,
    authors: e.authors.map(parseName).filter((a): a is PaperAuthor => !!a),
    year: e.year,
    containerTitle: `Proc. Interspeech ${e.year}`,
    venue: "Interspeech",
    publisher: "ISCA",
    url: e.pageUrl,
    ids: { isca: e.id },
    oaPdfUrl: e.pdfUrl,
  });
}

export interface IscaOptions extends SourceOptions {
  /** Index cache lifetime, ms. Default 24 h. */
  cacheMs?: number;
  /** Max years one search may scan (each is one ~1 MB request). Default 3. */
  maxSearchYears?: number;
}

export class IscaArchiveClient {
  readonly source = "isca" as const;
  private base: string;
  private limiter: RateLimiter;
  private cache = new Map<number, { at: number; entries: IscaIndexEntry[] }>();

  constructor(private opts: IscaOptions = {}) {
    this.base = trimSlash(opts.baseUrl ?? "https://www.isca-archive.org");
    this.limiter = opts.limiter ?? sharedLimiter("isca");
  }

  /** PDF URL for an id such as "interspeech_2020/gulati20_interspeech". */
  pdfUrl(id: string): string {
    return `${this.base}/${id}.pdf`;
  }

  private fetchText(url: string, signal?: AbortSignal) {
    return requestText(url, {
      source: "isca",
      limiter: this.limiter,
      headers: { "user-agent": userAgent(this.opts.contactEmail) },
      timeoutMs: this.opts.timeoutMs ?? 30_000,
      signal,
    });
  }

  async listYear(year: number, signal?: AbortSignal): Promise<IscaIndexEntry[]> {
    if (year < FIRST_YEAR) return [];
    const hit = this.cache.get(year);
    if (hit && Date.now() - hit.at < (this.opts.cacheMs ?? 86_400_000)) return hit.entries;
    const { text } = await this.fetchText(`${this.base}/interspeech_${year}/index.html`, signal);
    const entries = text ? parseIscaIndex(text, year, this.base) : [];
    if (this.cache.size >= 12) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(year, { at: Date.now(), entries });
    return entries;
  }

  /** Best title match in a given year (±1 if `nearbyYears`). */
  async findByTitle(title: string, year: number, opts: { minScore?: number; nearbyYears?: boolean; signal?: AbortSignal } = {}): Promise<{ entry: IscaIndexEntry; score: number } | null> {
    const years = opts.nearbyYears ? [year, year + 1, year - 1] : [year];
    let best: { entry: IscaIndexEntry; score: number } | null = null;
    const want = normalizeTitle(title);
    for (const y of years) {
      for (const e of await this.listYear(y, opts.signal)) {
        const score = normalizeTitle(e.title) === want ? 1 : titleSimilarity(title, e.title);
        if (!best || score > best.score) best = { entry: e, score };
      }
      if (best && best.score >= 0.99) break;
    }
    return best && best.score >= (opts.minScore ?? 0.9) ? best : null;
  }

  /**
   * Title search within a year range (required: an index page per year). Matches titles containing every
   * query word, ranked by similarity. Without a year range, searches the latest `maxSearchYears` years.
   */
  async search(query: string, opts: SearchOptions = {}): Promise<PaperRecord[]> {
    const thisYear = new Date().getUTCFullYear();
    const max = this.opts.maxSearchYears ?? 3;
    const to = Math.min(opts.yearTo ?? thisYear, thisYear);
    const from = Math.max(opts.yearFrom ?? to - max + 1, to - max + 1, FIRST_YEAR);
    const words = normalizeTitle(query).split(" ").filter((w) => w.length > 1);
    if (!words.length) return [];
    const hits: { e: IscaIndexEntry; score: number }[] = [];
    for (let y = to; y >= from; y--) {
      for (const e of await this.listYear(y, opts.signal)) {
        const nt = normalizeTitle(e.title);
        const authors = normalizeTitle(e.authors.join(" "));
        if (words.every((w) => nt.includes(w) || authors.includes(w))) hits.push({ e, score: titleSimilarity(query, e.title) });
      }
    }
    hits.sort((a, b) => b.score - a.score || b.e.year - a.e.year);
    return hits.slice(0, clampLimit(opts.limit, 100)).map((h) => iscaEntryToRecord(h.e));
  }

  /** Full metadata from a paper page (BibTeX with DOI, pages; abstract). `id` = "interspeech_2020/gulati20_interspeech". */
  async getPaper(id: string, signal?: AbortSignal): Promise<PaperRecord | null> {
    const m = /(interspeech_\d{4})\/([a-z0-9]+_interspeech)/i.exec(id);
    if (!m) return null;
    const pageUrl = `${this.base}/${m[1]}/${m[2]}.html`;
    const { text } = await this.fetchText(pageUrl, signal);
    if (!text) return null;
    const bib = /<code[^>]*id="bibtex-code"[^>]*>([\s\S]*?)<\/code>/i.exec(text)?.[1];
    const parsed = bib ? importBibtex(decodeEntities(bib)).records[0] : undefined;
    const abstract = cleanText(/<div id="abstract">([\s\S]*?)<\/div>/i.exec(text)?.[1]);
    if (!parsed) return null;
    const year = parsed.year ?? Number(m[1]!.slice(-4));
    return finalizeRecord({
      ...parsed,
      containerTitle: `Proc. Interspeech ${year}`,
      venue: "Interspeech",
      publisher: parsed.publisher ?? "ISCA",
      abstract: parsed.abstract ?? abstract,
      url: pageUrl,
      ids: { ...parsed.ids, isca: `${m[1]}/${m[2]}` },
      oaPdfUrl: `${this.base}/${m[1]}/${m[2]}.pdf`,
      bibtex: undefined,
      citeKey: undefined,
    });
  }
}
