/**
 * Hybrid search: keyword (CJK-aware ILIKE over each source's corpus) + semantic (pgvector k-NN in the active embedding
 * space), fused per result type with Reciprocal Rank Fusion. Falls back to keyword only when there is no active space,
 * the `embedding` role is unavailable, or embedding the query fails (`search_mode: "keyword_only"` + notice).
 */
import type { Queryable } from "../../db.js";
import { ai } from "../../ai/platform/index.js";
import type { AiPlatform } from "../../ai/platform/platform.js";
import { searchSpace, type EmbeddingSpace } from "../../ai/embedding/spaces.js";
import { rrf } from "./rrf.js";
import { chunksOf, embeddingOwner, embeddingOwnerTypes, searchSource, searchSources, type CorpusRow, type SearchType } from "./sources.js";
import { likeEscape, makeSnippet, plainText, relaxedThreshold, titleHighlights, tokenizeQuery, type Highlight, type QueryTerms } from "./text.js";
import "./sources.js";

export type SearchMode = "semantic" | "keyword_only";

export type SearchFilters = {
  types?: string[];
  studyId?: string;
  authorId?: string;
  /** Inclusive dates `YYYY-MM-DD` (Asia/Taipei). */
  from?: string;
  to?: string;
};

export type SearchOptions = SearchFilters & {
  /** Results per type (1–50, default 5). */
  limit?: number;
  /** `keyword` forces keyword-only search. */
  mode?: "auto" | "keyword";
  /** Caller (for the access filter and call-log attribution); null = system (no access filter). */
  user?: { id: string } | null;
};

export type SearchHit = {
  type: SearchType;
  id: string;
  title: string;
  title_highlights: Highlight[];
  snippet: string;
  highlights: Highlight[];
  url: string;
  study: { id: string; slug: string; title: string } | null;
  author: { id: string; name: string } | null;
  at: string;
  meta: Record<string, unknown>;
  /** Which retrievers found it. */
  matched: ("keyword" | "semantic")[];
  score: number;
};

export type SearchGroup = { type: SearchType; results: SearchHit[]; has_more: boolean };

export type SearchResponse = {
  q: string;
  search_mode: SearchMode;
  /** 繁中 reason when keyword_only (the UI shows 「目前使用關鍵字搜尋 · <reason>」). */
  notice_zh: string | null;
  groups: SearchGroup[];
  total: number;
};

// ---------------------------------------------------------------- access filter hook

/**
 * Restricts what a user may find. v3: everyone reads every study, so the default allows everything (null). A filter
 * returns the study ids the user may see; lab-wide content (no study, e.g. papers) stays visible.
 */
export type SearchAccessFilter = (db: Queryable, user: { id: string }) => Promise<{ studyIds: string[] } | null>;
let accessFilter: SearchAccessFilter | null = null;
export const setSearchAccessFilter = (f: SearchAccessFilter | null) => void (accessFilter = f);

// ---------------------------------------------------------------- tuning

/** Cosine distance above which a semantic neighbour is not considered relevant. */
export const SEMANTIC_MAX_DISTANCE = 0.75;
/** Neighbours further than the best one by more than this are dropped (keeps vague queries from flooding). */
export const SEMANTIC_RELATIVE_DISTANCE = 0.3;

// ---------------------------------------------------------------- platform access

function platformOrNull(): AiPlatform | null {
  try {
    return ai.platform;
  } catch {
    return null;
  }
}

/** Query vectors are cached briefly per space (typing in ⌘K repeats queries). */
const queryCache = new Map<string, { vec: number[]; at: number }>();
const QUERY_CACHE_MS = 5 * 60_000;

async function embedQuery(platform: AiPlatform, space: EmbeddingSpace, text: string, userId?: string): Promise<number[]> {
  const key = `${space.id}\u0000${text}`;
  const hit = queryCache.get(key);
  if (hit && Date.now() - hit.at < QUERY_CACHE_MS) return hit.vec;
  const r = await platform.embed([text], "query", { spaceId: space.id, userId });
  const vec = r.vectors[0];
  if (!vec?.length) throw new Error("empty query vector");
  if (queryCache.size > 300) queryCache.delete(queryCache.keys().next().value!);
  queryCache.set(key, { vec, at: Date.now() });
  return vec;
}

/**
 * Semantic search needs an active space and a working, *bound* `embedding` role (`embeddingState()` covers the space
 * and an unavailable role; an unbound role means the admin turned semantic search off).
 */
async function semanticState(platform: AiPlatform | null): Promise<{ space: EmbeddingSpace | null; reason_zh: string | null }> {
  if (!platform) return { space: null, reason_zh: "語意搜尋尚未啟用。" };
  try {
    const st = await platform.embeddingState();
    if (st.mode !== "semantic" || !st.space) return { space: null, reason_zh: st.reason_zh ?? "語意搜尋暫時無法使用。" };
    const role = (await platform.status()).roles.embedding?.state;
    if (role === "unconfigured") return { space: null, reason_zh: "尚未設定語意搜尋。" };
    return { space: st.space, reason_zh: null };
  } catch {
    return { space: null, reason_zh: "語意搜尋暫時無法使用。" };
  }
}

/** Current mode without running a query (for UIs and the agent tool). */
export async function searchMode(): Promise<{ mode: SearchMode; reason_zh: string | null }> {
  const st = await semanticState(platformOrNull());
  return { mode: st.space ? "semantic" : "keyword_only", reason_zh: st.reason_zh };
}

// ---------------------------------------------------------------- SQL

const COLS = "id, study_id, study_ids, title, body, author_id, at, meta";

type Built = { sql: string; params: unknown[] };

/** UNION ALL of the selected corpora with the common filters applied. */
function corpus(types: string[], filters: SearchFilters, allowStudyIds: string[] | null, params: unknown[]): string {
  const add = (v: unknown) => `$${params.push(v)}`;
  const parts = types.map((t) => `SELECT ${add(t)}::text AS type, x.* FROM (${searchSource(t)!.corpus}) AS x(${COLS})`);
  const where: string[] = [];
  if (filters.studyId) {
    const p = add(filters.studyId);
    where.push(`(c.study_id = ${p}::uuid OR ${p}::uuid = ANY(coalesce(c.study_ids, '{}'::uuid[])))`);
  }
  if (filters.authorId) where.push(`c.author_id = ${add(filters.authorId)}::uuid`);
  if (filters.from) where.push(`c.at >= (${add(filters.from)}::date)::timestamp AT TIME ZONE 'Asia/Taipei'`);
  if (filters.to) where.push(`c.at < (${add(filters.to)}::date + 1)::timestamp AT TIME ZONE 'Asia/Taipei'`);
  if (allowStudyIds) where.push(`(c.study_id IS NULL OR c.study_id = ANY(${add(allowStudyIds)}::uuid[]))`);
  return `(SELECT c.* FROM (${parts.join(" UNION ALL ")}) c${where.length ? ` WHERE ${where.join(" AND ")}` : ""})`;
}

type KeywordRow = CorpusRow & { score: number };

function keywordQuery(qt: QueryTerms, types: string[], filters: SearchFilters, allow: string[] | null, perType: number): Built {
  const params: unknown[] = [];
  const src = corpus(types, filters, allow, params);
  const add = (v: unknown) => `$${params.push(v)}`;
  const pat = (s: string) => add(`%${likeEscape(s)}%`);
  const termPats = qt.terms.map(pat);
  const gramPats = qt.relaxed ? qt.grams.map(pat) : termPats;
  const inTitle = (p: string) => `(c.title ILIKE ${p})`;
  const inAny = (p: string) => `(c.title ILIKE ${p} OR c.body ILIKE ${p})`;
  const strict = termPats.map(inAny).join(" AND ");
  const gramHits = gramPats.map((p) => `${inAny(p)}::int`).join(" + ");
  const titleHits = termPats.map((p) => `${inTitle(p)}::int`).join(" + ");
  const whole = pat(qt.normalized);
  const exact = add(qt.normalized);
  const threshold = relaxedThreshold(gramPats.length);
  const sql = `
    SELECT * FROM (
      SELECT s.*, row_number() OVER (PARTITION BY s.type ORDER BY s.score DESC, s.at DESC) AS rn FROM (
        SELECT c.*,
               (CASE WHEN ${strict} THEN 10 ELSE 0 END
                + 3 * (${titleHits})
                + 4.0 * (${gramHits}) / ${gramPats.length}
                + CASE WHEN c.title ILIKE ${whole} THEN 5 ELSE 0 END
                + CASE WHEN lower(c.title) = ${exact} THEN 10 ELSE 0 END)::float8 AS score,
               (${strict}) AS strict_hit,
               (${gramHits}) AS gram_hits
          FROM ${src} c
      ) s WHERE s.strict_hit OR (${qt.relaxed ? "true" : "false"} AND s.gram_hits >= ${threshold})
    ) r WHERE r.rn <= ${add(perType + 1)}
    ORDER BY r.type, r.rn`;
  return { sql, params };
}

function rowsByIds(types: string[], filters: SearchFilters, allow: string[] | null, pairs: { type: string; id: string }[]): Built {
  const params: unknown[] = [];
  const src = corpus(types, filters, allow, params);
  const t = `$${params.push(pairs.map((p) => p.type))}`;
  const i = `$${params.push(pairs.map((p) => p.id))}`;
  return { sql: `SELECT c.* FROM ${src} c WHERE (c.type, c.id) IN (SELECT * FROM unnest(${t}::text[], ${i}::uuid[]))`, params };
}

// ---------------------------------------------------------------- semantic

type SemanticHit = { type: string; id: string; distance: number; chunk: string };

async function semanticCandidates(db: Queryable, space: EmbeddingSpace, vec: number[], types: string[], k: number): Promise<SemanticHit[]> {
  const ownerTypes = embeddingOwnerTypes(types);
  if (!ownerTypes.length) return [];
  const hits = await searchSpace(db, space, vec, { ownerTypes, limit: k });
  const best = hits[0]?.distance ?? 1;
  const keep = hits.filter((h) => h.distance <= SEMANTIC_MAX_DISTANCE && h.distance <= best + SEMANTIC_RELATIVE_DISTANCE);
  // Resolve owners → results (and the matching chunk's text for the snippet).
  const byOwnerType = new Map<string, string[]>();
  for (const h of keep) byOwnerType.set(h.owner_type, [...(byOwnerType.get(h.owner_type) ?? []), h.owner_id]);
  const loaded = new Map<string, Map<string, { resultId: string; chunks: string[] }>>();
  for (const [ot, ids] of byOwnerType) {
    const e = embeddingOwner(ot);
    if (!e) continue;
    const owners = await e.def.load(db, [...new Set(ids)]);
    loaded.set(ot, new Map([...owners].map(([id, o]) => [id, { resultId: o.resultId, chunks: chunksOf(o) }])));
  }
  const out = new Map<string, SemanticHit>();
  for (const h of keep) {
    const e = embeddingOwner(h.owner_type);
    const o = loaded.get(h.owner_type)?.get(h.owner_id);
    if (!e || !o) continue;
    const key = `${e.type}:${o.resultId}`;
    if (out.has(key)) continue; // hits are sorted by distance: the first is the best chunk
    out.set(key, { type: e.type, id: o.resultId, distance: h.distance, chunk: o.chunks[h.chunk_index] ?? "" });
  }
  return [...out.values()];
}

// ---------------------------------------------------------------- main

const clampLimit = (n: number | undefined) => Math.min(Math.max(Math.trunc(n ?? 5), 1), 50);

export async function search(db: Queryable, q: string, opts: SearchOptions = {}): Promise<SearchResponse> {
  const qt = tokenizeQuery(q);
  const limit = clampLimit(opts.limit);
  const known = searchSources().map((s) => s.type);
  const types = opts.types?.length ? known.filter((t) => opts.types!.includes(t)) : known;
  let mode: SearchMode = "keyword_only";
  let notice: string | null = null;
  if (!qt.terms.length || !types.length) return { q: qt.normalized, search_mode: (await searchMode()).mode, notice_zh: null, groups: [], total: 0 };

  const allow = opts.user && accessFilter ? ((await accessFilter(db, opts.user))?.studyIds ?? null) : null;
  const filters: SearchFilters = { studyId: opts.studyId, authorId: opts.authorId, from: opts.from, to: opts.to };

  // Semantic part (best effort).
  let semantic: SemanticHit[] = [];
  if (opts.mode !== "keyword") {
    const platform = platformOrNull();
    const st = await semanticState(platform);
    if (platform && st.space) {
      try {
        const vec = await embedQuery(platform, st.space, qt.normalized, opts.user?.id);
        semantic = await semanticCandidates(db, st.space, vec, types, Math.min(200, Math.max(30, limit * types.length * 3)));
        mode = "semantic";
      } catch {
        notice = "語意搜尋暫時無法使用。";
      }
    } else notice = st.reason_zh ?? "語意搜尋暫時無法使用。";
  }

  const kw = keywordQuery(qt, types, filters, allow, limit * 2);
  const keywordRows = (await db.query<KeywordRow>(kw.sql, kw.params)).rows;

  // Semantic hits not found by keyword need their rows (this also applies the filters and the access hook to them).
  const rows = new Map<string, CorpusRow>(keywordRows.map((r) => [`${r.type}:${r.id}`, r]));
  const missing = semantic.filter((h) => !rows.has(`${h.type}:${h.id}`));
  if (missing.length) {
    const b = rowsByIds([...new Set(missing.map((m) => m.type))], filters, allow, missing);
    for (const r of (await db.query<CorpusRow>(b.sql, b.params)).rows) rows.set(`${r.type}:${r.id}`, r);
  }
  const keywordKeys = new Set(keywordRows.map((r) => `${r.type}:${r.id}`));
  const semByKey = new Map(semantic.map((h) => [`${h.type}:${h.id}`, h]));

  // Fuse per type.
  const groups: { type: string; ranked: { key: string; score: number }[] }[] = [];
  for (const type of types) {
    const kwIds = keywordRows.filter((r) => r.type === type).map((r) => `${type}:${r.id}`);
    const semIds = semantic.filter((h) => h.type === type && rows.has(`${type}:${h.id}`)).map((h) => `${type}:${h.id}`);
    const fused = rrf(mode === "semantic" ? [kwIds, semIds] : [kwIds]).map((x) => ({ key: x.id, score: x.score }));
    if (fused.length) groups.push({ type, ranked: fused });
  }

  // Display info.
  const picked = groups.flatMap((g) => g.ranked.slice(0, limit).map((x) => rows.get(x.key)!)).filter(Boolean);
  const studyIds = [...new Set(picked.map((r) => r.study_id).filter((x): x is string => Boolean(x)).concat(opts.studyId ? [opts.studyId] : []))];
  const authorIds = [...new Set(picked.map((r) => r.author_id).filter((x): x is string => Boolean(x)))];
  const studies = new Map(
    (await db.query<{ id: string; slug: string; title: string }>("SELECT id, slug, title FROM studies WHERE id = ANY($1::uuid[])", [studyIds])).rows.map((s) => [s.id, s]),
  );
  const authors = new Map((await db.query<{ id: string; name: string }>("SELECT id, name FROM users WHERE id = ANY($1::uuid[])", [authorIds])).rows.map((u) => [u.id, u]));
  const filterStudy = opts.studyId ? (studies.get(opts.studyId) ?? null) : null;

  const out: SearchGroup[] = groups.map((g) => ({
    type: g.type,
    has_more: g.ranked.length > limit,
    results: g.ranked.slice(0, limit).map(({ key, score }) => {
      const row = rows.get(key)!;
      const def = searchSource(row.type)!;
      const sem = semByKey.get(key);
      const kwHit = keywordKeys.has(key);
      const study = row.study_id ? (studies.get(row.study_id) ?? null) : filterStudy;
      const body = def.markdown === false ? row.body : plainText(row.body ?? "");
      let snip = makeSnippet(body, qt);
      if (!snip.highlights.length && sem?.chunk) {
        const chunkBody = plainText(sem.chunk.startsWith(row.title) ? sem.chunk.slice(row.title.length) : sem.chunk);
        snip = makeSnippet(chunkBody, qt);
      }
      return {
        type: row.type,
        id: row.id,
        title: row.title,
        title_highlights: titleHighlights(row.title, qt),
        snippet: snip.text,
        highlights: snip.highlights,
        url: def.url(row, { studySlug: study?.slug ?? null, filterStudySlug: filterStudy?.slug ?? null }),
        study: study ? { id: study.id, slug: study.slug, title: study.title } : null,
        author: row.author_id ? (authors.get(row.author_id) ?? null) : null,
        at: new Date(row.at).toISOString(),
        meta: row.meta ?? {},
        matched: [...(kwHit ? (["keyword"] as const) : []), ...(sem && mode === "semantic" ? (["semantic"] as const) : [])],
        score: Math.round(score * 1e6) / 1e6,
      };
    }),
  }));
  return { q: qt.normalized, search_mode: mode, notice_zh: mode === "semantic" ? null : notice, groups: out, total: out.reduce((n, g) => n + g.results.length, 0) };
}
