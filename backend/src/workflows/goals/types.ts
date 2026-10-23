/** Goal layer types (docs/architecture.md "Workflows" → Goals). */
import type { Artifact } from "../types.js";
import type { DeliverableKind, Readiness } from "./capabilities.js";

export const GOAL_STATUSES = ["planning", "awaiting_approval", "running", "awaiting_input", "done", "partial", "failed", "cancelled"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];
export const GOAL_ACTIVE: GoalStatus[] = ["planning", "awaiting_approval", "running", "awaiting_input"];
export const GOAL_FINISHED: GoalStatus[] = ["done", "partial", "failed", "cancelled"];

/** `waiting` = its run waits for the user (plan card, question, PDF); `partial` = finished with unmet criteria (the goal carries on). */
export type StageStatus = "pending" | "running" | "waiting" | "done" | "partial" | "failed" | "skipped" | "cancelled";

export type Deliverable = {
  kind: DeliverableKind;
  label: string;
  /** False when no playbook produces it directly: the roadmap says so (never a silent substitute). */
  direct: boolean;
  note?: string;
  language?: "zh" | "en";
  template?: string;
};

export type Stage = {
  id: string;
  playbook: string;
  title: string;
  /** Why this stage is on the roadmap (gaps it closes, what it hands to later stages). */
  why: string;
  request: string;
  /** Playbook inputs (study, paper_id, project_id, language, template…); stage outputs of `uses` are added at start. */
  inputs: Record<string, unknown>;
  /** Earlier stage ids whose artifacts this stage takes as inputs (note → note_ids, LaTeX project → project_id). */
  uses: string[];
  status: StageStatus;
  run_id: string | null;
  artifacts: Artifact[];
  summary?: string;
  issues?: string[];
  added_by: "plan" | "replan" | "user";
};

export type GoalRow = {
  id: string; user_id: string; study_id: string | null; conversation_id: string | null; tool_call_id: string | null;
  title: string; request: string; objective: string; deliverable: Deliverable; status: GoalStatus; stages: Stage[]; current: number;
  autopilot: boolean; context: Record<string, unknown>; readiness: Readiness | null;
  state: { template?: string | null; replans?: number; rounds?: Record<string, number>; planner?: "template" | "llm" };
  history: { at: string; kind: string; text: string }[]; question: string | null;
  /** The goal's fixed Brief (brief.ts): deliverable, the user's words, their deterministic requirements. */
  brief?: import("../brief.js").Brief | null;
  report: { summary_md: string; done: string[]; issues: string[] } | null;
  created_at: string; updated_at: string; finished_at: string | null;
};

/** A planned stage before it has an id/status. */
export type StageDraft = { playbook: string; title: string; why: string; request: string; inputs?: Record<string, unknown>; uses?: number[] };
export type GoalPlan = { title: string; objective: string; deliverable: Deliverable; stages: StageDraft[]; planner: "template" | "llm"; template: string | null };
