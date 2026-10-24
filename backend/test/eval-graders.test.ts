import { describe, expect, it } from "vitest";
import * as G from "../scripts/eval/graders.js";
import { EN_DECK, EN_DECK_TITLES, ZH_DECK, ZH_DECK_TITLES } from "../scripts/eval/fixtures.js";

const deck = (title: string, body: string) => G.parseDeck(`---\ntitle: ${JSON.stringify(title)}\n---\n\n${body}`);

describe("eval graders: decks", () => {
  it("parses the fixture decks: cover, slides, notes; headings inside code fences are not slides", () => {
    const zh = deck("中文封面", ZH_DECK);
    expect(zh.title).toBe("中文封面");
    expect(zh.slides.map((s) => s.title)).toEqual(ZH_DECK_TITLES);
    expect(zh.slides[0]!.notes).toContain("罕見詞");
    expect(zh.slides[0]!.body).not.toContain("::: {.notes}");
    const fenced = deck("x", "## A\n\n```python\n# not a slide\n```\n\n## B\n");
    expect(fenced.slides.map((s) => s.title)).toEqual(["A", "B"]);
  });

  it("language: an English deck with a Chinese cover or a Chinese note fails, a clean one passes", () => {
    expect(G.deckLanguage(deck("Contextual Biasing", EN_DECK), "en").ok).toBe(true);
    const cover = G.deckLanguage(deck("動態熱詞：學術現況", EN_DECK), "en");
    expect(cover.ok).toBe(false);
    expect(cover.where).toContain("封面");
    const note = G.deckLanguage(deck("Biasing", EN_DECK.replace("Why rare words are hard", "為什麼罕見詞很難")), "en");
    expect(note.where).toEqual(["p1 講稿"]);
    // 〈quoted titles〉 and link targets are allowed
    expect(G.deckLanguage(deck("Biasing", "## A\n\n- see 〈基於自監督學習之台語語音辨識〉 [x](https://例子.tw)\n"), "en").ok).toBe(true);
  });

  it("language: 繁中 needs Han on the cover and no all-English slide body", () => {
    expect(G.deckLanguage(deck("中文封面", ZH_DECK), "zh").ok).toBe(true);
    const en = G.deckLanguage(deck("English cover", ZH_DECK), "zh");
    expect(en.ok).toBe(false);
    expect(G.deckLanguage(deck("中文", EN_DECK), "zh").ok).toBe(false);
  });

  it("page count, kept titles (order), removed page, per-item fields, tables", () => {
    const d = deck("x", EN_DECK);
    expect(G.pageCount(d, 6).ok).toBe(true);
    expect(G.pageCount(d, 7).ok).toBe(false);
    expect(G.titlesKept(d, EN_DECK_TITLES).ok).toBe(true);
    expect(G.titlesKept(d, [...EN_DECK_TITLES].reverse()).ok).toBe(false);
    expect(G.titlesKept(deck("x", ZH_DECK.replace(/## 卡住[\s\S]*?(?=## Idea card)/, "")), ZH_DECK_TITLES, /^卡住$/).ok).toBe(true);
    expect(G.noSlideTitled(deck("x", ZH_DECK), /^卡住$/).ok).toBe(false);
    const fields = deck("x", "## M1\n\n- Architecture: x\n- Pros: a\n- Cons: b\n\n## M2\n\n**架構** y；**優點** a；**缺點** b\n\n## M3\n\n- Pros only\n");
    const g = G.perItemFields(fields, [["architecture", "架構"], ["pros", "優點"], ["cons", "缺點"]], 2);
    expect(g.ok).toBe(true);
    expect(g.detail).toMatch(/^2 頁/);
    expect(G.hasVisualTable(d).ok).toBe(true);
    const items = [["shallow"], ["CLAS", "deep context"], ["adapter"]];
    expect(G.tableMentioning(d, items).ok).toBe(false);
    const cmp = deck("x", `${EN_DECK}\n## Comparison\n\n| Method | Training |\n|---|---|\n| Shallow fusion | none |\n| CLAS | joint |\n| Contextual adapters | adapter only |\n`);
    expect(G.tableMentioning(cmp, items).detail).toMatch(/^p7/);
  });
});

describe("eval graders: documents and briefs", () => {
  it("citation keys (Pandoc and LaTeX) resolve against the study keys", () => {
    const text = "Shallow fusion [@zhao2019shallow; @pundak2018deep] and \\citep{xu2023adaptive,ghost2020}. Email a@b.com.";
    expect(G.citationKeys(text).sort()).toEqual(["ghost2020", "pundak2018deep", "xu2023adaptive", "zhao2019shallow"]);
    const r = G.citationsResolve(text, ["zhao2019shallow", "pundak2018deep", "xu2023adaptive"]);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("ghost2020");
    expect(G.citationsResolve("no cites", ["a"], 1).ok).toBe(false);
  });

  it("papers mentioned by key, title head or author + year", () => {
    const papers: G.PaperRef[] = [
      { key: "pundak2018deep", title: "Deep context: end-to-end contextual speech recognition", author: "Pundak", year: 2018 },
      { key: "zhao2019shallow", title: "Shallow-Fusion End-to-End Contextual Biasing", author: "Zhao", year: 2019 },
      { key: "xu2023adaptive", title: "Adaptive Contextual Biasing for Transducer Based Streaming Speech Recognition", author: "Xu", year: 2023 },
    ];
    const hit = G.papersMentioned("CLAS (Pundak et al., 2018) vs. shallow-fusion end-to-end contextual biasing; nothing on Xu.", papers);
    expect(hit.map((p) => p.key)).toEqual(["pundak2018deep", "zhao2019shallow"]);
  });

  it("table rows, placeholders, document language", () => {
    expect(G.maxTableRows("| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\ntext")).toBe(2);
    expect(G.maxTableRows("\\begin{tabular}{ll}\nA & B \\\\\n1 & 2 \\\\\n3 & 4 \\\\\n\\end{tabular}")).toBe(2);
    expect(G.noPlaceholder("內容待補").ok).toBe(false);
    expect(G.noPlaceholder("〔　這頁留給你自己寫：之後補上你的想法　〕").ok).toBe(true);
    expect(G.docLanguage("This note compares shallow fusion and CLAS for streaming transducers in detail.", "en").ok).toBe(true);
    expect(G.docLanguage("這份筆記比較 shallow fusion 與 CLAS 在串流辨識的差異與取捨。", "zh").ok).toBe(true);
    expect(G.docLanguage("This note compares shallow fusion and CLAS for streaming transducers.", "zh").ok).toBe(false);
    expect(G.docLanguage("", "zh").ok).toBe(false);
  });

  it("brief grounding: requirements must quote the user's words; no invented language or page count", () => {
    const words = ["幫我做一份這個研究的進度簡報，下週組會要用"];
    expect(G.briefGrounded({ user_words: words, requirements: [{ type: "audience", quote: "下週組會要用", source: "request" }] }).ok).toBe(true);
    const invented = G.briefGrounded({ user_words: words, requirements: [{ type: "language", quote: "繁體中文", source: "request" }, { type: "page_count", quote: "12 頁", source: "request" }] });
    expect(invented.ok).toBe(false);
    expect(invented.detail).toContain("頁數");
    expect(G.briefGrounded({ user_words: ["做一份 8 頁的簡報"], requirements: [{ type: "page_count", quote: "8 頁", source: "request" }] }).ok).toBe(true);
    expect(G.briefGrounded(null).ok).toBe(false);
  });
});

describe("eval graders: run metrics", () => {
  it("criteria flips: pass → fail between snapshots, pending in between ignored", () => {
    const flips = G.criteriaFlips([
      [{ id: "a", status: "pending" }, { id: "b", status: "pass" }],
      [{ id: "a", status: "pass" }, { id: "b", status: "pending" }],
      [{ id: "a", status: "fail" }, { id: "b", status: "fail" }],
      [{ id: "a", status: "pass" }, { id: "b", status: "fail" }],
    ]);
    expect(flips).toEqual(["a", "b"]);
  });

  it("check flips: a check that passed in a round and failed in the next", () => {
    const rounds = [
      { round: 0, failures: ["c:slide_count:共 5 頁", "j:task:abc"] },
      { round: 1, failures: ["c:speaker_notes:第 2 頁沒有講稿"] },
      { round: 2, failures: ["c:speaker_notes:第 2 頁沒有講稿", "c:slide_count:共 7 頁"] },
    ];
    expect(G.checkFlips(rounds, ["slide_count", "speaker_notes"])).toEqual(["speaker_notes@r1", "slide_count@r2"]);
  });
});
