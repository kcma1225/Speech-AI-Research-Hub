/**
 * Academic diagram engine of generated decks: ```diagram JSON spec → laid out by our own code → publication-style SVG
 * (glyph-outline text measured with the real fonts, so labels always fit their boxes). Entry: `renderDiagram`.
 */
import { createHash } from "node:crypto";
import { GlyphSink } from "./fonts.js";
import { architecture, comparison, cycle, encoderDecoder, graph, pipeline, timeline, tree, type Fit } from "./layouts.js";
import { renderScene } from "./render.js";
import { COMPACT, KIND_STYLE, LARGE, NORMAL, sceneBox, sceneMinFont, type Box, type Scale, type Scene, type SNode } from "./scene.js";
import { parseDiagram, type DiagramSpec, type DLegend } from "./spec.js";
import { fitText, plainLabel, type TextBlock } from "./text.js";
import { flame, snowflake } from "./icons.js";
import { visualFit } from "../deck-layout.js";

export { parseDiagram, DIAGRAM_SPEC_HELP, type DiagramSpec } from "./spec.js";

/** Smallest font size allowed in the rendered SVG (deck px at 1280×800). */
export const MIN_FONT = 16;
const MAX_UPSCALE = 1.3;
const PAD = 10;

export type DiagramRender = { svg: string; width: number; height: number; minFont: number; problems: string[] };

function layoutScene(spec: DiagramSpec, sc: Scale, fit: Fit): Scene {
  const ctx = { spec, sc, fit };
  switch (spec.type) {
    case "pipeline":
      return spec.direction === "TB"
        ? architecture(ctx, spec.stages.map((st) => (st.length === 1 ? { node: st[0]! } : { row: st })), { flow: "down", edges: spec.explicitEdges ? spec.edges.filter((e) => !isChain(spec, e)) : [] })
        : pipeline(ctx, spec.stages, spec.explicitEdges ? spec.edges : null);
    case "architecture":
      return architecture(ctx, spec.layers);
    case "encoder_decoder":
      return encoderDecoder(ctx);
    case "comparison":
      return comparison(ctx);
    case "cycle":
      return cycle(ctx, [...spec.nodes.keys()].slice(0, 8));
    case "timeline":
      return timeline(ctx);
    case "tree":
      return tree(ctx);
    case "graph":
      return graph(ctx);
  }
}

/** TB pipelines draw the chain themselves; explicit edges between consecutive stages are just labels. */
function isChain(spec: DiagramSpec, e: { from: string; to: string; label?: string }) {
  const i = spec.stages.findIndex((s) => s.includes(e.from));
  const j = spec.stages.findIndex((s) => s.includes(e.to));
  return j === i + 1 && !e.label;
}

/** Legend entries: explicit, else automatic for highlight / frozen / trainable / dashed edges when used. */
function legendItems(spec: DiagramSpec, scene: Scene): DLegend[] {
  if (spec.legend === false) return [];
  if (Array.isArray(spec.legend)) return spec.legend;
  const zh = [...spec.nodes.values()].some((n) => /[一-鿿]/.test(n.label));
  const out: DLegend[] = [];
  const nodes = scene.nodes.map((n) => n.node);
  if (nodes.some((n) => n.kind === "highlight") && spec.type !== "timeline") out.push({ kind: "highlight", label: zh ? "本文貢獻" : "Proposed" });
  if (nodes.some((n) => n.frozen)) out.push({ kind: "frozen", label: zh ? "凍結（不訓練）" : "Frozen" });
  if (nodes.some((n) => n.trainable)) out.push({ kind: "trainable", label: zh ? "訓練" : "Trained" });
  return out.length >= 1 && (out.length > 1 || out[0]!.kind !== "highlight" || scene.nodes.length >= 4) ? out : [];
}

function legendDeco(items: DLegend[], sc: Scale, x0: number, y0: number, vertical: boolean): { svg: string; texts: Scene["texts"]; box: Box } {
  const texts: Scene["texts"] = [];
  const parts: string[] = [];
  const blocks = items.map((it) => fitText(it.label, { size: sc.sub }, 260, { maxLines: 1, minSize: 16 }));
  const widths = blocks.map((b) => 34 + b.width + 28);
  const total = vertical ? Math.max(...widths) - 28 : widths.reduce((a, b) => a + b, 0) - 28;
  let x = vertical ? x0 : x0 - total / 2;
  let y = y0;
  items.forEach((it, i) => {
    const b = blocks[i]!;
    const mid = y + 13;
    if (it.kind === "frozen") parts.push(snowflake(x + 2, mid - 11, 22, "#2563eb"));
    else if (it.kind === "trainable") parts.push(flame(x + 2, mid - 11, 22, "#f97316"));
    else if (it.style) parts.push(`<line x1="${x}" y1="${mid}" x2="${x + 26}" y2="${mid}" stroke="#475569" stroke-width="2.2" stroke-dasharray="${it.style === "dotted" ? "1.5 5" : "7 5"}" stroke-linecap="round"/>`);
    else {
      const k = KIND_STYLE[it.kind ?? "model"];
      parts.push(`<rect x="${x}" y="${mid - 10}" width="26" height="20" rx="5" fill="url(#gk-${it.kind ?? "model"})" stroke="${k.stroke}" stroke-width="${Math.min(2.2, k.sw)}"/>`);
    }
    texts.push({ block: b, x: x + 34, y: mid - b.height / 2, align: "start", color: "#334155" });
    if (vertical) y += 34;
    else x += widths[i]!;
  });
  return { svg: parts.join(""), texts, box: { x: vertical ? x0 : x0 - total / 2, y: y0, w: total, h: vertical ? 34 * items.length - 8 : 26 } };
}

/** Group titles move to the right end of their frame when an edge would cross them on the left. */
function placeGroupTitles(scene: Scene) {
  const hits = (b: Box) =>
    scene.edges.some((e) =>
      e.pts.some((p, i) => {
        const q = e.pts[i + 1];
        if (!q) return false;
        const x0 = Math.min(p[0], q[0]);
        const x1 = Math.max(p[0], q[0]);
        const y0 = Math.min(p[1], q[1]);
        const y1 = Math.max(p[1], q[1]);
        return x1 > b.x - 4 && x0 < b.x + b.w + 4 && y1 > b.y - 2 && y0 < b.y + b.h + 2;
      }),
    );
  for (const g of scene.groups) {
    if (!g.title) continue;
    const left = { x: g.x + 14, y: g.y + 8, w: g.title.width, h: g.title.height };
    const right = { ...left, x: g.x + g.w - 14 - g.title.width };
    if (hits(left) && !hits(right)) g.titleAt = "end";
  }
}

function build(spec: DiagramSpec, sc: Scale, fit: Fit) {
  const scene = layoutScene(spec, sc, fit);
  placeGroupTitles(scene);
  let box = sceneBox(scene);
  const items = legendItems(spec, scene);
  if (items.length) {
    // Below the figure, or (tall figures with room on the side) stacked at its bottom-right.
    const vertical = box.h * (fit.w / Math.max(1, box.w)) > fit.h * 1.05 && box.w < fit.w * 0.72;
    const lg = vertical ? legendDeco(items, sc, box.x + box.w + 36, box.y + box.h - 34 * items.length + 8, true) : legendDeco(items, sc, box.x + box.w / 2, box.y + box.h + 26, false);
    scene.decos.push({ svg: lg.svg, box: lg.box });
    scene.texts.push(...lg.texts);
  }
  if (spec.title) {
    const t = fitText(spec.title, { size: sc.title, weight: 700 }, Math.max(box.w, 400), { maxLines: 2 });
    scene.texts.push({ block: t, x: box.x + box.w / 2, y: box.y - t.height - 18, align: "middle", color: "#0f172a" });
  }
  box = sceneBox(scene);
  return { scene, box };
}

/** Upscaling stops where node labels would exceed 26 px (bigger reads as clumsy on a slide). */
function maxLabelScale(scene: Scene) {
  const sizes = scene.nodes.map((n) => n.label.style.size);
  return sizes.length ? MAX_LABEL_PX / Math.max(...sizes) : MAX_UPSCALE;
}
const MAX_LABEL_PX = 26;

/** Tests: the laid-out scene of a spec (normal type scale). */
export const _buildScene = (spec: DiagramSpec, fit: Fit, compact = false) => build(spec, compact ? COMPACT : NORMAL, fit).scene;

/** Badges (small pills on a node's top edge). */
function badgesOf(scene: Scene, sc: Scale) {
  const m = new Map<SNode, TextBlock>();
  for (const n of scene.nodes) if (n.node.badge) m.set(n, fitText(n.node.badge, { size: 16, weight: 700 }, 140, { maxLines: 1, minSize: 16 }));
  void sc;
  return m;
}

/**
 * Lays out and renders a spec for a fit box (deck px). Tries the normal type scale, then a compact one; scales the
 * result to the box (≤ 1.3× up; down only while the smallest text stays ≥ MIN_FONT, otherwise reports a problem).
 */
export function renderDiagram(spec: DiagramSpec, fit: Fit = { w: 1120, h: 470 }): DiagramRender {
  const problems: string[] = [];
  type Cand = { built: ReturnType<typeof build>; scale: number; penalty: number };
  const cand = (sc: Scale, f: Fit, penalty = 1): Cand => {
    const built = build(spec, sc, f);
    return { built, scale: Math.min(MAX_UPSCALE, maxLabelScale(built.scene), fit.w / (built.box.w + 2 * PAD), fit.h / (built.box.h + 2 * PAD)), penalty };
  };
  const ok = (c: Cand) => c.scale * sceneMinFont(c.built.scene) >= MIN_FONT - 0.05;
  const fill = (c: Cand) => ((c.built.box.w * c.scale) * (c.built.box.h * c.scale)) / (fit.w * fit.h) * c.penalty;
  const cands: Cand[] = [cand(NORMAL, fit)];
  const first = cands[0]!;
  if (first.scale < 0.94) cands.push(cand(COMPACT, { ...fit, w: fit.w * 1.08 }));
  // Lots of unused height: bigger type and icons, and for long left→right pipelines two rows (snake).
  const usedH = (first.built.box.h * first.scale) / fit.h;
  if (usedH < 0.62 && first.scale >= 0.9) cands.push(cand(LARGE, fit));
  const lrPipe = (spec.type === "pipeline" && spec.direction === "LR") || (spec.type === "comparison" && spec.direction === "LR");
  if (spec.type === "pipeline" && spec.direction === "LR" && spec.stages.length >= 5 && usedH < 0.62) {
    cands.push(cand(NORMAL, { ...fit, rows: 2 }, 0.8));
    cands.push(cand(LARGE, { ...fit, rows: 2 }, 0.8));
  }
  void lrPipe;
  // The direction is a hint: a graph / vertical pipeline that does not fit is also tried the other way round.
  if ((spec.type === "graph" || (spec.type === "pipeline" && spec.direction === "TB")) && first.scale < 0.95) {
    const flipped = { ...spec, direction: spec.direction === "TB" ? ("LR" as const) : ("TB" as const) };
    const c = (() => {
      const built = build(flipped, NORMAL, fit);
      return { built, scale: Math.min(MAX_UPSCALE, maxLabelScale(built.scene), fit.w / (built.box.w + 2 * PAD), fit.h / (built.box.h + 2 * PAD)), penalty: 0.95 };
    })();
    cands.push(c);
  }
  const good = cands.filter(ok);
  const pick = (good.length ? good : cands).reduce((a, b) => (good.length ? (fill(b) > fill(a) ? b : a) : b.scale * sceneMinFont(b.built.scene) > a.scale * sceneMinFont(a.built.scene) ? b : a));
  const best = pick.built;
  const scale = pick.scale;
  const minFont0 = sceneMinFont(best.scene);
  const floor = MIN_FONT / minFont0;
  let s = scale;
  if (s < floor) {
    problems.push(`這張圖太大，放不進投影片（需要縮到 ${Math.round(scale * 100)}%，字會小於 ${MIN_FONT}px）：請減少節點、縮短標籤，或拆成兩張圖`);
    s = floor;
  }
  const pad = PAD;
  const view = { x: best.box.x - pad, y: best.box.y - pad, w: best.box.w + 2 * pad, h: best.box.h + 2 * pad };
  const sink = new GlyphSink();
  const title = spec.title ?? [...spec.nodes.values()].map((n) => plainLabel(n.label)).slice(0, 8).join(" → ");
  const svg = renderScene(best.scene, sink, { width: view.w * s, height: view.h * s, view, title, minFont: minFont0 * s, badges: badgesOf(best.scene, NORMAL) });
  return { svg, width: Math.round(view.w * s), height: Math.round(view.h * s), minFont: Math.round(minFont0 * s * 10) / 10, problems };
}

/** Parses + renders a ```diagram source; null spec → only problems. */
export function diagramFromSource(source: string, fit?: Fit): { render: DiagramRender | null; problems: string[]; spec: DiagramSpec | null } {
  const { spec, problems } = parseDiagram(source);
  if (!spec) return { render: null, problems, spec: null };
  const render = renderDiagram(spec, fit);
  return { render, problems: [...problems, ...render.problems], spec };
}

// ---------------------------------------------------------------- body helpers

export type DiagramBlock = { start: number; end: number; source: string };
const DIAGRAM_RE = /^```[ \t]*\{?\.?diagram\}?[^\n]*\n([\s\S]*?)^```[ \t]*$/gm;

export const diagramBlocks = (body: string): DiagramBlock[] => [...body.matchAll(DIAGRAM_RE)].map((m) => ({ start: m.index!, end: m.index! + m[0].length, source: m[1]!.trim() }));

export const diagramFileName = (source: string, fit: Fit) => `diagrams/diagram-${createHash("sha256").update(`${source}\n${Math.round(fit.w)}x${Math.round(fit.h)}\nv1`).digest("hex").slice(0, 12)}.svg`;

/** Lint of every ```diagram block (spec problems; rendering problems included), laid out for the box it gets on its slide. */
export function lintDiagrams(body: string): string[] {
  const out: string[] = [];
  diagramBlocks(body).forEach((b, i) => {
    const { problems } = diagramFromSource(b.source, visualFit(body, b.start, b.end));
    for (const p of problems) out.push(`第 ${i + 1} 張 diagram：${p}`);
  });
  return out;
}
