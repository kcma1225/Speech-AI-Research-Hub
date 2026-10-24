/** The Brief (brief.ts): pure helpers — user words vs the paraphrase, deliverable kinds, deck modes, prompts and scope. */
import { describe, expect, it } from "vitest";
import "../src/workflows/playbooks/index.js";
import {
  ambiguousKinds, briefBlock, checklistFrom, checklistOf, clipWords, composeWords, deliverableFromWords, editedBrief, playbookKind, sameDeliverable, scopeLine, seedBrief, unspecifiedOf,
} from "../src/workflows/brief.js";
import { deckModeOf, topicTitleOf } from "../src/workflows/playbooks/slides.js";
import { route } from "../src/workflows/route.js";
import { detectRequirements, messageLanguage } from "../src/workflows/requirements.js";
import type { Requirement } from "../src/workflows/types.js";

/** The production request of run 50b49d80 (shape): an English topic deck whose wording mentions "paper title". */
const TOPIC_DECK = "Make an English research presentation about dynamic hotwording approaches for streaming ASR. Each method slide should show the paper title and year.";

describe("brief: seed", () => {
  it("keeps the assistant's request as the paraphrase, never as the user's words", () => {
    const b = seedBrief("幫我做 12 頁的簡報，所有內容使用繁體中文，結構：背景、方法、結果", "slides", { userWords: ["幫我做一份熱詞方法的簡報"] });
    expect(b).toMatchObject({ version: 0, user_words: ["幫我做一份熱詞方法的簡報"], base: 1, deliverable: { kind: "deck", hard: true } });
    expect(b.paraphrase).toContain("12 頁");
  });
  it("the request is the user's own words without a chat (composer / API) or when the assistant passed them verbatim", () => {
    expect(seedBrief("做一份進度報告簡報", "slides").paraphrase).toBeNull();
    expect(seedBrief("做一份進度報告簡報", "slides", { userWords: ["好", "做一份進度報告簡報"] }).paraphrase).toBeNull();
  });
  it("words are clipped from the oldest turn, the newest kept whole", () => {
    const long = "早".repeat(1400);
    const out = clipWords([long, "最新的要求：做簡報"], 1000);
    expect(out.at(-1)).toBe("最新的要求：做簡報");
    expect(out.join("").length).toBeLessThanOrEqual(1001);
    expect(composeWords(["a1", "a2"], ["g1"])).toEqual({ user_words: ["a1", "a2", "g1"], base: 2 });
  });
});

describe("brief: deliverable kind", () => {
  it("names the deliverable from the user's words (presentation = a deck; 「整理成筆記」 wins over a mention of 簡報)", () => {
    expect(deliverableFromWords([TOPIC_DECK])).toBe("deck");
    expect(deliverableFromWords(["Prepare an English research presentation on contextual biasing; include each paper title"])).toBe("deck");
    expect(deliverableFromWords(["把這份簡報的重點整理成筆記"])).toBe("note");
    expect(deliverableFromWords(["最後要給我一個 latex 論文"])).toBe("paper");
    expect(deliverableFromWords(["好"])).toBeNull();
    // The newest turn wins over an earlier mention in the same chat.
    expect(deliverableFromWords(["上次那份簡報不錯", "幫我寫一份 wav2vec 2.0 的閱讀筆記"])).toBe("reading_note");
    // 「論文報告」 is a deck about a paper, 「論文的閱讀筆記」 a reading note — never a LaTeX paper.
    expect(deliverableFromWords(["幫我做一份論文報告簡報，下週 journal club 要用"])).toBe("deck");
    expect(deliverableFromWords(["幫我寫一份論文的閱讀筆記"])).toBe("reading_note");
    expect(route({ words: ["幫我做一份論文報告簡報"] }).playbook).toBe("slides");
  });
  it("two incompatible kinds in the newest turn are ambiguous (ask once); a sequence is a goal, not an ambiguity", () => {
    expect(ambiguousKinds(["幫我把這些整理成簡報或筆記"])).toEqual(["deck", "note"]);
    expect(ambiguousKinds(["先整理成筆記，再做成簡報"])).toEqual([]);
    expect(ambiguousKinds(["做成簡報"])).toEqual([]);
  });
    it("notes are one family; a deck or LaTeX never equals a note", () => {
    expect(sameDeliverable("reading_note", "note")).toBe(true);
    expect(sameDeliverable("lit_review", "note")).toBe(true);
    expect(sameDeliverable("deck", "note")).toBe(false);
    expect(sameDeliverable("latex", "note")).toBe(false);
    expect(playbookKind("generic")).toBe("note");
    expect(playbookKind("slides")).toBe("deck");
  });
  it("detection keeps the deliverable: an English presentation surveying approaches is a deck, not a topic note", () => {
    expect(route({ words: [TOPIC_DECK] }).playbook).toBe("slides");
    expect(route({ words: ["研究有哪些 dynamic hotwording 做法"], kind: "note" }).playbook).toBe("topic_research");
  });
});

describe("brief: slides mode (deliverable-correct routing)", () => {
  const opts = { explicitPaper: false, progressAsked: false };
  it("a topic deck that says 'paper title' is a topic deck, never a paper report", () => {
    expect(deckModeOf(TOPIC_DECK, opts)).toBe("topic");
    expect(deckModeOf("Make a presentation; put the paper title on the cover", opts)).toBe("progress");
    expect(deckModeOf("Make an English research presentation about self-supervised speech representations for emotion recognition. Each method slide should show the paper title and year.", opts)).toBe("topic");
    expect(deckModeOf("做一份介紹 dynamic hotwording 方法的簡報", opts)).toBe("topic");
    expect(topicTitleOf(TOPIC_DECK)).toBe("dynamic hotwording approaches for streaming ASR");
    expect(topicTitleOf("幫我做一份關於動態熱詞做法的簡報")).toBe("動態熱詞做法");
  });
  it("a report on one paper: asked for, or a given paper while the words are not about a topic", () => {
    expect(deckModeOf("幫我把這篇論文做成簡報", opts)).toBe("paper_report");
    expect(deckModeOf("論文報告簡報", opts)).toBe("paper_report");
    expect(deckModeOf("做簡報", { ...opts, explicitPaper: true })).toBe("paper_report");
    expect(deckModeOf(TOPIC_DECK, { ...opts, explicitPaper: true })).toBe("topic");
    expect(deckModeOf("做簡報", opts)).toBe("progress");
    expect(deckModeOf("做這週的進度報告", { ...opts, progressAsked: true, explicitPaper: true })).toBe("progress");
    expect(deckModeOf("x", { ...opts, inputMode: "paper_report" })).toBe("paper_report");
  });
});

describe("brief: requirements grounded in the user's words", () => {
  it("deterministic requirements quote the user's clause", () => {
    const r = detectRequirements("請做成 English slides，大約 10 頁，重點放在 TCPGen", { kind: "deck" });
    expect(r.find((x) => x.type === "language")).toMatchObject({ params: { language: "en" }, quote: expect.stringContaining("English slides") });
    expect(r.find((x) => x.type === "page_count")?.quote).toContain("10 頁");
  });
  it("an English message sets English; a Chinese one sets nothing (繁體中文 is the default, 「語言：未指定」)", () => {
    expect(messageLanguage([TOPIC_DECK])[0]).toMatchObject({ type: "language", params: { language: "en" } });
    expect(messageLanguage(["幫我做一份簡報"])).toEqual([]);
    expect(messageLanguage(["ok"])).toEqual([]);
  });
  it("unspecified items: language / pages for decks, language / length for notes", () => {
    expect(unspecifiedOf("deck", [])).toEqual(["語言", "頁數"]);
    expect(unspecifiedOf("note", [{ id: "r1", type: "language", text: "英文", source: "request" } as Requirement])).toEqual(["篇幅"]);
  });
});

describe("brief: prompts", () => {
  const b = { ...seedBrief("long paraphrase with 12 pages", "slides", { userWords: [TOPIC_DECK] }), unspecified: ["頁數"] };
  it("every sub-agent gets the deliverable, the user's words verbatim and 「未指定」", () => {
    const block = briefBlock(b, "producer");
    expect(block).toContain("要交付的成果：簡報");
    expect(block).toContain(`「${TOPIC_DECK}」`);
    expect(block).toContain("使用者沒有指定：頁數");
    expect(block).not.toContain("12 pages");
    expect(briefBlock(b, "verifier")).toContain("不要要求使用者沒說的東西");
  });
  it("a step states its own scope (pages 1–3 cannot write 8 pages)", () => {
    expect(scopeLine({ title: "撰寫第 1–3 頁", role: "writer", kind: "task", inputs: { pages: [1, 2, 3] } })).toContain("只寫第 1–3 頁（共 3 頁）");
    expect(scopeLine({ title: "方法比較", role: "writer", kind: "task", inputs: {} })).toContain("只完成「方法比較」");
    expect(scopeLine({ title: "整合", role: "integrator", kind: "integrate", inputs: {} })).toBe("");
  });
});

describe("brief: checklist and versions", () => {
  const criteria = [
    { id: "pages", text: "正好 8 頁", kind: "check" as const, check: { id: "slide_count", params: { expected: 8 } } },
    { id: "req_r1", text: "你的要求：英文", kind: "check" as const, check: { id: "req_language" } },
    { id: "u1", text: "使用者加的", kind: "judge" as const },
  ];
  it("the checklist shares the criteria ids; requirement / user items are the user's", () => {
    expect(checklistFrom(criteria).map((c) => [c.id, c.source, c.requirement_id ?? null])).toEqual([["pages", "playbook", null], ["req_r1", "user", "r1"], ["u1", "user", null]]);
    expect(checklistOf({ brief: null, criteria: criteria.map((c) => ({ ...c, status: "pending" as const })) }).length).toBe(3);
  });
  it("a plan-card edit is a new version; no change → no version", () => {
    const b = { ...seedBrief("做簡報", "slides"), version: 1, checklist: checklistFrom(criteria) };
    expect(editedBrief(b, { criteria })).toBeNull();
    const next = editedBrief(b, { requirements: [{ id: "r1", type: "page_count", text: "正好 5 頁", params: { exact: 5 }, source: "user" }] })!;
    expect(next).toMatchObject({ version: 2, source: "edit", unspecified: ["語言"] });
  });
});
