// Goals (backend/src/workflows/goals/, docs/architecture.md "Workflows" → Goals): a fixed final deliverable planned as a
// roadmap of stages; each stage is one workflow run (its own WorkflowCard).
import { api } from "#lib/api.ts";
import type { Artifact } from "#lib/workflows/types.ts";

export type GoalStatus = "planning" | "awaiting_approval" | "running" | "awaiting_input" | "done" | "partial" | "failed" | "cancelled";
export type StageStatus = "pending" | "running" | "waiting" | "done" | "partial" | "failed" | "skipped" | "cancelled";
export const GOAL_ACTIVE: GoalStatus[] = ["planning", "awaiting_approval", "running", "awaiting_input"];

export type Stage = {
  id: string;
  playbook: string;
  playbook_title: string;
  playbook_title_en: string;
  title: string;
  why: string;
  request: string;
  uses: string[];
  status: StageStatus;
  run_id: string | null;
  run_status: string | null;
  artifacts: Artifact[];
  summary?: string;
  issues?: string[];
  gaps: string[];
  added_by: "plan" | "replan" | "user";
};

export type Goal = {
  id: string;
  title: string;
  request: string;
  objective: string;
  deliverable: { kind: string; label: string; direct: boolean; note?: string; language?: "zh" | "en"; template?: string };
  status: GoalStatus;
  needs_you: boolean;
  action: "approve_plan" | "answer" | null;
  question: string | null;
  stages: Stage[];
  current: number;
  autopilot: boolean;
  readiness: string[];
  planner: "template" | "llm";
  history: { at: string; kind: string; text: string }[];
  report: { summary_md: string; done: string[]; issues: string[] } | null;
  conversation_id: string | null;
  study: { id: string; slug: string; title: string } | null;
  finished: boolean;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
};

export type StageEdit = { id?: string; playbook?: string; title?: string; request?: string; why?: string; skip?: boolean };
type G = { goal: Goal | null };

export const goalsApi = {
  get: (id: string) => api.get<{ goal: Goal }>(`/goals/${id}`),
  list: (q: { conversation?: string; active?: boolean } = {}) => {
    const p = new URLSearchParams();
    if (q.conversation) p.set("conversation", q.conversation);
    if (q.active) p.set("active", "1");
    const s = p.toString();
    return api.get<{ goals: Goal[] }>(`/goals${s ? `?${s}` : ""}`);
  },
  approve: (id: string, stages?: StageEdit[]) => api.post<G>(`/goals/${id}/approve`, stages ? { stages } : {}),
  editStages: (id: string, stages: StageEdit[]) => api.put<G>(`/goals/${id}/stages`, { stages }),
  resume: (id: string, action: "retry" | "skip") => api.post<G>(`/goals/${id}/resume`, { action }),
  update: (id: string, request: string) => api.patch<G>(`/goals/${id}`, { request }),
  cancel: (id: string) => api.post<G>(`/goals/${id}/cancel`),
  remove: (id: string) => api.del<{ ok: true }>(`/goals/${id}`),
};
