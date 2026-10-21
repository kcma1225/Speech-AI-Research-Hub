/**
 * `search` tool: keyword search over notes, tasks, studies and study papers. The search module plugs its search service in
 * with `setAgentSearchProvider` (hybrid when semantic search is on, its CJK-aware keyword search otherwise; return null
 * to fall back to the plain ILIKE search below), or replaces the whole tool with
 * `registerAgentTool({ name: "search", … })`.
 */
import { z } from "zod";
import { likeEscape } from "../../lib/library/store.js";
import { noteUrl } from "../../lib/notes/store.js";
import { studyUrl } from "../../lib/studies/access.js";
import { markdownExcerpt } from "../../lib/text/excerpt.js";
import { registerAgentTool, type AgentToolContext } from "./registry.js";
import { clip, readStudy, scrub, studyRef } from "./util.js";

export type AgentSearchType = "note" | "task" | "study" | "paper" | (string & {});
export type AgentSearchHit = {
  type: AgentSearchType;
  id: string;
  title: string;
  excerpt?: string;
  study?: { id: string; slug: string; title: string } | null;
  url?: string;
  /** Author of the content (null = unknown): hits not written by the caller taint the run. */
  authorId?: string | null;
  score?: number;
};
export type AgentSearchQuery = { query: string; studyId: string | null; types: AgentSearchType[] | null; limit: number };
export type AgentSearchProvider = (ctx: AgentToolContext, q: AgentSearchQuery) => Promise<{ hits: AgentSearchHit[]; mode: "semantic" | "hybrid" | "keyword" } | null>;

let provider: AgentSearchProvider | null = null;
/** Hook for the search module (semantic / hybrid search). */
export const setAgentSearchProvider = (p: AgentSearchProvider | null) => void (provider = p);

export async function keywordSearch(ctx: AgentToolContext, q: AgentSearchQuery): Promise<AgentSearchHit[]> {
  const like = `%${likeEscape(q.query)}%`;
  const want = (t: AgentSearchType) => !q.types || q.types.includes(t);
  const per = Math.max(3, Math.ceil(q.limit / 2));
  const hits: AgentSearchHit[] = [];
  const studyCols = "json_build_object('id',s.id,'slug',s.slug,'title',s.title) AS study";
  if (want("note")) {
    const rows = (await ctx.db.query<{ id: string; title: string; content_md: string; study: { id: string; slug: string; title: string }; created_by: string | null }>(
      `SELECT n.id,n.title,n.content_md,n.created_by,${studyCols} FROM notes n JOIN studies s ON s.id=n.study_id
        WHERE ($2::uuid IS NULL OR n.study_id=$2) AND (n.title ILIKE $1 OR n.content_md ILIKE $1) ORDER BY n.updated_at DESC LIMIT $3`,
      [like, q.studyId, per],
    )).rows;
    for (const r of rows) {
      const at = r.content_md.toLowerCase().indexOf(q.query.toLowerCase());
      const excerpt = at >= 0 ? r.content_md.slice(Math.max(0, at - 60), at + 120) : markdownExcerpt(r.content_md, 160);
      hits.push({ type: "note", id: r.id, title: r.title, excerpt, study: r.study, url: noteUrl(r.study.slug, r.id), authorId: r.created_by });
    }
  }
  if (want("task")) {
    const rows = (await ctx.db.query<{ id: string; title: string; status: string; study: { id: string; slug: string; title: string }; created_by: string | null }>(
      `SELECT t.id,t.title,t.status,t.created_by,${studyCols} FROM tasks t JOIN studies s ON s.id=t.study_id
        WHERE ($2::uuid IS NULL OR t.study_id=$2) AND (t.title ILIKE $1 OR t.detail_md ILIKE $1) ORDER BY t.updated_at DESC LIMIT $3`,
      [like, q.studyId, per],
    )).rows;
    for (const r of rows) hits.push({ type: "task", id: r.id, title: r.title, excerpt: r.status, study: r.study, url: studyUrl(r.study.slug, "tasks"), authorId: r.created_by });
  }
  if (want("study") && !q.studyId) {
    const rows = (await ctx.db.query<{ id: string; slug: string; title: string; summary_md: string; created_by: string | null }>(
      "SELECT id,slug,title,summary_md,created_by FROM studies WHERE status<>'archived' AND (title ILIKE $1 OR summary_md ILIKE $1) ORDER BY activity_at DESC LIMIT $2",
      [like, per],
    )).rows;
    for (const r of rows) hits.push({ type: "study", id: r.id, title: r.title, excerpt: markdownExcerpt(r.summary_md, 160), study: { id: r.id, slug: r.slug, title: r.title }, url: studyUrl(r.slug), authorId: r.created_by });
  }
  if (want("paper")) {
    const rows = (await ctx.db.query<{ id: string; title: string; year: number | null; study: { id: string; slug: string; title: string } | null }>(
      `SELECT p.id,p.title,p.year,CASE WHEN s.id IS NULL THEN NULL ELSE ${studyCols} END FROM papers p
         LEFT JOIN study_papers sp ON sp.paper_id=p.id AND ($2::uuid IS NOT NULL AND sp.study_id=$2) LEFT JOIN studies s ON s.id=sp.study_id
        WHERE ($2::uuid IS NULL OR sp.study_id IS NOT NULL) AND (p.title ILIKE $1 OR p.authors_text ILIKE $1 OR p.abstract ILIKE $1) ORDER BY p.created_at DESC LIMIT $3`,
      [like, q.studyId, per],
    )).rows;
    for (const r of rows) hits.push({ type: "paper", id: r.id, title: r.title, excerpt: r.year ? String(r.year) : undefined, study: r.study, url: `/library?paper=${r.id}`, authorId: null });
  }
  return hits.slice(0, q.limit);
}

registerAgentTool({
  name: "search",
  title: "搜尋",
  titleEn: "Search",
  risk: "read",
  description: "Search the lab's notes, tasks, studies and papers (semantic when available, otherwise keywords). Optionally limit to one study and to some types.",
  input: z.object({
    query: z.string().trim().min(1).max(200),
    study: studyRef.optional(),
    types: z.array(z.enum(["note", "task", "study", "paper"])).max(4).optional(),
    limit: z.number().int().min(1).max(30).optional(),
  }),
  summarize: (a) => `搜尋「${a.query}」`,
  async execute(a, ctx) {
    const study = a.study ? (await readStudy(ctx, a.study)).study : null;
    const q: AgentSearchQuery = { query: a.query, studyId: study?.id ?? null, types: a.types ?? null, limit: a.limit ?? 12 };
    let mode: "semantic" | "hybrid" | "keyword" = "keyword";
    let hits: AgentSearchHit[] | null = null;
    if (provider) {
      const r = await provider(ctx, q).catch((e) => {
        ctx.app.log.warn({ err: e }, "agent search provider failed; falling back to keywords");
        return null;
      });
      if (r) ({ hits, mode } = r);
    }
    hits ??= await keywordSearch(ctx, q);
    return {
      data: { mode, results: hits.map((h) => ({ type: h.type, id: h.id, title: scrub(h.title), excerpt: h.excerpt ? clip(scrub(h.excerpt), 200) : undefined, study: h.study ? { id: h.study.id, slug: h.study.slug, title: h.study.title } : undefined })) },
      untrusted: hits.some((h) => h.authorId !== ctx.user.id),
      source: "搜尋結果",
    };
  },
});
