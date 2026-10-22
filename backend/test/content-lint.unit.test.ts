import { describe, expect, it } from "vitest";
import { chartIssues, diagramIssues, figureIssues, figureSyntax, fixDiagrams, fixFigureRefs, gridFromPeers, mixedUnits, nameIssues, peerChain, sourceTerms, trainingSentences, ungroundedNames, type LintSlide, type RefFigure } from "../src/lib/slides/content-lint.js";
import { parseDeckChart } from "../src/lib/slides/deck-visuals.js";
import { diagramBlocks, parseDiagram, renderDiagram } from "../src/lib/slides/diagram/index.js";
import { _buildScene } from "../src/lib/slides/diagram/index.js";
import { parseSlides, runChecks } from "../src/workflows/checks.js";
import { fixContent, sourceIssues } from "../src/workflows/playbooks/slides-visual.js";
import { _test as slides } from "../src/workflows/playbooks/slides.js";

const slide = (title: string, body: string, notes = "", index = 1): LintSlide => ({ title, body, notes, index });
const diagram = (spec: unknown) => `\`\`\`diagram\n${JSON.stringify(spec)}\n\`\`\``;
const chart = (spec: unknown) => `\`\`\`chart\n${JSON.stringify(spec)}\n\`\`\``;
const deck = (...pages: [string, string, string?][]) => pages.map(([t, b, n]) => `## ${t}\n\n${b}\n\n::: {.notes}\n${n ?? "講稿內容說明這一頁的重點，至少三十個字以上才算完整的講稿。"}\n:::\n`).join("\n");

const PAPER = "We probe frozen HuBERT and wav2vec 2.0 representations with a linear probe trained on LibriSpeech. Alignment uses DTW between layers. We report CCA per layer (Fig. 2) and WER in Table 1.";
const TERMS = sourceTerms([PAPER]);
const TRAINING = trainingSentences([PAPER]);

describe("grounding: names not in the sources", () => {
  it("flags models / datasets the paper never names; generic acronyms, components and plurals are fine", () => {
    expect(ungroundedNames("Compared with WavLM and HuBERT-Large on LibriSpeech; WER and CER improve, the SSL model is frozen.", TERMS)).toEqual(["WavLM"]);
    expect(ungroundedNames("wav2vec 2.0 vs data2vec; Whisper is also strong.", TERMS)).toEqual(["data2vec", "Whisper"]);
    // A sentence-initial word / title case is not a name; math, URLs and paper-fig refs are not read.
    expect(ungroundedNames("Early Injection Cuts Rare-Word Errors. $W_{QKV}$ see https://x.org/GPT4All ![Fig. 2: CCA](paper-fig:3@0.1-0.5)", TERMS)).toEqual([]);
    const issues = nameIssues([slide("Results", "- WavLM is best"), slide("Setup", "- HuBERT on LibriSpeech", "", 2)], TERMS);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.issue).toContain("WavLM");
  });

  it("is a check on data.refs (skipped without a term list), notes included", () => {
    const text = deck(["Main result", "- HuBERT wins", "WavLM 也被拿來比較，結果更好，這裡說明完整的比較細節與數字。"]);
    const r = runChecks([{ id: "grounded_names" }], text, { refs: { terms: TERMS } })[0]!;
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/第 1 頁「Main result」.*WavLM/);
    expect(runChecks([{ id: "grounded_names" }], text, null)[0]!.ok).toBe(true);
    // Student-owned pages (the student's own answer, or study data under autopilot) are not the paper's claims.
    expect(runChecks([{ id: "grounded_names", params: { allow_titles: ["Main result"] } }], text, { refs: { terms: TERMS } })[0]!.ok).toBe(true);
    // Notes (no slides): one unit, no page numbers.
    const note = runChecks([{ id: "grounded_names", params: { doc: true } }], "## 方法\n\n作者也用了 WavLM（§3）。", { refs: { terms: TERMS } })[0]!;
    expect(note.ok).toBe(false);
    expect(note.detail).not.toContain("第 0 頁");
  });
});

describe("figure references", () => {
  const FIGS: RefFigure[] = [{ label: "Fig. 1", page: 2, top: 0.08, bottom: 0.42 }, { label: "Fig. 2", page: 4, top: 0.1, bottom: 0.5 }, { label: "Table 1", page: 5, top: 0.6, bottom: 0.85 }];

  it("rewrites a crop to where the figure list puts its Fig. N (page, band and the caption's page)", () => {
    const body = deck(["Architecture", "![Fig. 2: layer-wise CCA (p. 2)](paper-fig:2@0.08-0.42){width=80%}"]);
    const { body: out, fixed } = fixFigureRefs(body, FIGS);
    expect(fixed).toBe(1);
    expect(out).toContain("![Fig. 2: layer-wise CCA (p. 4)](paper-fig:4@0.10-0.50){width=80%}");
    // A caption without a number takes the label of the one figure its band covers.
    expect(fixFigureRefs("![overview (p. 2)](paper-fig:2@0.05-0.45)", FIGS).body).toBe("![Fig. 1: overview (p. 2)](paper-fig:2@0.08-0.42)");
    expect(fixFigureRefs(out, FIGS).fixed).toBe(0);
  });

  it("the writer's figure list carries the exact syntax of each figure", () => {
    expect(figureSyntax(FIGS[1]!)).toBe("![Fig. 2: 一句說明 (p. 4)](paper-fig:4@0.10-0.50)");
  });

  it("flags numberless captions, wrong pages, and text / notes naming another figure than the one shown", () => {
    const slides = [
      slide("Arch", "![overview](paper-fig:3@0.1-0.5)"),
      slide("CCA", "![Fig. 2: CCA (p. 2)](paper-fig:2@0.1-0.5)", "", 2),
      slide("Model", "![Fig. 1: model (p. 2)](paper-fig:2@0.08-0.42)", "如 Fig. 2 所示，模型分成三個部分。", 3),
      slide("Ok", "![Fig. 1: model (p. 2)](paper-fig:2@0.08-0.42)", "Fig. 1 的左邊是編碼器，對照 Fig. 2 的結果。", 4),
    ];
    const issues = figureIssues(slides, FIGS);
    expect(issues.map((i) => i.index)).toEqual([1, 2, 3]);
    expect(issues[1]!.issue).toContain("Fig. 2 在第 4 頁");
    expect(issues[2]!.issue).toContain("這頁放的是 Fig. 1");
  });

  it("notes: a mention with the wrong page", () => {
    const r = runChecks([{ id: "figure_refs", params: { doc: true } }], "## 結果\n\n各層 CCA 見 Fig. 2（p. 3），WER 見 Table 1, p. 5。", { refs: { figures: FIGS } })[0]!;
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("Fig. 2 在第 4 頁");
    expect(r.detail).not.toContain("Table 1");
  });
});

describe("diagram semantics", () => {
  it("inference-only steps and data are never trainable / frozen; trainable needs a training sentence in the sources", () => {
    const spec = { type: "pipeline", stages: [{ label: "Audio", kind: "input" }, { label: "HuBERT", kind: "model", frozen: true }, { label: "DTW alignment", trainable: true }, { label: "Head filtering", frozen: true }, { label: "Linear probe", trainable: true }, { label: "Decoder", trainable: true }] };
    const issues = diagramIssues([slide("Method", diagram(spec))], { training: TRAINING }).map((i) => i.issue);
    expect(issues.some((i) => i.includes("DTW alignment") && i.includes("推論"))).toBe(true);
    expect(issues.some((i) => i.includes("Head filtering"))).toBe(true);
    expect(issues.some((i) => i.includes("「Decoder」標成 trainable"))).toBe(true);
    expect(issues.some((i) => i.includes("Linear probe") || i.includes("HuBERT"))).toBe(false);
    const fixed = fixDiagrams(`## Method\n\n${diagram(spec)}\n`, { training: TRAINING });
    expect(fixed.fixed).toBe(1);
    const out = JSON.parse(diagramBlocks(fixed.body)[0]!.source) as { stages: Record<string, unknown>[] };
    expect(out.stages.map((s) => [s.label, !!(s.trainable || s.frozen)])).toEqual([["Audio", false], ["HuBERT", true], ["DTW alignment", false], ["Head filtering", false], ["Linear probe", true], ["Decoder", false]]);
  });

  it("parallel items drawn as an arrow chain are detected (peer title or listed together) and redrawn as a grid", () => {
    const apps = { type: "pipeline", stages: ["Speech recognition", "Speaker ID", "Spoken understanding"] };
    expect(diagramIssues([slide("Downstream applications", diagram(apps))])[0]!.issue).toContain("grid");
    // Neutral title, but the outline lists them together (no sequence words).
    const tools = { type: "pipeline", stages: [{ label: "Whisper", kind: "model" }, { label: "WhisperX", kind: "model" }, { label: "MFA", kind: "model" }] };
    const outline = [{ title: "Alignment quality", points: ["Compare Whisper, WhisperX and MFA timestamps"] }];
    expect(diagramIssues([slide("Alignment quality", diagram(tools))], { outline })).toHaveLength(1);
    // A real flow is not: input → model → output, or a sequence the text describes with arrows.
    const flow = { type: "pipeline", stages: [{ label: "Raw audio", kind: "input" }, { label: "Encoder", kind: "model" }, { label: "Linear probe" }] };
    expect(diagramIssues([slide("Downstream tasks", diagram(flow))])).toHaveLength(0);
    expect(diagramIssues([slide("Datasets and training", diagram({ type: "pipeline", stages: ["LibriSpeech 960h", "Fine-tune", "Evaluate"] }))])).toHaveLength(0);
    expect(diagramIssues([slide("Pipeline", diagram(tools), "Whisper → WhisperX → MFA 依序處理。")], { outline: [{ title: "Pipeline", points: ["Whisper → WhisperX → MFA"] }] })).toHaveLength(0);
    // Lanes of one box each are peers too.
    const lanes = parseDiagram(JSON.stringify({ type: "comparison", panels: [{ title: "A", stages: ["x"] }, { title: "B", stages: ["y"] }, { title: "C", stages: ["z"] }] })).spec!;
    expect(peerChain(lanes, { title: "x", lines: [] })).toEqual(["A", "B", "C"]);
    expect(gridFromPeers(lanes)).toMatchObject({ type: "grid", nodes: [{ label: "A", sub: "x" }, { label: "B" }, { label: "C" }] });

    const fixed = fixDiagrams(`## Downstream applications\n\n${diagram(apps)}\n`);
    const spec = parseDiagram(diagramBlocks(fixed.body)[0]!.source).spec!;
    expect(spec.type).toBe("grid");
    expect([...spec.nodes.values()].map((n) => n.label)).toEqual(apps.stages);
    expect(diagramIssues(parseSlides(fixed.body))).toHaveLength(0);
  });

  it("grid layout: no arrows, equal cards, rows centred, readable", () => {
    const spec = parseDiagram(JSON.stringify({ type: "grid", nodes: ["A one", "B two", "C three", "D four", "E five"] })).spec!;
    const scene = _buildScene(spec, { w: 1120, h: 470 });
    expect(scene.edges).toHaveLength(0);
    expect(new Set(scene.nodes.map((n) => n.w)).size).toBe(1);
    expect(new Set(scene.nodes.map((n) => Math.round(n.y))).size).toBe(2); // 3 + 2
    const r = renderDiagram(spec);
    expect(r.problems).toEqual([]);
    expect(r.minFont).toBeGreaterThanOrEqual(16);
    expect(r.svg).not.toContain("marker-end");
  });
});

describe("charts", () => {
  const ok = { type: "bar", labels: ["Base", "Ours"], series: [{ name: "WER", data: [5.2, 4.1] }], y_label: "WER (%)", source: "Table 1" };
  it("one axis = one unit", () => {
    expect(mixedUnits(parseDeckChart(JSON.stringify(ok))!)).toBeNull();
    expect(mixedUnits(parseDeckChart(JSON.stringify({ type: "bar", labels: ["Phone CCA", "Word CCA", "Phone best layer", "Word best layer"], series: [{ data: [0.75, 0.62, 6.5, 15] }] }))!)).toMatch(/layer|correlation/);
    expect(mixedUnits(parseDeckChart(JSON.stringify({ type: "bar", labels: ["Phone", "Word", "Speaker"], series: [{ name: "CCA", data: [0.75, 6.5, 15] }] }))!)).toContain("0–1");
    expect(mixedUnits(parseDeckChart(JSON.stringify({ type: "bar", labels: ["A", "B"], series: [{ name: "WER (%)", data: [5.2, 4.1] }, { name: "Params (M)", data: [95, 316] }] }))!)).toBeTruthy();
    expect(mixedUnits(parseDeckChart(JSON.stringify({ type: "line", labels: ["1", "2", "3"], series: [{ name: "Phone", data: [0.4, 0.6, 0.7] }, { name: "Word", data: [0.3, 0.5, 0.8] }] }))!)).toBeNull();
  });

  it("an axis label / unit on every chart, the same data on only one slide", () => {
    const noAxis = { type: "bar", labels: ["A", "B", "C"], series: [{ data: [1.5, 2.5, 3.5] }] };
    const issues = chartIssues([slide("R1", chart(ok)), slide("R2", chart(noAxis), "", 2), slide("R3", chart({ ...ok, type: "hbar", x_label: "WER (%)" }), "", 3)]);
    expect(issues.map((i) => [i.index, /座標軸/.test(i.issue) ? "axis" : /同一組數字/.test(i.issue) ? "dup" : "?"])).toEqual([[2, "axis"], [3, "dup"]]);
    const dup = chartIssues([slide("R1", chart({ ...ok, labels: ["A", "B", "C"], series: [{ name: "WER", data: [5.2, 4.1, 3.3] }] })), slide("R2", chart({ ...ok, labels: ["x", "y", "z"], series: [{ name: "WER", data: [3.3, 5.2, 4.1] }] }), "", 2)]);
    expect(dup[0]!.issue).toContain("第 1 頁「R1」");
  });
});

describe("deck integration", () => {
  it("writer checks, final criteria and the visual QA's source issues carry the content checks", () => {
    const outline = [{ n: 1, title: "A", points: [] }, { n: 2, title: "B", points: [] }];
    const ids = slides.writerSteps(outline)[0]!.verify!.checks.map((c) => c.id);
    for (const id of ["grounded_names", "figure_refs", "diagram_semantics", "chart_semantics"]) expect(ids).toContain(id);
    const crit = slides.criteriaFor(2, "paper_report", ["My assessment"]).map((c) => c.check?.id);
    expect(slides.criteriaFor(2, "paper_report", ["My assessment"]).find((c) => c.id === "names")!.check!.params).toEqual({ allow_titles: ["My assessment"] });
    for (const id of ["grounded_names", "figure_refs", "diagram_semantics", "chart_semantics"]) expect(crit).toContain(id);
    const body = deck(["Applications", diagram({ type: "pipeline", stages: ["Speech recognition", "Speaker ID", "Spoken understanding"] })], ["Results", `${chart({ type: "bar", labels: ["A", "B"], series: [{ name: "WER", data: [5.2, 4.1] }] })}\n\n- WavLM is better`]);
    const si = sourceIssues(body, { paper: true, refs: { terms: TERMS } });
    expect(si.get("Applications")!.join()).toContain("grid");
    expect(si.get("Results")!.join()).toMatch(/WavLM/);
    expect(si.get("Results")!.join()).toMatch(/座標軸/);
    // The deterministic fix turns the chain into a grid before anything is checked.
    expect(sourceIssues(fixContent(body, {}).body, { paper: true }).get("Applications")).toBeUndefined();
  });
});
