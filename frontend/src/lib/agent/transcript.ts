/**
 * Compact chat transcript (pure, unit-tested): groups the current branch into user messages and **assistant turns**.
 * A turn is everything between two user messages — every model step, its reasoning, preambles, tool calls and plan
 * updates. The chat shows per turn only the live plan (one checklist, the newest `update_plan` state), one collapsed
 * 「處理過程」 row (`activity`), the final answer, cards that need action (consent, ask_user, workflows) and result
 * chips; the rest is behind the expandable row.
 */
import { askArgs } from "./ask.ts";
import type { Message, ToolCall } from "./types.ts";

export type PlanItem = { step: string; status: "pending" | "in_progress" | "completed" };
export type PlanState = { items: PlanItem[]; explanation: string; done: number; total: number; current: string | null; callId: string; updates: number };

export type ActivityCategory = "section" | "page" | "search" | "read" | "create" | "suggest" | "edit" | "delete" | "memory";
export type ActivityCounts = Partial<Record<ActivityCategory, number>>;

export type AssistantTurn = {
  kind: "assistant";
  key: string;
  messages: Message[];
  /** The answer shown in the transcript (null while the turn is still working). */
  final: Message | null;
  /** Intermediate assistant messages (preambles, reasoning-only steps) — expanded view only. */
  steps: Message[];
  /** Every call of the turn in transcript order. */
  calls: ToolCall[];
  /** Calls of the expanded timeline (no plan updates, open cards or workflow cards). */
  activity: ToolCall[];
  plan: PlanState | null;
  pending: ToolCall[];
  asks: ToolCall[];
  workflows: ToolCall[];
  /** Finished writes (and the deck draft) shown as compact chips under the answer. */
  results: ToolCall[];
  notices: Message[];
  counts: ActivityCounts;
  failed: number;
  denied: number;
  hasReasoning: boolean;
  live: boolean;
  startedAt: string | null;
  endedAt: string | null;
};
export type TranscriptItem = { kind: "message"; key: string; message: Message } | AssistantTurn;

const SECTION = new Set(["read_paper", "latex_read_file", "read_attachment"]);
const PAGE = new Set(["view_paper_pages", "get_deck_pages", "review_deck_layout", "review_latex_layout"]);
const SEARCH = new Set(["search", "search_papers_online"]);

/** Tools whose result carries a live workflow / batch / goal card. */
export const START_TOOLS = new Set(["start_workflow", "start_goal", "update_goal"]);

/** Category of a tool for the summary line (`null` = not counted: plan, questions, workflows). */
export function categoryOf(c: Pick<ToolCall, "tool" | "risk">): ActivityCategory | null {
  const t = c.tool;
  if (t === "update_plan" || t === "ask_user" || START_TOOLS.has(t) || t === "get_workflow" || t === "get_goal" || t === "propose_study_plan") return null;
  if (SECTION.has(t)) return "section";
  if (PAGE.has(t)) return "page";
  if (SEARCH.has(t)) return "search";
  if (t === "remember") return "memory";
  if (c.risk === "destructive" || t.startsWith("delete_") || t.startsWith("remove_")) return "delete";
  if (c.risk === "read") return "read";
  if (t.startsWith("suggest_") || t.endsWith("_suggest_edit")) return "suggest";
  if (t.startsWith("create_") || t.startsWith("add_") || t.startsWith("import_")) return "create";
  return "edit";
}

/** How much one finished call adds to its category (pages viewed count pages, not calls). */
function weight(c: ToolCall): number {
  if (c.tool === "view_paper_pages" || c.tool === "review_latex_layout" || c.tool === "review_deck_layout") {
    const a = c.args ?? {};
    const n = (Array.isArray(a.pages) ? a.pages.length : 0) + (Array.isArray(a.regions) ? a.regions.length : 0);
    return Math.max(1, n);
  }
  return 1;
}

export function countActivity(calls: ToolCall[]): { counts: ActivityCounts; failed: number; denied: number } {
  const counts: ActivityCounts = {};
  let failed = 0;
  let denied = 0;
  for (const c of calls) {
    const cat = categoryOf(c);
    if (!cat) continue;
    if (c.status === "failed") failed++;
    else if (c.status === "denied") denied++;
    else if (c.status === "done") counts[cat] = (counts[cat] ?? 0) + weight(c);
  }
  return { counts, failed, denied };
}

/** The newest `update_plan` state among `calls` (already in transcript order). */
export function latestPlan(calls: ToolCall[]): PlanState | null {
  const plans = calls.filter((c) => c.tool === "update_plan" && (c.status === "done" || c.status === "running"));
  const last = plans.at(-1);
  if (!last) return null;
  const raw = (last.args as { plan?: unknown }).plan;
  const items = Array.isArray(raw)
    ? raw
        .filter((p): p is PlanItem => !!p && typeof (p as PlanItem).step === "string")
        .slice(0, 12)
        .map((p) => ({ step: p.step, status: p.status === "completed" || p.status === "in_progress" ? p.status : "pending" }) as PlanItem)
    : [];
  if (!items.length) return null;
  const explanation = typeof (last.args as { explanation?: unknown }).explanation === "string" ? (last.args as { explanation: string }).explanation : "";
  const done = items.filter((i) => i.status === "completed").length;
  const current = items.find((i) => i.status === "in_progress")?.step ?? null;
  return { items, explanation, done, total: items.length, current, callId: last.id, updates: plans.length };
}

/**
 * start_workflow / start_goal / update_goal → its run id, `batch:<id>` for a batch (one run per paper), or
 * `goal:<id>` for a goal (a roadmap of workflow runs: the GoalCard).
 */
const workflowIdOf = (c: ToolCall) => {
  const d = c.result?.data as { workflow_id?: unknown; batch_id?: unknown; goal_id?: unknown } | null | undefined;
  if (!START_TOOLS.has(c.tool)) return null;
  if (typeof d?.goal_id === "string") return `goal:${d.goal_id}`;
  if (typeof d?.batch_id === "string") return `batch:${d.batch_id}`;
  return typeof d?.workflow_id === "string" ? d.workflow_id : null;
};
export { workflowIdOf };

const isResult = (c: ToolCall) => c.status === "done" && c.risk !== "read" && c.tool !== "remember" && !START_TOOLS.has(c.tool);

/**
 * Builds the transcript items. `answered` = ask_user call ids that already have an answer message; `live` = a run of
 * the conversation is working right now (the last turn is then still in progress).
 */
export function buildTranscript(messages: Message[], calls: ToolCall[], opts: { answered?: Set<string>; live?: boolean } = {}): TranscriptItem[] {
  const answered = opts.answered ?? new Set<string>();
  const seqOf = new Map(messages.map((m) => [m.id, m.seq]));
  const byMessage = new Map<string, ToolCall[]>();
  for (const c of calls) {
    if (!seqOf.has(c.message_id)) continue;
    byMessage.set(c.message_id, [...(byMessage.get(c.message_id) ?? []), c]);
  }
  for (const list of byMessage.values()) list.sort((a, b) => a.position - b.position);

  const out: TranscriptItem[] = [];
  let group: Message[] = [];
  let lastUser: Message | null = null;
  const flush = (isLast: boolean) => {
    if (!group.length) return;
    out.push(makeTurn(group, byMessage, answered, !!opts.live && isLast, lastUser));
    group = [];
  };
  for (const m of messages) {
    if (m.role === "user" || m.role === "compaction") {
      flush(false);
      out.push({ kind: "message", key: m.id, message: m });
      if (m.role === "user") lastUser = m;
    } else group.push(m);
  }
  flush(true);
  // A live run whose first step has not produced a message yet: an empty live turn shows the status row.
  if (opts.live && out.at(-1)?.kind !== "assistant") {
    out.push(makeTurn([], byMessage, answered, true, lastUser));
  }
  return out;
}

function makeTurn(group: Message[], byMessage: Map<string, ToolCall[]>, answered: Set<string>, live: boolean, user: Message | null): AssistantTurn {
  const assistant = group.filter((m) => m.role === "assistant");
  const notices = group.filter((m) => m.role === "notice");
  const calls = assistant.flatMap((m) => byMessage.get(m.id) ?? []);
  const isAsk = (c: ToolCall) => c.tool === "ask_user" && c.status === "done" && !!askArgs(c);
  // Open cards: consent cards of the step, and deletions autopilot deferred (they never hold the turn).
  const pending = calls.filter((c) => c.status === "pending_approval" || c.status === "deferred");
  const asks = calls.filter((c) => isAsk(c) && !answered.has(c.id));
  const workflows = calls.filter((c) => !!workflowIdOf(c));
  const activity = calls.filter((c) => c.status !== "pending_approval" && c.status !== "deferred" && c.tool !== "update_plan" && !isAsk(c) && !workflowIdOf(c));
  const withText = assistant.filter((m) => m.text.trim());
  // While the turn works, a message with text is the answer only when it is the newest one and called no tools (a
  // preamble before tool calls is part of the process); once it ended, the newest text is the answer.
  const lastAssistant = assistant.at(-1);
  const final = live
    ? lastAssistant && lastAssistant.text.trim() && !(byMessage.get(lastAssistant.id)?.length) ? lastAssistant : null
    : (withText.at(-1) ?? null);
  const steps = assistant.filter((m) => m !== final && (m.text.trim() || m.reasoning.trim()));
  const { counts, failed, denied } = countActivity(calls);
  const times = [...group.map((m) => m.created_at), ...calls.map((c) => c.finished_at ?? c.created_at)].filter(Boolean).sort();
  return {
    kind: "assistant",
    // Stable from the first streamed token to the finished answer: the user message it answers.
    key: user ? `turn:${user.id}` : `turn:${group[0]?.id ?? "start"}`,
    messages: group,
    final,
    steps,
    calls,
    activity,
    plan: latestPlan(calls),
    pending,
    asks,
    workflows,
    results: calls.filter(isResult),
    notices,
    counts,
    failed,
    denied,
    hasReasoning: assistant.some((m) => !!m.reasoning.trim()),
    live,
    startedAt: user?.created_at ?? times[0] ?? null,
    endedAt: times.at(-1) ?? null,
  };
}

/** Whether the collapsed row has anything to expand. */
export const hasActivity = (t: AssistantTurn) => t.activity.length > 0 || t.steps.length > 0 || (t.plan?.updates ?? 0) > 1 || (!!t.final?.reasoning.trim());

/** Seconds the turn took (null when unknown or under a second). */
export function turnSeconds(t: Pick<AssistantTurn, "startedAt" | "endedAt">): number | null {
  if (!t.startedAt || !t.endedAt) return null;
  const s = Math.round((new Date(t.endedAt).getTime() - new Date(t.startedAt).getTime()) / 1000);
  return s >= 1 ? s : null;
}

/** Order the summary parts are listed in. */
export const CATEGORY_ORDER: ActivityCategory[] = ["section", "page", "search", "read", "create", "suggest", "edit", "delete", "memory"];

/** The tool call a live turn is working on (running first, then approved, then the newest unfinished). */
export function currentCall(t: AssistantTurn): ToolCall | null {
  return t.calls.findLast((c) => c.status === "running") ?? t.calls.findLast((c) => c.status === "approved") ?? null;
}

// ---------------------------------------------------------------- expand state (per message, this browser session)

const KEY = "agent.turnOpen";
let cache: Record<string, boolean> | null = null;
function load(): Record<string, boolean> {
  if (cache) return cache;
  try {
    cache = JSON.parse(sessionStorage.getItem(KEY) ?? "{}") as Record<string, boolean>;
  } catch {
    cache = {};
  }
  return cache!;
}
export function turnOpen(key: string): boolean {
  return !!load()[key];
}
export function setTurnOpen(key: string, open: boolean) {
  const s = load();
  if (open) s[key] = true;
  else delete s[key];
  // Keep the stored map small.
  const keys = Object.keys(s);
  if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete s[k];
  try {
    sessionStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // storage unavailable: in-memory only
  }
}
