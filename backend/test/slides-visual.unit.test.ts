import { describe, expect, it } from "vitest";
import { chartBlocks, figureRefs, fixMermaid, lintMermaid, normalizeDiagrams, parseDeckChart, renderDeckChartSvg } from "../src/lib/slides/deck-visuals.js";
import { qmdHeader } from "../src/lib/slides/templates.js";
import { runChecks, visibleWords } from "../src/workflows/checks.js";
import { combineScores, metricIssues, replaceSlides, scoreTable, visionScores, type ShotPage } from "../src/workflows/playbooks/slides-visual.js";
import type { WorkflowEnv } from "../src/workflows/env.js";

const metrics = (over: Partial<NonNullable<ShotPage["metrics"]>> = {}) => ({ words: 20, bullets: 3, minFont: 20, maxFont: 40, overflowY: 0, overflowX: 0, visuals: 1, tables: 0, diagrams: 1, diagramErrors: 0, rawDiagramCode: 0, codeBlocks: 0, ...over });

describe("deck charts", () => {
  it("parses specs, rejects invalid ones and renders a standalone SVG with values, legend and source", () => {
    expect(parseDeckChart("not json")).toBeNull();
    expect(parseDeckChart(JSON.stringify({ type: "pie", labels: ["a"], series: [{ data: [1] }] }))).toBeNull();
    expect(parseDeckChart(JSON.stringify({ type: "bar", series: [{ data: [1] }] }))).toBeNull(); // no labels
    const spec = parseDeckChart(JSON.stringify({ type: "grouped_bar", title: "WER", labels: ["Base", "Ours"], series: [{ name: "B-WER", data: [24.1, 7.6] }, { name: "U-WER", data: [6.2, 5.9] }], best: "min", source: "Table 2" }))!;
    expect(spec.type).toBe("bar");
    const svg = renderDeckChartSvg(spec);
    expect(svg.startsWith("<svg xmlns=\"http://www.w3.org/2000/svg\"")).toBe(true);
    for (const t of ["24.1", "7.6", "6.2", "5.9", "B-WER", "U-WER", "Source: Table 2"]) expect(svg).toContain(t);
    // best per series: 7.6 (B) and 5.9 (U) are outlined, 24.1 is not
    expect((svg.match(/stroke-width="2.5"/g) ?? []).length).toBe(2);
    expect(svg).not.toMatch(/<script|on\w+=/);
  });

  it("renders hbar, line, scatter and heatmap", () => {
    for (const s of [
      { type: "hbar", labels: ["A", "B"], series: [{ data: [3, 5] }] },
      { type: "line", labels: ["1", "2", "3"], series: [{ name: "x", data: [1, 2, null] }] },
      { type: "scatter", series: [{ data: [[1, 2], [3, 4]] }] },
      { type: "heatmap", rows: ["r1", "r2"], labels: ["c1", "c2"], values: [[1, 2], [3, 4]], best: "max" },
    ]) {
      const spec = parseDeckChart(JSON.stringify(s));
      expect(spec, JSON.stringify(s)).not.toBeNull();
      expect(renderDeckChartSvg(spec!)).toContain("</svg>");
    }
  });

  it("finds ```chart blocks and paper-fig references", () => {
    const body = "## A\n\n```chart\n{\"labels\":[\"a\"],\"series\":[{\"data\":[1]}]}\n```\n\n![Fig. 1: arch (p. 3)](paper-fig:3@0.1-0.5){width=\"60%\"}\n";
    expect(chartBlocks(body)).toHaveLength(1);
    const [f] = figureRefs(body);
    expect(f).toMatchObject({ page: 3, top: 0.1, bottom: 0.5, caption: "Fig. 1: arch (p. 3)", attrs: "{width=\"60%\"}" });
  });
});

describe("mermaid", () => {
  it("turns plain fences into Quarto mermaid cells and keeps the diagram type line", () => {
    const out = normalizeDiagrams("## A\n\n```mermaid\nflowchart LR\n  A[Audio] --> B[Encoder (Conformer)]\n```\n\n```\ngraph TD\n  X --> Y\n```\n");
    expect(out).toContain("```{mermaid}\nflowchart LR\n  A[Audio] --> B[\"Encoder (Conformer)\"]\n```");
    expect(out).toContain("```{mermaid}\ngraph TD");
    expect(out).not.toMatch(/^```mermaid/m);
  });

  it("quotes risky labels only", () => {
    expect(fixMermaid("flowchart LR\n  A[Plain] --> B[x: y]\n  style A stroke-width:4px").code).toBe("flowchart LR\n  A[Plain] --> B[\"x: y\"]\n  style A stroke-width:4px");
    expect(fixMermaid("sequenceDiagram\n  A->>B: hi (x)").fixed).toBe(0);
  });

  it("lints the diagram type, brackets and subgraphs", () => {
    expect(lintMermaid("flowchart LR\n  A --> B")).toEqual([]);
    expect(lintMermaid("A --> B")[0]).toContain("類型");
    expect(lintMermaid("flowchart LR\n  subgraph S\n  A[x --> B")).toHaveLength(2);
  });
});

describe("slide checks", () => {
  it("density, diagram syntax and visual share", () => {
    const crowded = `## Crowded\n\n${Array.from({ length: 8 }, (_, i) => `- point number ${i} with several more words here`).join("\n")}\n`;
    const [d] = runChecks([{ id: "slide_density" }], crowded, null);
    expect(d!.ok).toBe(false);
    expect(runChecks([{ id: "diagram_syntax" }], "## A\n\n```mermaid\nflowchart LR\nA-->B\n```\n", null)[0]!.ok).toBe(false);
    expect(runChecks([{ id: "diagram_syntax" }], "## A\n\n```{mermaid}\nflowchart LR\nA-->B\n```\n", null)[0]!.ok).toBe(true);
    const deck = "## A\n\n- text\n\n## B\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n## C\n\n- text\n";
    expect(runChecks([{ id: "visual_ratio", params: { min_ratio: 0.6 } }], deck, null)[0]!.ok).toBe(false);
    expect(runChecks([{ id: "visual_ratio", params: { min_ratio: 0.6, allow_titles: ["C"] } }], deck, null)[0]!.ok).toBe(false);
    expect(runChecks([{ id: "visual_ratio", params: { min_ratio: 0.5, allow_titles: ["C"] } }], deck, null)[0]!.ok).toBe(true);
    expect(visibleWords("中文十個字中文十個字 and three words")).toBe(8);
    expect(runChecks([{ id: "visual_qa" }], "", { visualQa: { failed: [3], scored: 5 } })[0]!.ok).toBe(false);
    expect(runChecks([{ id: "visual_qa" }], "", { visualQa: { failed: [], scored: 5, vision: true } })[0]!.ok).toBe(true);
  });

  it("generated decks reference the theme stylesheet", () => {
    expect(qmdHeader({ title: "t", author: "a", date: "d", theme: true })).toContain("    css: hub-deck.css");
    expect(qmdHeader({ title: "t", author: "a", date: "d" })).not.toContain("hub-deck.css");
  });
});

describe("visual QA", () => {
  const allowed = (t: string) => t === "My assessment";

  it("metric issues fail a page; student pages fail only on rendering problems", () => {
    expect(metricIssues({ index: 2, metrics: metrics({ rawDiagramCode: 1 }) })[0]).toContain("原始碼");
    expect(metricIssues({ index: 2, metrics: metrics({ overflowY: 40, minFont: 12, words: 120, bullets: 9 }) })).toHaveLength(4);
    const pages: ShotPage[] = [
      { index: 2, title: "Good", metrics: metrics() },
      { index: 3, title: "Crowded", metrics: metrics({ words: 140 }) },
      { index: 4, title: "My assessment", metrics: metrics({ words: 3, visuals: 0 }) },
    ];
    const s = combineScores(pages, [], allowed);
    expect(s.map((x) => x.pass)).toEqual([true, false, true]);
    expect(scoreTable(s)).toContain("| 3 | Crowded |");
  });

  it("scores screenshots with a (mock) vision verifier in batches: fail → fixed → pass", async () => {
    const calls: number[] = [];
    let round = 0;
    const env = {
      callJson: async (req: { messages: { content: unknown }[] }) => {
        const imgs = (req.messages[1]!.content as { type: string }[]).filter((c) => c.type === "image").length;
        calls.push(imgs);
        const all = { readability: 4, crowding: round === 0 ? 2 : 4, layout: 4, visual: 4, diagrams: 4, overflow: 5, consistency: 4, professional: 4 };
        return { value: { pages: [{ page: 2, scores: all, issues: round === 0 ? ["太擠"] : [], fix: "刪成 3 條" }] }, text: "" };
      },
    } as unknown as WorkflowEnv;
    const images = Array.from({ length: 8 }, (_, i) => ({ page: i + 1, mediaType: "image/webp" as const, data: "AAAA" }));
    const pages: ShotPage[] = images.map((i) => ({ index: i.page, title: `P${i.page}`, metrics: metrics() }));
    const first = combineScores(pages, await visionScores(env, images, pages, { allowed, batch: 6 }), allowed);
    expect(calls).toEqual([6, 2]);
    expect(first.find((p) => p.page === 2)).toMatchObject({ pass: false, fix: "刪成 3 條" });
    round = 1;
    const second = combineScores(pages, await visionScores(env, images, pages, { allowed, batch: 6 }), allowed);
    expect(second.every((p) => p.pass)).toBe(true);
  });

  it("replaces only the rewritten slides", () => {
    const body = "## A\n\nold a\n\n## B\n\nold b\n";
    expect(replaceSlides(body, "## B\n\nnew b\n")).toBe("## A\n\nold a\n\n## B\n\nnew b\n\n");
  });
});

describe("fenced divs", () => {
  it("nested ::::/::: column layouts are balanced", () => {
    const body = "## A\n\n:::: {.columns}\n::: {.column width=\"50%\"}\nx\n:::\n::: {.column width=\"50%\"}\ny\n:::\n::::\n\n::: {.notes}\nn\n:::\n";
    expect(runChecks([{ id: "not_truncated" }], body, null)[0]!.ok).toBe(true);
    expect(runChecks([{ id: "not_truncated" }], "## A\n\n:::: {.columns}\n::: {.column}\nx\n:::\n", null)[0]!.ok).toBe(false);
  });
});

describe("visual QA defects", () => {
  it("a cut-off figure the verifier reports fails the page even with a passing score", () => {
    const pages: ShotPage[] = [{ index: 2, title: "Fig", metrics: metrics() }];
    const v = [{ page: 2, title: "Fig", scores: { readability: 4 }, score: 4, pass: true, issues: ["論文截圖底部被硬切，正文斷在半行"], fix: "重新裁切", source: "vision" as const }];
    expect(combineScores(pages, v, () => false)[0]!.pass).toBe(false);
    expect(renderDeckChartSvg(parseDeckChart(JSON.stringify({ labels: ["a", "b"], series: [{ data: [4, 4.11] }] }))!)).toContain(">4.00<");
  });
});
