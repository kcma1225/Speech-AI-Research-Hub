// Page-scoped deck edits (production 12e713d3: 「我要你把第九頁刪掉」 rewrote and re-screenshotted all ten pages, and the
// page stayed): removal detection, the user's page numbers (cover counted), the scope, kept pages, the invariant.
import { describe, expect, it } from "vitest";
import { detectExclude, pageNumber, pageRefs } from "../src/workflows/requirements.js";
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
    expect(pageScope("我要你把第九頁刪掉", exclude("我要你把第九頁刪掉"), TITLES, true)).toEqual({ removed: [8], touched: [] });
    // The assistant's paraphrase (title + 「這一頁」 back-reference).
    const para = "把這份簡報的第九頁「Results and Evidence Comparison」完整刪除，不要保留這一頁的標題、內容或講稿。";
    expect(pageScope(para, exclude(para), TITLES, true)).toEqual({ removed: [8], touched: [] });
    // A removal the requirements missed is still a removal (the clause's own verb).
    expect(pageScope("我要你把第九頁刪掉", [], TITLES, true)).toEqual({ removed: [8], touched: [] });
    // Reasons are not asks.
    expect(pageScope("把第九頁拿掉 因為這一頁的內容完全不準確", [], TITLES, true)).toEqual({ removed: [8], touched: [] });
  });

  it("named pages are touched, the rest kept", () => {
    expect(pageScope("第三頁的標題改短一點", [], TITLES, true)).toEqual({ removed: [], touched: [2] });
    expect(pageScope("改 slide 3", [], TITLES, true)).toEqual({ removed: [], touched: [2] });
    expect(pageScope("把第九頁刪掉，然後第三頁的圖改成表格", exclude("把第九頁刪掉，然後第三頁的圖改成表格"), TITLES, true)).toEqual({ removed: [8], touched: [2] });
    expect(pageScope("「Key Takeaways」那頁多加一點結論", [], TITLES, true)).toEqual({ removed: [], touched: [10] });
  });

  it("words about the deck as a whole are not page-scoped", () => {
    expect(pageScope("刪掉第九頁，然後整體語氣正式一點", exclude("刪掉第九頁"), TITLES, true)).toBeNull();
    expect(pageScope("刪掉第九頁，每頁的講稿再短一點", exclude("刪掉第九頁"), TITLES, true)).toBeNull();
    expect(pageScope("把第九頁刪掉，再加一頁結論", exclude("把第九頁刪掉"), TITLES, true)).toBeNull();
    expect(pageScope("翻成中文", [], TITLES, true)).toBeNull();
    expect(pageScope("刪掉第九頁", [...exclude("刪掉第九頁"), { type: "language", params: { language: "zh" }, source: "request" }], TITLES, true)).toBeNull();
    // Nor does the language of an English message (the system's inference, not the user's ask).
    expect(pageScope("Delete slide 3 from this deck.", [...exclude("Delete slide 3 from this deck."), { type: "language", params: { language: "en", inferred: true }, source: "request" }], TITLES, true)).toEqual({ removed: [2], touched: [] });
    // A standing preference does not make the edit deck-wide.
    expect(pageScope("刪掉第九頁", [...exclude("刪掉第九頁"), { type: "language", params: { language: "en" }, source: "standing" }], TITLES, true)).toEqual({ removed: [8], touched: [] });
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
