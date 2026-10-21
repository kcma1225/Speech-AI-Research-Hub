import type { Queryable } from "../../db.js";
import type { CurrentUser } from "../auth.js";
import { citations, rowRecord, summarize, type PaperRow, type PaperSummary } from "./store.js";
import type { PaperRecord } from "./types.js";

export type PaperStudyRef = { id: string; slug: string; title: string; cite_key: string; reading_status: string; can_edit: boolean };

export type PaperDetail = PaperSummary & {
  record: PaperRecord;
  abstract: string | null;
  bibtex_original: string | null;
  oa_source: string | null;
  added_by: { id: string; name: string } | null;
  files: { id: string; bytes: number; source: string; file_name: string | null; created_at: string; added_by: string | null }[];
  studies: PaperStudyRef[];
  citations: { apa: string; ieee: string; bibtex: string };
  permissions: { edit: boolean; delete: boolean };
};

/**
 * Who may change a lab paper's metadata or PDF: admins, the user who added it, and editors (owner/member) of any
 * study whose library contains it. Deleting additionally requires that no study uses it (admins excepted).
 */
export async function paperPermissions(db: Queryable, paper: Pick<PaperRow, "id" | "added_by">, user: CurrentUser) {
  const r = (await db.query<{ editor: boolean; used: number }>(
    `SELECT EXISTS (SELECT 1 FROM study_papers sp JOIN study_members m ON m.study_id=sp.study_id
                     WHERE sp.paper_id=$1 AND m.user_id=$2 AND m.role IN ('owner','member')) AS editor,
            (SELECT count(*)::int FROM study_papers WHERE paper_id=$1) AS used`,
    [paper.id, user.id],
  )).rows[0]!;
  const edit = user.is_admin || paper.added_by === user.id || r.editor;
  return { edit, delete: user.is_admin || (paper.added_by === user.id && r.used === 0), used: r.used };
}

export async function paperDetail(db: Queryable, row: PaperRow, user: CurrentUser): Promise<PaperDetail> {
  const [files, studies, adder, perms] = await Promise.all([
    db.query<PaperDetail["files"][number]>(
      "SELECT id,bytes::float8 AS bytes,source,file_name,created_at,added_by FROM paper_files WHERE paper_id=$1 ORDER BY created_at DESC",
      [row.id],
    ),
    db.query<PaperStudyRef>(
      `SELECT s.id,s.slug,s.title,sp.cite_key,sp.reading_status,
              EXISTS (SELECT 1 FROM study_members m WHERE m.study_id=s.id AND m.user_id=$2 AND m.role IN ('owner','member')) AS can_edit
         FROM study_papers sp JOIN studies s ON s.id=sp.study_id WHERE sp.paper_id=$1 ORDER BY s.title`,
      [row.id, user.id],
    ),
    row.added_by ? db.query<{ id: string; name: string }>("SELECT id,name FROM users WHERE id=$1", [row.added_by]) : Promise.resolve({ rows: [] as { id: string; name: string }[] }),
    paperPermissions(db, row, user),
  ]);
  const record = rowRecord(row);
  const key = studies.rows[0]?.cite_key ?? "key";
  return {
    ...summarize(row),
    record: row.record,
    abstract: row.abstract,
    bibtex_original: row.bibtex,
    oa_source: row.oa_source,
    added_by: adder.rows[0] ?? null,
    files: files.rows,
    studies: studies.rows,
    citations: citations({ ...record, bibtex: undefined }, key),
    permissions: { edit: perms.edit, delete: perms.delete },
  };
}
