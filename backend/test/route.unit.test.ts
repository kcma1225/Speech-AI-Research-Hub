/**
 * The router (route.ts): ONE decision from the Brief — deliverable, playbook (the assistant's is a hint), deck mode / edit
 * kind, batch, and when to ask. Table-driven over the production failures (R5 audit, eval baseline) plus normal requests.
 */
import { describe, expect, it } from "vitest";
import "../src/workflows/playbooks/index.js";
import { route, routeStage, servesDeliverable, type RouteInput, type RouteReadiness } from "../src/workflows/route.js";
import { validStages, boundedDrafts } from "../src/workflows/goals/planner.js";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const P3 = "33333333-3333-4333-8333-333333333333";
const DECK = "44444444-4444-4444-8444-444444444444";
const PROJECT = "55555555-5555-4555-8555-555555555555";
const LIB: RouteReadiness = {
  papers: 10, papers_with_pdf: 9, experiment_notes: 0, latex_projects: 0,
  paperTitles: [{ id: P1, title: "Deep context: end-to-end contextual speech recognition" }, { id: P2, title: "Contextual Adapters for Personalized Speech Recognition in Neural Transducers" }],
};

type Row = { name: string; in: RouteInput; want: Partial<{ kind: string; playbook: string; deck: string; edit: string; batch: boolean; ask: string; hintAccepted: boolean }> };

const rows: Row[] = [
  // ---- production failures
  { name: "50b49d80: English topic deck that says 'Paper title' is a topic deck, not a paper report",
    in: { words: ['Make an English presentation on dynamic hotword biasing for streaming Zipformer / RNN-T ASR. Paper title: "Contextual Biasing for Streaming Transducers: A Survey". Cover the methods in our study library.'], ready: LIB },
    want: { kind: "deck", playbook: "slides", deck: "topic", batch: false } },
  { name: "c1b9a129: 「根據筆記製作約 8 頁簡報」 stays a deck (no paper needed, never generic)",
    in: { words: ["根據筆記製作約 8 頁簡報"], hint: "generic", ready: LIB }, want: { kind: "deck", playbook: "slides", deck: "progress", hintAccepted: false } },
  { name: "eval kind_conflict: reading_note hint + 「做成簡報」 → the Brief (deck) wins over the hint",
    in: { words: ["把〈Deep context: end-to-end contextual speech recognition〉做成簡報"], hint: "reading_note", inputs: { paper_id: P1 }, explicitPaper: true, ready: LIB },
    want: { kind: "deck", playbook: "slides", deck: "paper_report", hintAccepted: false } },
  { name: "a3b59ddd: a LaTeX paper is never a note (generic hint rejected)",
    in: { words: ["可編譯的 LaTeX 論文，不要只交 Markdown 筆記"], hint: "generic", ready: LIB }, want: { kind: "latex", playbook: "paper_draft", hintAccepted: false } },
  { name: "latex_section chosen for a paper-report deck → slides",
    in: { words: ["幫我做一份論文報告簡報：Contextual Adapters for Personalized Speech Recognition in Neural Transducers"], hint: "latex_section", ready: LIB },
    want: { kind: "deck", playbook: "slides", deck: "paper_report", hintAccepted: false } },
  { name: "5 paper_ids from the assistant → ONE deck (no batch without the user's words)",
    in: { words: ["幫我做一份英文簡報，根據研究文獻庫整理"], paraphrase: "Create one English deck", inputs: { paper_ids: [P1, P2, P3] }, ready: LIB },
    want: { kind: "deck", playbook: "slides", batch: false } },
  { name: "「每個方法要有…」 is per-item fields, not a per-paper batch",
    in: { words: ["做一份動態熱詞的簡報，每個方法要有架構、Pros/Cons"], ready: LIB }, want: { kind: "deck", batch: false } },
  { name: "eval note_generic_metrics: metrics (CER) + 「寫成一份筆記」 is a note, not an experiment report",
    in: { words: ["整理串流語音辨識常用的評估指標（CER、罕見詞 recall、誤觸發率、延遲）與計算方式，寫成一份筆記"], ready: LIB }, want: { kind: "note", playbook: "generic" } },
  { name: "experiment_report hint without experiment words or data is not taken",
    in: { words: ["整理 CER 和 WER 的計算方式"], hint: "experiment_report", ready: LIB }, want: { kind: "note", playbook: "generic", hintAccepted: false } },
  { name: "a topic survey asked as a reading note (no paper) → topic research",
    in: { words: ["在 Zipformer + RNNT 下研究有哪些 dynamic hotwording 做法"], hint: "reading_note", ready: LIB }, want: { kind: "note", playbook: "topic_research", hintAccepted: false } },
  { name: "eval note_topic_research: 調研 … 整理成研究筆記 → topic research",
    in: { words: ["調研：在 Zipformer + RNN-T 串流辨識下，有哪些 dynamic hotwording（contextual biasing）做法？整理成研究筆記"], ready: LIB }, want: { kind: "note", playbook: "topic_research" } },
  { name: "progress deck in a study with a single paper is not a paper report",
    in: { words: ["幫我做一份這個研究的進度簡報，下週組會要用"], ready: { ...LIB, papers: 1, papers_with_pdf: 1, paperTitles: [LIB.paperTitles![0]!] } }, want: { deck: "progress" } },
  // ---- normal requests
  { name: "paper report of a given paper", in: { words: ["幫我做一份論文報告簡報"], inputs: { paper_id: P2 }, explicitPaper: true, ready: LIB }, want: { playbook: "slides", deck: "paper_report" } },
  { name: "a paper named by title (no id) → paper report", in: { words: ["把 Contextual Adapters for Personalized Speech Recognition in Neural Transducers 做成簡報"], ready: LIB }, want: { deck: "paper_report" } },
  { name: "the given deck + 「全英文翻譯」 → edit (revise)", in: { words: ["全英文翻譯"], inputs: { deck_id: DECK }, ready: { ...LIB, deckPages: 6 } }, want: { kind: "deck", playbook: "slides", deck: "edit", edit: "revise" } },
  { name: "the given deck + 加一頁 → edit (expand)", in: { words: ["加一頁比較表，比較 shallow fusion、CLAS 和 contextual adapters"], kind: "deck", inputs: { deck_id: DECK }, ready: { ...LIB, deckPages: 6 } }, want: { deck: "edit", edit: "expand" } },
  { name: "the given deck + 刪掉「卡住」這頁 → edit", in: { words: ["刪掉「卡住」這頁"], kind: "deck", inputs: { deck_id: DECK }, ready: { ...LIB, deckPages: 6 } }, want: { deck: "edit", edit: "revise" } },
  { name: "an empty template deck is not edited (a new deck fills it)", in: { words: ["幫我做 8 頁的進度報告簡報"], inputs: { deck_id: DECK }, ready: { ...LIB, deckPages: 0 } }, want: { deck: "progress" } },
  { name: "「每一篇文獻都做成簡報」 → batch", in: { words: ["把這個研究的每一篇文獻都做成獨立的簡報"], ready: LIB }, want: { playbook: "slides", batch: true } },
  { name: "「每一篇」 needs ≥ 2 papers", in: { words: ["每一篇文獻都做成簡報"], ready: { ...LIB, papers: 1 } }, want: { batch: false } },
  { name: "「這三篇做成簡報」 with 3 paper ids: one or each? → ask", in: { words: ["這三篇論文做成簡報"], inputs: { paper_ids: [P1, P2, P3] }, ready: LIB }, want: { batch: false, ask: "batch" } },
  { name: "「這三篇整合成一份簡報」 → one deck, no question", in: { words: ["這三篇整合成一份簡報"], inputs: { paper_ids: [P1, P2, P3] }, ready: LIB }, want: { batch: false, ask: undefined } },
  { name: "reading note of a named paper", in: { words: ["幫我寫〈Deep context: end-to-end contextual speech recognition〉的閱讀筆記"], ready: LIB }, want: { kind: "reading_note", playbook: "reading_note" } },
  { name: "literature review", in: { words: ["幫我寫一份 contextual biasing 的文獻回顧，要有比較表"], ready: LIB }, want: { kind: "lit_review", playbook: "lit_review" } },
  { name: "experiment report", in: { words: ["把實驗結果 CER 整理成報告"], ready: { ...LIB, experiment_notes: 2 } }, want: { kind: "note", playbook: "experiment_report" } },
  { name: "meeting agenda", in: { words: ["準備下週組會的議程"], ready: LIB }, want: { kind: "note", playbook: "meeting_prep" } },
  { name: "paper outline", in: { words: ["幫我擬論文大綱"], ready: LIB }, want: { playbook: "paper_outline" } },
  { name: "a section of the given LaTeX project", in: { words: ["幫我寫 related work 章節"], inputs: { project_id: PROJECT }, ready: { ...LIB, latex_projects: 1 } }, want: { kind: "latex", playbook: "latex_section" } },
  { name: "a fitting hint is kept (topic research for a note)", in: { words: ["整理成筆記：有哪些 contextual biasing 做法"], hint: "topic_research", ready: LIB }, want: { playbook: "topic_research", hintAccepted: true } },
  { name: "nothing named: generic note", in: { words: ["幫我想一個資料清理流程"] }, want: { kind: "note", playbook: "generic" } },
  { name: "the assistant's request names the deliverable when the user's words do not", in: { words: ["好，就這樣做"], paraphrase: "做一份進度報告簡報" }, want: { kind: "deck", playbook: "slides" } },
  { name: "a goal stage's fixed deliverable wins over the goal's words", in: { words: ["寫一篇 LaTeX 論文"], kind: "note", hint: "topic_research" }, want: { kind: "note", playbook: "topic_research", hintAccepted: true } },
  { name: "a playbook the user chose (pinned) stays while it delivers the kind", in: { words: ["幫我寫文獻回顧"], kind: "lit_review", pinned: "topic_research", ready: { ...LIB, papers: 1 } }, want: { playbook: "topic_research" } },
];

describe("route: one decision from the Brief", () => {
  for (const r of rows) {
    it(r.name, () => {
      const out = route(r.in);
      const got: Record<string, unknown> = { kind: out.kind, playbook: out.playbook, deck: out.deck, edit: out.edit, batch: out.batch, ask: out.ask, hintAccepted: out.hint?.accepted };
      for (const [k, v] of Object.entries(r.want)) expect(got[k], `${k} (${out.reason})`).toBe(v);
      expect(out.reason.length).toBeGreaterThan(0);
    });
  }
  it("records why, in 繁中, naming the overridden hint", () => {
    const out = route({ words: ["把這篇做成簡報"], hint: "reading_note", inputs: { paper_id: P1 }, explicitPaper: true, ready: LIB });
    expect(out.reason).toMatch(/助理建議「閱讀筆記」不採用/);
    expect(out.informed).toBe(true);
    expect(route({ words: ["做簡報"] }).informed).toBe(false);
  });
});

describe("route: goals", () => {
  it("stage kinds that serve the deliverable", () => {
    expect(servesDeliverable("topic_note", "paper")).toBe(true);
    expect(servesDeliverable("outline", "paper")).toBe(true);
    expect(servesDeliverable("paper_section", "deck")).toBe(false);
    expect(servesDeliverable("deck", "paper")).toBe(false);
    expect(servesDeliverable("topic_note", "topic_note")).toBe(true);
  });
  it("a stage proposal that does not fit is routed (reading note for a topic → topic research; experiment report without data → generic)", () => {
    expect(routeStage("reading_note", "調研 contextual biasing 有哪些做法", LIB)).toBe("topic_research");
    expect(routeStage("experiment_report", "整理評估指標", LIB)).toBe("generic");
    expect(routeStage("paper_draft", "撰寫論文", LIB)).toBe("paper_draft");
  });
  it("the planner's stages: off-deliverable stages are dropped, uses remapped; the last stage must produce", () => {
    const st = validStages([{ playbook: "topic_research" }, { playbook: "latex_section" }, { playbook: "slides", uses: [0, 1] }], "deck", "做一份簡報", LIB)!;
    expect(st.map((s) => s.playbook)).toEqual(["topic_research", "slides"]);
    expect(st[1]!.uses).toEqual([0]);
    expect(validStages([{ playbook: "topic_research" }, { playbook: "lit_review" }], "paper", "x")).toBeNull();
  });
  it("re-plans keep the gathering caps", () => {
    const finished = [{ playbook: "topic_research", status: "partial" }, { playbook: "topic_research", status: "partial" }];
    expect(boundedDrafts(finished, [{ playbook: "topic_research" }, { playbook: "paper_outline" }]).map((d) => d.playbook)).toEqual(["paper_outline"]);
  });
});

describe("topic research: nothing importable online", () => {
  it("falls back to the library's most related papers (full text first) instead of stopping", async () => {
    const { libraryFallback } = await import("../src/workflows/playbooks/research.js");
    const lib = [
      { id: "a", title: "Speaker diarization survey", year: 2020, cite_key: "a", has_pdf: true, abstract: "diarization" },
      { id: "b", title: "Contextual biasing for RNN-T", year: 2021, cite_key: "b", has_pdf: false, abstract: "contextual biasing hotword" },
      { id: "c", title: "Deep context: contextual speech recognition", year: 2018, cite_key: "c", has_pdf: true, abstract: "contextual biasing" },
    ];
    const picks = libraryFallback(lib, "dynamic hotword contextual biasing streaming RNN-T");
    expect(picks.map((p) => (p as { paper_id: string }).paper_id)).toEqual(["b", "c"]);
    expect(picks.every((p) => p.kind === "library")).toBe(true);
  });
});
