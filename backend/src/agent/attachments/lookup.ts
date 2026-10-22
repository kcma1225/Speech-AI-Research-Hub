/**
 * 「#」 references in the assistant composer (docs/architecture.md "Agent → Attachments"): a fuzzy title lookup of one
 * kind (or all kinds) across the lab — the current study first, then studies the user belongs to, then the rest.
 * Everyone signed in reads every study, so nothing is filtered by membership; ranking only.
 */
import type { Queryable } from "../../db.js";
import { noteUrl } from "../../lib/notes/store.js";
import { meetingUrl } from "../../lib/meetings/store.js";
import { latexUrl } from "../../lib/latex-projects/store.js";
import { deckUrl } from "../tools/deck-create.js";

export const REF_KINDS = ["deck", "paper", "note", "meeting", "latex_project", "study", "task"] as const;
export type RefKind = (typeof REF_KINDS)[number];

export type RefItem = {
  kind: RefKind;
  id: string;
  title: string;
  /** Owning study (papers: the current study when the paper is in it; meetings: their first study). */
  study: { id: string; slug: string; title: string } | null;
  url: string;
  date: string | null;
  /** Short qualifier: note kind, deck kind, paper year · venue, task status, study status. */
  sub: string | null;
  /** In the current study. */
  here: boolean;
};

/**
 * One row per item: id, title, study_id (owning study or null), study_ids (all studies it belongs to), date, sub,
 * hay (text the query is matched against).
 */
const BASE: Record<RefKind, string> = {
  deck: "SELECT d.id, d.title, d.study_id, ARRAY[d.study_id] AS study_ids, d.updated_at AS date, d.kind AS sub, d.title AS hay FROM decks d",
  note: "SELECT n.id, coalesce(nullif(n.title,''),'（未命名筆記）') AS title, n.study_id, ARRAY[n.study_id] AS study_ids, n.updated_at AS date, n.kind AS sub, n.title AS hay FROM notes n",
  latex_project: "SELECT p.id, p.title, p.study_id, ARRAY[p.study_id] AS study_ids, p.updated_at AS date, p.kind AS sub, p.title AS hay FROM latex_projects p",
  task: "SELECT t.id, t.title, t.study_id, ARRAY[t.study_id] AS study_ids, t.updated_at AS date, t.status AS sub, t.title AS hay FROM tasks t",
  study: "SELECT s.id, s.title, s.id AS study_id, ARRAY[s.id] AS study_ids, s.activity_at AS date, s.status AS sub, concat_ws(' ', s.title, s.slug) AS hay FROM studies s",
  meeting: `SELECT m.id, m.title, ms.ids[1] AS study_id, coalesce(ms.ids, '{}'::uuid[]) AS study_ids, m.held_at AS date, m.status AS sub, m.title AS hay
              FROM meetings m LEFT JOIN LATERAL (SELECT array_agg(x.study_id ORDER BY x.position) AS ids FROM meeting_studies x WHERE x.meeting_id=m.id) ms ON true`,
  paper: `SELECT p.id, p.title, NULL::uuid AS study_id, coalesce(sp.ids, '{}'::uuid[]) AS study_ids, coalesce(sp.at, p.updated_at) AS date,
                 nullif(concat_ws(' · ', p.year::text, nullif(p.venue,'')), '') AS sub, concat_ws(' ', p.title, p.authors_text, sp.keys) AS hay
            FROM papers p LEFT JOIN LATERAL (SELECT array_agg(x.study_id) AS ids, max(x.updated_at) AS at, string_agg(x.cite_key, ' ') AS keys FROM study_papers x WHERE x.paper_id=p.id) sp ON true`,
};

/** Whitespace-separated terms (at most 5), LIKE-escaped. */
export function lookupTerms(q: string): string[] {
  return q
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .map((t) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
}

function urlOf(kind: RefKind, id: string, slug: string | null): string {
  const s = slug ?? "";
  switch (kind) {
    case "deck":
      return deckUrl(s, id);
    case "note":
      return noteUrl(s, id);
    case "latex_project":
      return latexUrl(s, id);
    case "meeting":
      return meetingUrl(id);
    case "paper":
      return `/library?paper=${id}`;
    case "study":
      return `/studies/${encodeURIComponent(s)}`;
    case "task":
      return `/studies/${encodeURIComponent(s)}?tab=tasks&task=${id}`;
  }
}

/**
 * Items of `kinds` whose title (papers: also authors and cite keys) matches every term — contains it, or a word
 * close to it (pg_trgm word similarity, for typos). Order: current study, my studies, title starts with the query,
 * similarity, most recent. An empty query lists the most recent items.
 */
export async function lookupRefs(
  db: Queryable,
  opts: { userId: string; kinds: readonly RefKind[]; q: string; studyId: string | null; limit: number },
): Promise<RefItem[]> {
  const q = opts.q.trim().slice(0, 100);
  const words = q.split(/\s+/).filter(Boolean).slice(0, 5);
  const terms = lookupTerms(q);
  const per = opts.kinds.length > 1 ? Math.max(3, Math.ceil(opts.limit / 2)) : opts.limit;
  const out: (RefItem & { rank: number[] })[] = [];
  for (const kind of opts.kinds) {
    const params: unknown[] = [opts.userId, opts.studyId, q, terms, per, words];
    const rows = (await db.query<{ id: string; title: string; study_id: string | null; slug: string | null; study_title: string | null; date: string | null; sub: string | null; here: boolean; mine: boolean; prefix: boolean; sim: number }>(
      `SELECT x.id, x.title, x.date, x.sub,
              s.id AS study_id, s.slug, s.title AS study_title,
              ($2::uuid IS NOT NULL AND $2::uuid = ANY(x.study_ids)) AS here,
              EXISTS (SELECT 1 FROM study_members sm WHERE sm.user_id=$1 AND sm.study_id = ANY(x.study_ids)) AS mine,
              ($3 <> '' AND lower(x.title) LIKE lower($3) || '%') AS prefix,
              CASE WHEN $3 = '' THEN 0 ELSE word_similarity($3, coalesce(x.hay,'')) END AS sim
         FROM (${BASE[kind]}) x
         LEFT JOIN studies s ON s.id = CASE WHEN $2::uuid IS NOT NULL AND $2::uuid = ANY(x.study_ids) THEN $2::uuid ELSE x.study_id END
        WHERE $3 = ''
           OR (SELECT bool_and(coalesce(x.hay,'') ILIKE t.l OR word_similarity(t.w, coalesce(x.hay,'')) >= 0.4)
                 FROM unnest($4::text[], $6::text[]) AS t(l, w))
        ORDER BY here DESC, mine DESC, prefix DESC, sim DESC, x.date DESC NULLS LAST
        LIMIT $5`,
      params,
    )).rows;
    for (const r of rows) {
      out.push({
        kind,
        id: r.id,
        title: r.title,
        study: r.study_id && r.slug ? { id: r.study_id, slug: r.slug, title: r.study_title ?? "" } : null,
        url: urlOf(kind, r.id, r.slug),
        date: r.date ? new Date(r.date).toISOString() : null,
        sub: r.sub,
        here: r.here,
        rank: [r.here ? 1 : 0, r.mine ? 1 : 0, r.prefix ? 1 : 0, Number(r.sim) || 0, r.date ? new Date(r.date).getTime() : 0],
      });
    }
  }
  if (opts.kinds.length > 1) {
    out.sort((a, b) => {
      for (let i = 0; i < a.rank.length; i++) if (a.rank[i] !== b.rank[i]) return b.rank[i]! - a.rank[i]!;
      return 0;
    });
  }
  return out.slice(0, opts.limit).map(({ rank: _rank, ...item }) => item);
}
