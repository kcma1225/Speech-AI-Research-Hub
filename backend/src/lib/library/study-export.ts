/**
 * A study's reading list as a bibliography file. Used by the export route and by other modules
 * (the LaTeX runner builds `refs.bib` with `exportStudyBibtex`).
 */
import type { Queryable } from "../../db.js";
import { recordToBibtex, type BibtexExportOptions } from "./bibtex.js";
import { exportCslJson } from "./csl.js";
import { exportRis } from "./ris.js";
import { rowRecord, type PaperRow } from "./store.js";
import type { PaperRecord } from "./types.js";

export type StudyExportFormat = "bibtex" | "ris" | "csl-json";

export type StudyBibEntry = { paperId: string; citeKey: string; record: PaperRecord };

/** Papers of a study with their study cite keys, ordered by cite key (stable output for diffs). */
export async function studyBibEntries(db: Queryable, studyId: string, opts: { paperIds?: string[] } = {}): Promise<StudyBibEntry[]> {
  const r = await db.query<PaperRow & { cite_key: string }>(
    `SELECT p.record, p.bibtex, p.id, sp.cite_key FROM study_papers sp JOIN papers p ON p.id=sp.paper_id
      WHERE sp.study_id=$1 AND ($2::uuid[] IS NULL OR sp.paper_id = ANY($2::uuid[]))
      ORDER BY lower(sp.cite_key)`,
    [studyId, opts.paperIds ?? null],
  );
  return r.rows.map((row) => ({ paperId: row.id, citeKey: row.cite_key, record: rowRecord(row) }));
}

/**
 * `refs.bib` content for a study: every paper in its library under its study cite key (unique per study,
 * case-insensitive). CJK stays UTF-8 (use XeLaTeX/LuaLaTeX); an imported entry keeps its original BibTeX text
 * (re-keyed) unless `useOriginal: false`. Abstracts are left out by default. Returns "" for an empty library.
 *
 *   const { bibtex, keys } = await exportStudyBibtex(db, studyId);
 */
export async function exportStudyBibtex(
  db: Queryable,
  studyId: string,
  opts: Omit<BibtexExportOptions, "existingKeys"> & { paperIds?: string[] } = {},
): Promise<{ bibtex: string; keys: string[]; count: number }> {
  const entries = await studyBibEntries(db, studyId, { paperIds: opts.paperIds });
  const o: BibtexExportOptions = { useOriginal: true, ...opts };
  const bibtex = entries.length ? entries.map((e) => recordToBibtex(e.record, e.citeKey, o)).join("\n\n") + "\n" : "";
  return { bibtex, keys: entries.map((e) => e.citeKey), count: entries.length };
}

/** File body + MIME type + extension for the export route. */
export async function exportStudyLibrary(db: Queryable, studyId: string, format: StudyExportFormat, opts: { paperIds?: string[]; abstract?: boolean } = {}) {
  if (format === "bibtex") {
    const { bibtex, count } = await exportStudyBibtex(db, studyId, opts);
    return { body: bibtex, contentType: "application/x-bibtex; charset=utf-8", ext: "bib", count };
  }
  const entries = await studyBibEntries(db, studyId, opts);
  const records = entries.map((e) => e.record);
  const keys = entries.map((e) => e.citeKey);
  if (format === "ris") return { body: exportRis(records, keys), contentType: "application/x-research-info-systems; charset=utf-8", ext: "ris", count: entries.length };
  return { body: exportCslJson(records, keys), contentType: "application/vnd.citationstyles.csl+json; charset=utf-8", ext: "json", count: entries.length };
}
