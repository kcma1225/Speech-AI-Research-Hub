/**
 * Where a library paper was actually published. A paper imported from arXiv used to stay 「arXiv」 forever (production
 * 61666f10: an Interspeech 2024 paper was 「arXiv, 2024」 in the library, a deck said it was not a conference paper, and
 * the assistant had no way to correct it). `refreshPublished` looks up the published version (service
 * `findPublishedVersion`: only the paper's own stored identifiers / title leave the hub) and merges it into the row.
 */
import type { Db } from "../../db.js";
import { transaction } from "../../db.js";
import { arxivIdFromDoi } from "./normalize.js";
import { isPublishedRecord, type LibraryService } from "./service.js";
import { getPaper, mergeIntoPaper, rowRecord, type PaperRow } from "./store.js";

/** A paper whose library record only knows a preprint (venue arXiv / none, no publisher DOI) but has an identifier to look up. */
export function preprintOnly(p: Pick<PaperRow, "venue" | "doi" | "arxiv_id">): boolean {
  if (p.doi && !arxivIdFromDoi(p.doi) && !/^10\.48550\//i.test(p.doi) && !/arxiv/i.test(p.venue ?? "")) return false;
  return (!p.venue || /arxiv|preprint|corr\b/i.test(p.venue)) && !!(p.arxiv_id || p.doi);
}

/** 「Interspeech 2024」, 「arXiv 2024」 (a preprint), 「2024」, or "" — how a deck cover / an answer names where a paper appeared. */
export function venueLabel(p: Pick<PaperRow, "venue" | "year">): string {
  return [p.venue?.trim(), p.year ? String(p.year) : ""].filter(Boolean).join(" ");
}

export type RefreshOutcome = { status: "updated" | "unchanged" | "published" | "not_found"; paper: PaperRow; before: { venue: string | null; year: number | null; doi: string | null } };

/**
 * Looks up the published version of a preprint-only paper and merges it in (venue, container, year, DOI, pages…;
 * fields already known are kept). `published`: the row already names a published venue (nothing to do).
 */
export async function refreshPublished(db: Db, service: LibraryService, paper: PaperRow, userId: string | null, opts: { signal?: AbortSignal } = {}): Promise<RefreshOutcome> {
  const before = { venue: paper.venue, year: paper.year, doi: paper.doi };
  if (!preprintOnly(paper) || isPublishedRecord(paper.record)) return { status: "published", paper, before };
  const pub = await service.findPublishedVersion(rowRecord(paper), { signal: opts.signal });
  if (!pub) return { status: "not_found", paper, before };
  const updated = await transaction(db, async (client) => {
    const row = await getPaper(client, paper.id, true);
    return row ? mergeIntoPaper(client, row, pub.record, userId) : null;
  });
  if (!updated) return { status: "not_found", paper, before };
  const changed = updated.venue !== paper.venue || updated.doi !== paper.doi || updated.year !== paper.year;
  return { status: changed ? "updated" : "unchanged", paper: updated, before };
}
