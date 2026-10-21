/**
 * Live overview of everything an AI agent is doing for one user (shell indicator 「N 個 Agent 執行中」 + its popover):
 * active workflow runs and assistant runs that are working or waiting for the user. Small, poll-friendly payload —
 * statuses, counts and one-line activity; never message or document content beyond titles and the activity line.
 */
import type { Queryable } from "../db.js";
import { runView } from "./store.js";
import type { RunRow } from "./types.js";

const ACTIVE_WF = ["planning", "awaiting_plan_approval", "running", "verifying", "awaiting_input", "paused"];
const NEEDS_YOU_WF = new Set(["awaiting_plan_approval", "awaiting_input"]);
/** An unanswered ask_user card older than this no longer counts as "waiting for you". */
const ASK_WINDOW_HOURS = 24;

export type ActiveAgentRun = {
  kind: "workflow" | "assistant";
  id: string;
  title: string;
  objective: string | null;
  /** Workflow status, or the assistant run's status (`awaiting_input` = an unanswered question card). */
  status: string;
  needs_you: boolean;
  conversation_id: string | null;
  study: { id: string; slug: string; title: string } | null;
  /** Current sub-agent role (workflows) / tool (assistant) and its one-line activity. */
  current: { role: string | null; text: string } | null;
  progress: { done: number; total: number } | null;
  plan: { done: number; total: number; current: string | null } | null;
  step: { step: number; max: number } | null;
  budget_pct: number | null;
  tokens: number;
  artifacts: { kind: string; id: string; url: string; title: string }[];
  started_at: string;
  updated_at: string;
};

type PlanArgs = { plan?: { step?: unknown; status?: unknown }[] };
function planOf(args: PlanArgs | null | undefined) {
  const items = Array.isArray(args?.plan) ? args!.plan.filter((p) => p && typeof p.step === "string") : [];
  if (!items.length) return null;
  return {
    done: items.filter((p) => p.status === "completed").length,
    total: items.length,
    current: (items.find((p) => p.status === "in_progress")?.step as string | undefined) ?? null,
  };
}
const pct = (a: number, b: number) => (b > 0 ? Math.min(100, Math.round((a / b) * 100)) : 0);
const iso = (d: Date | string | null | undefined) => (d instanceof Date ? d.toISOString() : d ? String(d) : new Date(0).toISOString());

export async function activeAgentRuns(db: Queryable, userId: string): Promise<ActiveAgentRun[]> {
  const out: ActiveAgentRun[] = [];

  // ---------------------------------------------------------------- workflows
  const runs = (await db.query<RunRow>(`SELECT * FROM workflow_runs WHERE user_id=$1 AND status = ANY($2) ORDER BY created_at DESC LIMIT 20`, [userId, ACTIVE_WF])).rows;
  if (runs.length) {
    const ids = runs.map((r) => r.id);
    const steps = (await db.query<{ run_id: string; role: string; title: string; status: string; started_at: Date | null }>(
      "SELECT run_id, role, title, status, started_at FROM workflow_steps WHERE run_id = ANY($1)",
      [ids],
    )).rows;
    const activity = (await db.query<{ run_id: string; data: { role?: string; text?: string } }>(
      `SELECT DISTINCT ON (run_id) run_id, data FROM workflow_events WHERE run_id = ANY($1) AND type='activity' ORDER BY run_id, seq DESC`,
      [ids],
    )).rows;
    for (const r of runs) {
      const v = await runView(db, r);
      const mine = steps.filter((s) => s.run_id === r.id);
      const working = mine.filter((s) => s.status === "running" || s.status === "verifying").sort((a, b) => (b.started_at?.getTime() ?? 0) - (a.started_at?.getTime() ?? 0))[0];
      const act = ["planning", "running", "verifying"].includes(r.status) ? activity.find((a) => a.run_id === r.id)?.data : undefined;
      const u = r.usage ?? ({} as RunRow["usage"]);
      const b = r.budget ?? ({} as RunRow["budget"]);
      const budget = Math.max(
        pct(u.calls ?? 0, b.max_calls ?? 0),
        pct((u.tokens_in ?? 0) + (u.tokens_out ?? 0), b.max_tokens ?? 0),
        pct(u.active_ms ?? 0, (b.max_minutes ?? 0) * 60_000),
        pct(u.steps ?? 0, b.max_steps ?? 0),
      );
      out.push({
        kind: "workflow",
        id: r.id,
        title: r.title,
        objective: r.objective || r.request || null,
        status: r.status,
        needs_you: NEEDS_YOU_WF.has(r.status),
        conversation_id: r.conversation_id,
        study: v.study,
        current: act?.text ? { role: act.role ?? working?.role ?? null, text: String(act.text).slice(0, 200) } : working ? { role: working.role, text: working.title.slice(0, 200) } : null,
        progress: mine.length ? { done: mine.filter((s) => s.status === "passed" || s.status === "skipped").length, total: mine.length } : null,
        plan: null,
        step: null,
        budget_pct: u.calls ? budget : null,
        tokens: (u.tokens_in ?? 0) + (u.tokens_out ?? 0),
        artifacts: (r.artifacts ?? []).slice(0, 4).map((a) => ({ kind: a.kind, id: a.id, url: a.url, title: a.title })),
        started_at: iso(r.started_at ?? r.created_at),
        updated_at: iso(r.updated_at),
      });
    }
  }

  // ---------------------------------------------------------------- assistant runs
  // The latest run of each of my conversations, when it is working / waiting for me, or ended on an unanswered card.
  const latest = (await db.query<{
    id: string; conversation_id: string; status: string; stop_reason: string | null; step: number; max_steps: number; tokens_in: number; tokens_out: number;
    started_at: Date; updated_at: Date; finished_at: Date | null; title: string; mode: string;
  }>(
    // Newest run per conversation first (approvals expire after 24 h, so older runs can never be active), then filter.
    `SELECT * FROM (
       SELECT DISTINCT ON (r.conversation_id) r.id, r.conversation_id, r.status, r.stop_reason, r.step, r.max_steps, r.tokens_in, r.tokens_out,
              r.started_at, r.updated_at, r.finished_at, c.title, c.mode
         FROM agent_runs r JOIN conversations c ON c.id = r.conversation_id
        WHERE c.user_id = $1 AND r.started_at > now() - interval '2 days'
        ORDER BY r.conversation_id, r.started_at DESC, r.id DESC) x
      WHERE x.status IN ('running','awaiting_approval','awaiting_llm')
         OR (x.status = 'done' AND x.stop_reason = 'awaiting_input' AND x.mode = 'chat' AND x.finished_at > now() - make_interval(hours => $2))`,
    [userId, ASK_WINDOW_HOURS],
  )).rows;
  for (const r of latest) {
    // Work of the current turn: calls after the last user message of the current branch.
    const lastUser = (await db.query<{ seq: string }>(
      "SELECT max(seq)::text AS seq FROM agent_messages WHERE conversation_id=$1 AND role='user' AND hidden_by IS NULL",
      [r.conversation_id],
    )).rows[0]?.seq ?? "0";
    if (r.status === "done") {
      // A question card answered by a normal message (or edited away) is no longer waiting.
      const after = (await db.query(
        `SELECT 1 FROM agent_messages m WHERE m.conversation_id=$1 AND m.hidden_by IS NULL AND m.run_id=$2 LIMIT 1`,
        [r.conversation_id, r.id],
      )).rowCount;
      const later = (await db.query(
        `SELECT 1 FROM agent_messages m WHERE m.conversation_id=$1 AND m.hidden_by IS NULL AND m.role='user'
            AND m.seq > (SELECT coalesce(max(seq),0) FROM agent_messages WHERE run_id=$2) LIMIT 1`,
        [r.conversation_id, r.id],
      )).rowCount;
      if (!after || later) continue;
    }
    const calls = (await db.query<{ tool: string; title: string; summary: string; status: string; args: PlanArgs }>(
      `SELECT tc.tool, tc.tool AS title, tc.summary, tc.status, tc.args
         FROM tool_calls tc JOIN agent_messages m ON m.id = tc.message_id
        WHERE tc.conversation_id=$1 AND m.hidden_by IS NULL AND m.seq > $2::bigint
        ORDER BY m.seq, tc.position`,
      [r.conversation_id, lastUser],
    )).rows;
    const planCall = calls.filter((c) => c.tool === "update_plan" && c.status === "done").at(-1);
    const plan = planOf(planCall?.args);
    const runningCall = calls.findLast((c) => c.status === "running" || c.status === "approved");
    const status = r.status === "done" ? "awaiting_input" : r.status;
    const current = runningCall
      ? { role: runningCall.tool, text: (runningCall.summary || runningCall.tool).slice(0, 200) }
      : r.status === "awaiting_approval"
        ? { role: null, text: (calls.findLast((c) => c.status === "pending_approval")?.summary ?? "").slice(0, 200) }
        : plan?.current
          ? { role: null, text: plan.current.slice(0, 200) }
          : null;
    out.push({
      kind: "assistant",
      id: r.id,
      title: r.title,
      objective: null,
      status,
      needs_you: status === "awaiting_approval" || status === "awaiting_input",
      conversation_id: r.conversation_id,
      study: null,
      current: current && current.text ? current : null,
      progress: null,
      plan,
      step: { step: Math.min(r.step + (r.status === "running" ? 1 : 0), r.max_steps), max: r.max_steps },
      budget_pct: null,
      tokens: r.tokens_in + r.tokens_out,
      artifacts: [],
      started_at: iso(r.started_at),
      updated_at: iso(r.updated_at),
    });
  }
  // "Needs you" first, then the most recently updated.
  out.sort((a, b) => Number(b.needs_you) - Number(a.needs_you) || b.updated_at.localeCompare(a.updated_at));
  return out;
}
