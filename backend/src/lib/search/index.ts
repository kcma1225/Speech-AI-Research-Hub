/**
 * Search module entry (docs/architecture.md "Search"). Importing it registers the built-in sources and wires the notes
 * list search (`setNoteSearchProvider`): when semantic search is available, the study's notes list uses the hybrid
 * ranking; otherwise the notes module keeps its own keyword filter.
 */
import { setNoteSearchProvider } from "../notes/store.js";
import { search } from "./service.js";
import "./sources.js";
import "./agent.js";

export { search, searchMode, setSearchAccessFilter, type SearchHit, type SearchGroup, type SearchResponse, type SearchMode, type SearchOptions } from "./service.js";
export { registerSearchSource, enqueueSearchIndex, forgetSearchOwner, searchSources, CORE_SEARCH_TYPES, type SearchSourceDef, type EmbeddingDef, type SearchType } from "./sources.js";
export { chunkMarkdown } from "./chunk.js";

setNoteSearchProvider(async (db, studyId, q, limit) => {
  const r = await search(db, q, { types: ["note"], studyId, limit: Math.min(limit, 50) });
  if (r.search_mode !== "semantic") return null;
  return r.groups.find((g) => g.type === "note")?.results.map((h) => h.id) ?? [];
});

export const searchRegistered = true;
