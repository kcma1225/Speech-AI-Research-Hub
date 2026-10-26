/** Workflow engine types (docs/architecture.md "Workflows"). */
import type { ChatMessage, ChatResult, ToolDefinition } from "../ai/types.js";
import type { AiRole } from "../ai/platform/roles.js";

/**
 * `queued` = over the per-user limit of working runs, starts automatically when a slot frees (`promoteQueued`);
 * `needs_pdf` = a paper run that could not get the paper's PDF (open access / the record's URL) — waits for 「從網址下載 PDF」
 * / an upload, never counts as working.
 */
export const WORKFLOW_STATUSES = ["queued", "planning", "awaiting_plan_approval", "running", "verifying", "awaiting_input", "needs_pdf", "paused", "done", "partial", "failed", "cancelled"] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];
export const ACTIVE_STATUSES: WorkflowStatus[] = ["queued", "planning", "awaiting_plan_approval", "running", "verifying", "awaiting_input", "needs_pdf", "paused"];
export const WORKING_STATUSES: WorkflowStatus[] = ["planning", "running", "verifying"];
export const FINISHED_STATUSES: WorkflowStatus[] = ["done", "partial", "failed", "cancelled"];

export const STEP_ROLES = ["planner", "researcher", "writer", "designer", "coder", "verifier", "integrator"] as const;
export type StepRole = (typeof STEP_ROLES)[number];
export type StepStatus = "pending" | "running" | "verifying" | "passed" | "failed" | "skipped" | "cancelled";
export type StepKind = "task" | "integrate" | "final";

/**
 * An acceptance item (the Brief's checklist, else the playbook's criteria). `scope`: `unit` = every step / page / section is
 * judged on it (language, tone, faithful to sources), `artifact` = only the final verification judges it (page count,
 * coverage, per-item fields); unset → derived (verify.ts `scopeOf`). `note` = 「資料未提供」 or a dropped, unverifiable
 * critique: a report note, never a fix.
 */
export type Criterion = { id: string; text: string; kind: "check" | "judge"; check?: CheckSpec; status: "pending" | "pass" | "fail" | "skipped"; reason?: string; evidence?: string; scope?: "unit" | "artifact"; requirement_id?: string; note?: string };
export type CheckSpec = { id: string; params?: Record<string, unknown> };
export type OutlineItem = { n: number; title: string; points: string[] };
/**
 * What a planned write does (autopilot.ts): `new` = creates a new object (deck, note, LaTeX file), `draft_own` = a new
 * draft revision of an object this run created (or an untouched template), `suggestion` = a suggestion the user accepts
 * later — these are draft-only. `overwrite` (existing user content), `publish`, `delete`, `outbound` (user data sent
 * outside the hub) always need the user's approval. A write without `effect` is treated as needing approval.
 */
export type WriteEffect = "new" | "draft_own" | "suggestion" | "overwrite" | "publish" | "delete" | "outbound";
export type PlannedWrite = { kind: string; label: string; effect?: WriteEffect };
/**
 * A requirement the user stated explicitly (requirements.ts): typed so it can be checked deterministically where possible
 * (`language`, `page_count`, `include_topics`, `exclude`, `per_item_fields`) and judged otherwise. `source`: where it came
 * from — the request, a guidance, a recent chat turn, the artifact's standing preferences (「沿用」), or the user's edit on
 * the plan card. Every requirement is a criterion (`req_<id>`) and is injected into every sub-agent prompt.
 */
export type RequirementType = "language" | "page_count" | "include_topics" | "exclude" | "per_item_fields" | "audience" | "tone" | "length" | "format" | "other";
export type RequirementTerm = { name: string; aliases?: string[] };
export type Requirement = {
  id: string; type: RequirementType; text: string;
  params?: {
    language?: "en" | "zh"; exact?: number; min?: number; max?: number; topics?: RequirementTerm[]; terms?: RequirementTerm[]; scope?: "page" | "content";
    pages?: number[]; item_kind?: string; items?: string[]; fields?: RequirementTerm[]; allow?: string[];
    /** Which part of a deck a language / tone requirement is about (absent = the whole artifact): slides = cover, titles, slide text; notes = speaker notes. */
    part?: "slides" | "notes";
    /** include_topics: the topics are the parts the user listed (「呈現 A、B、C」): each gets its own page / section. */
    sections?: boolean;
  };
  source: "request" | "guidance" | "conversation" | "standing" | "user";
  /** The user's own words this requirement rests on (verbatim, from `brief.user_words` / guidance); standing ones have none. */
  quote?: string;
};
/** `revise` = translate / polish an existing artifact (structure kept); `expand` = a deeper or restructured version (new outline). */
export type EditKind = "revise" | "expand";
export type Plan = {
  summary: string; outline?: OutlineItem[]; writes: PlannedWrite[]; notes?: string;
  /** The user's requirements (「你的要求」, editable at approval) — mirrors `state.requirements`. */
  requirements?: Requirement[]; edit_kind?: EditKind; /** Cover title in the target language (decks). */ front_title?: string;
};

export type Budget = { max_steps: number; max_calls: number; max_tokens: number; max_minutes: number; max_fix_rounds: number; concurrency: number };
/** `max_fix_rounds`: per unit (verify.ts / ledger.ts convergence; hard cap 3 whatever a run's budget says). */
export const DEFAULT_BUDGET: Budget = { max_steps: 300, max_calls: 600, max_tokens: 8_000_000, max_minutes: 240, max_fix_rounds: 2, concurrency: 3 };
/** Decks render, screenshot and re-write pages (visual QA ≤ 3 rounds): a cheap model needs more time and calls. */
/** Topic research reads 8–12 papers in full (plus extraction, writers and a consistency pass): more calls and time. */
export const budgetFor = (playbook: string): Budget =>
  playbook === "slides" ? { ...DEFAULT_BUDGET, max_calls: 1000, max_tokens: 20_000_000, max_minutes: 360 }
  : playbook === "topic_research" ? { ...DEFAULT_BUDGET, max_calls: 900, max_tokens: 16_000_000, max_minutes: 360 }
  : DEFAULT_BUDGET;
export type Usage = { steps: number; calls: number; tokens_in: number; tokens_out: number; active_ms: number; fix_rounds: number };

export type Artifact = { kind: "deck" | "note" | "latex_project" | "latex_file" | "paper"; id: string; url: string; title: string; role: "draft" | "suggestion" | "primary"; preview_url?: string; revision?: number };

/**
 * A verifier issue. `kind`: `error` = something in the output is wrong (needs `quote`, copied verbatim from the output),
 * `missing` = required content is absent, `unclear`. `source_quote` = the source passage a faithfulness claim rests on.
 * `id` = its issue-ledger id once recorded (ledger.ts).
 */
export type Issue = {
  severity: "high" | "medium" | "low"; text: string; where?: string; /** 0–1; only high/medium issues with confidence ≥ 0.6 trigger a fix round */ confidence?: number;
  kind?: "error" | "missing" | "unclear"; quote?: string; source_quote?: string; id?: string;
};
/**
 * Issue ledger of one step (`workflow_steps.inputs.ledger`): the first judged round records the actionable issues; later
 * rounds re-check those (fixed / still open, with evidence) and add only new high-severity ones. `open` blocks the step;
 * `unresolved` = a medium/low issue that survived `CONVERGENCE_ROUNDS` fix rounds (a report item, no longer fixed);
 * `invalid` = dropped by the false-positive filter (「驗收者判斷無效」); `note` = 「資料未提供」 (asked for, but the sources do
 * not hold it: a report note, never a fix). `rounds` = fix rounds the issue survived.
 */
export type LedgerStatus = "open" | "fixed" | "unresolved" | "invalid" | "note";
export type LedgerItem = Issue & { id: string; status: LedgerStatus; rounds: number; opened: number; closed?: number; evidence?: string; note?: string; /** identity across rounds (ledger.ts problemKey) */ key?: string };
export type Ledger = { reviewed: boolean; next: number; items: LedgerItem[] };
/** Final-verification ledger (`workflow_runs.state.final_ledger`): per criterion its last result and fail count, and the section hashes of the last judged artifact. */
export type FinalLedgerItem = { status: Criterion["status"]; evidence?: string; reason?: string; fails: number; invalid?: string; note?: string };
export type FinalLedger = { sections: string[]; items: Record<string, FinalLedgerItem> };
export type CheckResult = { id: string; ok: boolean; detail: string };
export type Verdict = { verdict: "pass" | "revise"; issues: Issue[]; checks: CheckResult[]; judged?: boolean };

export type StepOutput = { summary: string; text?: string; data?: unknown };

export type RunRow = {
  id: string; user_id: string; study_id: string | null; conversation_id: string | null; tool_call_id: string | null;
  playbook: string; title: string; request: string; objective: string; criteria: Criterion[]; plan: Plan | null;
  inputs: Record<string, unknown>; context: Record<string, unknown>; state: Record<string, unknown>; status: WorkflowStatus;
  question: string | null; autopilot: boolean; tainted: boolean; taint_sources: string[]; budget: Budget; usage: Usage;
  /** `system`: written by the engine (autopilot 繼續改), not the user's words (not part of the Brief). */
  artifacts: Artifact[]; guidance: { at: string; text: string; applied: boolean; system?: boolean; /** Answers a setup question (which study / paper): an input, not the user's words (never a requirement or the topic). */ setup?: boolean }[];
  report: {
    summary_md: string; done: string[]; issues: string[]; confirm?: string[];
    /** issue ledgers: 已修正 / 仍未解決 / 判定無效 / 資料未提供 */ ledger?: { fixed: string[]; unresolved: string[]; invalid: string[]; notes?: string[] };
    /** Per step: time, fix rounds, which version was kept and why the unit stopped (engine.ts buildReport). */
    steps?: StepReport[];
  } | null; stop_reason: string | null;
  error: { error: string; code?: string; hint?: string } | null; job_id: string | null; pause_requested: boolean; final_rounds: number;
  batch_id: string | null; batch_index: number | null;
  /** A stage of a goal (goals/): the goal advances when this run ends. */
  goal_id?: string | null; goal_stage?: string | null;
  /** The fixed Brief (brief.ts, `0120_workflow_brief.sql`): null only for runs created before it existed. */
  brief?: import("./brief.js").Brief | null; brief_versions?: import("./brief.js").Brief[];
  created_at: string; updated_at: string; started_at: string | null; finished_at: string | null;
};

export type StepReport = { key: string; title: string; status: StepStatus; ms: number; rounds: number; best_round?: number; best_score?: string; kept_best?: boolean; stop?: string; stop_label?: string };

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
  chat(role: AiRole, req: { messages: ChatMessage[]; tools?: ToolDefinition[]; maxTokens?: number; reasoning?: { effort: "low" | "medium" | "minimal" }; signal?: AbortSignal }, ctx: { userId: string; jobId?: string; signal?: AbortSignal; purpose: string; workflowId?: string; stepKey?: string; round?: number }): Promise<ChatResult>;
  /** Whether the role can serve now (ok/degraded). */
  available(role: AiRole): Promise<boolean>;
  vision(role: AiRole): Promise<boolean>;
};

export class WorkflowStop extends Error {
  constructor(readonly reason: "cancelled" | "paused" | "blocked" | "ask" | "budget_steps" | "budget_calls" | "budget_tokens" | "budget_time" | "conflict" | "access", message: string) {
    super(message);
  }
}
