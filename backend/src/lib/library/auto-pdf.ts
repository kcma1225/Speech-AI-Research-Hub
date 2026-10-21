/**
 * Open-access PDF right after a paper is added by identifier (agent `import_paper`, `fetch_paper_pdf`,
 * POST /library/papers): try to find + download it now within a short budget; when that runs out (slow mirrors,
 * rate limits) or the download fails, queue the `ai_library_import` job for the paper so it is retried in the
 * background. The outcome is reported truthfully (`has_pdf` only when a file is stored).
 */
import type { Db } from "../../db.js";
import { enqueueJob } from "../../jobs/queue.js";
import { LIBRARY_IMPORT_JOB, type LibraryImportPayload } from "../../ai-jobs/library/kinds.js";
import type { Storage } from "../storage.js";
import { fetchOpenAccessPdf, type FetchPdfOutcome } from "./files.js";
import { libraryService } from "./settings.js";
import { getPaper, type PaperRow } from "./store.js";
import type { LibraryService } from "./service.js";

export type AutoPdfStatus = "exists" | "stored" | "queued" | "not_found" | "failed";
export type AutoPdfOutcome = { status: AutoPdfStatus; source?: string; url?: string; bytes?: number; jobId?: string; message?: string };

export const AUTO_PDF_BUDGET_MS = 20_000;

/** Tests: replace the library service used here. */
let serviceOverride: LibraryService | null = null;
export const setAutoPdfService = (s: LibraryService | null) => {
  serviceOverride = s;
};

export async function autoFetchPdf(
  db: Db,
  storage: Storage,
  paper: PaperRow,
  userId: string,
  opts: { budgetMs?: number; signal?: AbortSignal; queueOnFailure?: boolean; force?: boolean } = {},
): Promise<AutoPdfOutcome> {
  if (paper.pdf_key && !opts.force) return { status: "exists" };
  const service = serviceOverride ?? (await libraryService(db)).service;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.budgetMs ?? AUTO_PDF_BUDGET_MS);
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener("abort", onAbort);
  let outcome: FetchPdfOutcome | { status: "timeout" };
  try {
    outcome = await fetchOpenAccessPdf(db, storage, service, paper, userId, { signal: ctrl.signal, force: opts.force }).catch((e: unknown) =>
      ctrl.signal.aborted ? ({ status: "timeout" } as const) : ({ status: "failed", message: e instanceof Error && /[一-鿿]/.test(e.message) ? e.message : "查詢開放全文失敗" } as const),
    );
    if (outcome.status === "failed" && ctrl.signal.aborted) outcome = { status: "timeout" };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
  if (outcome.status === "stored") return { status: "stored", source: outcome.source, url: outcome.url, bytes: outcome.bytes };
  if (outcome.status === "exists") return { status: "exists" };
  if (outcome.status === "not_found") return { status: "not_found" };
  if (opts.queueOnFailure === false || opts.signal?.aborted) return { status: "failed", ...(outcome.status === "failed" ? { message: outcome.message, url: outcome.url } : { message: "逾時" }) };
  // Another attempt in the background (ai-worker, needs internet; retries per paper).
  const fresh = await getPaper(db, paper.id);
  if (fresh?.pdf_key) return { status: "stored" };
  const jobId = await enqueueJob(db, LIBRARY_IMPORT_JOB, { batchId: null, paperIds: [paper.id], userId } satisfies LibraryImportPayload, userId);
  return { status: "queued", jobId, ...(outcome.status === "failed" ? { message: outcome.message, url: outcome.url } : {}) };
}

/** 繁中 sentence for the model / UI. */
export function autoPdfText(o: AutoPdfOutcome): string {
  switch (o.status) {
    case "exists":
      return "文獻庫已有這篇的 PDF。";
    case "stored":
      return `已自動下載開放取用的 PDF${o.source ? `（來源：${o.source}）` : ""}。`;
    case "queued":
      return "正在背景下載開放取用的 PDF（稍後可用 read_paper 讀全文；若一直沒有，請使用者上傳）。";
    case "not_found":
      return "找不到開放取用的全文 PDF，請使用者到文獻頁上傳 PDF。";
    default:
      return `下載 PDF 失敗${o.message ? `：${o.message}` : ""}。`;
  }
}
