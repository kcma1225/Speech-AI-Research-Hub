import { describe, expect, it } from "vitest";
import { XMLValidator } from "fast-xml-parser";
import { _buildScene, diagramBlocks, diagramFromSource, lintDiagrams, MIN_FONT, parseDiagram, renderDiagram } from "../src/lib/slides/diagram/index.js";
import { mermaidCellsToDiagrams, mermaidToSpec } from "../src/lib/slides/diagram/mermaid.js";
import { fitText } from "../src/lib/slides/diagram/text.js";
import { visualFit } from "../src/lib/slides/deck-layout.js";
import type { Scene } from "../src/lib/slides/diagram/scene.js";

const LONG = "Self-supervised speech representation encoder with twelve frozen transformer layers";
const CJK = "自監督語音表徵模型的逐層線性探測與分析流程";

const SPECS: Record<string, unknown> = {
  pipeline: { type: "pipeline", stages: [{ id: "a", label: "Raw audio", kind: "input", icon: "waveform" }, { id: "b", label: LONG, sub: "wav2vec 2.0 / HuBERT", kind: "model", frozen: true, icon: "transformer" }, [{ id: "c", label: "Phone probe" }, { id: "d", label: CJK, kind: "highlight" }], { id: "e", label: "Accuracy", kind: "output", icon: "chart" }], groups: [{ label: "Frozen", nodes: ["b"], style: "frozen" }] },
  long_pipeline: { type: "pipeline", stages: ["Audio", "Feature extractor", "Encoder", "Pooling", "Projection", "Classifier", "Score"] },
  architecture: { type: "architecture", layers: [{ id: "x", label: "Log-Mel input", kind: "input", icon: "spectrogram" }, { repeat: 12, label: "Transformer block", layers: [{ id: "att", label: "Multi-head self-attention $\\mathrm{softmax}(QK^\\top/\\sqrt{d})V$" }, { id: "ffn", label: CJK }] }, { id: "out", label: "Hidden states $h^{(\\ell)}_t$", kind: "output" }], nodes: [{ id: "probe", label: "Layer-wise probe", kind: "highlight" }], edges: [{ from: "att", to: "probe", label: "every layer" }, { from: "x", to: "ffn", kind: "residual" }] },
  encoder_decoder: { type: "encoder_decoder", encoder: { layers: [{ id: "mel", label: "Log-Mel", kind: "input" }, { id: "enc", label: "Encoder ×32", kind: "model" }] }, decoder: { layers: [{ id: "tok", label: "Tokens", kind: "input" }, { id: "xa", label: "Cross-attention", kind: "highlight" }, { id: "ts", label: "Word timestamps", kind: "output" }] }, edges: [{ from: "enc", to: "xa", kind: "cross", label: "keys / values" }] },
  comparison: { type: "comparison", panels: [{ title: "Baseline", stages: ["Audio", "ASR", "Forced aligner", "Timestamps"] }, { title: "Ours", highlight: true, stages: ["Audio", "ASR", { label: "Attention heads", kind: "highlight" }, "Timestamps"] }] },
  comparison_lr: { type: "comparison", direction: "LR", panels: [{ title: "Prior work", stages: ["Audio", "ASR", "Aligner"] }, { title: "This paper", highlight: true, stages: ["Audio", "ASR + heads"] }] },
  cycle: { type: "cycle", nodes: ["產生偽標籤", "篩選高信心樣本", "重新訓練模型", "評估"], center: "自我訓練" },
  timeline: { type: "timeline", events: [{ date: "2019", label: "wav2vec" }, { date: "2020", label: "wav2vec 2.0" }, { date: "2021", label: "HuBERT" }, { date: "2022", label: "WavLM" }, { date: "2024", label: "This work", kind: "highlight" }] },
  tree: { type: "tree", root: { label: "Probing", children: [{ label: "Acoustic", children: [{ label: "Pitch" }, { label: "Speaker" }] }, { label: "Lexical", children: [{ label: LONG }] }] } },
  graph: { type: "graph", direction: "LR", nodes: [{ id: "h", label: "Representation $\\mathbf{h}$" }, { id: "s", label: "Speaker subspace" }, { id: "c", label: "Content subspace", kind: "highlight" }], edges: [{ from: "h", to: "s" }, { from: "h", to: "c", label: "project" }, { from: "s", to: "c", label: "$\\perp$", style: "dashed", both: true }], groups: [{ label: "Subspaces", nodes: ["s", "c"] }] },
};

/** Every label / sub block sits inside its node box (content area). */
function assertFits(scene: Scene) {
  for (const n of scene.nodes) {
    const iconW = n.iconPos === "left" ? n.iconSize + 12 : 0;
    const textW = Math.max(n.label.width, n.sub?.width ?? 0);
    expect(textW, `${n.node.label} width`).toBeLessThanOrEqual(n.w - 2 * n.padX - iconW + 0.5);
    const textH = n.label.height + (n.sub ? 3 + n.sub.height : 0) + (n.iconPos === "top" ? n.iconSize + 7 : 0);
    expect(textH, `${n.node.label} height`).toBeLessThanOrEqual(n.h + 0.5);
    for (const b of [n.label, n.sub]) if (b) expect(b.style.size).toBeGreaterThanOrEqual(16);
  }
}

describe("diagram spec", () => {
  it("rejects invalid input with zh-TW problems and accepts lenient model output", () => {
    expect(parseDiagram("{").problems[0]).toContain("JSON");
    expect(parseDiagram(JSON.stringify({ type: "sankey" })).problems[0]).toContain("未知的 diagram type");
    const p = parseDiagram(JSON.stringify({ type: "flowchart", nodes: ["A", { label: "B", kind: "ours" }], edges: [["A", "B"], { from: "A", to: "Z" }] }));
    expect(p.spec?.type).toBe("pipeline");
    expect(p.spec?.nodes.get("b")?.kind).toBe("highlight");
    expect(p.spec?.edges).toHaveLength(1);
    expect(p.problems.join()).toContain("不存在的節點");
    const many = parseDiagram(JSON.stringify({ type: "graph", nodes: Array.from({ length: 20 }, (_, i) => `N${i}`) }));
    expect(many.problems.join()).toContain("節點太多");
    expect(parseDiagram(JSON.stringify({ type: "pipeline", stages: [{ label: "x".repeat(90) }] })).problems.join()).toContain("太長");
  });

  it("finds ```diagram blocks and lints them", () => {
    const body = "## A\n\n```diagram\n{\"type\":\"pipeline\",\"stages\":[\"a\",\"b\"]}\n```\n\n## B\n\n```diagram\n{oops}\n```\n";
    expect(diagramBlocks(body)).toHaveLength(2);
    const lint = lintDiagrams(body);
    expect(lint).toHaveLength(1);
    expect(lint[0]).toContain("第 2 張 diagram");
  });
});

describe("diagram layout and rendering", () => {
  for (const [name, raw] of Object.entries(SPECS)) {
    it(`${name}: labels fit their boxes, SVG is well-formed and readable`, () => {
      const { spec, problems } = parseDiagram(JSON.stringify(raw));
      expect(spec, problems.join()).not.toBeNull();
      for (const fit of [{ w: 1180, h: 520 }, { w: 640, h: 480 }]) {
        assertFits(_buildScene(spec!, fit));
        assertFits(_buildScene(spec!, fit, true));
        const r = renderDiagram(spec!, fit);
        expect(XMLValidator.validate(r.svg)).toBe(true);
        expect(r.svg).not.toMatch(/<script|\son\w+=|javascript:/i);
        expect(r.svg).toContain('data-hub-diagram="1"');
        if (!r.problems.length) {
          expect(r.minFont).toBeGreaterThanOrEqual(MIN_FONT - 0.05);
          expect(r.width).toBeLessThanOrEqual(fit.w + 1);
          expect(r.height).toBeLessThanOrEqual(fit.h + 1);
        }
      }
    });
  }

  it("text fit: balanced wrap, never wider than asked unless one word is", () => {
    const b = fitText(LONG, { size: 20, weight: 600 }, 200, { maxLines: 3 });
    expect(b.width).toBeLessThanOrEqual(200.5);
    const c = fitText(CJK, { size: 20 }, 150, { maxLines: 3 });
    expect(c.width).toBeLessThanOrEqual(150.5);
    expect(c.lines.length).toBeLessThanOrEqual(3);
    const word = fitText("Supercalifragilisticexpialidocious", { size: 20 }, 80);
    expect(word.style.size).toBe(16);
    expect(word.lines).toHaveLength(1);
  });

  it("an oversized diagram is reported instead of shrinking text below 16 px", () => {
    const r = diagramFromSource(JSON.stringify({ type: "pipeline", direction: "TB", stages: Array.from({ length: 16 }, (_, i) => `Step number ${i} with a long label`) }), { w: 400, h: 240 });
    expect(r.problems.join()).toContain("太大");
    expect(r.render!.minFont).toBeGreaterThanOrEqual(MIN_FONT - 0.05);
  });
});

describe("mermaid → diagram", () => {
  it("converts chains to pipelines and graphs with subgraphs / styles", () => {
    const chain = mermaidToSpec('flowchart LR\n  A[Audio] --> B["Encoder (frozen)"] --> C[Probe]\n  style C stroke-width:4px\n  style B fill:#ddd');
    expect(chain).toMatchObject({ type: "pipeline", direction: "LR" });
    const stages = (chain as { stages: { id: string; kind: string; frozen?: boolean }[] }).stages;
    expect(stages.map((s) => s.id)).toEqual(["A", "B", "C"]);
    expect(stages[2]!.kind).toBe("highlight");
    expect(stages[1]!.frozen).toBe(true);
    const g = mermaidToSpec("graph TD\n  subgraph S[Frozen model]\n  L1 --> L2\n  end\n  W[Wave] --> L1\n  L1 -.->|tap| P[Probe]\n  L2 -.-> P");
    expect(g).toMatchObject({ type: "graph", direction: "TB" });
    expect((g as { groups: unknown[] }).groups).toHaveLength(1);
    expect((g as { edges: { style?: string; label?: string }[] }).edges.find((e) => e.label === "tap")?.style).toBe("dashed");
    expect(mermaidToSpec("sequenceDiagram\n  A->>B: hi")).toBeNull();
    const body = mermaidCellsToDiagrams("## A\n\n```{mermaid}\nflowchart LR\n  A --> B\n```\n");
    expect(body.converted).toBe(1);
    expect(body.body).toContain("```diagram\n{");
  });
});

describe("visual fit", () => {
  it("columns narrow the box; takeaways and bullets lower it", () => {
    const full = "## T\n\n```diagram\n{}\n```\n";
    const withTake = "## T\n\n```diagram\n{}\n```\n\n::: {.takeaway}\nx\n:::\n\n- a\n- b\n";
    const col = "## T\n\n:::: {.columns}\n::: {.column width=\"60%\"}\n```diagram\n{}\n```\n:::\n::: {.column width=\"40%\"}\n- a\n- b\n- c\n:::\n::::\n";
    const at = (b: string) => [b.indexOf("```diagram"), b.indexOf("```\n", b.indexOf("```diagram") + 5) + 4] as const;
    const f1 = visualFit(full, ...at(full));
    const f2 = visualFit(withTake, ...at(withTake));
    const f3 = visualFit(col, ...at(col));
    expect(f1.w).toBeGreaterThan(1100);
    expect(f2.h).toBeLessThanOrEqual(800 - 86 - 26 - 92 - 88);
    expect(f3.column).toBe(true);
    expect(f3.w).toBeLessThan(760);
    // Bullets in the other column do not take this column's height.
    expect(f3.h).toBe(f1.h);
  });
});
