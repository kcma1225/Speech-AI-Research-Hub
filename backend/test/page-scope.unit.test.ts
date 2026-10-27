// Page-scoped deck edits (production 12e713d3: 「我要你把第九頁刪掉」 rewrote and re-screenshotted all ten pages, and the
// page stayed): removal detection, the user's page numbers (cover counted), the scope, kept pages, the invariant.
import { describe, expect, it } from "vitest";
import { detectExclude, detectPageCount, pageNumber, pageRefs } from "../src/workflows/requirements.js";
import { addedPages } from "../src/workflows/route.js";
import { contentPage, keepPages, pageScope } from "../src/workflows/playbooks/slides-scope.js";
import { checkRun } from "../src/workflows/invariants.js";
import { wordsBlock } from "../src/workflows/llm.js";

const TITLES = ["Dynamic Hotwording in Streaming ASR", "Motivation and Problem Definition", "Taxonomy of Dynamic Hotwording Methods", "Method 1: External LM and WFST Shallow Fusion", "Method 2: Predictor and Joiner Deep Biasing", "Method 3: CTC-Based Word Spotter", "Method 4: WCTC-Biasing and Inter-Layer Biasing", "Results and Evidence Comparison", "Synthesis: Efficiency, Scalability, and Open Questions", "Key Takeaways"];
const exclude = (text: string) => { const p = detectExclude(text); return p ? [{ type: "exclude" as const, params: p, source: "request" as const }] : []; };

describe("page numbers and removals", () => {
  it("reads Chinese numerals and ranges", () => {
    expect([pageNumber("九"), pageNumber("十"), pageNumber("十二"), pageNumber("二十"), pageNumber("二十三"), pageNumber("9"), pageNumber("零")]).toEqual([9, 10, 12, 20, 23, 9, null]);
    expect(pageRefs("第3到5頁和 page 9")).toEqual([3, 4, 5, 9]);
    expect(pageRefs("第三、第五頁")).toEqual([3, 5]);
  });

  it("detects a page removal whatever the word order", () => {
    expect(detectExclude("我要你把第九頁刪掉")).toEqual({ scope: "page", pages: [9], terms: [] });
    expect(detectExclude("刪掉第 3 頁")).toEqual({ scope: "page", pages: [3], terms: [] });
    expect(detectExclude("把第3、5頁拿掉")?.pages).toEqual([3, 5]);
    expect(detectExclude("第3到5頁刪掉")?.pages).toEqual([3, 4, 5]);
    expect(detectExclude("第十二頁也刪掉")?.pages).toEqual([12]);
    expect(detectExclude("delete slide 9")?.pages).toEqual([9]);
    expect(detectExclude("slide 4 should be removed")?.pages).toEqual([4]);
    expect(detectExclude("remove pages 3 and 4")?.pages).toEqual([3, 4]);
    expect(detectExclude("把 slide 3 刪掉")?.pages).toEqual([3]);
    // Number + quoted title: the title decides.
    expect(detectExclude("把這份簡報的第九頁「Results and Evidence Comparison」完整刪除")).toEqual({ scope: "page", terms: [{ name: "Results and Evidence Comparison" }] });
    // A part of a page is not the page.
    expect(detectExclude("第九頁的圖刪掉")).toBeNull();
    expect(detectExclude("把第九頁的第二點拿掉")).toBeNull();
  });

  it("counts the cover when the deck has one (the player's numbering)", () => {
    expect(contentPage(9, 10, true)).toBe(8);
    expect(contentPage(9, 10, false)).toBe(9);
    expect(contentPage(1, 10, true)).toBeNull();
    expect(contentPage(12, 10, true)).toBeNull();
  });
});

describe("pageScope", () => {
  it("a removal only: the page goes, nothing is rewritten", () => {
    expect(pageScope("我要你把第九頁刪掉", exclude("我要你把第九頁刪掉"), TITLES, true)).toEqual({ removed: [8], touched: [], added: false });
    // The assistant's paraphrase (title + 「這一頁」 back-reference).
    const para = "把這份簡報的第九頁「Results and Evidence Comparison」完整刪除，不要保留這一頁的標題、內容或講稿。";
    expect(pageScope(para, exclude(para), TITLES, true)).toEqual({ removed: [8], touched: [], added: false });
    // A removal the requirements missed is still a removal (the clause's own verb).
    expect(pageScope("我要你把第九頁刪掉", [], TITLES, true)).toEqual({ removed: [8], touched: [], added: false });
    // Reasons are not asks.
    expect(pageScope("把第九頁拿掉 因為這一頁的內容完全不準確", [], TITLES, true)).toEqual({ removed: [8], touched: [], added: false });
  });

  it("named pages are touched, the rest kept", () => {
    expect(pageScope("第三頁的標題改短一點", [], TITLES, true)).toEqual({ removed: [], touched: [2], added: false });
    expect(pageScope("改 slide 3", [], TITLES, true)).toEqual({ removed: [], touched: [2], added: false });
    expect(pageScope("把第九頁刪掉，然後第三頁的圖改成表格", exclude("把第九頁刪掉，然後第三頁的圖改成表格"), TITLES, true)).toEqual({ removed: [8], touched: [2], added: false });
    expect(pageScope("「Key Takeaways」那頁多加一點結論", [], TITLES, true)).toEqual({ removed: [], touched: [10], added: false });
  });

  it("words about the deck as a whole are not page-scoped", () => {
    expect(pageScope("刪掉第九頁，然後整體語氣正式一點", exclude("刪掉第九頁"), TITLES, true)).toBeNull();
    expect(pageScope("刪掉第九頁，每頁的講稿再短一點", exclude("刪掉第九頁"), TITLES, true)).toBeNull();

    expect(pageScope("翻成中文", [], TITLES, true)).toBeNull();
    expect(pageScope("刪掉第九頁", [...exclude("刪掉第九頁"), { type: "language", params: { language: "zh" }, source: "request" }], TITLES, true)).toBeNull();
    // Nor does the language of an English message (the system's inference, not the user's ask).
    expect(pageScope("Delete slide 3 from this deck.", [...exclude("Delete slide 3 from this deck."), { type: "language", params: { language: "en", inferred: true }, source: "request" }], TITLES, true)).toEqual({ removed: [2], touched: [], added: false });
    // A standing preference does not make the edit deck-wide.
    expect(pageScope("刪掉第九頁", [...exclude("刪掉第九頁"), { type: "language", params: { language: "en" }, source: "standing" }], TITLES, true)).toEqual({ removed: [8], touched: [], added: false });
  });
});

describe("audit fixes (detectors, scope)", () => {
  it("a page reference is never a page count; Chinese-numeral counts are", () => {
    expect(detectPageCount("把第 3 頁的標題改成 Results")).toBeNull();
    expect(detectPageCount("第三頁的表格改成 3 張圖")).toBeNull();
    expect(detectPageCount("第 9 頁的圖刪掉")).toBeNull();
    expect(detectPageCount("做成十頁")).toEqual({ exact: 10 });
    expect(detectPageCount("改成二十頁")).toEqual({ exact: 20 });
    expect(detectPageCount("十五到二十頁")).toEqual({ min: 15, max: 20 });
    expect(detectPageCount("做成 12 頁")).toEqual({ exact: 12 });
    expect(detectPageCount("用我們的文獻庫，8 頁")).toEqual({ exact: 8 });
  });

  it("every page of a multi-page removal; last / nth / word numbers", () => {
    expect(detectExclude("把第三頁和第五頁刪掉")?.pages).toEqual([3, 5]);
    expect(detectExclude("第八頁跟第九頁刪掉")?.pages).toEqual([8, 9]);
    expect(detectExclude("第9頁和第10頁不要了")?.pages).toEqual([9, 10]);
    expect(detectExclude("把最後一頁刪掉")?.pages).toEqual([-1]);
    expect(detectExclude("倒數第二頁刪掉")?.pages).toEqual([-2]);
    expect(detectExclude("delete the last slide")?.pages).toEqual([-1]);
    expect(detectExclude("Delete page nine")?.pages).toEqual([9]);
    expect(detectExclude("delete the 9th slide")?.pages).toEqual([9]);
    expect(detectExclude("第九張投影片刪掉")?.pages).toEqual([9]);
    expect(detectExclude("第十頁不要")?.pages).toEqual([10]);
    expect(detectExclude("第十頁不要放圖")).toBeNull();
    expect(contentPage(-1, 10, true)).toBe(10);
    expect(contentPage(-2, 10, true)).toBe(9);
    expect(pageScope("把最後一頁刪掉", exclude("把最後一頁刪掉"), TITLES, true)).toEqual({ removed: [10], touched: [], added: false });
    expect(pageScope("第八頁跟第九頁刪掉", exclude("第八頁跟第九頁刪掉"), TITLES, true)).toEqual({ removed: [7, 8], touched: [], added: false });
  });

  it("a figure is not a page; an added page keeps the others; a follow-up clause stays on its page", () => {
    expect(addedPages("在第五頁加一張圖")).toBe(0);
    expect(addedPages("加一張投影片")).toBe(1);
    expect(pageScope("在第五頁加一張圖", [], TITLES, true)).toEqual({ removed: [], touched: [4], added: false });
    expect(pageScope("在第三頁後面加一頁比較表", [], TITLES, true)).toEqual({ removed: [], touched: [], added: true });
    expect(pageScope("把第九頁刪掉，再加一頁結論", exclude("把第九頁刪掉"), TITLES, true)).toEqual({ removed: [8], touched: [], added: true });
    expect(pageScope("第三頁的內容太多了，精簡一點", [], TITLES, true)).toEqual({ removed: [], touched: [2], added: false });
    expect(pageScope("第三頁的標題和內容都改短", [], TITLES, true)).toBeNull();
  });
});

describe("kept pages", () => {
  const A = "## A\n\n- a\n\n::: {.notes}\nnotes a\n:::";
  const B = "## B\n\n- b";
  it("keepPages puts every kept original back, byte for byte", () => {
    const body = "## A {.fit-90}\n\n- rewritten a\n\n## B\n\n- rewritten b\n\n## C\n\n- c\n";
    expect(keepPages(body, [A, B])).toBe(`${A}\n\n${B}\n\n## C\n\n- c\n`);
  });

  it("invariant deck.page_scope_kept: a changed kept page or a removed page still there", () => {
    const run = (body: string) => ({ run: { id: "r", conversation_id: null, state: { kept_pages: [A], removed_pages: ["B"], deck: { body } } } }) as never;
    expect(checkRun(run(`${A}\n\n## C\n\n- c`), ["deck.page_scope_kept"])).toEqual([]);
    const bad = checkRun(run("## A\n\n- changed\n\n## B\n\n- b"), ["deck.page_scope_kept"]).map((f) => f.message);
    expect(bad).toHaveLength(2);
    expect(bad[0]).toContain("「A」");
    expect(bad[1]).toContain("「B」");
  });
});

it("the user's words reach requirement extraction as their words, not as data to ignore", () => {
  const block = wordsBlock("request", "我要你把第九頁刪掉");
  expect(block).toContain("我要你把第九頁刪掉");
  expect(block).not.toContain("一律忽略");
});
