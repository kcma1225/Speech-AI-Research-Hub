/** 「先確認先備知識」 rules (src/agent/tutor.ts) and the concept_check card schema / answers (src/agent/ask.ts). */
import { describe, expect, it } from "vitest";
import { askUserInput, answersText, validateAnswers } from "../src/agent/ask.js";
import { systemPrompt } from "../src/agent/prompt.js";
import {
  addSubConcepts,
  applyCardAnswer,
  applyOutcomes,
  buildSession,
  cardRows,
  DIRECT,
  MAX_PREREQS,
  mergeMemory,
  nextConcept,
  normaliseKey,
  parseCardValue,
  savedLine,
  SUB_BUDGET,
  topoOrder,
  type ConceptInput,
  type MemoryRow,
} from "../src/agent/tutor.js";

const P = "00000000-0000-4000-8000-000000000001";
const pre = (term_en: string, extra: Partial<ConceptInput> = {}): ConceptInput => ({ term_en, gloss: `${term_en} 的一句話`, kind: "prerequisite", ...extra });
const mem = (rows: Partial<MemoryRow>[]) => new Map(rows.map((r) => [r.concept_key!, { term_zh: "", term_en: r.concept_key!, level: "known", source: "self_report", ...r } as MemoryRow]));

describe("tutor: keys and order", () => {
  it("normalises keys", () => {
    expect(normaliseKey("  Connectionist Temporal Classification (CTC) ")).toBe("connectionist temporal classification ctc");
    expect(normaliseKey("Mel-Frequency  Cepstral Coefficients")).toBe("mel-frequency cepstral coefficients");
    expect(normaliseKey("ＭＦＣＣ")).toBe("mfcc");
    expect(normaliseKey("中文")).toBe("");
  });

  it("orders leaves first, keeps input order for ties, breaks cycles deterministically", () => {
    expect(topoOrder([{ key: "c", depends_on: ["b"] }, { key: "b", depends_on: ["a"] }, { key: "a", depends_on: [] }]).order).toEqual(["a", "b", "c"]);
    expect(topoOrder([{ key: "x", depends_on: [] }, { key: "y", depends_on: [] }]).order).toEqual(["x", "y"]);
    const cyc = topoOrder([{ key: "a", depends_on: ["b"] }, { key: "b", depends_on: ["a"] }, { key: "c", depends_on: ["a", "zzz", "c"] }]);
    expect(cyc.order).toEqual(["a", "b", "c"]);
    expect(cyc.broken).toEqual(["a"]);
    // Same input → same output.
    expect(topoOrder([{ key: "a", depends_on: ["b"] }, { key: "b", depends_on: ["a"] }]).order).toEqual(cyc.order.slice(0, 2));
  });
});

describe("tutor: buildSession caps and validation", () => {
  it("caps prerequisites (core first), merges duplicates, drops dangling dependencies, never asks paper-defined terms", () => {
    const input: ConceptInput[] = [
      ...Array.from({ length: 12 }, (_, i) => pre(`Concept ${i}`, { centrality: i >= 10 ? "core" : "supporting" })),
      pre("concept 0"),
      { term_en: "Our Fancy Loss", gloss: "論文提出的 loss", kind: "paper_defined" },
      { term_en: "x_t", gloss: "第 t 個 frame", kind: "symbol" },
      pre("Softmax", { depends_on: ["concept 11", "not in list"] }),
    ];
    const { session, dropped, merged } = buildSession(P, input, new Map());
    const prereqs = session.concepts.filter((c) => c.kind === "prerequisite");
    expect(prereqs).toHaveLength(MAX_PREREQS);
    expect(prereqs.map((c) => c.key)).toContain("concept 10");
    expect(prereqs.map((c) => c.key)).toContain("concept 11");
    expect(merged).toEqual(["concept 0"]);
    expect(dropped.length).toBe(3); // 13 distinct prerequisites − 10
    expect(cardRows(session).map((r) => r.key)).not.toContain("our fancy loss");
    expect(session.concepts.find((c) => c.key === "x t")?.status).toBe("done");
  });

  it("orders card rows topologically and pre-fills from memory; checked concepts are never asked", () => {
    const { session } = buildSession(P, [pre("CTC", { depends_on: ["HMM"] }), pre("HMM"), pre("MFCC")], mem([{ concept_key: "mfcc", level: "known", source: "checked" }, { concept_key: "hmm", level: "heard" }]));
    const rows = cardRows(session);
    expect(rows.map((r) => r.key)).toEqual(["hmm", "ctc"]);
    expect(rows[0]).toMatchObject({ prefill: "heard", remembered: true });
    expect(rows[1]!.prefill).toBeUndefined();
    expect(session.concepts.find((c) => c.key === "mfcc")).toMatchObject({ status: "done", outcome: "known" });
  });
});

describe("tutor: card answer, next concept, explain-back", () => {
  const fresh = () => buildSession(P, [pre("CTC", { depends_on: ["HMM"], centrality: "core", section: "3.1" }), pre("HMM", { section: "2" }), pre("Beam Search", { section: "4" })], new Map()).session;

  it("parses card values and rejects unknown keys or levels", () => {
    const rows = [{ key: "ctc" }, { key: "hmm" }];
    expect(parseCardValue(rows, ["ctc=known"]).levels.get("ctc")).toBe("known");
    expect(() => parseCardValue(rows, ["xx=known"])).toThrow();
    expect(() => parseCardValue(rows, ["ctc=maybe"])).toThrow();
    expect(() => parseCardValue(rows, ["ctc=known", "ctc=heard"])).toThrow();
    const d = parseCardValue(rows, [DIRECT]);
    expect(d.direct).toBe(true);
    expect([...d.levels.values()]).toEqual(["known", "known"]);
  });

  it("requires the card first; then teaches gaps leaves-first and offers one explain-back per core concept", () => {
    const s = fresh();
    expect(nextConcept(s).kind).toBe("card_needed");
    const writes = applyCardAnswer(s, parseCardValue(cardRows(s), ["hmm=unknown", "ctc=heard", "beam search=known"]));
    expect(writes.map((w) => [w.key, w.level, w.source])).toEqual([["hmm", "unknown", "self_report"], ["ctc", "heard", "self_report"], ["beam search", "known", "self_report"]]);
    const n1 = nextConcept(s);
    expect(n1).toMatchObject({ kind: "concept", mode: "explain", verify: false });
    expect(n1.kind === "concept" && n1.concept.key).toBe("hmm");
    applyOutcomes(s, [{ key: "hmm", outcome: "understood" }]);
    const n2 = nextConcept(s);
    expect(n2).toMatchObject({ kind: "concept", mode: "recap", verify: true });
    // Asking again does not offer a second explain-back.
    const again = nextConcept(s);
    expect(again).toMatchObject({ kind: "concept", verify: false });
    const r = applyOutcomes(s, [{ key: "ctc", outcome: "explain_back_passed" }]);
    expect(r.writes).toEqual([expect.objectContaining({ key: "ctc", level: "known", source: "checked" })]);
    expect(nextConcept(s)).toMatchObject({ kind: "none" });
  });

  it("section filter returns only what that section needs (and its dependencies)", () => {
    const s = fresh();
    applyCardAnswer(s, parseCardValue(cardRows(s), ["hmm=unknown", "ctc=unknown", "beam search=unknown"]));
    const n = nextConcept(s, "§3");
    expect(n.kind === "concept" && n.concept.key).toBe("hmm");
    expect(nextConcept(s, "5")).toMatchObject({ kind: "none", section: "5" });
  });

  it("「直接講」 and a skipped card turn checks off; a skipped explain-back too", () => {
    const s = fresh();
    applyCardAnswer(s, parseCardValue(cardRows(s), [DIRECT]));
    expect(s.checks_off).toBe(true);
    expect(nextConcept(s)).toMatchObject({ kind: "none" });
    const k = fresh();
    applyCardAnswer(k, null);
    expect(k).toMatchObject({ answered: true, checks_off: true });
    expect(nextConcept(k)).toMatchObject({ kind: "none" });
    const t = fresh();
    applyCardAnswer(t, parseCardValue(cardRows(t), ["hmm=known", "ctc=unknown"]));
    expect(nextConcept(t)).toMatchObject({ verify: true });
    applyOutcomes(t, [{ key: "ctc", outcome: "skipped" }]);
    expect(t.checks_off).toBe(true);
  });

  it("explain-back outcomes without an offered check count as understood / unclear", () => {
    const s = fresh();
    applyCardAnswer(s, parseCardValue(cardRows(s), ["hmm=unknown"]));
    nextConcept(s);
    const r = applyOutcomes(s, [{ key: "hmm", outcome: "explain_back_passed" }, { key: "nope", outcome: "understood" }]);
    expect(r.writes[0]).toMatchObject({ key: "hmm", source: "self_report", level: "known" });
    expect(r.unknown).toEqual(["nope"]);
    expect(r.notes.length).toBe(1);
  });
});

describe("tutor: lazy recursion", () => {
  it("adds sub-prerequisites before the parent with depth and budget limits", () => {
    const { session: s } = buildSession(P, [pre("CTC", { centrality: "core" })], new Map());
    applyCardAnswer(s, parseCardValue(cardRows(s), ["ctc=unknown"]));
    const out = addSubConcepts(s, "ctc", [{ term_en: "Dynamic Programming", gloss: "g", kind: "prerequisite" }, { term_en: "Softmax", gloss: "g", kind: "prerequisite" }], mem([{ concept_key: "softmax", level: "known" }]));
    expect(out.added).toEqual(["dynamic programming"]);
    expect(out.known).toEqual(["softmax"]);
    const n = nextConcept(s);
    expect(n.kind === "concept" && n.concept.key).toBe("dynamic programming");
    expect(n.kind === "concept" && n.chain).toEqual(["ctc"]);
    // Depth 3 max.
    addSubConcepts(s, "dynamic programming", [{ term_en: "Recursion", gloss: "g", kind: "prerequisite" }], new Map());
    addSubConcepts(s, "recursion", [{ term_en: "Function", gloss: "g", kind: "prerequisite" }], new Map());
    expect(() => addSubConcepts(s, "function", [{ term_en: "Set", gloss: "g", kind: "prerequisite" }], new Map())).toThrow(/第 3 層/);
    // Cycles are refused.
    expect(addSubConcepts(s, "recursion", [{ term_en: "CTC", gloss: "g", kind: "prerequisite" }], new Map()).refused[0]!.why).toMatch(/循環/);
    // Budget.
    let added = s.concepts.filter((c) => c.depth > 0).length;
    for (let i = 0; i < 20; i++) added += addSubConcepts(s, "ctc", [{ term_en: `Extra ${i}`, gloss: "g", kind: "prerequisite" }], new Map()).added.length;
    expect(added).toBeLessThanOrEqual(SUB_BUDGET);
    expect(() => addSubConcepts(s, "nothing", [{ term_en: "x", gloss: "g", kind: "prerequisite" }], new Map())).toThrow();
  });
});

describe("tutor: memory merge", () => {
  it("checked known is not demoted by a self-report of known; other writes replace", () => {
    expect(mergeMemory({ level: "known", source: "checked" }, { level: "known", source: "self_report" })).toBeNull();
    expect(mergeMemory({ level: "known", source: "checked" }, { level: "unknown", source: "self_report" })).toEqual({ level: "unknown", source: "self_report" });
    expect(mergeMemory({ level: "heard", source: "self_report" }, { level: "known", source: "checked" })).toEqual({ level: "known", source: "checked" });
    expect(mergeMemory(null, { level: "heard", source: "self_report" })).toEqual({ level: "heard", source: "self_report" });
    expect(mergeMemory({ level: "heard", source: "self_report" }, { level: "heard", source: "self_report" })).toBeNull();
  });
  it("saved line uses abbreviations", () => {
    const byKey = new Map([["ctc", { term_zh: "連結時序分類", term_en: "Connectionist Temporal Classification (CTC)" }], ["mfcc", { term_zh: "", term_en: "MFCC" }]]);
    expect(savedLine([{ key: "ctc", term_zh: "", term_en: "", level: "known", source: "self_report" }, { key: "mfcc", term_zh: "", term_en: "", level: "known", source: "self_report" }], byKey)).toBe("已記下你懂：CTC、MFCC");
  });
});

describe("concept_check card", () => {
  const card = { questions: [{ id: "concepts", type: "concept_check", prompt: "熟悉哪些？", paper_id: P, concepts: [{ key: "ctc", term_en: "CTC", term_zh: "連結時序分類", gloss: "g" }, { key: "hmm", term_en: "HMM", gloss: "g" }] }] };
  it("schema: needs paper_id, alone on its card", () => {
    expect(askUserInput.safeParse(card).success).toBe(true);
    expect(askUserInput.safeParse({ questions: [{ id: "c", type: "concept_check", prompt: "?" }] }).success).toBe(false);
    expect(askUserInput.safeParse({ questions: [card.questions[0], { id: "x", prompt: "?", type: "short_text" }] }).success).toBe(false);
  });
  it("answers: validated, labelled, keys for the model; empty = skipped", () => {
    const args = askUserInput.parse(card);
    const id = crypto.randomUUID();
    expect(() => validateAnswers(args, { tool_call_id: id, answers: [{ id: "concepts", value: ["zzz=known"] }] })).toThrow(/概念/);
    const stored = validateAnswers(args, { tool_call_id: id, answers: [{ id: "concepts", value: ["hmm=unknown", "ctc=known"] }] });
    expect(stored.answers[0]!.value).toEqual(["ctc=known", "hmm=unknown"]);
    const text = answersText(args, stored);
    expect(text.display).toContain("懂：連結時序分類（CTC）；不懂：HMM");
    expect(text.model).toContain("[hmm] HMM：不懂");
    const direct = validateAnswers(args, { tool_call_id: id, answers: [{ id: "concepts", value: [DIRECT] }] });
    expect(answersText(args, direct).display).toContain("全部都懂，直接講");
    expect(validateAnswers(args, { tool_call_id: id, answers: [{ id: "concepts", skipped: true }] }).answers[0]).toMatchObject({ skipped: true });
  });
  it("prompt: tutoring rules only when the switch is on", () => {
    const off = systemPrompt({ mode: "chat", user: { name: "A", role: "student" }, memories: null });
    const on = systemPrompt({ mode: "chat", user: { name: "A", role: "student" }, memories: null, prereqCheck: true });
    expect(off).not.toContain("extract_prerequisites");
    expect(on).toContain("extract_prerequisites");
    expect(on).toContain("concept_check");
    expect(on.startsWith(off.split("\n")[0]!)).toBe(true);
  });
});
