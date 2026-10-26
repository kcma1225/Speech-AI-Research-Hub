/**
 * What the chat composer does with the next message while something is pending (docs/architecture.md → Agent →
 * Queued message). Pure, unit-tested (composer.test.ts):
 *
 * - the assistant is replying → the message is QUEUED on the server (`conversations.queued`) and sent when the reply
 *   ends; the queue is server-side so it survives a background tab, a reload or a closed tab;
 * - a consent card waits → send asks first (「這會取消待確認的『…』」 取消它並送出 / 先處理卡片), then `supersede: true`;
 * - an `ask_user` card with one free-text question → the text is that question's answer (「會當成這題的回答」);
 *   a choice-only card → confirm first (sending leaves the card answerable);
 * - a workflow of this conversation waits for an answer → the text goes to the workflow (`POST /workflows/:id/answer
 *   {text}`), unless the user switched to 「改成一般對話」.
 *
 * `freeTextQuestion` / `answersFromText` mirror backend/src/agent/ask.ts (the server applies the same rule to a
 * queued message that meets a card).
 */
import type { Answer, AskQuestion } from "./types.ts";

export type PendingCard = { id: string; summary: string };
export type OpenAsk = { callId: string; questions: AskQuestion[] };
export type WaitingWorkflow = { id: string; title: string; question: string; cardOnly: boolean };
export type QueuedLite = { id: string; text: string; hold: "approval" | "question" | "error" | null; error?: string | null };

export type ComposerInput = {
  /** A reply is streaming (run `running`) or a send is in flight. */
  replying: boolean;
  /** Consent cards of the open step (`pending_approval`). */
  pending: PendingCard[];
  /** The unanswered `ask_user` card the last turn ended on. */
  ask: OpenAsk | null;
  /** A workflow of this conversation in `awaiting_input`. */
  workflow: WaitingWorkflow | null;
  /** 「改成一般對話」 for that workflow. */
  chatOnly: boolean;
  queued: QueuedLite | null;
};

export type ComposerMode =
  | { kind: "send" }
  | { kind: "queue"; appending: boolean }
  | { kind: "confirm_pending"; items: PendingCard[] }
  | { kind: "answer_ask"; callId: string; question: string }
  | { kind: "confirm_ask"; callId: string; question: string }
  | { kind: "answer_workflow"; workflowId: string; title: string; question: string }
  | { kind: "workflow_card"; workflowId: string; title: string; question: string };

const acceptsText = (q: AskQuestion) => q.type === "short_text" || q.type === "long_text" || ((q.type === "single_choice" || q.type === "multi_choice") && !!q.allow_other);
const normLabel = (s: string) => s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");

/** The question a typed reply answers; `single`: only a one-question card. Other questions must be optional. */
export function freeTextQuestion(questions: AskQuestion[], opts: { single?: boolean } = {}): AskQuestion | null {
  if (opts.single && questions.length !== 1) return null;
  const target = questions.find(acceptsText);
  if (!target) return null;
  if (questions.some((q) => q !== target && q.required)) return null;
  return target;
}

/** Answers from a typed reply (the free-text question gets the text, a matching option label picks that option). */
export function answersFromText(questions: AskQuestion[], text: string, opts: { single?: boolean } = {}): Answer[] | null {
  const t = text.trim();
  const target = t ? freeTextQuestion(questions, opts) : null;
  if (!target) return null;
  return questions.map((q) => {
    if (q !== target) return { id: q.id, skipped: true };
    if (q.type === "short_text" || q.type === "long_text") return { id: q.id, value: t };
    const hit = q.options?.find((o) => normLabel(o.label) === normLabel(t) || normLabel(o.value) === normLabel(t));
    if (q.type === "single_choice") return hit ? { id: q.id, value: hit.value } : { id: q.id, value: null, other: t };
    return hit ? { id: q.id, value: [hit.value] } : { id: q.id, value: [], other: t };
  });
}

/** Which way the next send goes (precedence: replying → consent cards → question card → waiting workflow → send). */
export function composerMode(s: ComposerInput): ComposerMode {
  if (s.replying) return { kind: "queue", appending: !!s.queued };
  if (s.pending.length) return { kind: "confirm_pending", items: s.pending };
  if (s.ask) {
    const q = freeTextQuestion(s.ask.questions, { single: true });
    return q ? { kind: "answer_ask", callId: s.ask.callId, question: q.prompt } : { kind: "confirm_ask", callId: s.ask.callId, question: s.ask.questions[0]?.prompt ?? "" };
  }
  if (s.workflow && !s.chatOnly) {
    const w = s.workflow;
    return w.cardOnly ? { kind: "workflow_card", workflowId: w.id, title: w.title, question: w.question } : { kind: "answer_workflow", workflowId: w.id, title: w.title, question: w.question };
  }
  return { kind: "send" };
}

/** 『新增待辦：…』、『刪除第 3 頁』 for the confirmation line. */
export const pendingNames = (items: PendingCard[], max = 3) =>
  items.slice(0, max).map((p) => `『${p.summary}』`).join("、") + (items.length > max ? ` 等 ${items.length} 項` : "");

/** One line, ≤ n chars, for hints that quote a question. */
export const clipLine = (s: string, n = 80) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** What the queued message's bubble offers, from the live state (the server's `hold` says why it was not sent). */
export type QueuedState = "waiting" | "held_approval" | "held_question" | "held_error";
export function queuedState(s: ComposerInput): QueuedState | null {
  const q = s.queued;
  if (!q) return null;
  if (s.replying) return "waiting";
  if (q.hold === "error") return "held_error";
  if (s.pending.length) return "held_approval";
  if (q.hold === "question" || s.ask) return "held_question";
  // Nothing holds it: the server sends it in a moment (ticker / run end).
  return "waiting";
}
