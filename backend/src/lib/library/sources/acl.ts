import { importBibtex } from "../bibtex.js";
import { requestText, sharedLimiter, userAgent, type RateLimiter } from "../http.js";
import { aclIdFromDoi, normalizeDoi } from "../normalize.js";
import type { PaperRecord } from "../types.js";
import { trimSlash, type SourceOptions } from "./common.js";

// ACL Anthology has no search API (only static files: anthology.bib.gz, metadata XML on GitHub).
// We resolve ids → BibTeX and derive PDF URLs; full-text search goes through OpenAlex/S2, which index the Anthology.

const ACL_ID_RE = /^(?:\d{4}\.[a-z0-9-]+\.\d+|[A-Z]\d{2}-\d{4})$/i;

/** ACL Anthology id from an id, an aclanthology.org URL, or an ACL DOI. */
export function parseAclId(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const s = input.trim();
  const fromUrl = /aclanthology\.org\/([^/?#]+?)(?:\.pdf|\.bib)?\/?(?:[?#].*)?$/i.exec(s)?.[1];
  if (fromUrl && ACL_ID_RE.test(fromUrl)) return fromUrl;
  const fromDoi = aclIdFromDoi(normalizeDoi(s));
  if (fromDoi) return fromDoi;
  return ACL_ID_RE.test(s) ? s : undefined;
}

export class AclAnthologyClient {
  readonly source = "acl" as const;
  readonly searchSupported = false;
  private base: string;
  private limiter: RateLimiter;

  constructor(private opts: SourceOptions = {}) {
    this.base = trimSlash(opts.baseUrl ?? "https://aclanthology.org");
    this.limiter = opts.limiter ?? sharedLimiter("acl");
  }

  pdfUrl(id: string): string {
    return `${this.base}/${id}.pdf`;
  }

  /** Metadata from the paper's .bib file. */
  async getById(id: string, signal?: AbortSignal): Promise<PaperRecord | null> {
    const aclId = parseAclId(id);
    if (!aclId) return null;
    const { text } = await requestText(`${this.base}/${aclId}.bib`, {
      source: "acl",
      limiter: this.limiter,
      headers: { "user-agent": userAgent(this.opts.contactEmail) },
      timeoutMs: this.opts.timeoutMs,
      signal,
    });
    if (!text || !text.includes("@")) return null;
    const r = importBibtex(text).records[0];
    if (!r) return null;
    return { ...r, ids: { ...r.ids, acl: aclId }, url: r.url ?? `${this.base}/${aclId}`, oaPdfUrl: this.pdfUrl(aclId) };
  }
}
