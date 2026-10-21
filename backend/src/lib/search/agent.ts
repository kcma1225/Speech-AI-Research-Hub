/**
 * Plugs the search service into the agent's `search` tool (`setAgentSearchProvider`): hybrid ranking when semantic
 * search is on, otherwise the service's keyword search (CJK substrings and relaxed bigrams, all searchable types), which
 * the tool reports as `mode: "keyword"`.
 */
import { setAgentSearchProvider, type AgentSearchHit } from "../../agent/tools/search.js";
import { search } from "./service.js";

setAgentSearchProvider(async (ctx, q) => {
  const r = await search(ctx.db, q.query, { types: q.types ?? ["note", "task", "study", "paper"], studyId: q.studyId ?? undefined, limit: q.limit, user: ctx.user });
  // Interleave the per-type rankings (best of each type first), then cut to the limit.
  const hits: AgentSearchHit[] = [];
  const depth = Math.max(0, ...r.groups.map((g) => g.results.length));
  for (let i = 0; i < depth && hits.length < q.limit; i++) {
    for (const g of r.groups) {
      const h = g.results[i];
      if (!h || hits.length >= q.limit) continue;
      hits.push({ type: h.type, id: h.id, title: h.title, excerpt: h.snippet || undefined, study: h.study, url: h.url, authorId: h.author?.id ?? null, score: h.score });
    }
  }
  return { hits, mode: r.search_mode === "semantic" ? "hybrid" : "keyword" };
});

export const agentSearchWired = true;
