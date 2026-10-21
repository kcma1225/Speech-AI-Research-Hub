/** Job kinds of the library module (shared by the backend producer and the ai-worker handler). */
export const LIBRARY_IMPORT_JOB = "ai_library_import";

/** Fetch open-access PDFs for papers added by an import (`import_batches.job_id`). */
export type LibraryImportPayload = { batchId: string | null /* null: a single paper added by identifier (agent import_paper, POST /library/papers) */; paperIds: string[]; userId: string };

export type LibraryImportResult = { stored: number; notFound: number; failed: number; skipped: number; total: number };
