/**
 * Original pages preserved on deck edits (eval `deck_expand_fields_zh`, run 2b6d7935): expanding one page into
 * per-method pages dropped / merged / retitled two pages the user never mentioned and verification still passed 18/18.
 */
import { describe, expect, it } from "vitest";
import { CHECKS, keptIssues, matchOriginals } from "../src/workflows/checks.js";
import { _test as slides, type SlideOutline } from "../src/workflows/playbooks/slides.js";
import type { Requirement } from "../src/workflows/types.js";

const raw = (title: string, bullets: string[]) => `## ${title}\n\n${bullets.map((b) => `- ${b}`).join("\n")}\n\n::: {.notes}\n這一頁說明${title}。\n:::`;
const DECK = [
  raw("問題定義", ["串流語音辨識對人名、地名等罕見詞常常辨識錯誤", "目標：不重新訓練模型，讓熱詞更容易被辨識出來"]),
  raw("動態熱詞的做法", ["shallow fusion、TCPGen 和 contextual biasing"]),
  raw("目前進度", ["讀完 shallow fusion 與 TCPGen 的論文", "在 icefall 上跑通 Zipformer 串流基線"]),
  raw("卡住", ["資料量不足：標註了熱詞的串流語料太少", "評估指標：罕見詞錯誤率還沒有統一的算法"]),
  raw("Idea card", ["把熱詞清單做成字首樹，在 RNN-T 解碼時加分"]),
  raw("下週與要問", ["實作字首樹加分的 baseline", "想問老師：罕見詞 recall 要用哪一份測試集"]),
];
const src = { deck: { id: "d", title: "熱詞", kind: "progress" as const, paper_id: null }, slides: DECK.map((r) => ({ title: /^## (.+)$/m.exec(r)![1]!, raw: r })), cover: true };
const page = (title: string, points: string[] = ["重點"], from?: number): SlideOutline => ({ n: 0, title, points, ...(from ? { from } : {}) });
const numbered = (o: SlideOutline[]) => o.map((p, i) => ({ ...p, n: i + 1 }));
const fields: Requirement = { id: "r1", type: "per_item_fields", text: "每個方法一頁，每頁都要有架構、優點、缺點", source: "request", params: { item_kind: "方法", fields: [{ name: "架構" }, { name: "優點" }, { name: "缺點" }] } } as Requirement;

/** The production outline: the method pages, 「目前進度」 retitled and moved, the last two pages merged. */
const PRODUCTION = numbered([
  page("問題定義"),
  page("Idea 或架構：動態熱詞的做法總覽", ["五種方法"]),
  page("方法一：Shallow fusion", ["架構", "優點", "缺點"]),
  page("方法二：CLAS", ["架構", "優點", "缺點"]),
  page("Table 1 現況與本週關鍵結果（對帳）", ["讀完 shallow fusion 與 TCPGen 的論文", "在 icefall 上跑通 Zipformer 串流基線"]),
  page("卡住"),
  page("Idea card、下週與要問", ["字首樹加分", "測試集"]),
]);

describe("original pages preserved (revise / expand)", () => {
  const words = "把「動態熱詞的做法」展開：每個方法一頁，每頁都要有架構、優點、缺點";

  it("keeps every page the words do not name; the named page may be expanded", () => {
    const rule = slides.keepRule(words, [fields], src, "expand")!;
    expect(rule.targets).toEqual(["動態熱詞的做法"]);
    expect(rule.originals.map((o) => o.title)).toEqual(["問題定義", "目前進度", "卡住", "Idea card", "下週與要問"]);
    expect(rule).toMatchObject({ ordered: true, translate: false, keepTitles: true });
    // A removal, a reorder and a restructure are the user's own words.
    const ex = { id: "r2", type: "exclude", text: "刪掉卡住", source: "request", params: { terms: [{ name: "卡住" }] } } as Requirement;
    expect(slides.keepRule("刪掉「卡住」這頁", [ex], src, "revise")!.originals.map((o) => o.title)).not.toContain("卡住");
    expect(slides.keepRule("把卡住移到最後，再詳細一點", [], src, "expand")!.ordered).toBe(false);
    expect(slides.keepRule("整份重新組織，再詳細一點", [], src, "expand")).toBeNull();
    // Translating: titles change language, so they are not kept verbatim.
    const en = { id: "r3", type: "language", text: "英文", source: "request", params: { language: "en" } } as Requirement;
    expect(slides.keepRule("全英文翻譯", [en], src, "revise")).toMatchObject({ translate: true, keepTitles: false });
  });

  it("the outline check fails the production outline: a page dropped (merged) and one retitled", () => {
    const rule = slides.keepRule(words, [fields], src, "expand")!;
    const r = CHECKS.pages_kept!("", { params: { originals: rule.originals, ordered: true, keep_titles: true }, data: { outline: PRODUCTION } });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("第 6 頁「下週與要問」");
    expect(r.detail).toContain("「目前進度」→「Table 1 現況與本週關鍵結果（對帳）」");
  });

  it("the repair puts dropped pages back, restores titles and keeps new pages after the page they followed", () => {
    const rule = slides.keepRule(words, [fields], src, "expand")!;
    const r = slides.keepOriginals(PRODUCTION, rule, src.slides.map((p) => p.raw));
    expect(r.outline.map((p) => p.title)).toEqual(["問題定義", "Idea 或架構：動態熱詞的做法總覽", "方法一：Shallow fusion", "方法二：CLAS", "目前進度", "卡住", "Idea card", "下週與要問"]);
    expect(r.restored).toEqual(["下週與要問"]);
    expect(r.outline.find((p) => p.title === "下週與要問")!.points).toEqual(["實作字首樹加分的 baseline", "想問老師：罕見詞 recall 要用哪一份測試集"]);
    expect(r.outline.find((p) => p.title === "目前進度")).toMatchObject({ from: 3, points: ["讀完 shallow fusion 與 TCPGen 的論文", "在 icefall 上跑通 Zipformer 串流基線"] });
    expect(r.outline.map((p) => p.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // The repaired outline passes the check.
    expect(CHECKS.pages_kept!("", { params: { originals: rule.originals, ordered: true, keep_titles: true }, data: { outline: r.outline } }).ok).toBe(true);
  });

  it("a reorder nobody asked for is undone; asked for, it stands", () => {
    const moved = numbered([page("問題定義"), page("卡住"), page("目前進度"), page("方法一", ["架構"]), page("Idea card"), page("下週與要問")]);
    const rule = slides.keepRule(words, [fields], src, "expand")!;
    expect(keptIssues(rule.originals, moved, matchOriginals(rule.originals, moved), { ordered: true }).join()).toContain("順序被改了");
    expect(slides.keepOriginals(moved, rule, src.slides.map((p) => p.raw)).outline.map((p) => p.title)).toEqual(["問題定義", "目前進度", "方法一", "卡住", "Idea card", "下週與要問"]);
    const free = slides.keepRule("把卡住移到第二頁，動態熱詞的做法再詳細一點", [], src, "expand")!;
    expect(slides.keepOriginals(moved, free, src.slides.map((p) => p.raw)).outline.map((p) => p.title)).toEqual(moved.map((p) => p.title));
  });

  it("splitting a page into several (each claiming it) keeps it; a translation is matched by `from` / position", () => {
    const rule = slides.keepRule("再詳細一點，每個方法要有架構、Pros/Cons", [fields], src, "expand")!;
    const split = numbered([page("問題定義"), page("Shallow fusion", ["架構"], 2), page("TCPGen", ["架構"], 2), page("目前進度"), page("卡住"), page("Idea card"), page("下週與要問")]);
    expect(keptIssues(rule.originals, split, matchOriginals(rule.originals, split), { ordered: true, keepTitles: true })).toEqual([]);
    const en = { id: "r3", type: "language", text: "英文", source: "request", params: { language: "en" } } as Requirement;
    const tr = slides.keepRule("全英文翻譯", [en], src, "revise")!;
    const english = numbered(["Problem", "Hotword methods", "Progress", "Blocked", "Idea card", "Next steps"].map((t) => page(t)));
    expect(matchOriginals(tr.originals, english, { translate: true }).at).toEqual([0, 1, 2, 3, 4, 5]);
    // One page short: the claimed `from`s find the dropped one.
    const short = numbered([page("Problem", [], 1), page("Hotword methods", [], 2), page("Blocked", [], 4), page("Idea card", [], 5), page("Next steps", [], 6)]);
    expect(keptIssues(tr.originals, short, matchOriginals(tr.originals, short, { translate: true })).join()).toContain("第 3 頁「目前進度」");
  });

  it("the deck check: the plan's kept pages all present, in order", () => {
    const deck = ["問題定義", "方法一", "目前進度", "卡住", "Idea card", "下週與要問"].map((t) => raw(t, ["x"])).join("\n\n");
    const titles = ["問題定義", "目前進度", "卡住", "Idea card", "下週與要問"];
    expect(CHECKS.pages_kept!(deck, { params: { titles, ordered: true }, data: null }).ok).toBe(true);
    const dropped = ["問題定義", "方法一", "卡住", "目前進度", "Idea card、下週"].map((t) => raw(t, ["x"])).join("\n\n");
    const r = CHECKS.pages_kept!(dropped, { params: { titles, ordered: true }, data: null });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("「卡住」");
    expect(r.detail).toContain("「下週與要問」");
  });
});
