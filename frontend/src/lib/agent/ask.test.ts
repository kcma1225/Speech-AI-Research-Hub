import { describe, expect, it } from "vitest";
import { answerLabel, CONCEPT_DIRECT, conceptLevels } from "./ask.ts";
import type { AskQuestion } from "./types.ts";

describe("concept_check answers", () => {
  const q: AskQuestion = { id: "c", prompt: "?", type: "concept_check", paper_id: "p", concepts: [{ key: "ctc", term_en: "CTC", term_zh: "連結時序分類", gloss: "g" }, { key: "hmm", term_en: "HMM", gloss: "g" }] };
  it("parses key=level entries", () => {
    expect([...conceptLevels(["ctc=known", CONCEPT_DIRECT, "hmm=unknown", "bad"]).entries()]).toEqual([["ctc", "known"], ["hmm", "unknown"]]);
  });
  it("labels grouped by level, the shortcut and a skip", () => {
    expect(answerLabel(q, { id: "c", value: ["ctc=known", "hmm=unknown"] })).toContain("連結時序分類（CTC）");
    expect(answerLabel(q, { id: "c", value: [CONCEPT_DIRECT] })).not.toContain("CTC");
    expect(answerLabel(q, { id: "c", skipped: true })).not.toContain("CTC");
  });
});
