/** API shapes of /api/workflows (backend/src/workflows/store.ts runView / stepView). */
export type WorkflowStatus = "planning" | "awaiting_plan_approval" | "running" | "verifying" | "awaiting_input" | "paused" | "done" | "partial" | "failed" | "cancelled";
export type StepRole = "planner" | "researcher" | "writer" | "designer" | "coder" | "verifier" | "integrator";
export type StepStatus = "pending" | "running" | "verifying" | "passed" | "failed" | "skipped" | "cancelled";

export type Criterion = { id: string; text: string; kind: "check" | "judge"; status: "pending" | "pass" | "fail" | "skipped"; reason?: string };
export type OutlineItem = { n: number; title: string; points: string[]; student_owned?: boolean };
export type Plan = { summary: string; outline?: OutlineItem[]; writes: { kind: string; label: string }[]; notes?: string };
export type Budget = { max_steps: number; max_calls: number; max_tokens: number; max_minutes: number; max_fix_rounds: number; concurrency: number };
export type Usage = { steps: number; calls: number; tokens_in: number; tokens_out: number; active_ms: number; fix_rounds: number };
export type Artifact = { kind: "deck" | "note" | "latex_project" | "latex_file" | "paper"; id: string; url: string; title: string; role: "draft" | "suggestion" | "primary"; preview_url?: string; revision?: number };
export type Issue = { severity: "high" | "medium" | "low"; text: string; where?: string };
export type Verdict = { verdict: "pass" | "revise"; issues: Issue[]; checks: { id: string; ok: boolean; detail: string }[]; judged?: boolean };

export type Workflow = {
  id: string;
  title: string;
  playbook: string;
  playbook_title: string;
  playbook_title_en: string;
  status: WorkflowStatus;
  request: string;
  objective: string;
  criteria: Criterion[];
  plan: Plan | null;
  study: { id: string; slug: string; title: string } | null;
  conversation_id: string | null;
  autopilot: boolean;
  tainted: boolean;
  taint_sources: string[];
  budget: Budget;
  usage: Usage;
  artifacts: Artifact[];
  guidance: { at: string; text: string; applied: boolean }[];
  report: { summary_md: string; done: string[]; issues: string[] } | null;
  stop_reason: string | null;
  error: { error: string; code?: string; hint?: string } | null;
  question: string | null;
  /** Question cards the run asked (pending = waiting for the answer; answered ones can be edited). */
  asks?: WorkflowAsk[];
  job: { status: string; stage: string | null } | null;
  created_at: string;
  updated_at: string;
  started_at?: string | null;
  finished_at: string | null;
};

export type Step = {
  id: string;
  key: string;
  parent_key: string | null;
  position: number;
  role: StepRole;
  kind: "task" | "integrate" | "final";
  title: string;
  instructions: string;
  depends_on: string[];
  expected: string;
  verify: { checks: { id: string; params?: Record<string, unknown> }[]; judge: boolean };
  status: StepStatus;
  attempts: number;
  round: number;
  output: { summary: string; excerpt?: string } | null;
  verdict: Verdict | null;
  history: { round: number; verdict: Verdict; summary: string }[];
  tokens: { in: number; out: number };
  ms: number;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
};

export type Activity = { step_key: string; role: StepRole | "orchestrator"; text: string; at: number };
export type LogLine = { level: "info" | "warn"; text: string; at: number };

export type WorkflowDetail = { workflow: Workflow; steps: Step[]; resumeFrom: number };
export type Playbook = { id: string; title: string; title_en: string; description: string; description_en: string; auto_approvable: boolean };

export const ACTIVE: WorkflowStatus[] = ["planning", "awaiting_plan_approval", "running", "verifying", "awaiting_input", "paused"];
export const WORKING: WorkflowStatus[] = ["planning", "running", "verifying"];
export const FINISHED: WorkflowStatus[] = ["done", "partial", "failed", "cancelled"];

/** A workflow question card (backend `questions.ts`), rendered with the `ask_user` AskCard. */
export type WorkflowAsk = {
  id: string;
  title: string;
  intro?: string;
  questions: import("#lib/agent/types.ts").AskQuestion[];
  step_key: string | null;
  purpose: "input" | "blocked";
  ai_suggested: boolean;
  asked_at: string;
  answers?: import("#lib/agent/types.ts").Answer[];
  answered_at?: string;
  edited?: number;
  pending: boolean;
};
