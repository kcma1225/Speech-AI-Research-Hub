/**
 * `ask_user`: structured questions the model asks (Claude-Desktop style question card). The tool call itself only shows
 * the card; the user's answers arrive as a special **user turn** (`agent_messages.answers`), so editing answers is the
 * same as editing a message (a new branch). This file holds the question schema and the answer validation/formatting.
 */
import { z } from "zod";
import { HttpError } from "../lib/http.js";
import { parseQuizAnswer, quizAnswerLines, type QuizAnswer } from "./quiz.js";
import { CONCEPT_LEVELS, DIRECT, LEVEL_LABEL, parseCardValue, termLabel } from "./tutor.js";

/**
 * `concept_check` (「先確認先備知識」, src/agent/tutor.ts): one row per prerequisite concept, each answered 懂 / 有聽過 /
 * 不懂, plus 「全部都懂，直接講」. The model only names the paper; the rows are filled by code (`ask_user` prepare).
 * The answer value is `["<key>=known|heard|unknown", …]` (+ `"__direct__"` for the shortcut).
 */
/**
 * `quiz` (the end-of-paper 小測驗, src/agent/quiz.ts): the model only names the paper and the quiz (`build_quiz`); the
 * items are filled by code without the answer keys. The answer value is a JSON string
 * `{"q1":{"choice":"b","guess":true},"q4":{"text":"…"}}`; the stored answer gains `graded` (the result per item).
 */
export const QUESTION_TYPES = ["single_choice", "multi_choice", "short_text", "long_text", "number", "date", "scale", "yes_no", "concept_check", "quiz"] as const;
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

const conceptRow = z.object({
  key: z.string().min(1).max(60),
  term_zh: z.string().max(80).optional(),
  term_en: z.string().min(1).max(120),
  gloss: z.string().max(200),
  section: z.string().max(40).optional(),
  centrality: z.enum(["core", "supporting"]).optional(),
  prefill: z.enum(CONCEPT_LEVELS).optional(),
  remembered: z.boolean().optional(),
});
export type ConceptRow = z.infer<typeof conceptRow>;

const quizItem = z.object({
  id: z.string().regex(/^q\d{1,2}$/),
  concept: z.string().max(60),
  term: z.string().max(220),
  level: z.enum(["concept", "apply"]),
  format: z.enum(["choice", "short"]),
  prompt: z.string().max(400),
  options: z.array(z.object({ value: z.string().max(4), label: z.string().max(160) })).max(4),
  section: z.string().max(40),
});

const questionObject = z.object({
  id: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/).describe("Short unique id, e.g. q1 or data_type"),
  prompt: z.string().trim().min(1).max(300).describe("The question (user's language)"),
  type: z.enum(QUESTION_TYPES).describe("single_choice/multi_choice need options; scale uses 1–5 unless scale_labels is given"),
  options: z.array(option).min(2).max(12).optional(),
  allow_other: z.boolean().optional().describe("Choice questions: offer an 「其他」 free-text option"),
  required: z.boolean().optional().describe("Default false. Prefer optional questions with an explicit 「還不確定」 option"),
  placeholder: z.string().trim().max(120).optional(),
  scale_labels: z.array(z.string().trim().min(1).max(40)).min(2).max(10).optional().describe("Scale: custom point labels (low → high)"),
  paper_id: z.string().trim().max(64).optional().describe("concept_check only: the paper whose prerequisites (from extract_prerequisites) the card asks about"),
  concepts: z.array(conceptRow).max(10).optional().describe("concept_check only: filled by the system from extract_prerequisites — omit"),
  quiz_id: z.string().trim().max(16).optional().describe("quiz only: the quiz build_quiz created"),
  items: z.array(quizItem).max(8).optional().describe("quiz only: filled by the system from build_quiz — omit"),
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
      if (q.type === "concept_check") {
        if (!q.paper_id) ctx.addIssue({ code: "custom", path: ["questions", i, "paper_id"], message: "concept_check needs paper_id" });
        if (v.questions.length > 1) ctx.addIssue({ code: "custom", path: ["questions"], message: "a concept_check card has only that one question" });
        if (q.concepts && new Set(q.concepts.map((c) => c.key)).size !== q.concepts.length) ctx.addIssue({ code: "custom", path: ["questions", i, "concepts"], message: "duplicate concept key" });
      }
      if (q.type === "quiz") {
        if (!q.paper_id || !q.quiz_id) ctx.addIssue({ code: "custom", path: ["questions", i], message: "quiz needs paper_id and quiz_id (from build_quiz)" });
        if (v.questions.length > 1) ctx.addIssue({ code: "custom", path: ["questions"], message: "a quiz card has only that one question" });
      }
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
/** A quiz item's result, kept on the stored answer once graded (the card shows ✓ / ✗ and the correct option). */
export type QuizGraded = { id: string; outcome: "correct" | "guessed" | "wrong" | "unanswered" | "short"; correct: string | null; why?: string };
export type StoredAnswers = { toolCallId: string; answers: { id: string; value: string | number | boolean | string[] | null; other?: string; skipped?: boolean; graded?: QuizGraded[] }[] };

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
      case "concept_check": {
        if (!q.concepts?.length) throw bad(q, "的格式不正確。");
        if (!Array.isArray(v)) throw bad(q, "需要逐項選擇。");
        let parsed: ReturnType<typeof parseCardValue>;
        try {
          parsed = parseCardValue(q.concepts, v);
        } catch (e) {
          throw bad(q, (e as Error).message);
        }
        if (!parsed.levels.size) {
          if (q.required) throw bad(q, "是必答題。");
          out.push({ id: q.id, value: null, skipped: true });
          break;
        }
        const list = q.concepts.filter((c) => parsed.levels.has(c.key)).map((c) => `${c.key}=${parsed.levels.get(c.key)}`);
        out.push({ id: q.id, value: parsed.direct ? [...list, DIRECT] : list });
        break;
      }
      case "quiz": {
        if (!q.items?.length) throw bad(q, "的格式不正確。");
        let parsed: QuizAnswer | null;
        try {
          parsed = parseQuizAnswer(q.items, v);
        } catch (e) {
          throw bad(q, (e as Error).message);
        }
        if (!parsed) {
          out.push({ id: q.id, value: null, skipped: true });
          break;
        }
        out.push({ id: q.id, value: JSON.stringify(parsed) });
        break;
      }
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
    case "concept_check": {
      const list = Array.isArray(a.value) ? a.value : [];
      if (list.includes(DIRECT)) return "全部都懂，直接講";
      const levels = conceptLevels(list);
      return CONCEPT_LEVELS.map((lv) => [lv, (q.concepts ?? []).filter((c) => levels.get(c.key) === lv).map(termLabel)] as const)
        .filter(([, names]) => names.length)
        .map(([lv, names]) => `${LEVEL_LABEL[lv]}：${names.join("、")}`)
        .join("；") || "（略過）";
    }
    case "scale": {
      const n = Number(a.value);
      return q.scale_labels ? `${q.scale_labels[n - 1] ?? n}（${n}/${q.scale_labels.length}）` : `${n}/5`;
    }
    case "quiz":
      return `\n${quizAnswerLines(q.items ?? [], quizValue(a.value)).join("\n")}`;
    default:
      return String(a.value);
  }
}

/** A stored quiz answer value (JSON string) back to the per-item answers. */
export function quizValue(v: unknown): QuizAnswer | null {
  if (typeof v !== "string") return null;
  try {
    return JSON.parse(v) as QuizAnswer;
  } catch {
    return null;
  }
}

/** `key=level` entries of a concept_check answer (without the 直接講 marker). */
export const conceptLevels = (list: string[]) =>
  new Map(list.filter((x) => x !== DIRECT && x.includes("=")).map((x) => [x.slice(0, x.lastIndexOf("=")), x.slice(x.lastIndexOf("=") + 1)]));

/** concept_check, for the model: one line per row with its key (the tutoring tools take keys). */
function conceptLinesForModel(q: Question, a: StoredAnswers["answers"][number] | undefined): string {
  const list = a && !a.skipped && Array.isArray(a.value) ? a.value : [];
  if (!list.length) return "   → （略過）";
  const levels = conceptLevels(list);
  const label = (k: string) => LEVEL_LABEL[levels.get(k) as keyof typeof LEVEL_LABEL] ?? "（沒選）";
  return (q.concepts ?? []).map((c) => `   - [${c.key}] ${termLabel({ term_zh: c.term_zh ?? "", term_en: c.term_en })}：${label(c.key)}`).join("\n") + (list.includes(DIRECT) ? "\n   （使用者按了「全部都懂，直接講」）" : "");
}

/** The clean list the model receives as the user's turn, and the plain text kept in `agent_messages.text`. */
export function answersText(args: AskUserArgs, stored: StoredAnswers): { model: string; display: string } {
  const byId = new Map(stored.answers.map((a) => [a.id, a]));
  const lines = args.questions.map((q, i) => `${i + 1}. ${q.prompt}\n   → ${answerLabel(q, byId.get(q.id))}`);
  const quiz = args.questions.find((q) => q.type === "quiz");
  if (quiz) {
    const a = byId.get(quiz.id);
    const body = !a || a.skipped ? "（使用者略過了小測驗）" : quizAnswerLines(quiz.items ?? [], quizValue(a.value)).join("\n");
    return {
      model: `<user_answers to="ask_user" note="使用者在小測驗卡片上的作答；判分結果在 tutor_note">\n${quiz.prompt}\n${body}\n</user_answers>`,
      display: `${quiz.prompt}\n${body}`,
    };
  }
  if (args.questions.some((q) => q.type === "concept_check")) {
    const model = args.questions.map((q, i) => `${i + 1}. ${q.prompt}\n${q.type === "concept_check" ? conceptLinesForModel(q, byId.get(q.id)) : `   → ${answerLabel(q, byId.get(q.id))}`}`);
    return {
      model: `<user_answers to="ask_user" note="使用者在概念確認卡片上的回答；（略過）表示使用者選擇不回答，請不要追問">\n${model.join("\n")}\n</user_answers>`,
      display: lines.join("\n"),
    };
  }
  return {
    model: `<user_answers to="ask_user" note="使用者在問題卡片上的回答；（略過）表示使用者選擇不回答，請不要追問">\n${lines.join("\n")}\n</user_answers>`,
    display: lines.join("\n"),
  };
}

// ---------------------------------------------------------------- a typed reply as the answer (composer → card)

type QuestionLike = Pick<Question, "id" | "type" | "prompt" | "options" | "allow_other" | "required">;
const acceptsText = (q: QuestionLike) => q.type === "short_text" || q.type === "long_text" || ((q.type === "single_choice" || q.type === "multi_choice") && !!q.allow_other);
const normLabel = (s: string) => s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");

/**
 * The question a typed chat reply answers (the composer's 「會當成這題的回答」, a queued message, `answer_workflow`):
 * the first question that takes free text (short/long text, or a choice with 「其他」). `single` (chat `ask_user` cards):
 * only when the card has exactly that one question. Otherwise the other questions must be optional (they are skipped).
 * Null = the card can only be answered on the card (choice-only, or another question is required).
 */
export function freeTextQuestion<Q extends QuestionLike>(questions: Q[], opts: { single?: boolean } = {}): Q | null {
  if (opts.single && questions.length !== 1) return null;
  const target = questions.find(acceptsText);
  if (!target) return null;
  if (questions.some((q) => q !== target && q.required)) return null;
  return target;
}

/**
 * Answers for `questions` from a typed reply: the free-text question gets the text (a choice picks the option whose
 * label / value is the text, else 「其他：text」); every other question is skipped. Null = not answerable by text.
 * The result goes through the normal validation (`validateAnswers` / workflow `validateCardAnswers`).
 */
export function answersFromText<Q extends QuestionLike>(questions: Q[], text: string, opts: { single?: boolean } = {}): AnswersInput["answers"] | null {
  const t = text.trim();
  const target = t ? freeTextQuestion(questions, opts) : null;
  if (!target) return null;
  return questions.map((q) => {
    if (q !== target) return { id: q.id, skipped: true };
    if (q.type === "short_text" || q.type === "long_text") return { id: q.id, value: t.slice(0, q.type === "short_text" ? 500 : 5000) };
    const hit = q.options?.find((o) => normLabel(o.label) === normLabel(t) || normLabel(o.value) === normLabel(t));
    if (q.type === "single_choice") return hit ? { id: q.id, value: hit.value } : { id: q.id, value: null, other: t.slice(0, 500) };
    return hit ? { id: q.id, value: [hit.value] } : { id: q.id, value: [], other: t.slice(0, 500) };
  });
}
