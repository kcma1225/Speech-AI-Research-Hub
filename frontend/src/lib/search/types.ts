/** `GET /api/search` (docs/architecture.md "Search"). Highlights are [start, end) offsets into the string they belong to. */
export type SearchType = "study" | "note" | "paper" | "meeting" | "task" | "milestone" | "deck";
export type Highlight = [number, number];
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
  matched: ("keyword" | "semantic")[];
  score: number;
};
export type SearchGroup = { type: SearchType; results: SearchHit[]; has_more: boolean };
export type SearchResponse = { q: string; search_mode: "semantic" | "keyword_only"; notice_zh: string | null; groups: SearchGroup[]; total: number };
