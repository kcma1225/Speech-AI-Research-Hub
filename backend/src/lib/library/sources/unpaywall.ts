import { requestJson, sharedLimiter, userAgent, type RateLimiter } from "../http.js";
import { normalizeDoi } from "../normalize.js";
import { trimSlash, type SourceOptions } from "./common.js";

// Unpaywall v2. https://unpaywall.org/products/api — email required, 100k calls/day.

export interface UnpaywallLocation {
  url?: string | null;
  url_for_pdf?: string | null;
  url_for_landing_page?: string | null;
  license?: string | null;
  host_type?: string | null;
  version?: string | null;
}

export interface UnpaywallResult {
  doi: string;
  is_oa?: boolean;
  oa_status?: string;
  best_oa_location?: UnpaywallLocation | null;
  oa_locations?: UnpaywallLocation[];
}

export class UnpaywallClient {
  readonly source = "unpaywall" as const;
  private base: string;
  private limiter: RateLimiter;

  constructor(private opts: SourceOptions = {}) {
    this.base = trimSlash(opts.baseUrl ?? "https://api.unpaywall.org/v2");
    this.limiter = opts.limiter ?? sharedLimiter("unpaywall");
  }

  /** Unpaywall needs a contact email; without one it is unavailable. */
  get available(): boolean {
    return !!this.opts.contactEmail;
  }

  async lookup(doi: string, signal?: AbortSignal): Promise<UnpaywallResult | null> {
    const d = normalizeDoi(doi);
    if (!d || !this.opts.contactEmail) return null;
    const u = new URL(`${this.base}/${encodeURIComponent(d)}`);
    u.searchParams.set("email", this.opts.contactEmail);
    const { data } = await requestJson<UnpaywallResult>(u.toString(), {
      source: "unpaywall",
      limiter: this.limiter,
      headers: { "user-agent": userAgent(this.opts.contactEmail) },
      timeoutMs: this.opts.timeoutMs,
      okStatuses: [404, 422],
      signal,
    });
    return data?.doi ? data : null;
  }

  /** Best open PDF URL for a DOI, if any. */
  async pdfUrl(doi: string, signal?: AbortSignal): Promise<{ url: string; license?: string; landingUrl?: string } | null> {
    const r = await this.lookup(doi, signal);
    if (!r?.is_oa) return null;
    const locs = [r.best_oa_location, ...(r.oa_locations ?? [])].filter((l): l is UnpaywallLocation => !!l);
    const loc = locs.find((l) => l.url_for_pdf);
    if (!loc?.url_for_pdf) return null;
    return { url: loc.url_for_pdf, ...(loc.license ? { license: loc.license } : {}), ...(loc.url_for_landing_page ? { landingUrl: loc.url_for_landing_page } : {}) };
  }
}
