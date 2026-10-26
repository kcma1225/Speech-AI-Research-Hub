/**
 * The Brief (docs/architecture.md "Workflows" → Brief): the single, fixed statement of what a run (or goal) has to deliver,
 * built once before any playbook-specific planning and carried into every sub-agent call.
 *
 * - `deliverable` (hard): the kind of artifact the user asked for. Routing, playbook redirects, the repeated-question
 *   fallback and goal stages keep it; a switch to a playbook that produces another kind stops and asks (`switchGuard`).
 * - `user_words`: the user's own words, verbatim (the chat turns that asked + their guidance / clarifying answers). The
 *   assistant's `start_workflow` request is stored as `paraphrase` and is never a source of requirements.
 * - `requirements`: requirements.ts, grounded in `user_words` only (each model-extracted item quotes them verbatim) plus
 *   the artifact's standing preferences for what the user did not restate.
 * - `unspecified`: what the user did not say (「未指定」) — never invented (no default page count becomes a requirement).
 * - `checklist`: the acceptance list (= the run's criteria, ids shared; `source` user | playbook). P1's verification reads it
 *   through `checklistOf`.
 *
 * Versioned and immutable (`0120_workflow_brief.sql` trigger): version 0 is the seed written at creation, version 1 is built
 * at planning; later versions only come from the user (guidance, plan-card edits, a clarifying answer, an approved
 * deliverable change). Agents have no write path to it.
 */
import { createHash } from "node:crypto";
import type { Queryable } from "../db.js";
import { askUser, asksOf, isSkipped, answerLines } from "./questions.js";
import { capabilityOf, DELIVERABLE_LABEL, deliverableOf, type DeliverableKind } from "./goals/capabilities.js";
import { getWorkflowPlaybook } from "./playbooks/registry.js";
import type { WorkflowEnv } from "./env.js";
import type { CheckSpec, Criterion, Requirement, RunRow, StepRow } from "./types.js";
import { instructionOf } from "./material.js";

export type BriefKind = "deck" | "note" | "latex" | "lit_review" | "reading_note" | "other";
export const BRIEF_KINDS: BriefKind[] = ["deck", "note", "latex", "lit_review", "reading_note", "other"];
export const BRIEF_KIND_LABEL: Record<BriefKind, string> = { deck: "簡報", note: "筆記", latex: "LaTeX 論文", lit_review: "文獻回顧筆記", reading_note: "閱讀筆記", other: "其他成果" };

export type ChecklistItem = { id: string; text: string; kind: "check" | "judge"; check?: CheckSpec; requirement_id?: string; source: "user" | "playbook" };
/** What produced a version: the seed at creation, planning, the user's guidance / plan-card edit / clarifying answer / deliverable choice. */
export type BriefSource = "start" | "plan" | "guidance" | "edit" | "clarify" | "deliverable";
export type Brief = {
  version: number;
  deliverable: { kind: BriefKind; label: string; hard: true };
  user_words: string[];
  /** How many of `user_words` came with the start (the rest are guidance / answers, oldest first). */
  base: number;
  paraphrase: string | null;
  requirements: Requirement[];
  unspecified: string[];
  checklist: ChecklistItem[];
  source: BriefSource;
  /** A clarifying question was asked (at most one per run). */
  clarified?: boolean;
  /** Hash of the inputs this version was built from (a re-plan without new user input keeps the version). */
  key?: string;
  at: string;
};

/** Budget of the user's words in prompts (verbatim, newest kept whole). */
export const USER_WORDS_MAX = 1500;

// ---------------------------------------------------------------- deliverable kinds

export const briefKindOf = (k: DeliverableKind): BriefKind =>
  k === "deck" ? "deck" : k === "paper" || k === "paper_section" ? "latex" : k === "lit_review" ? "lit_review" : k === "reading_note" ? "reading_note" : "note";
/** The kind a playbook produces (its capability). */
export const playbookKind = (playbook: string): BriefKind => {
  const c = capabilityOf(playbook);
  return c ? briefKindOf(c.produces) : "other";
};
/** Notes of different flavours are one deliverable (a reading note asked for a topic survey becomes a topic note); a deck or LaTeX never becomes a note. */
const NOTE_FAMILY = new Set<BriefKind>(["note", "lit_review", "reading_note"]);
export const sameDeliverable = (a: BriefKind, b: BriefKind) => a === b || (NOTE_FAMILY.has(a) && NOTE_FAMILY.has(b));

/** 「整理成筆記」「做成簡報」「write it up as a note」: the target the user names explicitly (wins over a mention). */
const TARGET_RE = /(?:做成|整理成|寫成|轉成|改成|變成|弄成|產出|生成|做一份|寫一份|整理一份|準備一份|弄一份|做一篇|寫一篇|給我一份|給我一個|turn (?:it|this) into|make (?:it|this) (?:into )?|write (?:it|this) up as)\s*(?:一份|一個|一篇|an?\s+)?(英文|中文|english\s+)?(論文報告|閱讀筆記|文獻回顧|簡報|投影片|筆記|latex\s*論文|論文(?![報的筆大摘])|slides?|deck|presentation|reading note|literature review|note|paper(?!\s*(?:report|title|summary)))/i;
const TARGET_KIND: [RegExp, DeliverableKind][] = [[/論文報告|簡報|投影片|slide|deck|presentation/i, "deck"], [/閱讀筆記|reading note/i, "reading_note"], [/文獻回顧|literature review/i, "lit_review"], [/latex|論文|paper/i, "paper"], [/筆記|note/i, "note"]];

/** The deliverable the user's words name, newest turn first: an explicit target (「整理成筆記」), else a mention (簡報 …). */
export function deliverableFromWords(words: string[]): DeliverableKind | null {
  for (const w of [...words].reverse()) {
    const m = TARGET_RE.exec(w);
    const k = m ? TARGET_KIND.find(([re]) => re.test(m[2]!))?.[1] : deliverableOf(w);
    if (k) return k;
  }
  return null;
}

/**
 * The run's deliverable: the user's words, else the assistant's request (what it proposed and the plan card shows), else
 * what the playbook produces.
 */
export function deliverableFor(words: string[], paraphrase: string | null, playbook: string): { kind: BriefKind; label: string } {
  const named = deliverableFromWords(words) ?? (paraphrase ? deliverableFromWords([paraphrase]) : null);
  if (named) return { kind: briefKindOf(named), label: DELIVERABLE_LABEL[named] };
  const c = capabilityOf(playbook);
  return c ? { kind: briefKindOf(c.produces), label: DELIVERABLE_LABEL[c.produces] } : { kind: "other", label: BRIEF_KIND_LABEL.other };
}

// ---------------------------------------------------------------- the user's words

const squash = (t: string) => t.replace(/\s+/g, " ").trim();
/** The user's words within budget: newest turns kept whole, older ones clipped, oldest dropped first. */
export function clipWords(words: string[], max = USER_WORDS_MAX): string[] {
  const out: string[] = [];
  let left = max;
  for (const w of [...words].reverse()) {
    const t = squash(w).slice(0, 1200);
    if (!t || left <= 40) continue;
    out.unshift(t.length > left ? `${t.slice(0, left - 1)}…` : t);
    left -= Math.min(t.length, left);
  }
  return out;
}

/** 「ok」「好」「謝謝」: an acknowledgement, never part of a task. */
const ACK_RE = /^(?:ok(?:ay)?|k|好的?|好喔|好哦|嗯+|恩+|收到|了解|知道了|謝謝|感謝|thanks?(?: you)?|thx|got it|sure|沒問題|讚|👍)[\s。.!！~～]*$/i;

type Turn = { role: string; text: string; content: unknown };
const asksBack = (t: Turn) => {
  const blocks = Array.isArray(t.content) ? (t.content as { type?: string; name?: string }[]) : [];
  if (blocks.some((b) => b.type === "tool_use" && b.name === "ask_user")) return true;
  return /[？?]\s*$/.test(t.text.trim());
};

/**
 * Which of the conversation's recent user turns are part of the task (pure, unit-tested; production e6d552fc: a question
 * the assistant had already answered — 「偏向 Hot Word 還是 Contextual Biasing」 — and an 「ok」 became the notes request's
 * words): walking back from the newest turn over consecutive user messages and over assistant turns that asked back
 * (an ask_user card / ending with a question mark); an assistant answer ends the task — earlier turns were another
 * exchange. Acknowledgements (「ok」「好」) never count unless they are the only turn.
 */
export function taskTurns(turns: Turn[]): string[] {
  const out: string[] = [];
  for (let j = turns.length - 1; j >= 0; j--) {
    const m = turns[j]!;
    if (m.role === "user") {
      if (m.text.trim()) out.unshift(m.text);
      continue;
    }
    if (m.role !== "assistant") continue;
    if (!out.length) continue; // the same agent turn's preamble before its tool call
    if (asksBack(m)) continue;
    if (!m.text.trim()) continue; // a tool-only step of the same agent turn
    break;
  }
  const kept = out.filter((t, i) => i === out.length - 1 || !ACK_RE.test(t.trim()));
  return kept.slice(-3);
}

/**
 * The user's own turns that asked for this task: the conversation's latest user messages since the previous
 * start_workflow / start_goal of that conversation that belong to the task (`taskTurns`, ≤ 3, newest last), verbatim.
 * Empty without a conversation.
 */
export async function collectUserWords(db: Queryable, conversationId: string | null | undefined): Promise<string[]> {
  if (!conversationId) return [];
  const boundary = (await db.query<{ seq: string | null }>(
    `SELECT max(seq) AS seq FROM agent_messages WHERE conversation_id=$1 AND role='assistant'
        AND (content @> '[{"type":"tool_use","name":"start_workflow"}]'::jsonb OR content @> '[{"type":"tool_use","name":"start_goal"}]'::jsonb)
        AND seq < (SELECT coalesce(max(seq), 0) FROM agent_messages WHERE conversation_id=$1 AND role='user' AND hidden_by IS NULL)`,
    [conversationId],
  ).catch(() => ({ rows: [] as { seq: string | null }[] }))).rows[0]?.seq ?? "0";
  const rows = (await db.query<{ role: string; text: string | null; content: unknown }>(
    "SELECT role, text, content FROM agent_messages WHERE conversation_id=$1 AND role IN ('user','assistant') AND hidden_by IS NULL AND seq > $2 ORDER BY seq DESC LIMIT 40",
    [conversationId, boundary],
  ).catch(() => ({ rows: [] as { role: string; text: string | null; content: unknown }[] }))).rows.reverse();
  // Only what came up to the newest user turn (the assistant's start_workflow reply is after it).
  const lastUser = rows.map((r) => r.role).lastIndexOf("user");
  // A turn that carries pasted material keeps only its request part (material.ts `instructionOf`): the material reaches the
  // run as a `message` material ref, never as dozens of 「requirements」.
  const turns = rows.slice(0, lastUser + 1).map((r) => ({ role: r.role, text: r.role === "user" ? instructionOf((r.text ?? "").replace(/^（交給 Agent）/, "")) : (r.text ?? ""), content: r.content }));
  return clipWords(taskTurns(turns));
}

export const baseWords = (b: Brief) => b.user_words.slice(0, b.base);
/** `user_words` = the start's words (+ clarifying answers) then guidance, clipped; `base` follows what the clip dropped. */
export function composeWords(base: string[], rest: string[]): { user_words: string[]; base: number } {
  const all = [...base, ...rest];
  const user_words = clipWords(all);
  return { user_words, base: Math.max(0, base.length - (all.filter((w) => squash(w)).length - user_words.length)) };
}
/** The words with one more line of the user's (a clarifying answer, a choice) at the end of the start's part. */
const withLine = (b: Brief, line: string) => composeWords([...baseWords(b), line], b.user_words.slice(b.base));
/** Guidance lines the user wrote (補充指示, answers, 修改); the autopilot's own 繼續改 lines are not the user's words. */
export const userGuidance = (run: Pick<RunRow, "guidance">) => (run.guidance ?? []).filter((g) => !g.system && !g.setup).map((g) => g.text);

// ---------------------------------------------------------------- versions

const now = () => new Date().toISOString();

export type BriefSeed = { userWords?: string[] | null; deliverable?: { kind: BriefKind; label: string } | null };

/**
 * Version 0, written with the run: the user's words (the chat turns, or the request itself when the user typed it: the
 * composer, the API), the assistant's request as `paraphrase` when it differs, and the deliverable (hard).
 */
export function seedBrief(request: string, playbook: string, seed: BriefSeed = {}): Brief {
  const given = clipWords(seed.userWords ?? []);
  const words = given.length ? given : clipWords([request]);
  const same = given.length > 0 && given.some((w) => squash(w).includes(squash(request).slice(0, 60)));
  const paraphrase = given.length && !same ? request.slice(0, 4000) : null;
  const d = seed.deliverable ?? deliverableFor(words, paraphrase, playbook);
  return { version: 0, deliverable: { kind: d.kind, label: d.label, hard: true }, user_words: words, base: words.length, paraphrase, requirements: [], unspecified: [], checklist: [], source: "start", at: now() };
}

/**
 * A goal's Brief (goals/service.ts): the goal's deliverable, the user's words, deterministic requirements only (no model
 * call when a goal is planned). Stage runs get the same user words with their own stage deliverable.
 */
export function goalBrief(request: string, userWords: string[] | null | undefined, deliverable: { kind: BriefKind; label: string }, detect: (text: string) => Omit<Requirement, "id" | "source">[], prev?: Brief | null): Brief {
  const seed = seedBrief(request, "generic", { userWords, deliverable });
  const user_words = prev ? clipWords([...prev.user_words, ...seed.user_words.filter((w) => !prev.user_words.includes(w))]) : seed.user_words;
  const requirements = user_words.flatMap(detect).filter((r, i, all) => all.findIndex((x) => x.type === r.type) === i).map((r, i) => ({ ...r, id: `r${i + 1}`, source: "request" as const }));
  const fields = { deliverable: seed.deliverable, user_words, base: user_words.length, paraphrase: seed.paraphrase, requirements, unspecified: unspecifiedOf(deliverable.kind, requirements) };
  return prev ? nextVersion(prev, fields, "guidance") : { ...seed, ...fields, version: 1, source: "plan" };
}

/** The next version (the checklist starts empty unless given). */
export const nextVersion = (b: Brief, patch: Partial<Brief>, source: BriefSource): Brief => ({ ...b, checklist: [], ...patch, version: b.version + 1, source, at: now() });

/** Writes a brief (the previous version goes to `brief_versions`, ≤ 10). The DB trigger rejects any change to a written version. */
export async function saveBrief(db: Queryable, runId: string, next: Brief, table: "workflow_runs" | "workflow_goals" = "workflow_runs") {
  if (table === "workflow_goals") {
    await db.query("UPDATE workflow_goals SET brief=$2 WHERE id=$1", [runId, JSON.stringify(next)]);
    return;
  }
  await db.query(
    `UPDATE workflow_runs SET brief=$2::jsonb,
       brief_versions = CASE WHEN brief IS NULL OR (brief->>'version')::int = ($2::jsonb->>'version')::int THEN brief_versions
         ELSE (SELECT coalesce(jsonb_agg(v ORDER BY n), '[]'::jsonb) FROM (SELECT v, n FROM jsonb_array_elements(brief_versions || jsonb_build_array(brief)) WITH ORDINALITY x(v, n) ORDER BY n DESC LIMIT 10) t) END,
       updated_at=now() WHERE id=$1`,
    [runId, JSON.stringify(next)],
  );
}

async function store(env: WorkflowEnv, next: Brief) {
  await saveBrief(env.db, env.run.id, next);
  env.run.brief = next;
  return next;
}

/** A brief for a run created before 0120: the chat turns when the assistant started it, else the request. */
async function legacySeed(env: WorkflowEnv): Promise<Brief> {
  const words = env.run.tool_call_id ? await collectUserWords(env.db, env.run.conversation_id) : [];
  return seedBrief(env.run.request, env.run.playbook, { userWords: words });
}

const hashOf = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);

const TYPED_UNSPEC = ["語言", "頁數", "篇幅"];
/** What the user did not specify for this kind of deliverable (shown as 「未指定」; never turned into a requirement). */
export function unspecifiedOf(kind: BriefKind, reqs: Requirement[]): string[] {
  const has = (t: Requirement["type"]) => reqs.some((r) => r.type === t);
  const out: string[] = [];
  if (!has("language")) out.push("語言");
  if (kind === "deck" && !has("page_count")) out.push("頁數");
  if (kind !== "deck" && !has("length") && !has("page_count")) out.push("篇幅");
  return out;
}

/**
 * Planning (engine planPhase, before the playbook plans): version 1 from the seed, or a new version when the user added
 * guidance / answers since. `requirements` is requirements.ts' `prepareRequirements` (grounded in `user_words`).
 */
export async function prepareBrief(env: WorkflowEnv, playbook: string, requirements: (b: Brief) => Promise<Requirement[]>): Promise<Brief> {
  let b = env.run.brief ?? null;
  if (!b) b = await store(env, await legacySeed(env));
  const words = composeWords(baseWords(b), userGuidance(env.run));
  const working: Brief = { ...b, ...words };
  const reqs = await requirements(working);
  const key = hashOf([words.user_words, reqs.map((r) => [r.type, r.text, r.params ?? null]), playbook]);
  if (b.version >= 1 && b.key === key) return b;
  // Items a clarifying question left open (「要報告的論文」) stay; the typed ones follow the requirements.
  const unspecified = [...unspecifiedOf(b.deliverable.kind, reqs), ...b.unspecified.filter((u) => !TYPED_UNSPEC.includes(u))];
  const changed = words.user_words.length !== b.user_words.length || words.user_words.some((w, i) => w !== b!.user_words[i]);
  return store(env, nextVersion(b, { ...words, requirements: reqs, unspecified, key }, b.version > 0 && changed ? "guidance" : "plan"));
}

/** Acceptance checklist of a criteria list (ids shared with `run.criteria`; `req_*` and the user's own items are `user`). */
export function checklistFrom(criteria: Pick<Criterion, "id" | "text" | "kind" | "check">[]): ChecklistItem[] {
  return criteria.map((c) => ({
    id: c.id, text: c.text, kind: c.kind, ...(c.check ? { check: c.check } : {}),
    ...(c.id.startsWith("req_") ? { requirement_id: c.id.slice(4) } : {}),
    source: c.id.startsWith("req_") || /^u\d+$/.test(c.id) ? "user" : "playbook",
  }));
}

/** The plan's criteria become the brief's checklist (the same version when it had none; otherwise a new version). */
export async function setChecklist(env: WorkflowEnv, criteria: Pick<Criterion, "id" | "text" | "kind" | "check">[], source: BriefSource = "plan") {
  const b = env.run.brief;
  if (!b) return;
  const checklist = checklistFrom(criteria);
  if (JSON.stringify(checklist) === JSON.stringify(b.checklist)) return;
  await store(env, b.checklist.length ? nextVersion(b, { checklist }, source) : { ...b, checklist });
}

/** **P1 API**: the acceptance list of a run — the brief's checklist, else (runs planned before the Brief) its criteria. */
export function checklistOf(run: Pick<RunRow, "brief" | "criteria">): ChecklistItem[] {
  return run.brief?.checklist?.length ? run.brief.checklist : checklistFrom(run.criteria ?? []);
}

/**
 * The plan card edited the requirements / criteria (service approveWorkflow): a new version from the user's edit.
 * Pure: the caller writes it inside its transaction.
 */
export function editedBrief(b: Brief | null | undefined, patch: { requirements?: Requirement[]; criteria?: Pick<Criterion, "id" | "text" | "kind" | "check">[] }): Brief | null {
  if (!b) return null;
  const requirements = patch.requirements ?? b.requirements;
  const checklist = patch.criteria ? checklistFrom(patch.criteria) : b.checklist;
  if (JSON.stringify(requirements) === JSON.stringify(b.requirements) && JSON.stringify(checklist) === JSON.stringify(b.checklist)) return null;
  return nextVersion(b, { requirements, unspecified: [...unspecifiedOf(b.deliverable.kind, requirements), ...b.unspecified.filter((u) => !TYPED_UNSPEC.includes(u))], checklist }, "edit");
}

// ---------------------------------------------------------------- prompts

/** The brief every sub-agent gets (with the requirements block, env.ts `withRequirements`): compact, verbatim user words. */
export function briefBlock(b: Brief | null | undefined, audience: "producer" | "verifier"): string {
  if (!b) return "";
  const words = clipWords(b.user_words);
  const lines = [
    "固定的任務簡報（使用者確認的內容，任何步驟都不能更改）：",
    `- 要交付的成果：${b.deliverable.label}（必須是這種成果，不能改成其他形式）`,
    words.length ? `- 使用者的原話（逐字；要求只來自這裡和下方列出的明確要求）：\n${words.map((w) => `  「${w}」`).join("\n")}` : "",
    b.unspecified.length ? `- 使用者沒有指定：${b.unspecified.join("、")}（照計畫與預設處理；不要當成使用者的要求，也不要自己編一個數字或語言說是使用者要的）` : "",
    audience === "verifier" ? "- 驗收只依使用者的原話、明確要求與確認的計畫；不要要求使用者沒說的東西。" : "",
  ];
  return lines.filter(Boolean).join("\n");
}

/** Pages of an outline step scope (slides writers: `inputs.pages`). */
const rangeText = (nums: number[]) => (nums.length > 1 && nums.at(-1)! - nums[0]! === nums.length - 1 ? `第 ${nums[0]}–${nums.at(-1)} 頁` : `第 ${nums.join("、")} 頁`);

/**
 * The step's own scope, stated explicitly (production 0f427194: a 「第 1–3 頁」 step wrote 8 pages from the whole request):
 * `inputs.scope` when the playbook set one, the pages of a page-range step, else the step's own part for producers.
 */
export function scopeLine(step: Pick<StepRow, "title" | "role" | "kind" | "inputs">): string {
  const i = (step.inputs ?? {}) as { scope?: unknown; pages?: unknown };
  if (typeof i.scope === "string" && i.scope.trim()) return `這一步的範圍：${i.scope.trim()}`;
  const pages = Array.isArray(i.pages) ? (i.pages as unknown[]).filter((n): n is number => typeof n === "number") : [];
  if (pages.length) return `這一步的範圍：只寫${rangeText(pages)}（共 ${pages.length} 頁），標題照大綱；其他頁由別的步驟負責，不要寫，也不要多寫頁數。`;
  if (step.kind === "task" && (step.role === "writer" || step.role === "designer" || step.role === "coder")) return `這一步的範圍：只完成「${step.title}」這一部分；成果的其他部分由別的步驟負責，不要寫。`;
  return "";
}

/** How a prompt names the run's request: the user's own words, or the assistant's paraphrase marked as such. */
export function requestLine(env: Pick<WorkflowEnv, "run">): string {
  const b = env.run.brief;
  if (!b?.paraphrase) return `使用者的要求：${env.run.request}`;
  return `任務說明（助理整理的，只是參考；要求以使用者的原話與明確要求為準，不要從這段加入新的要求）：${env.run.request}`;
}

// ---------------------------------------------------------------- clarify once

export type ClarifyOption = { value: string; label: string; description?: string };

/**
 * Asks ONE clarifying question with options (a must-have input or the deliverable is genuinely missing / ambiguous).
 * Returns the chosen value (or the user's own text as `{ other }`), or null when it stays 「未指定」: under autopilot, when
 * a clarifying question was already asked in this run, or when the user skipped it. The answer is the user's words
 * (a new brief version); an unanswered item is added to `unspecified`. Throws WorkflowStop("ask") while it waits.
 */
export async function clarifyOnce(env: WorkflowEnv, q: { id: string; title: string; intro?: string; prompt: string; options: ClarifyOption[]; unspecified: string }): Promise<{ value: string | null; other?: string } | null> {
  const b = env.run.brief;
  const cardId = `clarify_${q.id}`;
  const asked = asksOf(env.run.state)[cardId];
  const record = async (patch: Partial<Brief>) => {
    if (b) await store(env, nextVersion(b, { ...patch, checklist: b.checklist }, "clarify"));
  };
  if (!asked && (env.run.autopilot || b?.clarified)) {
    if (b && !b.unspecified.includes(q.unspecified)) await record({ unspecified: [...b.unspecified, q.unspecified] });
    return null;
  }
  const answers = await askUser(env, {
    id: cardId, title: q.title, intro: q.intro, step_key: null, purpose: "input", ai_suggested: false,
    questions: [{ id: "q", prompt: q.prompt, type: "single_choice", options: q.options, allow_other: true, required: false }],
  });
  const a = answers.find((x) => x.id === "q");
  const question = { id: "q", prompt: q.prompt, type: "single_choice" as const, options: q.options, allow_other: true };
  const line = `（回答「${q.title.slice(0, 60)}」）${answerLines(question, a).join("；")}`;
  if (b && !b.user_words.includes(line)) {
    if (isSkipped(a)) await record({ clarified: true, unspecified: b.unspecified.includes(q.unspecified) ? b.unspecified : [...b.unspecified, q.unspecified] });
    else await record({ clarified: true, ...withLine(b, line) });
  }
  if (isSkipped(a)) return null;
  // A 「其他」 answer that hands the choice back (「你決定」) takes the first option (the deliverable-keeping default).
  const value = typeof a?.value === "string" && q.options.some((o) => o.value === a.value) ? a.value : a?.other && /你(來)?(決定|選|挑|判斷)|交給你|都可以|隨便|you (decide|choose|pick)|up to you/i.test(a.other) ? q.options[0]?.value ?? null : null;
  return { value, ...(a?.other?.trim() ? { other: a.other.trim() } : {}) };
}

/** 「先…再…」「然後」: several deliverables in sequence (a goal), not an ambiguity. */
const SEQUENCE_RE = /先[^。！？\n]{1,60}(?:再|然後|接著|之後)|然後|接著|最後|and then|, then |followed by/i;

/** Incompatible deliverable kinds the user's newest turn names as targets (「做成簡報或筆記」); ≥ 2 = ambiguous. */
export function ambiguousKinds(words: string[]): BriefKind[] {
  const last = words.at(-1) ?? "";
  if (SEQUENCE_RE.test(last)) return [];
  const kinds: BriefKind[] = [];
  for (const m of last.matchAll(new RegExp(TARGET_RE.source, "gi"))) {
    const k = TARGET_KIND.find(([re]) => re.test(m[2] ?? ""))?.[1];
    if (k && !kinds.some((x) => sameDeliverable(x, briefKindOf(k)))) kinds.push(briefKindOf(k));
  }
  // 「A 或 B」 after one verb: 「做成簡報或筆記」.
  const alt = /(簡報|投影片|筆記|latex\s*論文|論文|slides?|deck|presentation|note|paper)\s*(?:或|或是|還是|or)\s*(簡報|投影片|筆記|latex\s*論文|論文|slides?|deck|presentation|note|paper)/i.exec(last);
  if (alt) for (const g of [alt[1]!, alt[2]!]) {
    const k = TARGET_KIND.find(([re]) => re.test(g))?.[1];
    if (k && !kinds.some((x) => sameDeliverable(x, briefKindOf(k)))) kinds.push(briefKindOf(k));
  }
  return kinds.length >= 2 ? kinds : [];
}

/**
 * The deliverable is genuinely ambiguous (the user's newest turn names two incompatible kinds without a sequence): ONE
 * clarifying card with the kinds as options. The choice is a new brief version (the router then picks its producer);
 * returns true when the deliverable changed (false: answered with the current kind, skipped, or autopilot →
 * 「成果種類：未指定」).
 */
export async function clarifyDeliverable(env: WorkflowEnv): Promise<boolean> {
  const b = env.run.brief;
  if (!b || b.version < 1) return false;
  const kinds = ambiguousKinds(baseWords(b));
  if (!kinds.length) return false;
  const answer = await clarifyOnce(env, {
    id: "deliverable", title: "要交付哪一種成果？", prompt: "你提到了不只一種成果，這次要做哪一種？",
    options: kinds.map((k) => ({ value: k, label: BRIEF_KIND_LABEL[k] })), unspecified: "成果種類",
  });
  const kind = BRIEF_KINDS.find((k) => k === answer?.value);
  if (!kind) return false;
  return chooseDeliverable(env, kind);
}

/** The user chose a deliverable on a card (clarify / the router's 「沒有流程能產生」 card): a new brief version. */
export async function chooseDeliverable(env: WorkflowEnv, kind: BriefKind): Promise<boolean> {
  const cur = env.run.brief;
  if (!cur || sameDeliverable(kind, cur.deliverable.kind)) return false;
  await store(env, nextVersion(cur, { deliverable: { kind, label: BRIEF_KIND_LABEL[kind], hard: true }, unspecified: cur.unspecified, requirements: cur.requirements }, "clarify"));
  return true;
}

// ---------------------------------------------------------------- the deliverable invariant

export type SwitchDecision = { ok: true } | { ok: false; action: "topic" | "retry" | "stop" };

/**
 * A playbook switch (redirect, the repeated-question fallback) that would change the deliverable kind stops and asks —
 * never silently (production 50b49d80, c1b9a129, a3b59ddd: decks / LaTeX became notes). Options: (slides) keep the deck
 * and build it from the study's library and notes, switch to the other kind (the user's choice → a new brief version),
 * stop, or write what is missing (「其他」 → guidance, plan again). Same kind (or the note family) → `{ ok: true }`.
 */
export async function switchGuard(env: WorkflowEnv, from: { id: string; title: string; edit?: boolean }, to: string, why: string): Promise<SwitchDecision> {
  const b = env.run.brief;
  const target = playbookKind(to);
  if (!b || sameDeliverable(b.deliverable.kind, target)) return { ok: true };
  const done = env.state<Record<string, string>>("switch_answers") ?? {};
  const id = `deliverable_${Object.keys(done).length + 1}`;
  const toPb = getWorkflowPlaybook(to);
  const targetLabel = BRIEF_KIND_LABEL[target];
  // An edit of a given artifact is never offered a new deck or another kind: only 「其他」 (what is missing) or stop.
  const options: ClarifyOption[] = from.edit ? [
    { value: "retry", label: `繼續${from.title}`, description: "照原本的要求再規劃一次（可以在「其他」補充資料）。" },
    { value: "stop", label: "先停下來", description: "結束這個工作流程（原本的成果不變），我補好資料再重新開始。" },
  ] : [
    ...(from.id === "slides" ? [{ value: "topic", label: "仍做簡報：用研究的文獻庫與筆記整理", description: "不指定單篇論文，依研究已有的文獻與筆記做主題簡報。" }] : []),
    { value: "switch", label: `改做${targetLabel}`, description: `改用「${toPb?.title ?? to}」，成果會是${targetLabel}，不是${b.deliverable.label}。` },
    { value: "stop", label: "先停下來", description: "結束這個工作流程（已寫的草稿保留），我補好資料再重新開始。" },
  ];
  await env.note(`「${from.title}」沒辦法照你要的成果（${b.deliverable.label}）繼續：${why.slice(0, 120)}。不會自動改成${targetLabel}，先問你。`, "warn");
  const answers = await askUser(env, {
    id, title: `要怎麼繼續？你要的是${b.deliverable.label}`, step_key: null, purpose: "input", ai_suggested: false,
    intro: `「${from.title}」還缺少資料才能繼續：${why.slice(0, 300)}\n你要的成果是「${b.deliverable.label}」，我不會自己改成${targetLabel}。也可以在「其他」寫下補充資料（例如論文標題、要用的筆記），我會照它重新規劃。`,
    questions: [{ id: "q", prompt: "要怎麼繼續？", type: "single_choice", options, allow_other: true, required: true }],
  });
  const a = answers.find((x) => x.id === "q");
  const value = a?.other?.trim() ? "other" : typeof a?.value === "string" ? a.value : "stop";
  await env.setState({ switch_answers: { ...done, [id]: value } });
  if (value === "switch") {
    await store(env, nextVersion(b, { deliverable: { kind: target, label: capabilityOf(to) ? DELIVERABLE_LABEL[capabilityOf(to)!.produces] : targetLabel, hard: true }, ...withLine(b, `（選擇改做${targetLabel}）`), unspecified: b.unspecified, requirements: b.requirements }, "deliverable"));
    return { ok: true };
  }
  if (value === "retry") return { ok: false, action: "retry" };
  if (value === "other") {
    // The user's own words: guidance for the re-plan (a new brief version is built from it).
    await env.db.query("UPDATE workflow_runs SET guidance = guidance || $2::jsonb, updated_at=now() WHERE id=$1", [env.run.id, JSON.stringify([{ at: now(), text: a!.other!.trim().slice(0, 2000), applied: false }])]);
    await env.refresh();
    return { ok: false, action: "retry" };
  }
  return { ok: false, action: value === "topic" ? "topic" : "stop" };
}
