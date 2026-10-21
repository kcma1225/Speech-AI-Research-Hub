/** Pure helpers of the workflow card: SSE event reducer, budget usage, outline editing, `/agent` parsing. */
import type { Activity, Artifact, LogLine, Step, Verdict, Workflow } from "./types.ts";

export type WorkflowState = { workflow: Workflow | null; steps: Step[]; activity: Record<string, Activity>; log: LogLine[] };
export const emptyState = (): WorkflowState => ({ workflow: null, steps: [], activity: {}, log: [] });

const MAX_LOG = 60;

/** Applies one SSE event (`workflow`, `step`, `activity`, `verdict`, `artifact`, `log`). Returns a new state. */
export function applyEvent(s: WorkflowState, type: string, data: Record<string, unknown>, now = Date.now()): WorkflowState {
  switch (type) {
    case "workflow": {
      const w = data.workflow as Workflow | undefined;
      return w ? { ...s, workflow: w } : s;
    }
    case "step": {
      const step = data.step as Step | undefined;
      if (!step) return s;
      const i = s.steps.findIndex((x) => x.id === step.id || x.key === step.key);
      const steps = i >= 0 ? s.steps.map((x, j) => (j === i ? step : x)) : [...s.steps, step];
      steps.sort((a, b) => a.position - b.position);
      // A finished step's live activity line is no longer relevant.
      const activity = step.status === "running" || step.status === "verifying" ? s.activity : omit(s.activity, step.key);
      return { ...s, steps, activity };
    }
    case "activity": {
      const key = String(data.step_key ?? "");
      if (!key) return s;
      return { ...s, activity: { ...s.activity, [key]: { step_key: key, role: (data.role as Activity["role"]) ?? "orchestrator", text: String(data.text ?? ""), at: now } } };
    }
    case "verdict": {
      const key = String(data.step_key ?? "");
      const verdict = data.verdict as Verdict | undefined;
      if (!key || !verdict) return s;
      return { ...s, steps: s.steps.map((x) => (x.key === key ? { ...x, verdict } : x)) };
    }
    case "artifact": {
      const a = data.artifact as Artifact | undefined;
      if (!a || !s.workflow) return s;
      const artifacts = [...s.workflow.artifacts.filter((x) => !(x.kind === a.kind && x.id === a.id)), a];
      return { ...s, workflow: { ...s.workflow, artifacts } };
    }
    case "log": {
      const line: LogLine = { level: data.level === "warn" ? "warn" : "info", text: String(data.text ?? ""), at: now };
      return { ...s, log: [...s.log, line].slice(-MAX_LOG) };
    }
    default:
      return s;
  }
}

function omit<T>(o: Record<string, T>, key: string) {
  if (!(key in o)) return o;
  const { [key]: _, ...rest } = o;
  return rest;
}

/** Usage as 0–100 per dimension (the highest one drives the bar). */
export function budgetUsage(w: Pick<Workflow, "budget" | "usage">) {
  const pct = (a: number, b: number) => (b > 0 ? Math.min(100, Math.round((a / b) * 100)) : 0);
  const calls = pct(w.usage.calls ?? 0, w.budget.max_calls);
  const tokens = pct((w.usage.tokens_in ?? 0) + (w.usage.tokens_out ?? 0), w.budget.max_tokens);
  const time = pct(w.usage.active_ms ?? 0, w.budget.max_minutes * 60_000);
  const steps = pct(w.usage.steps ?? 0, w.budget.max_steps);
  return { calls, tokens, time, steps, max: Math.max(calls, tokens, time, steps) };
}

export const criteriaPassed = (w: Pick<Workflow, "criteria">) => w.criteria.filter((c) => c.status === "pass").length;

/** Outline editing (plan card). */
export type EditableOutline = { title: string; points: string[] }[];
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length || from === to) return list;
  const next = [...list];
  const [x] = next.splice(from, 1);
  next.splice(to, 0, x!);
  return next;
}
export function cleanOutline(o: EditableOutline): EditableOutline {
  return o.map((p) => ({ title: p.title.trim().slice(0, 120), points: p.points.map((x) => x.trim().slice(0, 200)).filter(Boolean).slice(0, 8) })).filter((p) => p.title).slice(0, 40);
}
export function outlineChanged(before: { title: string; points: string[] }[] | undefined, after: EditableOutline) {
  const a = JSON.stringify((before ?? []).map((p) => ({ title: p.title, points: p.points })));
  return a !== JSON.stringify(cleanOutline(after));
}

/** `/agent <request>` → the request, else null. */
export function parseAgentCommand(text: string): string | null {
  const m = /^\/agent(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return null;
  return (m[1] ?? "").trim();
}

/** Seconds → 「3 分 20 秒」-style parts. */
export const minutes = (ms: number) => Math.round(ms / 60_000);
