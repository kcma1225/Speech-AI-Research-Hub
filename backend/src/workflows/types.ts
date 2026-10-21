/** Workflow engine types (docs/architecture.md "Workflows"). */
import type { ChatMessage, ChatResult, ToolDefinition } from "../ai/types.js";
import type { AiRole } from "../ai/platform/roles.js";

export const WORKFLOW_STATUSES = ["planning", "awaiting_plan_approval", "running", "verifying", "awaiting_input", "paused", "done", "partial", "failed", "cancelled"] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];
export const ACTIVE_STATUSES: WorkflowStatus[] = ["planning", "awaiting_plan_approval", "running", "verifying", "awaiting_input", "paused"];
export const WORKING_STATUSES: WorkflowStatus[] = ["planning", "running", "verifying"];
export const FINISHED_STATUSES: WorkflowStatus[] = ["done", "partial", "failed", "cancelled"];

export const STEP_ROLES = ["planner", "researcher", "writer", "designer", "coder", "verifier", "integrator"] as const;
export type StepRole = (typeof STEP_ROLES)[number];
export type StepStatus = "pending" | "running" | "verifying" | "passed" | "failed" | "skipped" | "cancelled";
export type StepKind = "task" | "integrate" | "final";

export type Criterion = { id: string; text: string; kind: "check" | "judge"; check?: CheckSpec; status: "pending" | "pass" | "fail" | "skipped"; reason?: string; evidence?: string };
export type CheckSpec = { id: string; params?: Record<string, unknown> };
export type OutlineItem = { n: number; title: string; points: string[] };
export type Plan = { summary: string; outline?: OutlineItem[]; writes: { kind: string; label: string }[]; notes?: string };

export type Budget = { max_steps: number; max_calls: number; max_tokens: number; max_minutes: number; max_fix_rounds: number; concurrency: number };
export const DEFAULT_BUDGET: Budget = { max_steps: 30, max_calls: 60, max_tokens: 800_000, max_minutes: 40, max_fix_rounds: 2, concurrency: 3 };
export type Usage = { steps: number; calls: number; tokens_in: number; tokens_out: number; active_ms: number; fix_rounds: number };

export type Artifact = { kind: "deck" | "note" | "latex_project" | "latex_file" | "paper"; id: string; url: string; title: string; role: "draft" | "suggestion" | "primary"; preview_url?: string; revision?: number };

export type Issue = { severity: "high" | "medium" | "low"; text: string; where?: string; /** 0–1; only high/medium issues with confidence ≥ 0.6 trigger a fix round */ confidence?: number };
export type CheckResult = { id: string; ok: boolean; detail: string };
export type Verdict = { verdict: "pass" | "revise"; issues: Issue[]; checks: CheckResult[]; judged?: boolean };

export type StepOutput = { summary: string; text?: string; data?: unknown };

export type RunRow = {
  id: string; user_id: string; study_id: string | null; conversation_id: string | null; tool_call_id: string | null;
  playbook: string; title: string; request: string; objective: string; criteria: Criterion[]; plan: Plan | null;
  inputs: Record<string, unknown>; context: Record<string, unknown>; state: Record<string, unknown>; status: WorkflowStatus;
  question: string | null; autopilot: boolean; tainted: boolean; taint_sources: string[]; budget: Budget; usage: Usage;
  artifacts: Artifact[]; guidance: { at: string; text: string; applied: boolean }[];
  report: { summary_md: string; done: string[]; issues: string[] } | null; stop_reason: string | null;
  error: { error: string; code?: string; hint?: string } | null; job_id: string | null; pause_requested: boolean; final_rounds: number;
  created_at: string; updated_at: string; started_at: string | null; finished_at: string | null;
};

export type StepRow = {
  id: string; run_id: string; parent_id: string | null; key: string; position: number; role: StepRole; kind: StepKind;
  title: string; instructions: string; depends_on: string[]; inputs: Record<string, unknown>; expected: string;
  verify: { checks: CheckSpec[]; judge: boolean }; status: StepStatus; attempts: number; round: number; max_rounds: number | null;
  output: StepOutput | null; artifacts: Artifact[]; verdict: Verdict | null; history: { round: number; verdict: Verdict; summary: string }[];
  tokens_in: number; tokens_out: number; ms: number; error: string | null;
  created_at: string; started_at: string | null; finished_at: string | null;
};

/** A step a playbook plans (inserted as a workflow_steps row). */
export type StepSpec = {
  key: string; role: StepRole; kind?: StepKind; title: string; instructions: string; depends_on?: string[];
  inputs?: Record<string, unknown>; expected?: string; verify?: { checks: CheckSpec[]; judge: boolean }; max_rounds?: number;
  /** Already done during planning (research, outline): inserted as `passed` with this output/verdict. */
  done?: { output: StepOutput; verdict?: Verdict; round?: number; history?: StepRow["history"] };
};

/** The model port of the engine (the AI platform in production; a scripted mock in tests). */
export type ModelPort = {
  chat(role: AiRole, req: { messages: ChatMessage[]; tools?: ToolDefinition[]; maxTokens?: number; reasoning?: { effort: "low" | "medium" | "minimal" }; signal?: AbortSignal }, ctx: { userId: string; jobId?: string; signal?: AbortSignal; purpose: string }): Promise<ChatResult>;
  /** Whether the role can serve now (ok/degraded). */
  available(role: AiRole): Promise<boolean>;
  vision(role: AiRole): Promise<boolean>;
};

export class WorkflowStop extends Error {
  constructor(readonly reason: "cancelled" | "paused" | "blocked" | "ask" | "budget_steps" | "budget_calls" | "budget_tokens" | "budget_time" | "conflict" | "access", message: string) {
    super(message);
  }
}
