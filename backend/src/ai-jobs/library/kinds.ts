/** Job kinds of the library module (shared by the backend producer and the ai-worker handler). */
export const LIBRARY_IMPORT_JOB = "ai_library_import";

/**
 * Fetch open-access PDFs for papers added by an import (`import_batches.job_id`), and look up the published version of
 * preprint-only papers (lib/library/published.ts). `metadataOnly`: only the published-version lookup (the migration
 * 0126 backfill of the papers imported from arXiv before the lookup existed).
 */
export type LibraryImportPayload = { batchId: string | null /* null: a single paper added by identifier (agent import_paper, POST /library/papers) */; paperIds: string[]; userId: string | null; metadataOnly?: boolean };

export type LibraryImportResult = { stored: number; notFound: number; failed: number; skipped: number; total: number; published?: number };
