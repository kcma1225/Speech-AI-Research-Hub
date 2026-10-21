import type { Db } from "../../db.js";
import type { Storage } from "../storage.js";
import { SourceError } from "./http.js";
import { normalizeArxivId, normalizeDoi } from "./normalize.js";
import { storePaperPdf } from "./files.js";
import { parseAclId } from "./sources/acl.js";
import type { DownloadedPdf, DownloadPdfOptions } from "./pdf.js";
import type { LibraryService } from "./service.js";

/**
 * "Add a PDF by URL": turns what a user pastes (a PDF link, or a landing page such as arXiv abs, ACL Anthology,
 * OpenReview forum, a DOI) into the URL to download. Everything else is downloaded as-is; `downloadPdf` then follows a
 * landing page's `citation_pdf_url` once. docs/architecture.md "Library".
 */
export type PdfUrlPlan =
  | { kind: "direct" | "arxiv" | "acl" | "openreview"; url: string }
  | { kind: "doi"; doi: string };

export function planPdfUrl(input: string): PdfUrlPlan {
  const raw = input.trim();
  // Bare identifiers people paste instead of a link.
  if (/^arxiv:\s*\S+$/i.test(raw)) {
    const id = normalizeArxivId(raw);
    if (id) return { kind: "arxiv", url: `https://arxiv.org/pdf/${id}` };
  }
  if (/^(doi:\s*)?10\.\d{4,9}\//i.test(raw)) return doiPlan(normalizeDoi(raw)!);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SourceError("download", 0, "網址格式錯誤，請貼上 http:// 或 https:// 開頭的網址", "invalid_url");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new SourceError("download", 0, "只支援 http/https 網址", "invalid_url");
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "arxiv.org" || host === "export.arxiv.org") {
    const m = /^\/(?:abs|html|pdf)\/(.+?)(?:\.pdf)?\/?$/i.exec(u.pathname);
    const id = m ? normalizeArxivId(m[1]) : undefined;
    // Keep an explicit version (…v2) when the user gave one.
    const version = m?.[1] && /v\d+$/i.test(m[1]) ? /v\d+$/i.exec(m[1])![0] : "";
    if (id) return { kind: "arxiv", url: `https://arxiv.org/pdf/${id}${version && !id.endsWith(version) ? version : ""}` };
  }
  if (host === "aclanthology.org" && !/\.pdf$/i.test(u.pathname)) {
    const id = parseAclId(`https://aclanthology.org${u.pathname}`);
    if (id) return { kind: "acl", url: `https://aclanthology.org/${id}.pdf` };
  }
  if (host === "openreview.net" && /^\/(forum|pdf|attachment)\/?$/i.test(u.pathname)) {
    const id = u.searchParams.get("id");
    if (id && /^[\w-]{4,40}$/.test(id)) return { kind: "openreview", url: `https://openreview.net/pdf?id=${id}` };
  }
  if (host === "doi.org" || host === "dx.doi.org") {
    const doi = normalizeDoi(raw);
    if (doi) return doiPlan(doi);
  }
  return { kind: "direct", url: u.toString() };
}

function doiPlan(doi: string): PdfUrlPlan {
  const arxiv = /^10\.48550\/arxiv\.(.+)$/i.exec(doi)?.[1];
  const arxivId = arxiv ? normalizeArxivId(arxiv) : undefined;
  if (arxivId) return { kind: "arxiv", url: `https://arxiv.org/pdf/${arxivId}` };
  const acl = parseAclId(doi);
  if (acl) return { kind: "acl", url: `https://aclanthology.org/${acl}.pdf` };
  return { kind: "doi", doi };
}

/** File name for a downloaded PDF: the last path segment when it looks like a file, else `<host>.pdf`. */
export function fileNameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const id = u.searchParams.get("id");
    let last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "");
    if (!last && id) last = id;
    if (!last) last = u.hostname;
    last = last.replace(/[\\/:*?"<>|\r\n]+/g, " ").slice(0, 120);
    return /\.pdf$/i.test(last) ? last : `${last}.pdf`;
  } catch {
    return "download.pdf";
  }
}

export interface UrlPdfResult extends DownloadedPdf {
  plan: PdfUrlPlan;
  /** The URL actually requested first (after landing-page rewriting / DOI resolution). */
  requestedUrl: string;
  fileName: string;
}

/**
 * Resolves the pasted URL and downloads the PDF (SSRF-safe `downloadPdf`: every hop re-validated, content type,
 * `%PDF-` magic, size cap). DOIs go through the open-access lookup (arXiv / ACL / ISCA / Unpaywall / OpenAlex / S2).
 * Throws SourceError with `code` (`no_open_access` when a DOI has no free PDF).
 */
export async function downloadPdfFromUrl(
  service: LibraryService,
  input: string,
  opts: Pick<DownloadPdfOptions, "maxBytes" | "signal" | "timeoutMs"> = {},
): Promise<UrlPdfResult> {
  const plan = planPdfUrl(input);
  let url: string;
  if (plan.kind === "doi") {
    const oa = await service.findOpenAccessPdf({ type: "article-journal", title: "", authors: [], doi: plan.doi }, { titleMatch: false, signal: opts.signal });
    if (!oa) throw new SourceError("download", 404, "這個 DOI 找不到開放取用的 PDF，請改貼 PDF 的直接連結或上傳檔案", "no_open_access");
    url = oa.url;
  } else url = plan.url;
  const pdf = await service.downloadPdf(url, { ...opts, followLandingPage: true });
  return { ...pdf, plan, requestedUrl: url, fileName: fileNameFromUrl(pdf.finalUrl) };
}

/** Downloads and stores a PDF on an existing paper (`paper_files.source = 'url'`). */
export async function attachPdfFromUrl(
  db: Db,
  storage: Storage,
  service: LibraryService,
  input: { paperId: string; url: string; userId: string; maxBytes?: number; signal?: AbortSignal },
) {
  const pdf = await downloadPdfFromUrl(service, input.url, { maxBytes: input.maxBytes, signal: input.signal });
  const stored = await storePaperPdf(db, storage, {
    paperId: input.paperId, data: pdf.data, source: "url", sourceUrl: pdf.finalUrl, fileName: pdf.fileName, userId: input.userId,
  });
  return { ...stored, finalUrl: pdf.finalUrl, kind: pdf.plan.kind };
}
