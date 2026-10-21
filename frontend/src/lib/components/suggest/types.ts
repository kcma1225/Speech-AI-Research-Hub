/** Shapes of GET /api/suggestions (docs/editor-collab.md). */
export type HunkStatus = "pending" | "accepted" | "rejected";
export type Hunk = {
  id: string;
  from: number;
  to: number;
  before: string;
  after: string;
  status: HunkStatus;
  /** Base64 Y.RelativePosition anchors (Yjs targets). */
  start?: string;
  end?: string;
  state: HunkStatus | "stale";
  current: { from: number; to: number } | null;
  decided_by?: string | null;
  decided_at?: string | null;
};
export type Suggestion = {
  id: string;
  target_type: string;
  target_id: string;
  study_id: string | null;
  doc_name: string | null;
  title: string;
  source: "user" | "ai" | "autopilot";
  status: "pending" | "applied" | "partial" | "rejected";
  created_by: string | null;
  creator_name: string | null;
  created_at: string;
  url: string | null;
  hunks: Hunk[];
  pending: number;
  stale: number;
};

/** A pending hunk placed in the editor right now (positions in the editor document). */
export type LiveHunk = {
  suggestionId: string;
  hunkId: string;
  from: number;
  to: number;
  before: string;
  after: string;
  stale: boolean;
  title: string;
  author: string | null;
};
