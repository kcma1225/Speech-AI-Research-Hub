/** End-of-paper quiz rules (src/agent/quiz.ts) and the quiz card schema / answers (src/agent/ask.ts). */
import { describe, expect, it } from "vitest";
import { askUserInput, answersText, validateAnswers } from "../src/agent/ask.js";
import {
  applyQuizResults,
  gradeQuiz,
  MAX_ROUNDS,
  parseQuizAnswer,
  quizCardItems,
  quizHint,
  quizTargets,
  shuffle,
  validateQuiz,
  type Quiz,
  type QuizQuestionInput,
} from "../src/agent/quiz.js";
import { applyCardAnswer, buildSession, nextConcept, type ConceptInput, type MemoryRow, type Session } from "../src/agent/tutor.js";

const P = "00000000-0000-4000-8000-000000000001";
const pre = (term_en: string, extra: Partial<ConceptInput> = {}): ConceptInput => ({ term_en, gloss: `${term_en} 的一句話`, kind: "prerequisite", ...extra });

/** A session: A (core, taught), B (self-reported known), C (core, known), D (skipped row), E (verified before). */
function session(): Session {
  const memory = new Map<string, MemoryRow>([["e", { concept_key: "e", term_zh: "", term_en: "E", level: "known", source: "checked" }]]);
  const s = buildSession(P, [pre("A", { centrality: "core" }), pre("B"), pre("C", { centrality: "core" }), pre("D"), pre("E")], memory).session;
  applyCardAnswer(s, { levels: new Map([["a", "unknown"], ["b", "known"], ["c", "known"]]), direct: false });
  const a = s.concepts.find((c) => c.key === "a")!;
  Object.assign(a, { status: "done", outcome: "understood", level: "known" });
  return s;
}

const choice = (concept: string, extra: Partial<QuizQuestionInput> = {}): QuizQuestionInput => ({
  concept,
  level: "concept",
  format: "choice",
  prompt: `關於 ${concept} 哪一個說法正確？`,
  options: [
    { text: "正確的說法在這裡", correct: true, why: "因為論文這樣定義" },
    { text: "常見的誤解之一喔", why: "混淆了兩個概念" },
    { text: "另一個常見的誤解", why: "把結果當原因" },
  ],
  section: "3",
  evidence: "We use CTC on MFCC features.",
  ...extra,
});
const yes = () => true;

describe("quiz: targets", () => {
  it("taught first, then self-reported 懂, core before supporting; skipped and verified-before left out", () => {
    const t = quizTargets(session());
    expect(t.kind).toBe("targets");
    if (t.kind !== "targets") return;
    expect(t.concepts.map((c) => c.key)).toEqual(["a", "c", "b"]);
    expect(t).toMatchObject({ round: 1, retest: false });
  });

  it("after misses: re-teach first, then only those concepts; capped at MAX_ROUNDS", () => {
    const s = session();
    const t = quizTargets(s);
    if (t.kind !== "targets") throw new Error("no targets");
    const v = validateQuiz(t.concepts, [choice("a", { level: "apply" }), choice("b"), choice("c")], "qz1", yes);
    if (!v.items) throw new Error(v.problems.join());
    const quiz: Quiz = { id: "qz1", round: 1, status: "open", items: v.items, created_at: "" };
    s.quizzes = [quiz];
    const right = (id: string) => v.items.find((i) => i.id === id)!.options.find((o) => o.correct)!.value;
    const wrong = (id: string) => v.items.find((i) => i.id === id)!.options.find((o) => !o.correct)!.value;
    const res = applyQuizResults(s, quiz, gradeQuiz(quiz, { q1: { choice: wrong("q1") }, q2: { choice: right("q2"), guess: true }, q3: { choice: right("q3") } }));
    expect(res).toMatchObject({ failed: ["a"], guessed: ["b"], passed: ["c"] });
    // a: taught → said known → failed: demoted to 有聽過; c verified; b unchanged
    expect(res.writes).toEqual([
      expect.objectContaining({ key: "a", level: "heard", source: "self_report" }),
      expect.objectContaining({ key: "c", level: "known", source: "checked" }),
    ]);
    expect(quizTargets(s)).toEqual({ kind: "teach_first", keys: ["a", "b"] });
    // the re-teach: a with the misconception, explain mode, no explain-back
    const n = nextConcept(s);
    expect(n).toMatchObject({ kind: "concept", concept: { key: "a", quiz: "failed" }, mode: "explain", verify: false });
    if (n.kind === "concept") expect(n.concept.quiz_miss).toMatch(/^選了「.+」：(混淆了兩個概念|把結果當原因)$/);
    for (const c of s.concepts) if (c.status !== "done" && c.kind === "prerequisite") c.status = "done";
    const t2 = quizTargets(s);
    expect(t2).toMatchObject({ kind: "targets", round: 2, retest: true });
    if (t2.kind === "targets") expect(t2.concepts.map((c) => c.key)).toEqual(["a", "b"]);
    expect(quizHint(s)).toContain("第 2 輪");
    s.quizzes = Array.from({ length: MAX_ROUNDS }, (_, i) => ({ ...quiz, id: `x${i}`, status: "answered" as const }));
    expect(quizTargets(s)).toEqual({ kind: "limit" });
    expect(quizHint(s)).toBe("");
  });

  it("all passed: nothing left to test; skipped / 直接講: no offer", () => {
    const s = session();
    for (const c of s.concepts) c.quiz = "passed";
    expect(quizTargets(s)).toEqual({ kind: "none" });
    const off = session();
    off.checks_off = true;
    expect(quizHint(off)).toBe("");
    const skipped = session();
    skipped.quizzes = [{ id: "z", round: 1, status: "skipped", items: [], created_at: "" }];
    expect(quizHint(skipped)).toBe("");
    expect(quizHint(session())).toContain("build_quiz");
  });
});

describe("quiz: validation", () => {
  const targets = [{ key: "a", term_en: "A", term_zh: "甲" }, { key: "b", term_en: "B", term_zh: "" }];
  const problems = (input: QuizQuestionInput[], grounded: (e: string) => boolean | null = yes) => {
    const v = validateQuiz(targets, input, "seed", grounded);
    return v.items ? [] : v.problems;
  };

  it("accepts a good quiz; items keep the key server side, the card does not", () => {
    const v = validateQuiz(targets, [choice("a"), choice("B", { level: "apply" })], "seed", yes);
    expect(v.problems).toEqual([]);
    expect(v.items![0]).toMatchObject({ id: "q1", concept: "a", term: "甲（A）" });
    expect(v.items![0]!.options.filter((o) => o.correct)).toHaveLength(1);
    const card = quizCardItems({ id: "seed", round: 1, status: "open", items: v.items!, created_at: "" });
    expect(JSON.stringify(card)).not.toMatch(/correct|why|evidence|rubric/);
  });

  it("rejects: unknown concept, missing target, no apply, two correct, duplicates, length giveaway, answer in prompt, ungrounded, too many shorts", () => {
    expect(problems([choice("a"), choice("z", { level: "apply" })]).join()).toMatch(/不是這一輪要考的概念/);
    expect(problems([choice("a", { level: "apply" })]).join()).toMatch(/還缺：b/);
    expect(problems([choice("a"), choice("b")]).join()).toMatch(/apply/);
    const two = choice("a", { level: "apply", options: [{ text: "一", correct: true, why: "因為一" }, { text: "二", correct: true, why: "因為二" }, { text: "三", why: "因為三" }] });
    expect(problems([two, choice("b")]).join()).toMatch(/剛好一個正確選項/);
    const dup = choice("a", { level: "apply", options: [{ text: "同一個", correct: true, why: "因為一" }, { text: "同 一 個", why: "因為二" }, { text: "三", why: "因為三" }] });
    expect(problems([dup, choice("b")]).join()).toMatch(/選項重複/);
    const long = choice("a", { level: "apply", options: [{ text: "這是一個非常非常長而且非常詳細完整的正確答案說明喔", correct: true, why: "因為一" }, { text: "短的", why: "因為二" }, { text: "也短", why: "因為三" }] });
    expect(problems([long, choice("b")]).join()).toMatch(/明顯比其他選項長/);
    expect(problems([choice("a", { level: "apply", prompt: "為什麼「正確的說法在這裡」是對的？" }), choice("b")]).join()).toMatch(/題目裡已經寫出正確答案/);
    expect(problems([choice("a", { level: "apply" }), choice("b")], () => false).join()).toMatch(/evidence/);
    const short = (c: string): QuizQuestionInput => ({ concept: c, level: "apply", format: "short", prompt: "用自己的話說明這個概念", rubric: "要提到對齊", model_answer: "…", section: "3", evidence: "We use CTC on MFCC features." });
    expect(problems([short("a"), short("b")]).join()).toMatch(/簡答題最多/);
    expect(problems([choice("a"), { ...short("b"), rubric: undefined }]).join()).toMatch(/rubric/);
    // paper text unavailable (null): not checked
    expect(problems([choice("a", { level: "apply" }), choice("b")], () => null)).toEqual([]);
  });

  it("shuffles options deterministically; the correct option is not always first", () => {
    expect(shuffle([1, 2, 3, 4], "x")).toEqual(shuffle([1, 2, 3, 4], "x"));
    const firsts = new Set<number>();
    for (let i = 0; i < 20; i++) {
      const v = validateQuiz(targets, [choice("a", { level: "apply" }), choice("b")], `seed${i}`, yes);
      firsts.add(v.items![0]!.options.findIndex((o) => o.correct));
    }
    expect(firsts.size).toBeGreaterThan(1);
  });
});

describe("quiz: card answers", () => {
  const v = validateQuiz([{ key: "a", term_en: "A", term_zh: "" }], [choice("a", { level: "apply" })], "seed", yes);
  const items = quizCardItems({ id: "seed", round: 1, status: "open", items: v.items!, created_at: "" });
  const args = askUserInput.parse({ questions: [{ id: "quiz", type: "quiz", prompt: "小測驗", paper_id: P, quiz_id: "seed", items }] });

  it("schema: needs paper_id + quiz_id, only question on its card", () => {
    expect(askUserInput.safeParse({ questions: [{ id: "quiz", type: "quiz", prompt: "小測驗", paper_id: P }] }).success).toBe(false);
    expect(askUserInput.safeParse({ questions: [{ id: "quiz", type: "quiz", prompt: "小測驗", paper_id: P, quiz_id: "s" }, { id: "x", type: "short_text", prompt: "?" }] }).success).toBe(false);
  });

  it("parses, validates and formats answers; skipped when empty", () => {
    const c = items[0]!.options[1]!.value;
    expect(parseQuizAnswer(items, JSON.stringify({ q1: { choice: c, guess: true } }))).toEqual({ q1: { choice: c, guess: true } });
    expect(() => parseQuizAnswer(items, JSON.stringify({ q1: { choice: "z" } }))).toThrow(/選項/);
    expect(() => parseQuizAnswer(items, JSON.stringify({ q9: { choice: c } }))).toThrow(/對應不到/);
    expect(() => parseQuizAnswer(items, "nope")).toThrow(/格式/);
    expect(parseQuizAnswer(items, "{}")).toBeNull();
    const stored = validateAnswers(args, { tool_call_id: "00000000-0000-4000-8000-000000000009", answers: [{ id: "quiz", value: JSON.stringify({ q1: { choice: c, guess: true } }) }] });
    expect(stored.answers[0]!.skipped).toBeUndefined();
    const text = answersText(args, stored);
    expect(text.display).toContain("（我是猜的）");
    expect(text.model).toContain("tutor_note");
    expect(validateAnswers(args, { tool_call_id: "00000000-0000-4000-8000-000000000009", answers: [{ id: "quiz", value: "{}" }] }).answers[0]).toMatchObject({ skipped: true });
  });
});
