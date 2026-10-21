/** `ask_user` question cards: draft state, validation and answer labels (mirrors backend/src/agent/ask.ts). */
import { t } from "#lib/i18n.svelte.ts";
import type { Answer, AskArgs, AskQuestion, Message, ToolCall } from "./types.ts";

export type Draft = { value: string | number | boolean | string[] | null; other: string; otherOn: boolean; skipped: boolean };

export const isChoice = (q: AskQuestion) => q.type === "single_choice" || q.type === "multi_choice" || q.type === "yes_no";
export const scaleSize = (q: AskQuestion) => q.scale_labels?.length ?? 5;

export function askArgs(call: Pick<ToolCall, "args">): AskArgs | null {
  const a = call.args as Partial<AskArgs>;
  return Array.isArray(a?.questions) && a.questions.length ? (a as AskArgs) : null;
}

export function emptyDraft(q: AskQuestion): Draft {
  return { value: q.type === "multi_choice" ? [] : null, other: "", otherOn: false, skipped: false };
}

export function draftFrom(q: AskQuestion, a: Answer | undefined): Draft {
  if (!a) return emptyDraft(q);
  return { value: a.value ?? (q.type === "multi_choice" ? [] : null), other: a.other ?? "", otherOn: !!a.other, skipped: !!a.skipped };
}

/** Whether the draft holds an answer (an 「其他」 text counts). */
export function answered(q: AskQuestion, d: Draft): boolean {
  if (d.skipped) return false;
  if (q.allow_other && d.otherOn && d.other.trim()) return true;
  const v = d.value;
  if (v === null || v === undefined || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (q.type === "number") return Number.isFinite(Number(v));
  return true;
}

export function toAnswer(q: AskQuestion, d: Draft): Answer {
  if (!answered(q, d)) return { id: q.id, skipped: true };
  const other = q.allow_other && d.otherOn && d.other.trim() ? d.other.trim() : undefined;
  let value = d.value;
  if (q.type === "number") value = Number(value);
  if (q.type === "single_choice" && value === "") value = null;
  return { id: q.id, value, ...(other ? { other } : {}) };
}

/** Labels of one answer for the summaries (「語音、文字、其他：腦波」). */
export function answerLabel(q: AskQuestion, a: Answer | undefined): string {
  if (!a || a.skipped) return t("agent.ask.skipped");
  const label = (v: string) => q.options?.find((o) => o.value === v)?.label ?? v;
  const other = a.other ? `${t("agent.ask.other")}：${a.other}` : "";
  switch (q.type) {
    case "single_choice":
      return [typeof a.value === "string" ? label(a.value) : "", other].filter(Boolean).join("；");
    case "multi_choice":
      return [...(Array.isArray(a.value) ? a.value.map(label) : []), other].filter(Boolean).join("、");
    case "yes_no":
      return a.value ? t("agent.ask.yes") : t("agent.ask.no");
    case "scale": {
      const n = Number(a.value);
      return q.scale_labels ? `${q.scale_labels[n - 1] ?? n}（${n}/${q.scale_labels.length}）` : `${n} / 5`;
    }
    default:
      return String(a.value ?? "");
  }
}

/** Answer messages of the current branch, by the card they answer. */
export function answersByCall(messages: Message[]): Map<string, Message> {
  const out = new Map<string, Message>();
  for (const m of messages) if (m.role === "user" && m.answers?.toolCallId) out.set(m.answers.toolCallId, m);
  return out;
}
