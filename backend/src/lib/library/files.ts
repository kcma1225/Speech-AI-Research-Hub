import { createHash, randomUUID } from "node:crypto";
import type { Db, Queryable } from "../../db.js";
import type { Storage } from "../storage.js";
import { isPdf } from "./pdf.js";
import { libraryKeys, type PaperRow } from "./store.js";
import type { LibraryService } from "./service.js";
import type { PaperRecord } from "./types.js";

export type PaperFileSource = "upload" | "open_access" | "import" | "url";

/**
 * Stores a PDF for a paper: S3 `library/papers/<paperId>/<fileId>.pdf`, a `paper_files` row, and `papers.pdf_key`
 * (the newest file is the primary one). Uploads to S3 before the rows, so a failed insert leaves only an orphan
 * object that is removed here.
 */
export async function storePaperPdf(
  db: Queryable,
  storage: Storage,
  input: { paperId: string; data: Buffer; source: PaperFileSource; sourceUrl?: string | null; fileName?: string | null; userId: string | null },
): Promise<{ fileId: string; key: string; bytes: number }> {
  if (!isPdf(input.data)) throw Object.assign(new Error("not a pdf"), { notPdf: true });
  const sha256 = createHash("sha256").update(input.data).digest("hex");
  const dup = (await db.query<{ id: string; key: string; bytes: string }>("SELECT id,key,bytes FROM paper_files WHERE paper_id=$1 AND sha256=$2", [input.paperId, sha256])).rows[0];
  if (dup) {
    await db.query("UPDATE papers SET pdf_key=$2,updated_at=now() WHERE id=$1", [input.paperId, dup.key]);
    return { fileId: dup.id, key: dup.key, bytes: Number(dup.bytes) };
  }
  const fileId = randomUUID();
  const key = libraryKeys.paperFile(input.paperId, fileId);
  await storage.put(key, input.data, "application/pdf");
  try {
    await db.query(
      `INSERT INTO paper_files(id,paper_id,key,bytes,sha256,source,source_url,file_name,added_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [fileId, input.paperId, key, input.data.length, sha256, input.source, input.sourceUrl ?? null, input.fileName?.slice(0, 255) ?? null, input.userId],
    );
    await db.query("UPDATE papers SET pdf_key=$2,updated_at=now() WHERE id=$1", [input.paperId, key]);
  } catch (e) {
    await storage.delete(key).catch(() => {});
    throw e;
  }
  return { fileId, key, bytes: input.data.length };
}

export type FetchPdfOutcome =
  | { status: "stored"; source: string; url: string; bytes: number }
  | { status: "exists" }
  | { status: "not_found" }
  | { status: "failed"; message: string; url?: string };

/**
 * Finds an open-access PDF for a paper and stores it. Records the location found (`papers.oa_url`) even when the
 * download fails, and an arXiv id discovered by title match.
 */
export async function fetchOpenAccessPdf(
  db: Db,
  storage: Storage,
  service: LibraryService,
  paper: PaperRow,
  userId: string | null,
  opts: { signal?: AbortSignal; force?: boolean } = {},
): Promise<FetchPdfOutcome> {
  if (paper.pdf_key && !opts.force) return { status: "exists" };
  const record: PaperRecord = paper.record;
  const oa = await service.findOpenAccessPdf(record, { signal: opts.signal });
  if (!oa) return { status: "not_found" };
  await db.query("UPDATE papers SET oa_url=$2,oa_source=$3 WHERE id=$1", [paper.id, oa.url, oa.source]);
  if (oa.arxivId && !paper.arxiv_id) {
    await db
      .query(
        `UPDATE papers SET arxiv_id=$2, record=jsonb_set(record,'{arxivId}',to_jsonb($2::text)) WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM papers WHERE arxiv_id=$2)`,
        [paper.id, oa.arxivId],
      )
      .catch(() => {});
  }
  try {
    const pdf = await service.downloadPdf(oa.url, { signal: opts.signal });
    const stored = await storePaperPdf(db, storage, { paperId: paper.id, data: pdf.data, source: "open_access", sourceUrl: pdf.finalUrl, userId });
    return { status: "stored", source: oa.source, url: oa.url, bytes: stored.bytes };
  } catch (e) {
    return { status: "failed", url: oa.url, message: e instanceof Error && /[一-鿿]/.test(e.message) ? e.message : "下載 PDF 失敗" };
  }
}
