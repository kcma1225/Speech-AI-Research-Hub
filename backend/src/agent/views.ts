/** Row → API view mappers (also the payloads of SSE events). */
import { getAgentTool, isGrantable } from "./tools/registry.js";

export type ConversationRow = {
  id: string;
  user_id: string;
  title: string;
  title_source: "auto" | "user";
  mode: "chat" | "interview";
  context: Record<string, unknown>;
  study_id: string | null;
  autopilot: boolean;
  memory_enabled: boolean;
  summary: string | null;
  summary_until: string | null;
  created_at: string;
  updated_at: string;
};

export const conversationView = (c: ConversationRow) => ({
  id: c.id,
  title: c.title,
  mode: c.mode,
  context: c.context,
  study_id: c.study_id,
  autopilot: c.autopilot,
  memory_enabled: c.memory_enabled,
  compacted: !!c.summary,
  created_at: c.created_at,
  updated_at: c.updated_at,
});

export type RunRow = {
  id: string;
  conversation_id: string;
  user_id: string;
  status: "running" | "awaiting_approval" | "awaiting_llm" | "done" | "cancelled" | "failed";
  step: number;
  max_steps: number;
  autopilot: boolean;
  tainted: boolean;
  taint_sources: string[];
  autopilot_writes: number;
  tokens_in: number;
  tokens_out: number;
  active_ms: number;
  stop_reason: string | null;
  error: { error: string; code?: string; hint?: string } | null;
  llm_waits: number;
  next_retry_at: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
};

export const runView = (r: RunRow) => ({
  id: r.id,
  conversation_id: r.conversation_id,
  status: r.status,
  step: r.step,
  max_steps: r.max_steps,
  tainted: r.tainted,
  taint_sources: r.taint_sources,
  autopilot_writes: r.autopilot_writes,
  tokens: { in: r.tokens_in, out: r.tokens_out },
  stop_reason: r.stop_reason,
  error: r.error,
  llm_waits: r.llm_waits,
  next_retry_at: r.next_retry_at,
  started_at: r.started_at,
  finished_at: r.finished_at,
});

export type MessageRow = {
  id: string;
  seq: string;
  conversation_id: string;
  run_id: string | null;
  role: "user" | "assistant" | "tool" | "notice" | "compaction";
  content: unknown;
  text: string;
  reasoning: string;
  provider_state: unknown;
  page_context: Record<string, unknown> | null;
  status: "complete" | "cancelled";
  model: string | null;
  created_at: string;
  version_of?: string | null;
  hidden_by?: string | null;
  answers?: { toolCallId: string; answers: unknown[] } | null;
  memories?: { id: string; content: string }[];
  /** Ids of every version of this user message (oldest first), when it has more than one. */
  versions?: string[];
  /** Resolved attachments of a user message (`src/agent/attachments`). */
  attachments?: unknown[] | null;
};

export const messageView = (m: MessageRow) => ({
  id: m.id,
  seq: Number(m.seq),
  run_id: m.run_id,
  role: m.role,
  text: m.text,
  reasoning: m.reasoning,
  status: m.status,
  page_context: m.page_context,
  // Notices carry their kind (limit_steps, repeat, expired…) for the UI's action buttons.
  kind: m.role === "notice" && Array.isArray(m.content) ? ((m.content[0] as { kind?: string } | undefined)?.kind ?? null) : null,
  // A partial workflow's unmet items (「要我修這幾項嗎？」 → 繼續改 with them) and the run they belong to.
  // `replan`: unmet items only a new plan can meet (「重新規劃」).
  ...(m.role === "notice" && Array.isArray(m.content) && (Array.isArray((m.content[0] as { items?: unknown } | undefined)?.items) || Array.isArray((m.content[0] as { replan?: unknown } | undefined)?.replan))
    ? { items: (m.content[0] as { items?: string[] }).items ?? [], replan: (m.content[0] as { replan?: string[] }).replan ?? [], workflow_id: (m.content[0] as { workflowId?: string }).workflowId ?? null }
    : {}),
  memories: m.memories ?? [],
  // `ask_user` answers of this user turn (the card renders them; 「修改答案」 edits them as a new version).
  answers: m.answers ?? null,
  versions: m.versions && m.versions.length > 1 ? m.versions : null,
  attachments: m.attachments ?? [],
  hidden: !!m.hidden_by,
  created_at: m.created_at,
});

export type ToolCallRow = {
  id: string;
  run_id: string;
  conversation_id: string;
  message_id: string;
  step: number;
  position: number;
  provider_call_id: string;
  tool: string;
  args: Record<string, unknown>;
  edited_args: Record<string, unknown> | null;
  risk: "read" | "write" | "destructive";
  status: "pending_approval" | "deferred" | "approved" | "denied" | "running" | "done" | "failed" | "cancelled" | "expired";
  /** An autopilot deletion that never held its step (a card decided later; approve executes it). */
  deferred: boolean;
  approved_via: "user" | "conversation_grant" | "autopilot" | null;
  approval_reason: string | null;
  decided_by: string | null;
  decided_at: string | null;
  deny_reason: string | null;
  summary: string;
  target: { studyId: string | null; studySlug?: string; label: string; url?: string } | null;
  result: { data?: unknown; links?: unknown[]; source?: string; untrusted?: boolean; undo?: unknown; undone_at?: string } | null;
  result_text: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
};

export const toolCallView = (t: ToolCallRow, extra: { provenance?: string[] } = {}) => {
  const def = getAgentTool(t.tool);
  return {
    id: t.id,
    run_id: t.run_id,
    message_id: t.message_id,
    step: t.step,
    position: t.position,
    tool: t.tool,
    title: def?.title ?? t.tool,
    title_en: def?.titleEn ?? t.tool,
    risk: t.risk,
    always_ask: !!def?.alwaysAsk,
    grantable: def ? isGrantable(def) : false,
    open_world: !!def?.openWorld,
    status: t.status,
    approved_via: t.approved_via,
    approval_reason: t.approval_reason,
    deferred: !!t.deferred,
    decided_at: t.decided_at,
    deny_reason: t.deny_reason,
    summary: t.summary,
    target: t.target,
    args: t.edited_args ?? t.args,
    edited: !!t.edited_args,
    result: t.result ? { data: t.result.data ?? null, links: t.result.links ?? [], source: t.result.source ?? null } : null,
    error: t.error,
    // 「復原」 for calls that ran without a card: "available" until used, then "done".
    undo: t.status === "done" && t.result?.undo ? (t.result.undone_at ? "done" : "available") : null,
    undone_at: t.result?.undone_at ?? null,
    provenance: extra.provenance ?? [],
    created_at: t.created_at,
    finished_at: t.finished_at,
  };
};
