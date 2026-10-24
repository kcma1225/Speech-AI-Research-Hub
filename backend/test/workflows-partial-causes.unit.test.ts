/**
 * Root causes of the eval runs that ended `partial` (2026-10-24):
 * - deck_add_page (126957f2): the visual fix of the comparison page 「Shallow fusion vs. CLAS vs. contextual adapters」
 *   replaced the pages 「Shallow fusion」 and 「Contextual adapters」 too (loose title match) — three copies, two pages
 *   lost — and the page checks / eval grader passed it;
 * - deck_translate_en (d2e938cb): a status timeline repeating the status table (vision hard defect 「重複呈現」);
 * - deck_followup_expand (5b112199): a writer titled its page in Chinese in an English deck → page check failed.
 */
import { describe, expect, it } from "vitest";
import { assignTitles, CHECKS, duplicatePages, findByTitle, parseSlides } from "../src/workflows/checks.js";
import { dedupeVisuals, inventedNumbers, replaceSlides } from "../src/workflows/playbooks/slides-visual.js";
import { _test as slides } from "../src/workflows/playbooks/slides.js";
import * as G from "../scripts/eval/graders.js";

const page = (title: string, body = `- ${title} point one\n- ${title} point two with enough words`) => `## ${title}\n\n${body}\n\n::: {.notes}\n${title} notes for the presenter.\n:::\n\n`;
const OUTLINE = ["Problem", "Shallow fusion", "Deep context (CLAS)", "Contextual adapters", "Shallow fusion vs. CLAS vs. contextual adapters", "Current progress", "Next steps"];
const CMP = "Shallow fusion vs. CLAS vs. contextual adapters";
const cmpPage = page(CMP, "| Method | Training |\n|---|---|\n| Shallow fusion | none |\n| CLAS | joint |\n| Contextual adapters | adapter only |");

describe("one page per title (deck_add_page)", () => {
  it("a rewritten comparison page replaces only itself", () => {
    const body = OUTLINE.map((t) => (t === CMP ? cmpPage : page(t))).join("");
    const fixed = page(CMP, "| Method | Training | Latency |\n|---|---|---|\n| Shallow fusion | none | low |\n| CLAS | joint | mid |\n| Contextual adapters | adapter | low |");
    const out = replaceSlides(body, fixed);
    expect(parseSlides(out).map((s) => s.title)).toEqual(OUTLINE);
    expect(out.match(/\| Latency \|/g)).toHaveLength(1);
    // A fixer that slightly retitles a page still lands on that page (one unambiguous containing title).
    expect(parseSlides(replaceSlides(body, page("Current progress (week 3)", "- new"))).map((s) => s.title)).toContain("Current progress (week 3)");
  });

  it("titles are assigned one-to-one; a page naming several outline titles stands for none of them", () => {
    const got = ["Problem", CMP, "Deep context (CLAS)", CMP, CMP, "Current progress", "Next steps"];
    const at = assignTitles(OUTLINE, got);
    expect(at[1]).toBe(-1);
    expect(at[3]).toBe(-1);
    expect(at[4]).toBe(1);
    expect(assignTitles(["Shallow fusion"], ["Shallow fusion: architecture"])).toEqual([0]);
    expect(findByTitle([{ t: "Shallow fusion" }, { t: CMP }], CMP, (x) => x.t)!.t).toBe(CMP);
    expect(findByTitle([{ t: "Shallow fusion" }, { t: "Shallow fusion: pros" }], "Shallow", (x) => x.t)).toBeUndefined();
  });

  it("the page criterion, pages_kept and the eval grader all fail the production deck (3 copies, 2 pages lost)", () => {
    const broken = ["Problem", CMP, "Deep context (CLAS)", CMP, CMP, "Current progress", "Next steps"].map((t) => (t === CMP ? cmpPage : page(t))).join("");
    const pages = CHECKS.slide_count!(broken, { params: { expected: 7, titles: OUTLINE }, data: null });
    expect(pages.ok).toBe(false);
    expect(pages.detail).toContain("「Shallow fusion」");
    expect(pages.detail).toContain("「Contextual adapters」");
    expect(pages.detail).toContain("出現 3 次");
    expect(CHECKS.slide_titles!(broken, { params: { titles: OUTLINE }, data: null }).ok).toBe(false);
    const kept = CHECKS.pages_kept!(broken, { params: { titles: ["Problem", "Shallow fusion", "Deep context (CLAS)", "Contextual adapters", "Current progress", "Next steps"], ordered: true }, data: null });
    expect(kept.ok).toBe(false);
    expect(duplicatePages(parseSlides(broken), OUTLINE)).toHaveLength(1);
    const deck = G.parseDeck(broken);
    expect(G.titlesKept(deck, ["Problem", "Shallow fusion", "Deep context (CLAS)", "Contextual adapters", "Current progress", "Next steps"]).ok).toBe(false);
    expect(G.noDuplicatePages(deck).ok).toBe(false);
    // The intact deck passes everything.
    const good = OUTLINE.map((t) => (t === CMP ? cmpPage : page(t))).join("");
    expect(CHECKS.slide_count!(good, { params: { expected: 7, titles: OUTLINE }, data: null }).ok).toBe(true);
    expect(G.titlesKept(G.parseDeck(good), ["Problem", "Shallow fusion", "Deep context (CLAS)", "Contextual adapters", "Current progress", "Next steps"]).ok).toBe(true);
    expect(G.noDuplicatePages(G.parseDeck(good)).ok).toBe(true);
  });
});

describe("the same information twice on a slide (deck_translate_en p4)", () => {
  it("a timeline repeating the status table is dropped; a chart of the table's numbers drops the table", () => {
    const status = page("Current Progress", '```diagram\n{"type":"timeline","events":[{"date":"Done","label":"Shallow fusion & TCPGen papers"},{"date":"Done","label":"Zipformer streaming baseline"},{"date":"Now","label":"Hotword experiments"}]}\n```\n\n| Item | Status |\n|---|---|\n| Shallow fusion & TCPGen papers | Read |\n| Zipformer streaming baseline (icefall) | Complete |\n| Hotword experiments | In progress |');
    const r = dedupeVisuals(status);
    expect(r.fixed).toBe(1);
    expect(r.body).not.toContain("```diagram");
    expect(r.body).toContain("| Hotword experiments | In progress |");
    const chart = page("Results", '```chart\n{"type":"bar","labels":["base","bias"],"series":[{"name":"WER","data":[12.4,9.8]}]}\n```\n\n| System | WER |\n|---|---|\n| base | 12.4 |\n| bias | 9.8 |');
    const c = dedupeVisuals(chart);
    expect(c.fixed).toBe(1);
    expect(c.body).toContain("```chart");
    expect(c.body).not.toContain("| base | 12.4 |");
    // A pipeline whose stages are not the table's rows stays.
    const fine = page("Method", '```diagram\n{"type":"pipeline","stages":["Audio","Encoder","Decoder"]}\n```\n\n| Method | WER |\n|---|---|\n| Shallow fusion | 9.8 |\n| CLAS | 8.1 |');
    expect(dedupeVisuals(fine).fixed).toBe(0);
  });
});

describe("writer headings follow the outline (deck_followup_expand)", () => {
  it("a page the writer retitled (here: in Chinese in an English deck) gets the outline title back", () => {
    const out = slides.outlineHeadings("## 方法 3：神經上下文偏置 (CLAS)\n\n- x\n\n::: {.notes}\nn\n:::\n", ["Method 3: Neural Contextual Biasing (CLAS)"]);
    expect(parseSlides(out)[0]!.title).toBe("Method 3: Neural Contextual Biasing (CLAS)");
    // A different page count is left to the page check (no guessing which page is which).
    expect(slides.outlineHeadings("## A\n\nx\n\n## B\n\ny\n", ["Only one"])).toBe("## A\n\nx\n\n## B\n\ny\n");
  });
});

describe("hand-shrunk text (deck_expand_fields_zh: a 15.6 px <small> citation failed the page twice)", () => {
  it("<small>, inline font sizes and [x]{.small} spans are removed; other styles stay", () => {
    const out = slides.stripPositions('<small>先例：Le et al., 2021</small>\n\n<span style="font-size:12px;color:red">x</span>\n\n[來源]{.small}');
    expect(out).toBe('先例：Le et al., 2021\n\n<span style="color:red">x</span>\n\n來源');
  });
});

describe("a layout fix never brings new numbers (deck_translate_en: a table 「偏高／待驗證」 became a chart of 10 % / 2 %)", () => {
  it("chart / table numbers the page and the sources do not have are reported", () => {
    const before = "## Problem Definition\n\n| Scenario | Rare-word error rate |\n|---|---|\n| Standard decoding | Relatively high |";
    const fresh = '## Problem Definition\n\n```chart\n{"type":"bar","labels":["Standard","Hotwords"],"series":[{"name":"x","data":[10,2.5]}]}\n```';
    expect(inventedNumbers(fresh, before, "研究資料：基線 CER 5.1%")).toEqual(["10", "2.5"]);
    expect(inventedNumbers(fresh.replace("10,2.5", "5.1"), before, "研究資料：基線 CER 5.1%")).toEqual([]);
  });
});

describe("outcome: a step check the final criteria re-check is superseded (deck_add_page 778a713d, deck_followup_expand 5b112199)", () => {
  const crit = (id: string, check: string, status: "pass" | "fail" = "pass") => ({ id, text: id, kind: "check" as const, check: { id: check }, status });
  const failedStep = (ids: string[]) => ({ status: "failed" as const, error: null, kind: "task" as const, verdict: { verdict: "revise" as const, issues: [], checks: ids.map((id) => ({ id, ok: false, detail: "x" })) } });
  it("done when every failing step check is covered by a passing criterion; partial otherwise", async () => {
    const { outcomeOf } = await import("../src/workflows/engine.js");
    const covered = { slide_density: "visual_qa", slide_titles: "pages" };
    const criteria = [crit("pages", "slide_count"), crit("visual_qa", "visual_qa")];
    expect(outcomeOf(criteria, [failedStep(["slide_density"])] as never, null, covered)).toBe("done");
    expect(outcomeOf(criteria, [failedStep(["slide_titles"])] as never, null, covered)).toBe("done");
    // Not covered (no criterion re-checks it), or the covering criterion failed → partial.
    expect(outcomeOf(criteria, [failedStep(["grounded_names"])] as never, null, covered)).toBe("partial");
    expect(outcomeOf([crit("pages", "slide_count"), crit("visual_qa", "visual_qa", "fail")], [failedStep(["slide_density"])] as never, null, covered)).toBe("partial");
  });
});
