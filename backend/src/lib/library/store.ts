/**
 * Database layer of the library module: `papers`, `paper_files`, `study_papers` (migration 0050).
 * Pure helpers (parsing, dedupe, keys) live next to this file; routes in routes/papers.ts and routes/library*.ts.
 */
import type { Queryable } from "../../db.js";
import { generateCiteKey, uniqueCiteKey, CITE_KEY_RE } from "./citekey.js";
import { compareRecords, mergeRecords, type MatchLevel } from "./dedupe.js";
import { formatApa, formatIeee } from "./format.js";
import { recordToBibtex } from "./bibtex.js";
import { authorDisplayName, doiKey, normalizeArxivId, normalizeTitle } from "./normalize.js";
import type { PaperAuthor, PaperRecord } from "./types.js";

/** S3 keys of the library (single bucket, see docs/architecture.md "Object keys"). */
export const libraryKeys = {
  paperFile: (paperId: string, fileId: string) => `library/papers/${paperId}/${fileId}.pdf`,
  paperPrefix: (paperId: string) => `library/papers/${paperId}/`,
  importUpload: (batchId: string) => `library/imports/${batchId}/upload.pdf`,
  importPrefix: (batchId: string) => `library/imports/${batchId}/`,
};

export type PaperRow = {
  id: string;
  record: PaperRecord;
  type: string;
  title: string;
  title_norm: string;
  authors_text: string;
  year: number | null;
  venue: string | null;
  doi: string | null;
  doi_key: string | null;
  arxiv_id: string | null;
  s2_id: string | null;
  openalex_id: string | null;
  abstract: string | null;
  bibtex: string | null;
  oa_url: string | null;
  oa_source: string | null;
  pdf_key: string | null;
  added_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

/** Record stored in `papers.record`: no per-study cite key, original BibTeX kept in its own column. */
export function storedRecord(r: PaperRecord): PaperRecord {
  const { citeKey: _k, bibtex: _b, ...rest } = r;
  return rest as PaperRecord;
}

/** Full record of a row (with the original BibTeX, so exports can re-use it). */
export const rowRecord = (row: Pick<PaperRow, "record" | "bibtex">): PaperRecord => ({ ...row.record, ...(row.bibtex ? { bibtex: row.bibtex } : {}) });

export const authorsText = (authors: PaperAuthor[]) => authors.map(authorDisplayName).filter(Boolean).join("; ").slice(0, 4000);

function derived(r: PaperRecord) {
  return {
    type: r.type,
    title: r.title.slice(0, 1000),
    title_norm: normalizeTitle(r.title) || r.title.toLowerCase(),
    authors_text: authorsText(r.authors),
    year: r.year && r.year >= 1000 && r.year <= 3000 ? r.year : null,
    venue: r.venue ?? null,
    doi: r.doi ?? null,
    doi_key: doiKey(r.doi) ?? null,
    arxiv_id: normalizeArxivId(r.arxivId) ?? null,
    s2_id: r.ids?.s2 ?? null,
    openalex_id: r.ids?.openalex ?? null,
    abstract: r.abstract ?? null,
  };
}

const PAPER_COLS = "p.id,p.record,p.type,p.title,p.title_norm,p.authors_text,p.year,p.venue,p.doi,p.doi_key,p.arxiv_id,p.s2_id,p.openalex_id,p.abstract,p.bibtex,p.oa_url,p.oa_source,p.pdf_key,p.added_by,p.updated_by,p.created_at,p.updated_at";

export async function getPaper(db: Queryable, id: string, forUpdate = false): Promise<PaperRow | null> {
  return (await db.query<PaperRow>(`SELECT ${PAPER_COLS} FROM papers p WHERE p.id=$1${forUpdate ? " FOR UPDATE" : ""}`, [id])).rows[0] ?? null;
}

export async function insertPaper(db: Queryable, record: PaperRecord, userId: string | null): Promise<PaperRow> {
  const d = derived(record);
  const r = await db.query<PaperRow>(
    `INSERT INTO papers AS p (record,type,title,title_norm,authors_text,year,venue,doi,doi_key,arxiv_id,s2_id,openalex_id,abstract,bibtex,oa_url,oa_source,added_by,updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17)
     RETURNING ${PAPER_COLS}`,
    [JSON.stringify(storedRecord(record)), d.type, d.title, d.title_norm, d.authors_text, d.year, d.venue, d.doi, d.doi_key, d.arxiv_id, d.s2_id, d.openalex_id, d.abstract,
      record.bibtex ?? null, record.oaPdfUrl ?? null, record.oaPdfUrl ? "import" : null, userId],
  );
  return r.rows[0]!;
}

/** Replaces the record (keeps the stored BibTeX unless `bibtex` is passed). */
export async function updatePaperRecord(db: Queryable, id: string, record: PaperRecord, userId: string | null, opts: { bibtex?: string | null } = {}): Promise<PaperRow> {
  const d = derived(record);
  const r = await db.query<PaperRow>(
    `UPDATE papers p SET record=$2,type=$3,title=$4,title_norm=$5,authors_text=$6,year=$7,venue=$8,doi=$9,doi_key=$10,arxiv_id=$11,s2_id=$12,
       openalex_id=$13,abstract=$14,bibtex=CASE WHEN $15::boolean THEN $16 ELSE p.bibtex END,
       oa_url=coalesce($18,p.oa_url),updated_by=$17,updated_at=now()
     WHERE p.id=$1 RETURNING ${PAPER_COLS}`,
    [id, JSON.stringify(storedRecord(record)), d.type, d.title, d.title_norm, d.authors_text, d.year, d.venue, d.doi, d.doi_key, d.arxiv_id, d.s2_id, d.openalex_id, d.abstract,
      opts.bibtex !== undefined, opts.bibtex ?? null, userId, record.oaPdfUrl ?? null],
  );
  return r.rows[0]!;
}

/**
 * Merges `incoming` into an existing paper (fills missing fields, unions ids). Identifier columns that another
 * row already owns are left alone, so a merge never violates the unique indexes.
 */
export async function mergeIntoPaper(db: Queryable, row: PaperRow, incoming: PaperRecord, userId: string | null): Promise<PaperRow> {
  let merged = mergeRecords(row.record, storedRecord(incoming));
  const clash = async (col: string, value: string | null | undefined) =>
    !!value && (await db.query(`SELECT 1 FROM papers WHERE ${col}=$1 AND id<>$2`, [value, row.id])).rowCount! > 0;
  if (await clash("doi_key", doiKey(merged.doi))) merged = { ...merged, doi: row.record.doi };
  if (await clash("arxiv_id", normalizeArxivId(merged.arxivId))) merged = { ...merged, arxivId: row.record.arxivId };
  if (await clash("s2_id", merged.ids?.s2)) merged = { ...merged, ids: { ...merged.ids, s2: row.record.ids?.s2 } };
  if (await clash("openalex_id", merged.ids?.openalex)) merged = { ...merged, ids: { ...merged.ids, openalex: row.record.ids?.openalex } };
  const bibtex = row.bibtex ? undefined : incoming.bibtex ?? undefined;
  return updatePaperRecord(db, row.id, merged, userId, bibtex !== undefined ? { bibtex } : {});
}

export type PaperMatch = { level: Exclude<MatchLevel, "none">; reason?: string; score: number; paper: PaperRow };

/**
 * Lab papers that may be the same work as `r`, best first: identifier matches (`same`), then title candidates
 * prefiltered with pg_trgm and confirmed with `compareRecords` (`likely` / `possible`).
 */
export async function findPaperMatches(db: Queryable, r: PaperRecord, limit = 5): Promise<PaperMatch[]> {
  const out: PaperMatch[] = [];
  const seen = new Set<string>();
  const doi = doiKey(r.doi);
  const arxiv = normalizeArxivId(r.arxivId);
  const ids = await db.query<PaperRow>(
    `SELECT ${PAPER_COLS} FROM papers p
      WHERE ($1::text IS NOT NULL AND p.doi_key=$1) OR ($2::text IS NOT NULL AND p.arxiv_id=$2)
         OR ($3::text IS NOT NULL AND p.s2_id=$3) OR ($4::text IS NOT NULL AND p.openalex_id=$4)
      LIMIT 10`,
    [doi ?? null, arxiv ?? null, r.ids?.s2 ?? null, r.ids?.openalex ?? null],
  );
  for (const row of ids.rows) {
    const m = compareRecords(rowRecord(row), r);
    out.push({ level: m.level === "none" ? "same" : m.level, reason: m.reason ?? "id", score: m.score, paper: row });
    seen.add(row.id);
  }
  const norm = normalizeTitle(r.title);
  if (norm) {
    const cands = await db.query<PaperRow>(
      `SELECT ${PAPER_COLS} FROM papers p
        WHERE p.title_norm=$1 OR p.title_norm % $1 OR left(p.title_norm, 16) = left($1, 16)
        ORDER BY similarity(p.title_norm, $1) DESC LIMIT 20`,
      [norm],
    );
    for (const row of cands.rows) {
      if (seen.has(row.id)) continue;
      const m = compareRecords(rowRecord(row), r);
      if (m.level === "none") continue;
      out.push({ level: m.level, reason: m.reason, score: m.score, paper: row });
      seen.add(row.id);
    }
  }
  const rank = { same: 0, likely: 1, possible: 2 } as const;
  return out.sort((a, b) => rank[a.level] - rank[b.level] || b.score - a.score).slice(0, limit);
}

// ---------------------------------------------------------------- study papers

export async function studyCiteKeys(db: Queryable, studyId: string): Promise<Set<string>> {
  const r = await db.query<{ k: string }>("SELECT lower(cite_key) AS k FROM study_papers WHERE study_id=$1", [studyId]);
  return new Set(r.rows.map((x) => x.k));
}

/** A cite key for `record` in a study: the preferred key when valid and free, otherwise a generated unique one. */
export function chooseCiteKey(record: PaperRecord, taken: Set<string>, preferred?: string | null): string {
  if (preferred && CITE_KEY_RE.test(preferred) && preferred.length <= 100 && !taken.has(preferred.toLowerCase())) return preferred;
  const base = (preferred && CITE_KEY_RE.test(preferred) ? preferred : generateCiteKey(record)).slice(0, 90);
  return uniqueCiteKey(base, (k) => taken.has(k.toLowerCase()));
}

/**
 * Adds a paper to a study (no-op when it is already there). Lock the study row first when adding many in one
 * transaction (`taken` is then shared). Returns whether a row was inserted and the key.
 */
export async function addPaperToStudy(
  db: Queryable,
  input: { studyId: string; paper: PaperRow; userId: string; citeKey?: string | null; tags?: string[]; taken?: Set<string> },
): Promise<{ inserted: boolean; citeKey: string }> {
  const existing = (await db.query<{ cite_key: string }>("SELECT cite_key FROM study_papers WHERE study_id=$1 AND paper_id=$2", [input.studyId, input.paper.id])).rows[0];
  if (existing) return { inserted: false, citeKey: existing.cite_key };
  const taken = input.taken ?? (await studyCiteKeys(db, input.studyId));
  const citeKey = chooseCiteKey(input.paper.record, taken, input.citeKey ?? null);
  await db.query(
    "INSERT INTO study_papers(study_id,paper_id,cite_key,tags,added_by) VALUES($1,$2,$3,$4,$5)",
    [input.studyId, input.paper.id, citeKey, input.tags ?? [], input.userId],
  );
  taken.add(citeKey.toLowerCase());
  return { inserted: true, citeKey };
}

// ---------------------------------------------------------------- responses

export type PaperSummary = {
  id: string;
  type: string;
  title: string;
  authors: PaperAuthor[];
  year: number | null;
  venue: string | null;
  container_title: string | null;
  doi: string | null;
  arxiv_id: string | null;
  url: string | null;
  has_pdf: boolean;
  oa_url: string | null;
  created_at: string;
  updated_at: string;
};

export const summarize = (row: PaperRow): PaperSummary => ({
  id: row.id,
  type: row.type,
  title: row.title,
  authors: row.record.authors ?? [],
  year: row.year,
  venue: row.venue,
  container_title: row.record.containerTitle ?? null,
  doi: row.doi,
  arxiv_id: row.arxiv_id,
  url: row.record.url ?? null,
  has_pdf: Boolean(row.pdf_key),
  oa_url: row.oa_url,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

export const citations = (r: PaperRecord, key = "key") => ({ apa: formatApa(r), ieee: formatIeee(r), bibtex: recordToBibtex(r, key) });

/** Escapes LIKE wildcards. */
export const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
