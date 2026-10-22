/**
 * Workflow playbooks: structured templates the orchestrator starts from. Modules register more with
 * `registerWorkflowPlaybook(def)` (import side effect; `src/workflows/playbooks/index.ts` imports the built-ins).
 */
import type { Criterion, OutlineItem, Plan, StepOutput, StepRow, StepSpec } from "../types.js";
import type { WorkflowEnv } from "../env.js";

export type PlanResult =
  | { kind: "plan"; title?: string; objective: string; criteria: Omit<Criterion, "status">[]; plan: Plan; steps: StepSpec[]; studyId?: string | null }
  /** Blocked: the run waits in `awaiting_input` with this question (e.g. 「這篇論文沒有 PDF…」). */
  | { kind: "question"; question: string }
  /** The paper has no PDF (open access + the record's URL tried): status `needs_pdf` with 「從網址下載 PDF」 / upload. */
  | { kind: "needs_pdf"; message: string; paperId: string }
  /** The user chose to skip this item (e.g. 「跳過」 on the missing-PDF card): the run ends `cancelled` / `skipped`. */
  | { kind: "skip"; message: string }
  /** Another playbook fits the request better (a topic survey asked as a reading note): the engine switches and re-plans. */
  | { kind: "redirect"; playbook: string; message: string };

export type ApprovalEdits = { outline?: { title: string; points: string[] }[]; steps?: { key: string; title?: string; instructions?: string; skip?: boolean }[] };

export interface WorkflowPlaybook {
  id: string;
  title: string;
  titleEn: string;
  description: string;
  descriptionEn: string;
  /** 0–1: how well a free-text request matches (the highest wins; generic is the fallback). */
  detect(request: string, inputs: Record<string, unknown>): number;
  /** What it produces / requires (goal planner, goals/capabilities.ts); built-ins without it use the capability table there. */
  capability?: import("../goals/capabilities.js").Capability;
  /** Plans may be auto-approved under autopilot (writes only new drafts; never destructive). */
  autoApprovable: boolean;
  /** Gathers context and writes objective + criteria + plan + steps. */
  plan(env: WorkflowEnv): Promise<PlanResult>;
  /** The user edited the outline / steps on the plan card: return the step list to use (default: keep). */
  applyEdits?(env: WorkflowEnv, edits: ApprovalEdits, outline: OutlineItem[] | undefined): Promise<{ steps?: StepSpec[]; outline?: OutlineItem[] }>;
  /** Runs one step (one round). `fix` = the previous output + the issues to fix. */
  execute(env: WorkflowEnv, step: StepRow, fix: { previous: StepOutput; issues: string[] } | null): Promise<StepOutput>;
  /** Final verification input: the integrated artifact text and data for deterministic criteria. */
  finalText(env: WorkflowEnv): Promise<{ text: string; data: unknown }>;
  /** Failing criteria → steps to reopen with these issues (their dependents are re-run too). */
  repair?(env: WorkflowEnv, failing: Criterion[]): Promise<{ key: string; issues: string[] }[]>;
  /** `repair` maps failing requirement criteria (`req_*`) itself; otherwise the engine reopens the writers whose output fails them. */
  handlesRequirements?: boolean;
  /** At the end (done or partial): write the artifact once (notes) and return a short line for the report. */
  commit?(env: WorkflowEnv, outcome: "done" | "partial"): Promise<string | null>;
}

const playbooks = new Map<string, WorkflowPlaybook>();

export function registerWorkflowPlaybook(def: WorkflowPlaybook) {
  if (!/^[a-z][a-z0-9_]{1,47}$/.test(def.id)) throw new Error(`invalid playbook id ${def.id}`);
  playbooks.set(def.id, def);
}
export const getWorkflowPlaybook = (id: string) => playbooks.get(id) ?? null;
export const listWorkflowPlaybooks = () => [...playbooks.values()];

/** Best playbook for a request (generic when nothing scores ≥ 0.3). */
export function detectPlaybook(request: string, inputs: Record<string, unknown>): string {
  let best = "generic";
  let score = 0.29;
  for (const p of playbooks.values()) {
    if (p.id === "generic") continue;
    const s = p.detect(request, inputs);
    if (s > score) {
      best = p.id;
      score = s;
    }
  }
  return best;
}
