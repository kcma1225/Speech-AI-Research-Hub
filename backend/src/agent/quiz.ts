/**
 * 「先確認先備知識」 end-of-paper quiz (docs/architecture.md "Agent" → Prerequisite check → Quiz). The model writes the
 * questions (`build_quiz`); everything else is decided here, in code: which concepts are tested (`quizTargets`), whether
 * the questions are acceptable (`validateQuiz`: grounded in the paper, one correct option, no length giveaway, …), the
 * option order (shuffled, so the correct one is not always first), grading (choice questions only — a short answer is
 * feedback, never a verdict) and what the result does to the session and the user's memory (`applyQuizResults`):
 * correct and not guessed → verified (`checked`); guessed → recapped; wrong → taught again from another angle and
 * tested again in the next round (≤ MAX_ROUNDS).
 *
 * The answer keys stay in the session (paper_concept_sessions.quizzes); the card gets `quizCardItems` only.
 * Pure functions, unit-tested in test/quiz.unit.test.ts.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Queryable } from "../db.js";
import { loadSession, normaliseKey, saveSession, savedLine, termLabel, writeMemory, type MemoryWrite, type Session, type SessionConcept } from "./tutor.js";

/** Concepts per round, questions per quiz, short answers per quiz, rounds per paper. */
export const MAX_TARGETS = 4;
export const MAX_QUESTIONS = 5;
export const MAX_SHORT = 1;
export const MAX_ROUNDS = 3;

const OPTION_VALUES = ["a", "b", "c", "d"] as const;

export const quizQuestionInput = z.object({
  concept: z.string().trim().min(1).max(120).describe("Key of the concept this question tests (one of the targets build_quiz listed)"),
  level: z.enum(["concept", "apply"]).describe("concept = what it is / why; apply = how this paper uses it (why X and not Y here, what breaks without it)"),
  format: z.enum(["choice", "short"]).describe("choice = 3–4 options, exactly one correct (graded by the system); short = one free-text question (at most one per quiz)"),
  prompt: z.string().trim().min(8).max(400).describe("The question (zh-TW)"),
  options: z
    .array(z.object({
      text: z.string().trim().min(1).max(160),
      correct: z.boolean().optional(),
      why: z.string().trim().min(4).max(300).describe("Why this option is right, or the misconception it stands for"),
    }))
    .min(3)
    .max(4)
    .optional()
    .describe("choice only: wrong options are plausible misconceptions, similar in length to the correct one"),
  rubric: z.string().trim().max(400).optional().describe("short only: what a good answer must mention"),
  model_answer: z.string().trim().max(600).optional().describe("short only"),
  section: z.string().trim().min(1).max(40).describe("Where in the paper the answer is grounded, e.g. '3.2'"),
  evidence: z.string().trim().min(10).max(300).describe("A sentence copied verbatim from the paper (prose, not an equation) that supports the answer"),
});
export type QuizQuestionInput = z.infer<typeof quizQuestionInput>;

export type QuizOption = { value: string; label: string; correct: boolean; why: string };
export type QuizItem = {
  id: string;
  concept: string;
  term: string;
  level: "concept" | "apply";
  format: "choice" | "short";
  prompt: string;
  options: QuizOption[];
  rubric: string;
  model_answer: string;
  section: string;
  evidence: string;
};
export type QuizResult = { id: string; concept: string; outcome: "correct" | "guessed" | "wrong" | "unanswered" | "short"; chosen: string | null; correct: string | null; text?: string };
export type Quiz = {
  id: string;
  round: number;
  status: "open" | "answered" | "skipped" | "replaced";
  items: QuizItem[];
  results?: QuizResult[];
  created_at: string;
};
/** What the card shows: no answer keys. */
export type QuizCardItem = { id: string; concept: string; term: string; level: "concept" | "apply"; format: "choice" | "short"; prompt: string; options: { value: string; label: string }[]; section: string };
/** What the user posts: per item the option chosen (+ 「我是猜的」) or the short answer. */
export type QuizAnswer = Record<string, { choice?: string; guess?: boolean; text?: string }>;

const isPrereq = (c: SessionConcept) => c.kind === "prerequisite";
const verifiedBefore = (c: SessionConcept) => !!c.memory && c.memory.source === "checked" && c.memory.level === "known";
const answeredQuizzes = (s: Session) => (s.quizzes ?? []).filter((q) => q.status === "answered");

export type Targets =
  | { kind: "targets"; round: number; concepts: SessionConcept[]; retest: boolean }
  | { kind: "teach_first"; keys: string[] }
  | { kind: "limit" }
  | { kind: "none" };

/**
 * Which concepts the next quiz tests, decided in code. After a round with misses: only those concepts, once they were
 * taught again (`teach_first` until then). Otherwise the paper's own prerequisites (depth 0) that are not verified:
 * taught in this conversation first, then self-reported 懂 (never checked), then the remaining core ones; core before
 * supporting; skipped rows and concepts verified earlier (memory `checked`) or passed in a quiz are left out.
 */
export function quizTargets(s: Session): Targets {
  const done = answeredQuizzes(s);
  if (done.length >= MAX_ROUNDS) return { kind: "limit" };
  const byKey = new Map(s.concepts.map((c) => [c.key, c]));
  const last = done.at(-1);
  if (last) {
    const missed = [...new Set((last.results ?? []).filter((r) => r.outcome === "wrong" || r.outcome === "guessed").map((r) => r.concept))]
      .map((k) => byKey.get(k))
      .filter((c): c is SessionConcept => !!c && c.quiz !== "passed");
    if (missed.length) {
      const pending = missed.filter((c) => c.status !== "done");
      if (pending.length) return { kind: "teach_first", keys: pending.map((c) => c.key) };
      return { kind: "targets", round: done.length + 1, concepts: missed.slice(0, MAX_TARGETS), retest: true };
    }
  }
  const pool = s.concepts.filter((c) => isPrereq(c) && c.depth === 0 && c.status === "done" && c.outcome !== "skipped" && !verifiedBefore(c) && c.quiz !== "passed");
  const rank = (c: SessionConcept) => (c.outcome === "understood" ? 0 : c.outcome === "known" ? 1 : 2) * 2 + (c.centrality === "core" ? 0 : 1);
  const chosen = pool.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i).slice(0, MAX_TARGETS).map((x) => x.c);
  if (!chosen.length) return { kind: "none" };
  return { kind: "targets", round: done.length + 1, concepts: chosen, retest: false };
}

/** Text normalised for "is this quote in the paper": NFKC, lower case, letters / digits / CJK only. */
export const normQuote = (t: string) => t.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const normOption = (t: string) => normQuote(t);

/** Deterministic PRNG from a string seed (mulberry32 over a sha256 prefix). */
function rng(seed: string): () => number {
  let a = createHash("sha256").update(seed).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates with a seeded PRNG: the same quiz always shows the same order. */
export function shuffle<T>(list: T[], seed: string): T[] {
  const out = [...list];
  const r = rng(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * Validates the model's questions against the targets and builds the quiz items (options shuffled, values a–d).
 * `grounded(evidence)` says whether the quote is in the paper (null = the paper text is not available: not checked).
 * Returns the problems (zh-TW, one per line) instead of items when anything is wrong.
 */
export function validateQuiz(
  targets: Pick<SessionConcept, "key" | "term_en" | "term_zh">[],
  input: QuizQuestionInput[],
  quizId: string,
  grounded: (evidence: string) => boolean | null,
): { items: QuizItem[]; problems: [] } | { items: null; problems: string[] } {
  const problems: string[] = [];
  const byKey = new Map(targets.map((t) => [t.key, t]));
  const perConcept = new Map<string, number>();
  if (input.length > MAX_QUESTIONS) problems.push(`最多 ${MAX_QUESTIONS} 題。`);
  const shorts = input.filter((q) => q.format === "short").length;
  if (shorts > MAX_SHORT) problems.push(`簡答題最多 ${MAX_SHORT} 題，其他請出選擇題。`);
  if (input.length >= 2 && !input.some((q) => q.level === "apply")) problems.push("至少要有一題 apply：問這篇論文怎麼用這個概念（為什麼用 X 不用 Y、拿掉會怎樣），不只是定義。");
  if (input.length && shorts === input.length) problems.push("至少要有一題選擇題（由系統判分）。");
  const items: QuizItem[] = [];
  input.forEach((q, i) => {
    const n = `第 ${i + 1} 題`;
    const key = normaliseKey(q.concept);
    const t = byKey.get(key);
    if (!t) {
      problems.push(`${n}：「${q.concept}」不是這一輪要考的概念。`);
      return;
    }
    perConcept.set(key, (perConcept.get(key) ?? 0) + 1);
    const ok = grounded(q.evidence);
    if (ok === false) problems.push(`${n}：evidence 在論文裡找不到；請從論文逐字複製一句（文字敘述，不要公式）。`);
    let options: QuizOption[] = [];
    if (q.format === "choice") {
      const opts = q.options ?? [];
      if (opts.length < 3) problems.push(`${n}：選擇題要 3–4 個選項。`);
      const correct = opts.filter((o) => o.correct);
      if (correct.length !== 1) problems.push(`${n}：要剛好一個正確選項（目前 ${correct.length} 個）。`);
      if (new Set(opts.map((o) => normOption(o.text))).size !== opts.length) problems.push(`${n}：選項重複。`);
      const right = correct[0];
      if (right) {
        const others = opts.filter((o) => o !== right).map((o) => [...o.text].length);
        const max = Math.max(0, ...others);
        const len = [...right.text].length;
        if (others.length && len > max * 1.5 && len - max > 12) problems.push(`${n}：正確選項明顯比其他選項長，會洩漏答案；讓選項長度相近。`);
        if (normOption(right.text).length >= 6 && normOption(q.prompt).includes(normOption(right.text))) problems.push(`${n}：題目裡已經寫出正確答案。`);
      }
      const seed = `${quizId}:${i}`;
      options = shuffle(opts, seed).map((o, j) => ({ value: OPTION_VALUES[j]!, label: o.text, correct: !!o.correct, why: o.why }));
    } else {
      if (q.options?.length) problems.push(`${n}：簡答題不要有選項。`);
      if (!q.rubric || !q.model_answer) problems.push(`${n}：簡答題要有 rubric（好答案要提到什麼）與 model_answer。`);
    }
    items.push({
      id: `q${i + 1}`,
      concept: key,
      term: termLabel({ term_en: t.term_en, term_zh: t.term_zh }),
      level: q.level,
      format: q.format,
      prompt: q.prompt,
      options,
      rubric: q.rubric ?? "",
      model_answer: q.model_answer ?? "",
      section: q.section,
      evidence: q.evidence,
    });
  });
  for (const [k, n] of perConcept) if (n > 2) problems.push(`「${k}」出了 ${n} 題；每個概念最多 2 題。`);
  const missing = targets.filter((t) => !perConcept.has(t.key)).map((t) => t.key);
  if (missing.length) problems.push(`每個要考的概念至少一題，還缺：${missing.join("、")}。`);
  return problems.length ? { items: null, problems } : { items, problems: [] };
}

export const quizCardItems = (quiz: Quiz): QuizCardItem[] =>
  quiz.items.map((it) => ({ id: it.id, concept: it.concept, term: it.term, level: it.level, format: it.format, prompt: it.prompt, options: it.options.map((o) => ({ value: o.value, label: o.label })), section: it.section }));

const quizAnswerSchema = z.record(
  z.string().regex(/^q\d{1,2}$/),
  z.object({ choice: z.string().max(4).optional(), guess: z.boolean().optional(), text: z.string().max(1000).optional() }).strict(),
);

/** Parses and checks a quiz answer value (a JSON string). Null = nothing answered. Throws a 繁中 message on bad input. */
export function parseQuizAnswer(items: Pick<QuizCardItem, "id" | "format" | "options">[], value: unknown): QuizAnswer | null {
  if (typeof value !== "string") throw new Error("測驗回答的格式不正確。");
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new Error("測驗回答的格式不正確。");
  }
  const parsed = quizAnswerSchema.safeParse(raw);
  if (!parsed.success) throw new Error("測驗回答的格式不正確。");
  const out: QuizAnswer = {};
  for (const [id, a] of Object.entries(parsed.data)) {
    const it = items.find((x) => x.id === id);
    if (!it) throw new Error("測驗回答對應不到題目。");
    if (it.format === "choice") {
      if (!a.choice) continue;
      if (!it.options.some((o) => o.value === a.choice)) throw new Error("測驗的選項不正確。");
      out[id] = { choice: a.choice, ...(a.guess ? { guess: true } : {}) };
    } else {
      const text = a.text?.trim();
      if (text) out[id] = { text };
    }
  }
  return Object.keys(out).length ? out : null;
}

/** Grades the answers: choice questions by the key; a short answer is `short` (the model gives feedback, no verdict). */
export function gradeQuiz(quiz: Quiz, answer: QuizAnswer): QuizResult[] {
  return quiz.items.map((it) => {
    const a = answer[it.id];
    const right = it.options.find((o) => o.correct)?.value ?? null;
    if (it.format === "short") return { id: it.id, concept: it.concept, outcome: a?.text ? "short" : "unanswered", chosen: null, correct: null, ...(a?.text ? { text: a.text } : {}) };
    if (!a?.choice) return { id: it.id, concept: it.concept, outcome: "unanswered", chosen: null, correct: right };
    const ok = a.choice === right;
    return { id: it.id, concept: it.concept, outcome: ok ? (a.guess ? "guessed" : "correct") : "wrong", chosen: a.choice, correct: right };
  });
}

/**
 * Applies a graded quiz to the session, per concept: any wrong answer → taught again (pending, level unknown, the
 * misconception kept for the re-teach), remembered as 有聽過 when the user had said 懂; else any guessed → recapped
 * (pending, level heard), memory unchanged; else correct → verified (done, remembered known + checked). Concepts
 * with only unanswered / short answers are unchanged. Returns the memory writes and the concepts per outcome.
 */
export function applyQuizResults(s: Session, quiz: Quiz, results: QuizResult[]): { writes: MemoryWrite[]; passed: string[]; guessed: string[]; failed: string[] } {
  quiz.status = "answered";
  quiz.results = results;
  const writes: MemoryWrite[] = [];
  const out = { passed: [] as string[], guessed: [] as string[], failed: [] as string[] };
  const keys = [...new Set(results.map((r) => r.concept))];
  for (const key of keys) {
    const c = s.concepts.find((x) => x.key === key);
    if (!c) continue;
    const mine = results.filter((r) => r.concept === key);
    const w = (level: MemoryWrite["level"], source: MemoryWrite["source"]) => writes.push({ key, term_zh: c.term_zh, term_en: c.term_en, level, source });
    const wasKnown = c.level === "known" || c.memory?.level === "known";
    if (mine.some((r) => r.outcome === "wrong")) {
      const miss = mine.find((r) => r.outcome === "wrong")!;
      const it = quiz.items.find((i) => i.id === miss.id);
      const chose = it?.options.find((o) => o.value === miss.chosen);
      Object.assign(c, { status: "pending", level: "unknown", outcome: "unclear", quiz: "failed", quiz_miss: chose ? `選了「${chose.label}」：${chose.why}` : "" });
      if (wasKnown) w("heard", "self_report");
      out.failed.push(key);
    } else if (mine.some((r) => r.outcome === "guessed")) {
      Object.assign(c, { status: "pending", level: "heard", outcome: "unclear", quiz: "guessed", quiz_miss: "" });
      out.guessed.push(key);
    } else if (mine.some((r) => r.outcome === "correct")) {
      Object.assign(c, { status: "done", level: "known", outcome: "understood", quiz: "passed", quiz_miss: "", check: c.check === "offered" ? "passed" : c.check });
      w("known", "checked");
      out.passed.push(key);
    }
  }
  return { writes, ...out };
}

/** The note for the model after a quiz answer: per question the result, then what to do next. */
export function quizNote(s: Session, quiz: Quiz, applied: ReturnType<typeof applyQuizResults>, paperId: string): string {
  const lines = quiz.items.map((it, i) => {
    const r = quiz.results?.find((x) => x.id === it.id);
    const opt = (v: string | null | undefined) => it.options.find((o) => o.value === v);
    const head = `${i + 1}. [${it.concept}] ${it.prompt}`;
    if (!r || r.outcome === "unanswered") return `${head}\n   → 沒作答（正確答案：${opt(r?.correct)?.label ?? "—"}；${opt(r?.correct)?.why ?? ""}）`;
    if (r.outcome === "short") return `${head}\n   → 簡答：「${r.text}」\n   評分標準：${it.rubric}\n   參考答案：${it.model_answer}\n   （依評分標準給具體回饋；不要判對錯分數，這題不影響記錄）`;
    const chose = opt(r.chosen);
    const right = opt(r.correct);
    return r.outcome === "correct"
      ? `${head}\n   → 答對：「${chose?.label}」。${right?.why ?? ""}`
      : r.outcome === "guessed"
        ? `${head}\n   → 答對但使用者說是猜的：「${chose?.label}」。${right?.why ?? ""}`
        : `${head}\n   → 答錯：選了「${chose?.label}」（${chose?.why ?? ""}）。正確是「${right?.label}」：${right?.why ?? ""}`;
  });
  const left = applied.failed.length + applied.guessed.length;
  const next = left
    ? `接著：先用一兩句總結結果（不要打分數、不要說教），逐題簡短講解答錯與猜的題目。然後呼叫 next_concept（paper_id ${paperId}），把答錯的概念換一個和之前不同的角度與例子重講、猜對的簡短講清楚，一次一個；都講完後系統會請你出下一輪（只考這些概念）。`
    : applied.passed.length
      ? "全部答對：用一句話肯定使用者，簡短補充有價值的題目講解即可，不要再出題。"
      : "使用者沒有作答選擇題：簡短回饋，不要再出題。";
  return [`小測驗第 ${quiz.round} 輪的結果（系統判分）：`, ...lines, next].join("\n");
}

/** How a quiz answer reads in the user's turn (display and model): one line per item. */
export function quizAnswerLines(items: QuizCardItem[], answer: QuizAnswer | null): string[] {
  return items.map((it, i) => {
    const a = answer?.[it.id];
    const val = !a ? "（沒作答）" : it.format === "short" ? (a.text ?? "") : `${a.choice?.toUpperCase()}. ${it.options.find((o) => o.value === a.choice)?.label ?? ""}${a.guess ? "（我是猜的）" : ""}`;
    return `${i + 1}. ${it.prompt}\n   → ${val}`;
  });
}

/**
 * What the tutoring tools say about the quiz once no gap is left (next_concept without a section, mark_concepts):
 * offer the first round after the paper was explained, or the next round after a re-teach. Empty when the user
 * turned checks off (「直接講」 / skipped), no concept qualifies, or the rounds are used up.
 */
export function quizHint(s: Session): string {
  if (s.checks_off && !answeredQuizzes(s).length) return "";
  if ((s.quizzes ?? []).some((q) => q.status === "skipped")) return "";
  const t = quizTargets(s);
  if (t.kind !== "targets") return "";
  return t.retest
    ? `重講完了：呼叫 build_quiz（paper_id ${s.paper_id}）出第 ${t.round} 輪小測驗，只考 ${t.concepts.map((c) => c.key).join("、")}，題目要和上一輪不同。`
    : `整篇論文講完、使用者沒有其他問題時，呼叫 build_quiz（paper_id ${s.paper_id}）提供一份 3–5 題的小測驗確認理解（使用者可以略過）；論文還沒講完就先繼續講。`;
}

// ---------------------------------------------------------------- DB

/**
 * The user answered (or skipped) a quiz card, inside the turn's transaction: grades it, applies the result to the
 * session and the user's concept memory. Returns the note for the model and the per-item results the card shows.
 */
export async function applyQuizAnswer(db: Queryable, conversationId: string, paperId: string, quizId: string, answer: QuizAnswer | null): Promise<{ note: string; graded: { id: string; outcome: QuizResult["outcome"]; correct: string | null; why?: string }[] | null }> {
  const conv = (await db.query<{ user_id: string }>("SELECT user_id FROM conversations WHERE id=$1", [conversationId])).rows[0];
  const s = conv ? await loadSession(db, conversationId, paperId, true) : null;
  const quiz = s?.quizzes?.find((q) => q.id === quizId);
  if (!conv || !s || !quiz) return { note: "", graded: null };
  if (quiz.status !== "open") return { note: "這份小測驗之前已經作答過，這次的作答不再判分；不要再出題。", graded: null };
  if (!answer) {
    quiz.status = "skipped";
    await saveSession(db, conversationId, s, { pending: true });
    return { note: "使用者略過了小測驗：不要再出題，也不要追問；繼續回答使用者。", graded: null };
  }
  const results = gradeQuiz(quiz, answer);
  const applied = applyQuizResults(s, quiz, results);
  await saveSession(db, conversationId, s, { pending: true });
  const saved = await writeMemory(db, conv.user_id, paperId, applied.writes);
  const line = savedLine(saved, new Map(s.concepts.map((c) => [c.key, c])));
  const graded = results.map((r) => {
    const it = quiz.items.find((i) => i.id === r.id)!;
    const why = it.options.find((o) => o.value === r.correct)?.why;
    return { id: r.id, outcome: r.outcome, correct: r.correct, ...(why ? { why } : {}) };
  });
  return { note: [quizNote(s, quiz, applied, paperId), line ? `記憶已更新：${line}（可在 設定 → 記憶 → 懂的概念 修改）。` : ""].filter(Boolean).join("\n"), graded };
}
