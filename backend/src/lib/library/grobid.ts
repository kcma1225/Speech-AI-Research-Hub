import { importBibtex } from "./bibtex.js";
import { request, sharedLimiter, type RateLimiter } from "./http.js";
import type { PaperRecord } from "./types.js";
import { trimSlash } from "./sources/common.js";

// Optional GROBID service (Apache-2.0, internal container). https://grobid.readthedocs.io/en/latest/Grobid-service/
// We ask for BibTeX (`Accept: application/x-bibtex`) so the result goes through our BibTeX importer.

export interface GrobidOptions {
  url: string;
  limiter?: RateLimiter;
  /** GROBID can be slow on big PDFs; default 120 s. */
  timeoutMs?: number;
}

export class GrobidClient {
  private base: string;
  private limiter: RateLimiter;

  constructor(private opts: GrobidOptions) {
    this.base = trimSlash(opts.url);
    this.limiter = opts.limiter ?? sharedLimiter("grobid");
  }

  private async post(path: string, pdf: Uint8Array, fields: Record<string, string>, signal?: AbortSignal): Promise<string | null> {
    const form = new FormData();
    form.set("input", new Blob([new Uint8Array(pdf)], { type: "application/pdf" }), "paper.pdf");
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    const res = await request(`${this.base}${path}`, {
      source: "grobid",
      method: "POST",
      body: form,
      limiter: this.limiter,
      headers: { accept: "application/x-bibtex" },
      timeoutMs: this.opts.timeoutMs ?? 120_000,
      retries: 1,
      okStatuses: [204],
      signal,
    });
    if (res.status === 204) return null; // GROBID: no result
    return res.text();
  }

  async isAlive(signal?: AbortSignal): Promise<boolean> {
    try {
      const res = await request(`${this.base}/api/isalive`, { source: "grobid", timeoutMs: 5000, retries: 0, signal });
      return (await res.text()).trim() === "true";
    } catch {
      return false;
    }
  }

  /** Header metadata (title, authors, venue, DOI, abstract) of a PDF. */
  async processHeader(pdf: Uint8Array, signal?: AbortSignal): Promise<PaperRecord | null> {
    const bib = await this.post("/api/processHeaderDocument", pdf, { consolidateHeader: "0" }, signal);
    const r = bib ? importBibtex(bib).records[0] : undefined;
    if (!r) return null;
    const { citeKey: _k, bibtex: _b, ...rest } = r;
    return rest;
  }

  /** The PDF's reference list as records. */
  async processReferences(pdf: Uint8Array, signal?: AbortSignal): Promise<PaperRecord[]> {
    const bib = await this.post("/api/processReferences", pdf, { consolidateCitations: "0" }, signal);
    return bib ? importBibtex(bib).records.map(({ citeKey: _k, bibtex: _b, ...rest }) => rest) : [];
  }
}
