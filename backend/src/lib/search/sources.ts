/**
 * Searchable content. Each result type has a keyword corpus (an SQL SELECT over its domain table) and, optionally,
 * embedding owners (registered with the AI platform's `registerEmbeddingSource`, so `ai_embedding_reindex` can fill a
 * new space, and used by `ai_search_index` for incremental updates).
 *
 * Other modules add their content with `registerSearchSource(def)` (e.g. meetings: `meeting`, `transcript`) from a file
 * that both the backend (search route) and the ai-worker (`lib/search/index-job.ts`) import; changes must call
 * `enqueueSearchIndex(client, ownerType, ownerId)` (or a DB trigger calling `search_enqueue(type, id)`), deletions
 * `forgetSearchOwner` / `search_forget`.
 */
import type { Queryable } from "../../db.js";
import { registerEmbeddingSource } from "../../ai/embedding/sources.js";
import { chunkMarkdown } from "./chunk.js";

/** Built-in result types (group order in responses). Modules may add more. */
export const CORE_SEARCH_TYPES = ["study", "note", "paper", "meeting", "task", "milestone", "deck"] as const;
export type SearchType = (typeof CORE_SEARCH_TYPES)[number] | (string & {});

/** A corpus row, as selected by `SearchSourceDef.corpus`. */
export type CorpusRow = {
  type: string;
  id: string;
  /** Owning study (null for lab-wide content such as papers). */
  study_id: string | null;
  /** Studies the content is linked to besides `study_id` (papers: every study whose library has it). */
  study_ids: string[] | null;
  title: string;
  /** Searchable text (Markdown or plain). */
  body: string;
  author_id: string | null;
  /** Date used for sorting ties and the from/to filter. */
  at: Date;
  meta: Record<string, unknown>;
};

export type UrlContext = { studySlug: string | null; filterStudySlug: string | null };

/** One embedded owner: the text to chunk and the result it belongs to. */
export type EmbeddedOwner = { resultId: string; title: string; text: string };

export type EmbeddingDef = {
  /** `embeddings.owner_type` (lower snake case). */
  ownerType: string;
  count(db: Queryable): Promise<number>;
  /** Owner ids in ascending order after `afterId`. */
  ids(db: Queryable, afterId: string | undefined, limit: number): Promise<string[]>;
  /** Text per owner id (missing = deleted or nothing to embed). */
  load(db: Queryable, ownerIds: string[]): Promise<Map<string, EmbeddedOwner>>;
};

export type SearchSourceDef = {
  type: SearchType;
  /**
   * SELECT producing exactly these columns, in this order:
   * `id uuid, study_id uuid, study_ids uuid[], title text, body text, author_id uuid, at timestamptz, meta jsonb`.
   */
  corpus: string;
  /** SPA link of a result. */
  url(row: CorpusRow, ctx: UrlContext): string;
  /** Whether `body` is Markdown (converted to plain text for snippets). Default true. */
  markdown?: boolean;
  embeddings?: EmbeddingDef[];
};

const defs = new Map<string, SearchSourceDef>();
const embeddingDefs = new Map<string, { def: EmbeddingDef; type: string }>();

/** Chunks of an owner; a title without body still embeds as one chunk. */
export function chunksOf(owner: EmbeddedOwner): string[] {
  const chunks = chunkMarkdown(owner.text, owner.title);
  const title = owner.title.trim();
  return chunks.length ? chunks : title ? [title] : [];
}

export function registerSearchSource(def: SearchSourceDef) {
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(def.type)) throw new Error(`bad search type ${def.type}`);
  defs.set(def.type, def);
  for (const e of def.embeddings ?? []) {
    embeddingDefs.set(e.ownerType, { def: e, type: def.type });
    registerEmbeddingSource(e.ownerType, {
      count: (db) => e.count(db),
      async *iterate(db, { afterId, batchSize }) {
        let after = afterId;
        for (;;) {
          const ids = await e.ids(db, after, batchSize);
          if (!ids.length) return;
          const loaded = await e.load(db, ids);
          for (const id of ids) {
            const owner = loaded.get(id);
            yield { ownerId: id, chunks: owner ? chunksOf(owner).map((text, index) => ({ index, text })) : [] };
          }
          after = ids[ids.length - 1];
        }
      },
    });
  }
}

export const searchSources = () => {
  const order = (t: string) => {
    const i = (CORE_SEARCH_TYPES as readonly string[]).indexOf(t);
    return i < 0 ? 100 : i;
  };
  return [...defs.values()].sort((a, b) => order(a.type) - order(b.type));
};
export const searchSource = (type: string) => defs.get(type);
export const embeddingOwner = (ownerType: string) => embeddingDefs.get(ownerType);
export const embeddingOwnerTypes = (types?: string[]) =>
  [...embeddingDefs.entries()].filter(([, v]) => !types || types.includes(v.type)).map(([k]) => k);

/** Queues an owner for re-embedding (same as the SQL `search_enqueue`; no-op while no space is live). */
export async function enqueueSearchIndex(client: Queryable, ownerType: string, ownerId: string) {
  await client.query("SELECT search_enqueue($1, $2)", [ownerType, ownerId]);
}
/** Removes an owner's vectors from every space. */
export async function forgetSearchOwner(client: Queryable, ownerType: string, ownerId: string) {
  await client.query("SELECT search_forget($1, $2)", [ownerType, ownerId]);
}

// ---------------------------------------------------------------- built-in sources

const q = encodeURIComponent;
const studyPath = (ctx: UrlContext) => `/studies/${q(ctx.studySlug ?? "")}`;

/** Simple embedding owner over one table with a uuid `id`. */
function tableOwner(ownerType: string, table: string, select: string, where = "true"): EmbeddingDef {
  return {
    ownerType,
    async count(db) {
      return (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)).rows[0]!.n;
    },
    async ids(db, afterId, limit) {
      const r = await db.query<{ id: string }>(
        `SELECT id FROM ${table} WHERE ${where} AND ($1::uuid IS NULL OR id > $1::uuid) ORDER BY id LIMIT $2`,
        [afterId ?? null, limit],
      );
      return r.rows.map((x) => x.id);
    },
    async load(db, ownerIds) {
      const r = await db.query<{ id: string; title: string; text: string }>(`SELECT id, ${select} FROM ${table} WHERE id = ANY($1::uuid[]) AND ${where}`, [ownerIds]);
      return new Map(r.rows.map((x) => [x.id, { resultId: x.id, title: x.title, text: x.text ?? "" }]));
    },
  };
}

registerSearchSource({
  type: "study",
  corpus: `SELECT s.id, s.id, NULL::uuid[], s.title, s.summary_md, s.created_by, s.activity_at,
                  jsonb_build_object('status', s.status) FROM studies s`,
  url: (_row, ctx) => studyPath(ctx),
  embeddings: [tableOwner("study", "studies", "title, summary_md AS text")],
});

registerSearchSource({
  type: "note",
  corpus: `SELECT n.id, n.study_id, NULL::uuid[], n.title, n.content_md, n.created_by,
                  coalesce((n.event_date + time '12:00') AT TIME ZONE 'Asia/Taipei', n.updated_at),
                  jsonb_build_object('kind', n.kind, 'event_date', to_char(n.event_date, 'YYYY-MM-DD')) FROM notes n`,
  url: (row, ctx) => `${studyPath(ctx)}/notes/${row.id}`,
  embeddings: [tableOwner("note", "notes", "title, content_md AS text")],
});

registerSearchSource({
  type: "paper",
  corpus: `SELECT p.id, NULL::uuid, coalesce(l.study_ids, '{}'::uuid[]), p.title,
                  concat_ws(E'\\n', p.authors_text, p.venue, p.abstract, l.notes), p.added_by, p.updated_at,
                  jsonb_build_object('year', p.year, 'venue', p.venue, 'authors', p.authors_text)
             FROM papers p
             LEFT JOIN LATERAL (SELECT array_agg(sp.study_id) AS study_ids, string_agg(nullif(sp.notes_md, ''), E'\\n') AS notes
                                  FROM study_papers sp WHERE sp.paper_id = p.id) l ON true`,
  url: (row, ctx) => (ctx.filterStudySlug ? `/studies/${q(ctx.filterStudySlug)}?tab=papers&paper=${row.id}` : `/library/${row.id}`),
  markdown: true,
  embeddings: [
    tableOwner("paper", "papers", "title, concat_ws(E'\\n', authors_text, venue, abstract) AS text"),
    // Reading notes of one study on one paper; owner id = search_study_paper_id(study, paper).
    {
      ownerType: "study_paper",
      async count(db) {
        return (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM study_papers WHERE notes_md <> ''")).rows[0]!.n;
      },
      async ids(db, afterId, limit) {
        const r = await db.query<{ id: string }>(
          `SELECT search_study_paper_id(study_id, paper_id) AS id FROM study_papers
            WHERE notes_md <> '' AND ($1::uuid IS NULL OR search_study_paper_id(study_id, paper_id) > $1::uuid)
            ORDER BY 1 LIMIT $2`,
          [afterId ?? null, limit],
        );
        return r.rows.map((x) => x.id);
      },
      async load(db, ownerIds) {
        const r = await db.query<{ id: string; paper_id: string; title: string; notes_md: string }>(
          `SELECT search_study_paper_id(sp.study_id, sp.paper_id) AS id, sp.paper_id, p.title, sp.notes_md
             FROM study_papers sp JOIN papers p ON p.id = sp.paper_id
            WHERE search_study_paper_id(sp.study_id, sp.paper_id) = ANY($1::uuid[]) AND sp.notes_md <> ''`,
          [ownerIds],
        );
        return new Map(r.rows.map((x) => [x.id, { resultId: x.paper_id, title: x.title, text: x.notes_md }]));
      },
    },
  ],
});

registerSearchSource({
  type: "task",
  corpus: `SELECT t.id, t.study_id, NULL::uuid[], t.title, t.detail_md, t.created_by, t.updated_at,
                  jsonb_build_object('status', t.status, 'due_on', to_char(t.due_on, 'YYYY-MM-DD'), 'assignee_id', t.assignee_id) FROM tasks t`,
  url: (row, ctx) => `${studyPath(ctx)}?tab=tasks&task=${row.id}`,
});

registerSearchSource({
  type: "milestone",
  corpus: `SELECT m.id, m.study_id, NULL::uuid[], m.title, ''::text, m.created_by, m.updated_at,
                  jsonb_build_object('due_on', to_char(m.due_on, 'YYYY-MM-DD'), 'done', m.done_at IS NOT NULL) FROM milestones m`,
  url: (_row, ctx) => studyPath(ctx),
  markdown: false,
});

registerSearchSource({
  type: "deck",
  corpus: `SELECT d.id, d.study_id, NULL::uuid[], d.title, ''::text, d.created_by, d.updated_at,
                  jsonb_build_object('kind', d.kind) FROM decks d`,
  url: (row, ctx) => `${studyPath(ctx)}/decks/${row.id}`,
  markdown: false,
});


// ---------------------------------------------------------------- meetings (tables from migration 0080; triggers 0091)

const TRANSCRIPT_TEXT = `(SELECT string_agg(e.seg->>'text', ' ' ORDER BY e.ord) FROM jsonb_array_elements(t.segments) WITH ORDINALITY AS e(seg, ord))`;

registerSearchSource({
  type: "meeting",
  // Cross-study: no owning study; `study_ids` = the meeting's studies. Body = notes, AI drafts and the shown transcript.
  corpus: `SELECT m.id, NULL::uuid, coalesce(ms.ids, '{}'::uuid[]), m.title,
                  concat_ws(E'\\n', nullif(m.notes, ''), d.text, tr.text), m.created_by, m.held_at,
                  jsonb_build_object('status', m.status, 'held_at', m.held_at)
             FROM meetings m
             LEFT JOIN LATERAL (SELECT array_agg(x.study_id ORDER BY x.position) AS ids FROM meeting_studies x WHERE x.meeting_id = m.id) ms ON true
             LEFT JOIN LATERAL (SELECT string_agg(concat_ws(E'\\n', nullif(x.summary_md, ''), nullif(x.feedback_md, '')), E'\\n') AS text
                                  FROM meeting_study_drafts x WHERE x.meeting_id = m.id AND x.status <> 'dismissed') d ON true
             LEFT JOIN LATERAL (SELECT ${TRANSCRIPT_TEXT} AS text FROM transcripts t WHERE t.id = m.transcript_id) tr ON true`,
  url: (row) => `/meetings/${row.id}`,
  embeddings: [
    tableOwner(
      "meeting",
      "meetings",
      `title, concat_ws(E'\\n', nullif(notes, ''), (SELECT string_agg(concat_ws(E'\\n', nullif(x.summary_md, ''), nullif(x.feedback_md, '')), E'\\n')
                                                   FROM meeting_study_drafts x WHERE x.meeting_id = meetings.id AND x.status <> 'dismissed')) AS text`,
    ),
    // The shown transcript of each meeting (owner = transcript id, result = its meeting).
    {
      ownerType: "transcript",
      async count(db) {
        return (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM meetings WHERE transcript_id IS NOT NULL")).rows[0]!.n;
      },
      async ids(db, afterId, limit) {
        const r = await db.query<{ id: string }>(
          "SELECT transcript_id AS id FROM meetings WHERE transcript_id IS NOT NULL AND ($1::uuid IS NULL OR transcript_id > $1::uuid) ORDER BY 1 LIMIT $2",
          [afterId ?? null, limit],
        );
        return r.rows.map((x) => x.id);
      },
      async load(db, ownerIds) {
        const r = await db.query<{ id: string; meeting_id: string; title: string; text: string | null }>(
          `SELECT t.id, m.id AS meeting_id, m.title, ${TRANSCRIPT_TEXT} AS text
             FROM transcripts t JOIN meetings m ON m.transcript_id = t.id WHERE t.id = ANY($1::uuid[])`,
          [ownerIds],
        );
        return new Map(r.rows.filter((x) => x.text).map((x) => [x.id, { resultId: x.meeting_id, title: x.title, text: x.text! }]));
      },
    },
  ],
});

/** Import marker: importing this module registers the built-in sources. */
export const searchSourcesRegistered = true;
