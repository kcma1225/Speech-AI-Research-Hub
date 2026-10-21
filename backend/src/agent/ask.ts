/**
 * `ask_user`: structured questions the model asks (Claude-Desktop style question card). The tool call itself only shows
 * the card; the user's answers arrive as a special **user turn** (`agent_messages.answers`), so editing answers is the
 * same as editing a message (a new branch). This file holds the question schema and the answer validation/formatting.
 */
import { z } from "zod";
import { HttpError } from "../lib/http.js";

export const QUESTION_TYPES = ["single_choice", "multi_choice", "short_text", "long_text", "number", "date", "scale", "yes_no"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

const option = z.object({
  value: z.string().trim().min(1).max(80).describe("Stable value (returned in the answer); defaults to the label"),
  label: z.string().trim().min(1).max(120).describe("What the user sees"),
  description: z.string().trim().max(200).optional().describe("One short line under the label"),
});

/**
 * Forgiving input for small models (they often omit `value` or name the question `question`/`text`): fills
 * `prompt` from an alias and each option's missing `value` from its label (or `o<n>`), before validation.
 */
function normaliseQuestion(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const q = { ...(raw as Record<string, unknown>) };
  if (typeof q.prompt !== "string" || !q.prompt.trim()) {
    const alias = [q.question, q.text, q.title, q.label].find((v) => typeof v === "string" && v.trim());
    if (alias) q.prompt = alias;
  }
  if (Array.isArray(q.options)) {
    const used = new Set<string>();
    q.options = q.options.map((o, i) => {
      if (typeof o === "string") o = { label: o };
      if (!o || typeof o !== "object") return o;
      const opt = { ...(o as Record<string, unknown>) };
      if (typeof opt.value !== "string" || !opt.value.trim()) {
        const label = typeof opt.label === "string" ? opt.label.trim() : "";
        let value = label && label.length <= 80 ? label : `o${i + 1}`;
        if (used.has(value)) value = `o${i + 1}`;
        opt.value = value;
      }
      used.add(String(opt.value).trim());
      return opt;
    });
  }
  return q;
}

const questionObject = z.object({
  id: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/).describe("Short unique id, e.g. q1 or data_type"),
  prompt: z.string().trim().min(1).max(300).describe("The question (user's language)"),
  type: z.enum(QUESTION_TYPES).describe("single_choice/multi_choice need options; scale uses 1–5 unless scale_labels is given"),
  options: z.array(option).min(2).max(12).optional(),
  allow_other: z.boolean().optional().describe("Choice questions: offer an 「其他」 free-text option"),
  required: z.boolean().optional().describe("Default false. Prefer optional questions with an explicit 「還不確定」 option"),
  placeholder: z.string().trim().max(120).optional(),
  scale_labels: z.array(z.string().trim().min(1).max(40)).min(2).max(10).optional().describe("Scale: custom point labels (low → high)"),
});
export const questionSchema = z.preprocess(normaliseQuestion, questionObject);
export type Question = z.infer<typeof questionObject>;

export const askUserInput = z
  .object({
    intro: z.string().trim().max(4000).optional().describe("Shown above the questions: one short sentence, or — when a question refers to a structure/plan/outline (「以下的架構」) — that full content (e.g. every page title + key points), one item per line"),
    questions: z.array(questionSchema).min(1).max(6),
  })
  .superRefine((v, ctx) => {
    // A question about "the structure below" must show it: the user must never approve content they cannot see.
    const refers = /(?:以下|下列|如下|上述|上面)的?\s*(?:\d+\s*(?:頁|張|點|項)\s*的?)?(?:架構|結構|大綱|計畫|規劃|頁面|內容|安排|流程|步驟)|這(?:個|份)(?:架構|結構|大綱|計畫|規劃)|(?:outline|structure|plan) (?:below|above)/i;
    if (v.questions.some((q) => refers.test(q.prompt)) || (v.intro && refers.test(v.intro))) {
      const intro = v.intro ?? "";
      const items = intro.split("\n").filter((l) => /^\s*(?:[-*•]|\d{1,2}[.、)）]|第\s*\d+\s*頁)/.test(l)).length;
      if (items < 3 && intro.length < 120)
        ctx.addIssue({ code: "custom", path: ["intro"], message: "a question refers to content (以下／上述的架構…) that the card does not show: put the full content (every page title + key points, one per line) in `intro`" });
    }
    const seen = new Set<string>();
    v.questions.forEach((q, i) => {
      if (seen.has(q.id)) ctx.addIssue({ code: "custom", path: ["questions", i, "id"], message: "duplicate id" });
      seen.add(q.id);
      if ((q.type === "single_choice" || q.type === "multi_choice") && !q.options?.length) ctx.addIssue({ code: "custom", path: ["questions", i, "options"], message: "choice questions need 2–12 options" });
      if (q.options && new Set(q.options.map((o) => o.value)).size !== q.options.length) ctx.addIssue({ code: "custom", path: ["questions", i, "options"], message: "duplicate option value" });
    });
  });
export type AskUserArgs = z.infer<typeof askUserInput>;

/** What the SPA posts for one question. `value` shape depends on the type; `skipped` only for optional questions. */
export const answerInput = z.object({
  id: z.string().min(1).max(40),
  value: z.union([z.string().max(5000), z.number(), z.boolean(), z.array(z.string().max(80)).max(12), z.null()]).optional(),
  other: z.string().trim().max(500).optional(),
  skipped: z.boolean().optional(),
});
export const answersInput = z.object({ tool_call_id: z.uuid(), answers: z.array(answerInput).max(6) });
export type AnswersInput = z.infer<typeof answersInput>;
export type StoredAnswers = { toolCallId: string; answers: { id: string; value: string | number | boolean | string[] | null; other?: string; skipped?: boolean }[] };

const bad = (q: Question, why: string) => new HttpError(400, `「${q.prompt.slice(0, 40)}」${why}`);
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/** Validates answers against the questions (400 with a 繁中 message) and returns the normalised stored form. */
export function validateAnswers(args: AskUserArgs, input: AnswersInput): StoredAnswers {
  const byId = new Map(input.answers.map((a) => [a.id, a]));
  for (const a of input.answers) if (!args.questions.some((q) => q.id === a.id)) throw new HttpError(400, "回答對應不到問題。");
  const out: StoredAnswers["answers"] = [];
  for (const q of args.questions) {
    const a = byId.get(q.id);
    const other = a?.other?.trim() || undefined;
    const empty = !a || a.skipped || a.value === undefined || a.value === null || a.value === "" || (Array.isArray(a.value) && !a.value.length && !other);
    if (empty && !(q.allow_other && other)) {
      if (q.required) throw bad(q, "是必答題。");
      out.push({ id: q.id, value: null, skipped: true });
      continue;
    }
    const values = new Set(q.options?.map((o) => o.value) ?? []);
    const v = a!.value ?? null;
    switch (q.type) {
      case "single_choice":
        if (v !== null && (typeof v !== "string" || !values.has(v))) throw bad(q, "的選項不正確。");
        if (v === null && !(q.allow_other && other)) throw bad(q, "請選一個選項。");
        out.push({ id: q.id, value: v, ...(q.allow_other && other ? { other } : {}) });
        break;
      case "multi_choice": {
        const list = Array.isArray(v) ? v : v === null ? [] : null;
        if (!list || list.some((x) => !values.has(x))) throw bad(q, "的選項不正確。");
        out.push({ id: q.id, value: [...new Set(list)], ...(q.allow_other && other ? { other } : {}) });
        break;
      }
      case "short_text":
      case "long_text":
        if (typeof v !== "string") throw bad(q, "需要文字回答。");
        out.push({ id: q.id, value: v.trim().slice(0, q.type === "short_text" ? 500 : 5000) });
        break;
      case "number": {
        const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
        if (!Number.isFinite(n)) throw bad(q, "需要數字。");
        out.push({ id: q.id, value: n });
        break;
      }
      case "date":
        if (typeof v !== "string" || !isDate(v)) throw bad(q, "需要日期（YYYY-MM-DD）。");
        out.push({ id: q.id, value: v });
        break;
      case "scale": {
        const max = q.scale_labels?.length ?? 5;
        if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > max) throw bad(q, `需要 1–${max} 的分數。`);
        out.push({ id: q.id, value: v });
        break;
      }
      case "yes_no":
        if (typeof v !== "boolean") throw bad(q, "請選「是」或「否」。");
        out.push({ id: q.id, value: v });
        break;
    }
  }
  return { toolCallId: input.tool_call_id, answers: out };
}

/** Human-readable answer of one question (labels, not values). */
export function answerLabel(q: Question, a: StoredAnswers["answers"][number] | undefined): string {
  if (!a || a.skipped) return "（略過）";
  const label = (v: string) => q.options?.find((o) => o.value === v)?.label ?? v;
  const other = a.other ? `其他：${a.other}` : "";
  switch (q.type) {
    case "single_choice":
      return [typeof a.value === "string" ? label(a.value) : "", other].filter(Boolean).join("；");
    case "multi_choice":
      return [...(Array.isArray(a.value) ? a.value.map(label) : []), other].filter(Boolean).join("、") || "（未選）";
    case "yes_no":
      return a.value ? "是" : "否";
    case "scale": {
      const n = Number(a.value);
      return q.scale_labels ? `${q.scale_labels[n - 1] ?? n}（${n}/${q.scale_labels.length}）` : `${n}/5`;
    }
    default:
      return String(a.value);
  }
}

/** The clean list the model receives as the user's turn, and the plain text kept in `agent_messages.text`. */
export function answersText(args: AskUserArgs, stored: StoredAnswers): { model: string; display: string } {
  const byId = new Map(stored.answers.map((a) => [a.id, a]));
  const lines = args.questions.map((q, i) => `${i + 1}. ${q.prompt}\n   → ${answerLabel(q, byId.get(q.id))}`);
  return {
    model: `<user_answers to="ask_user" note="使用者在問題卡片上的回答；（略過）表示使用者選擇不回答，請不要追問">\n${lines.join("\n")}\n</user_answers>`,
    display: lines.join("\n"),
  };
}
