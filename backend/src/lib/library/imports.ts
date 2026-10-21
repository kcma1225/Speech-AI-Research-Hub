/**
 * Two-step imports into a study: `createImportPreview` parses nothing itself (callers pass records from a file,
 * Zotero or a PDF), matches every record against the lab library and the study, and stores an `import_batches`
 * row with status `preview`. `confirmImport` applies the user's per-record decisions in one transaction.
 */
import type pg from "pg";
import type { Queryable } from "../../db.js";
import { compareRecords } from "./dedupe.js";
import { finalizeRecord } from "./normalize.js";
import {
  addPaperToStudy, chooseCiteKey, findPaperMatches, getPaper, insertPaper, mergeIntoPaper, studyCiteKeys, summarize,
  type PaperRow, type PaperSummary,
} from "./store.js";
import type { ImportWarning, PaperRecord } from "./types.js";

export const MAX_IMPORT_RECORDS = 2000;

export type ImportAction = "add" | "link" | "skip";

export type ImportItem = {
  index: number;
  record: PaperRecord;
  /** Key the paper would get in the study (pinned source key when free, else generated). */
  citeKey: string;
  /** Best lab-library match. */
  match: { level: "same" | "likely" | "possible"; reason?: string; score: number; paper: PaperSummary } | null;
  /** The matched paper is already in this study. */
  inStudy: boolean;
  /** Another record earlier in the same file is the same work. */
  duplicateOf: number | null;
  /** Suggested default action. */
  action: ImportAction;
};

export type ImportBatch = {
  id: string;
  study_id: string | null;
  user_id: string;
  source: "file" | "zotero" | "pdf";
  format: string;
  file_name: string | null;
  status: "preview" | "done" | "cancelled";
  items: ImportItem[];
  warnings: ImportWarning[];
  file_key: string | null;
  counts: { added?: number; linked?: number; skipped?: number; total?: number };
  job_id: string | null;
  created_at: string;
  confirmed_at: string | null;
};

const BATCH_COLS = "id,study_id,user_id,source,format,file_name,status,items,warnings,file_key,counts,job_id,created_at,confirmed_at";

export async function getImportBatch(db: Queryable, id: string, forUpdate = false): Promise<ImportBatch | null> {
  return (await db.query<ImportBatch>(`SELECT ${BATCH_COLS} FROM import_batches WHERE id=$1${forUpdate ? " FOR UPDATE" : ""}`, [id])).rows[0] ?? null;
}

/** Counts by suggested action/match level for the preview header. */
export function previewSummary(items: ImportItem[]) {
  return {
    total: items.length,
    new: items.filter((i) => !i.match && i.duplicateOf === null).length,
    same: items.filter((i) => i.match?.level === "same").length,
    likely: items.filter((i) => i.match?.level === "likely").length,
    possible: items.filter((i) => i.match?.level === "possible").length,
    inStudy: items.filter((i) => i.inStudy).length,
    inFile: items.filter((i) => i.duplicateOf !== null).length,
  };
}

export async function buildImportItems(db: Queryable, studyId: string | null, records: PaperRecord[]): Promise<ImportItem[]> {
  const taken = studyId ? await studyCiteKeys(db, studyId) : new Set<string>();
  const inStudyIds = studyId
    ? new Set((await db.query<{ paper_id: string }>("SELECT paper_id FROM study_papers WHERE study_id=$1", [studyId])).rows.map((r) => r.paper_id))
    : new Set<string>();
  const items: ImportItem[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = finalizeRecord(records[index]!);
    const best = (await findPaperMatches(db, record, 1))[0] ?? null;
    let duplicateOf: number | null = null;
    for (const prev of items) {
      const lvl = compareRecords(prev.record, record).level;
      if (lvl === "same" || lvl === "likely") {
        duplicateOf = prev.index;
        break;
      }
    }
    const inStudy = Boolean(best && best.level !== "possible" && inStudyIds.has(best.paper.id));
    const citeKey = inStudy ? "" : chooseCiteKey(record, taken, record.citeKey ?? null);
    if (citeKey) taken.add(citeKey.toLowerCase());
    const action: ImportAction =
      duplicateOf !== null || inStudy ? "skip" : best && (best.level === "same" || best.level === "likely") ? "link" : "add";
    items.push({
      index,
      record,
      citeKey,
      match: best ? { level: best.level, reason: best.reason, score: Math.round(best.score * 1000) / 1000, paper: summarize(best.paper) } : null,
      inStudy,
      duplicateOf,
      action,
    });
  }
  return items;
}

export async function createImportPreview(
  db: Queryable,
  input: {
    studyId: string | null;
    userId: string;
    source: ImportBatch["source"];
    format: string;
    fileName?: string | null;
    records: PaperRecord[];
    warnings: ImportWarning[];
    fileKey?: string | null;
    id?: string;
  },
): Promise<ImportBatch> {
  // Old previews are disposable.
  await db.query("DELETE FROM import_batches WHERE status='preview' AND created_at < now() - interval '1 day' AND file_key IS NULL");
  const warnings = [...input.warnings];
  let records = input.records;
  if (records.length > MAX_IMPORT_RECORDS) {
    warnings.push({ index: -1, message: `一次最多匯入 ${MAX_IMPORT_RECORDS} 筆，其餘 ${records.length - MAX_IMPORT_RECORDS} 筆已略過` });
    records = records.slice(0, MAX_IMPORT_RECORDS);
  }
  const items = await buildImportItems(db, input.studyId, records);
  const r = await db.query<ImportBatch>(
    `INSERT INTO import_batches(id,study_id,user_id,source,format,file_name,items,warnings,file_key,counts)
     VALUES(coalesce($1::uuid, gen_random_uuid()),$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${BATCH_COLS}`,
    [input.id ?? null, input.studyId, input.userId, input.source, input.format, input.fileName?.slice(0, 255) ?? null, JSON.stringify(items),
      JSON.stringify(warnings.slice(0, 500)), input.fileKey ?? null, JSON.stringify({ total: items.length })],
  );
  return r.rows[0]!;
}

export type ImportDecision = { index: number; action: ImportAction; paperId?: string; citeKey?: string; record?: PaperRecord };

export type ConfirmResult = {
  added: number;
  linked: number;
  skipped: number;
  /** Papers now in the study because of this import (new or linked), with their keys. */
  papers: { index: number; paperId: string; citeKey: string; created: boolean }[];
  /** Every lab paper an item resolved to (including ones already in the study). */
  resolved: { index: number; paperId: string }[];
};

/**
 * Applies decisions (items without a decision use their suggested action). `link` merges the record into the
 * matched (or given) paper and adds it to the study; `add` creates a new lab paper, falling back to linking when an
 * identifier turns out to exist. Must run in a transaction (`client`); locks the batch and the study.
 */
export async function confirmImport(
  client: pg.PoolClient,
  batch: ImportBatch,
  decisions: ImportDecision[],
  userId: string,
  targetStudyId: string | null,
): Promise<ConfirmResult> {
  if (targetStudyId) await client.query("SELECT id FROM studies WHERE id=$1 FOR UPDATE", [targetStudyId]);
  const taken = targetStudyId ? await studyCiteKeys(client, targetStudyId) : new Set<string>();
  const byIndex = new Map(decisions.map((d) => [d.index, d]));
  const out: ConfirmResult = { added: 0, linked: 0, skipped: 0, papers: [], resolved: [] };
  for (const item of batch.items) {
    const d = byIndex.get(item.index);
    const action = d?.action ?? item.action;
    const record = d?.record ? finalizeRecord(d.record) : item.record;
    const wantKey = d?.citeKey ?? (item.citeKey || record.citeKey || null);
    if (action === "skip") {
      out.skipped++;
      continue;
    }
    let paper: PaperRow | null = null;
    let created = false;
    if (action === "link") {
      const id = d?.paperId ?? item.match?.paper.id;
      paper = id ? await getPaper(client, id, true) : null;
      if (paper) paper = await mergeIntoPaper(client, paper, record, userId);
    }
    if (!paper) {
      // Re-check identifiers right before inserting (another import may have added the work meanwhile).
      const same = (await findPaperMatches(client, record, 1)).find((m) => m.level === "same");
      if (same) paper = await mergeIntoPaper(client, same.paper, record, userId);
      else {
        await client.query("SAVEPOINT lib_add");
        try {
          paper = await insertPaper(client, record, userId);
          created = true;
          await client.query("RELEASE SAVEPOINT lib_add");
        } catch (e) {
          await client.query("ROLLBACK TO SAVEPOINT lib_add");
          if ((e as { code?: string }).code !== "23505") throw e;
          const again = (await findPaperMatches(client, record, 1)).find((m) => m.level === "same");
          if (!again) throw e;
          paper = await mergeIntoPaper(client, again.paper, record, userId);
        }
      }
    }
    out.resolved.push({ index: item.index, paperId: paper.id });
    if (!targetStudyId) {
      if (created) out.added++;
      else out.linked++;
      out.papers.push({ index: item.index, paperId: paper.id, citeKey: "", created });
      continue;
    }
    const res = await addPaperToStudy(client, { studyId: targetStudyId, paper, userId, citeKey: wantKey, taken, tags: [] });
    if (!res.inserted) {
      out.skipped++;
      continue;
    }
    if (created) out.added++;
    else out.linked++;
    out.papers.push({ index: item.index, paperId: paper.id, citeKey: res.citeKey, created });
  }
  return out;
}
