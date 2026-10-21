/**
 * `ai_library_import` (ai-worker, needs internet): after an import is confirmed, finds and stores open-access PDFs
 * for the imported papers that have none. One paper failing never fails the job; resumes from a checkpoint.
 */
import { AiJobInputError, registerAiJob } from "../../ai-worker/registry.js";
import { fetchOpenAccessPdf } from "../../lib/library/files.js";
import { libraryService } from "../../lib/library/settings.js";
import { getPaper } from "../../lib/library/store.js";
import { LIBRARY_IMPORT_JOB, type LibraryImportPayload, type LibraryImportResult } from "./kinds.js";

registerAiJob<LibraryImportPayload>(LIBRARY_IMPORT_JOB, {
  roles: [],
  concurrency: 1,
  timeoutMs: 3 * 3600_000,
  async run({ job, db, storage, signal, progress, checkpoint, saveCheckpoint, log }) {
    const ids = job.payload?.paperIds;
    if (!Array.isArray(ids) || !ids.length) throw new AiJobInputError("沒有要下載全文的文獻。");
    const cp = (checkpoint ?? {}) as Partial<LibraryImportResult> & { next?: number };
    const out: LibraryImportResult = { stored: cp.stored ?? 0, notFound: cp.notFound ?? 0, failed: cp.failed ?? 0, skipped: cp.skipped ?? 0, total: ids.length };
    const { service } = await libraryService(db);
    for (let i = cp.next ?? 0; i < ids.length; i++) {
      if (signal.aborted) throw new Error("aborted");
      await progress("fetching_pdfs", (i / ids.length) * 100);
      const paper = await getPaper(db, ids[i]!);
      if (!paper || paper.pdf_key) out.skipped++;
      else {
        try {
          const r = await fetchOpenAccessPdf(db, storage, service, paper, job.payload.userId ?? job.createdBy, { signal });
          if (r.status === "stored") out.stored++;
          else if (r.status === "not_found") out.notFound++;
          else if (r.status === "exists") out.skipped++;
          else out.failed++;
        } catch (e) {
          if (signal.aborted) throw e;
          log.warn({ err: e, paperId: paper.id }, "library pdf fetch failed");
          out.failed++;
        }
      }
      await saveCheckpoint({ ...out, next: i + 1 });
    }
    await progress("done", 100);
    return out;
  },
});
