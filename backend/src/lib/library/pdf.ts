import { assertPublicUrl, sharedLimiter, SourceError, userAgent, type RateLimiter } from "./http.js";
import { normalizeArxivId, normalizeDoi } from "./normalize.js";

// ---------------------------------------------------------------- download

export interface DownloadPdfOptions {
  /** Default 50 MB. */
  maxBytes?: number;
  /** Whole download, default 60 s. */
  timeoutMs?: number;
  /** Allow private/loopback hosts (tests only). */
  allowPrivate?: boolean;
  limiter?: RateLimiter;
  contactEmail?: string;
  signal?: AbortSignal;
}

export interface DownloadedPdf {
  data: Buffer;
  finalUrl: string;
  contentType: string;
}

const PDF_TYPES = /^(application\/(pdf|x-pdf|octet-stream|force-download|download)|binary\/octet-stream)\b/i;

/**
 * Download a PDF with SSRF checks on every redirect hop, a size cap, a content-type check and the `%PDF-` magic.
 * Throws SourceError (source "download") with a 繁中 message.
 */
export async function downloadPdf(url: string, opts: DownloadPdfOptions = {}): Promise<DownloadedPdf> {
  const maxBytes = opts.maxBytes ?? 50 * 1024 * 1024;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60_000);
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener("abort", onAbort);
  const limiter = opts.limiter ?? sharedLimiter("download");
  try {
    let current = url;
    for (let hop = 0; hop <= 5; hop++) {
      const u = opts.allowPrivate ? new URL(current) : await assertPublicUrl(current);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new SourceError("download", 0, "只支援 http/https 網址");
      const res = await limiter
        .schedule(() =>
          fetch(u, {
            redirect: "manual",
            signal: ctrl.signal,
            headers: { "user-agent": userAgent(opts.contactEmail), accept: "application/pdf,*/*;q=0.5" },
          }),
        )
        .catch((e: Error) => {
          throw new SourceError("download", 0, e.name === "AbortError" ? "下載 PDF 逾時" : "無法下載 PDF");
        });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        await res.body?.cancel().catch(() => {});
        current = new URL(res.headers.get("location")!, u).toString();
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new SourceError("download", res.status, `下載 PDF 失敗（HTTP ${res.status}）`);
      }
      const ct = (res.headers.get("content-type") ?? "").trim();
      if (ct && !PDF_TYPES.test(ct)) {
        await res.body?.cancel().catch(() => {});
        throw new SourceError("download", 415, "連結不是 PDF（可能需要登入或付費）");
      }
      const len = Number(res.headers.get("content-length"));
      if (Number.isFinite(len) && len > maxBytes) {
        await res.body?.cancel().catch(() => {});
        throw new SourceError("download", 413, `PDF 太大（上限 ${Math.round(maxBytes / 1024 / 1024)} MB）`);
      }
      const chunks: Buffer[] = [];
      let size = 0;
      const reader = res.body?.getReader();
      if (!reader) throw new SourceError("download", 0, "PDF 內容是空的");
      for (;;) {
        const { done, value } = await reader.read().catch((e: Error) => {
          throw new SourceError("download", 0, e.name === "AbortError" ? "下載 PDF 逾時" : "下載 PDF 中斷");
        });
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new SourceError("download", 413, `PDF 太大（上限 ${Math.round(maxBytes / 1024 / 1024)} MB）`);
        }
        chunks.push(Buffer.from(value));
      }
      const data = Buffer.concat(chunks);
      if (!isPdf(data)) throw new SourceError("download", 415, "下載的檔案不是 PDF");
      return { data, finalUrl: u.toString(), contentType: ct || "application/pdf" };
    }
    throw new SourceError("download", 0, "轉址次數過多");
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/** `%PDF-` within the first 1 KB (some servers prepend junk; PDF readers accept that). */
export function isPdf(data: Uint8Array): boolean {
  const head = Buffer.from(data.subarray(0, 1024)).toString("latin1");
  return head.includes("%PDF-");
}

// ---------------------------------------------------------------- text + metadata

export interface PdfTextResult {
  numPages: number;
  /** Text of the pages read (first `maxPages`, plus the last page when `lastPage`). */
  pages: string[];
  /** Info dictionary (Title, Author, Subject, Keywords, …). */
  info: Record<string, unknown>;
  /** Raw XMP metadata, if present. */
  xmp?: string;
  /** Largest-font line(s) on page 1: a title guess. */
  titleGuess?: string;
}

interface PdfTextItem {
  str: string;
  transform: number[];
  height?: number;
  hasEOL?: boolean;
}

/** Extract text from the first pages with pdf.js (legacy Node build; no worker, no eval, no fonts). */
export async function extractPdfText(data: Uint8Array, opts: { maxPages?: number; lastPage?: boolean } = {}): Promise<PdfTextResult> {
  if (!isPdf(data)) throw new SourceError("pdf", 415, "檔案不是 PDF");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: new Uint8Array(data), // pdf.js detaches the buffer it gets
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
    stopAtErrors: false,
  });
  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    const name = (e as Error).name;
    throw new SourceError("pdf", 422, name === "PasswordException" ? "PDF 有密碼保護，無法讀取" : "PDF 損毀或無法解析");
  }
  try {
    const n = doc.numPages;
    const wanted = new Set<number>();
    for (let i = 1; i <= Math.min(n, opts.maxPages ?? 2); i++) wanted.add(i);
    if (opts.lastPage !== false && n > 0) wanted.add(n);
    const pages: string[] = [];
    let titleGuess: string | undefined;
    for (const p of [...wanted].sort((a, b) => a - b)) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const items: PdfTextItem[] = content.items.flatMap((it) => ("str" in it && typeof it.str === "string" ? [it as PdfTextItem] : []));
      pages.push(items.map((it) => it.str + (it.hasEOL ? "\n" : " ")).join("").replace(/[ \t]+/g, " "));
      if (p === 1) titleGuess = guessTitle(items);
      page.cleanup();
    }
    const meta = await doc.getMetadata().catch(() => null);
    const xmp = meta?.metadata ? safeXmp(meta.metadata) : undefined;
    return { numPages: n, pages, info: (meta?.info as Record<string, unknown>) ?? {}, ...(xmp ? { xmp } : {}), ...(titleGuess ? { titleGuess } : {}) };
  } finally {
    await task.destroy().catch(() => {});
  }
}

function safeXmp(m: unknown): string | undefined {
  try {
    const all = (m as { getAll?: () => Record<string, unknown> }).getAll?.();
    return all ? JSON.stringify(all) : undefined;
  } catch {
    return undefined;
  }
}

function guessTitle(items: PdfTextItem[]): string | undefined {
  const sized = items
    .filter((it) => it.str.trim())
    .map((it) => ({ s: it.str, size: Math.abs(it.height || it.transform[3] || 0), y: it.transform[5] ?? 0 }));
  if (!sized.length) return undefined;
  // Ignore arXiv side stamps and tiny running headers: pick the largest size used by text with ≥ 3 letters.
  const candidates = sized.filter((x) => /\p{L}{3}/u.test(x.s) && !/^arXiv:/i.test(x.s.trim()));
  const max = Math.max(...candidates.map((x) => x.size));
  if (!Number.isFinite(max) || max <= 0) return undefined;
  const title = candidates
    .filter((x) => Math.abs(x.size - max) < 0.5)
    .map((x) => x.s)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return title.length >= 8 && title.length <= 300 ? title : undefined;
}

export interface PdfIdentifiers {
  doi?: string;
  arxivId?: string;
}

const DOI_IN_TEXT = /\b(10\.\d{4,9}\/[-._;()/:A-Z0-9]+)/gi;
const ARXIV_STAMP = /arXiv:\s*(\d{4}\.\d{4,5})(v\d+)?/i;

/** DOI / arXiv id from PDF metadata and text (first pages first, then the rest). */
export function extractIdentifiers(input: { pages: string[]; info?: Record<string, unknown>; xmp?: string }): PdfIdentifiers {
  const out: PdfIdentifiers = {};
  const metaText = [input.xmp ?? "", ...Object.values(input.info ?? {}).map((v) => (typeof v === "string" ? v : ""))].join(" ");
  const metaDoi = /(?:doi[:/\s]+|doi\.org\/)(10\.\d{4,9}\/[^\s"<>]+)/i.exec(metaText)?.[1];
  if (metaDoi) out.doi = normalizeDoi(metaDoi);
  const text = input.pages.join("\n").replace(/-\n(?=\S)/g, "-");
  if (!out.doi) {
    for (const m of text.matchAll(DOI_IN_TEXT)) {
      const d = normalizeDoi(m[1]);
      // An arXiv DOI identifies the preprint; keep looking for a publisher DOI but remember the arXiv id.
      if (d && /^10\.48550\/arxiv\./i.test(d)) {
        out.arxivId ??= normalizeArxivId(d);
        continue;
      }
      if (d) {
        out.doi = d;
        break;
      }
    }
  }
  const stamp = ARXIV_STAMP.exec(metaText) ?? ARXIV_STAMP.exec(input.pages[0] ?? "") ?? ARXIV_STAMP.exec(text);
  if (stamp) out.arxivId ??= normalizeArxivId(stamp[1]);
  return out;
}
