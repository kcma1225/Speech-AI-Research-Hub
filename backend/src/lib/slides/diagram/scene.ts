/**
 * Scene model of the diagram engine: positioned nodes (with their wrapped text blocks), orthogonal / curved edges,
 * group frames and decorations. Layouts produce a Scene; `render.ts` turns it into SVG. Every text block is placed
 * inside the box it was measured for, so a label can never overflow its node.
 */
import type { DEdge, DNode, EdgeKind, EdgeStyle, NodeKind } from "./spec.js";
import { fitText, type TextBlock } from "./text.js";
import type { TextStyle } from "./fonts.js";

export type Box = { x: number; y: number; w: number; h: number };
export type Pt = [number, number];

/** Type scale (px at scale 1; the deck renders diagrams at ≈ 1:1). Every size ≥ 16. */
export type Scale = { label: number; sub: number; edge: number; group: number; title: number; padX: number; padY: number; icon: number; gap: number };
export const NORMAL: Scale = { label: 21, sub: 17, edge: 17, group: 17, title: 23, padX: 18, padY: 14, icon: 34, gap: 1 };
export const LARGE: Scale = { label: 23, sub: 18.5, edge: 18, group: 18, title: 24, padX: 22, padY: 20, icon: 46, gap: 1.15 };
export const COMPACT: Scale = { label: 19, sub: 16.5, edge: 16.5, group: 16.5, title: 21, padX: 14, padY: 11, icon: 28, gap: 0.78 };

export type KindStyle = { fill1: string; fill2: string; stroke: string; ink: string; sub: string; accent: string; sw: number; dash?: string };
export const KIND_STYLE: Record<NodeKind, KindStyle> = {
  input: { fill1: "#f8fafc", fill2: "#e9eef5", stroke: "#94a3b8", ink: "#0f172a", sub: "#475569", accent: "#64748b", sw: 1.6 },
  process: { fill1: "#ffffff", fill2: "#eef3fb", stroke: "#8aa1c4", ink: "#0f172a", sub: "#475569", accent: "#3b6fd8", sw: 1.6 },
  model: { fill1: "#eaf1ff", fill2: "#cddffd", stroke: "#2f63d6", ink: "#0b1f4d", sub: "#2f4675", accent: "#2563eb", sw: 1.8 },
  data: { fill1: "#effcf6", fill2: "#d3f3e4", stroke: "#18a77a", ink: "#053b2c", sub: "#2c6553", accent: "#059669", sw: 1.7 },
  output: { fill1: "#f7f5ff", fill2: "#e6defd", stroke: "#8b5cf6", ink: "#2e1065", sub: "#56478a", accent: "#7c3aed", sw: 1.7 },
  highlight: { fill1: "#fff9ee", fill2: "#ffdfa8", stroke: "#e58a00", ink: "#4a2300", sub: "#7a4712", accent: "#ea580c", sw: 2.6 },
  note: { fill1: "#ffffff", fill2: "#ffffff", stroke: "#cbd5e1", ink: "#334155", sub: "#64748b", accent: "#64748b", sw: 1.4, dash: "5 4" },
};
export const EDGE_COLOR: Record<EdgeKind, string> = { flow: "#475569", skip: "#64748b", residual: "#64748b", feedback: "#7c3aed", cross: "#2563eb", gradient: "#dc2626" };
export const GROUP_STYLE = {
  default: { fill: "#f3f7ff", stroke: "#a9c1ea", ink: "#1e40af" },
  frozen: { fill: "#f3f5f8", stroke: "#b6c0cd", ink: "#475569" },
  highlight: { fill: "#fff7ea", stroke: "#f2b45b", ink: "#9a4a00" },
  plain: { fill: "none", stroke: "#cbd5e1", ink: "#475569" },
} as const;

export type SNode = Box & { id: string; node: DNode; label: TextBlock; sub?: TextBlock; iconPos: "top" | "left" | "none"; iconSize: number; padX: number; padY: number };
export type SEdge = { pts: Pt[]; kind: EdgeKind; style: EdgeStyle; label?: TextBlock; labelAt?: Pt; arrowEnd: boolean; arrowStart: boolean; smooth?: boolean; color?: string; width?: number };
export type SGroup = Box & { title?: TextBlock; style: keyof typeof GROUP_STYLE; repeat?: TextBlock; titleAt?: "start" | "end" };
export type Deco = { svg: string; box: Box };
export type Scene = { nodes: SNode[]; edges: SEdge[]; groups: SGroup[]; decos: Deco[]; texts: { block: TextBlock; x: number; y: number; align: "start" | "middle" | "end"; color: string; bg?: boolean }[] };

export const emptyScene = (): Scene => ({ nodes: [], edges: [], groups: [], decos: [], texts: [] });

export const labelStyle = (n: DNode, sc: Scale): TextStyle => ({ size: sc.label, weight: n.kind === "highlight" ? 700 : 600 });
export const subStyle = (sc: Scale): TextStyle => ({ size: sc.sub, weight: 400 });
export const edgeStyle = (sc: Scale): TextStyle => ({ size: sc.edge, weight: 400, italic: true });

/**
 * Measures a node for a maximum outer width: wraps the label (≤ 3 lines) and sub (≤ 2 lines) to fit, then returns
 * the outer size. `minW` / `minH` widen the box (text stays centred).
 */
export function measureNode(n: DNode, sc: Scale, maxW: number, opts: { iconPos?: "top" | "left"; minW?: number } = {}): SNode {
  const hasIcon = !!n.icon;
  const iconPos = hasIcon ? (opts.iconPos ?? "top") : "none";
  const marks = n.frozen || n.trainable || n.badge;
  const padX = sc.padX + (marks ? 4 : 0);
  const padY = sc.padY + (marks ? 3 : 0);
  const iconW = iconPos === "left" ? sc.icon + 12 : 0;
  const contentMax = Math.max(60, maxW - 2 * padX - iconW);
  const label = fitText(n.label, labelStyle(n, sc), contentMax, { maxLines: 3, minSize: Math.min(sc.label, 17) });
  const sub = n.sub ? fitText(n.sub, subStyle(sc), Math.max(contentMax, label.width), { maxLines: 2, minSize: 16 }) : undefined;
  const textW = Math.max(label.width, sub?.width ?? 0);
  const textH = label.height + (sub ? 3 + sub.height : 0);
  let w: number;
  let h: number;
  if (iconPos === "top") {
    w = Math.max(textW, sc.icon) + 2 * padX;
    h = padY + sc.icon + 7 + textH + padY;
  } else if (iconPos === "left") {
    w = padX + iconW + textW + padX;
    h = padY + Math.max(sc.icon, textH) + padY;
  } else {
    w = textW + 2 * padX;
    h = textH + 2 * padY;
  }
  w = Math.ceil(Math.max(w, opts.minW ?? 0, n.shape === "circle" ? 0 : 108));
  h = Math.ceil(Math.max(h, 54));
  if (n.shape === "circle") {
    const d = Math.ceil(Math.max(w, h) * 1.08);
    w = h = d;
  }
  if (n.shape === "cylinder") h += 14;
  return { id: n.id, node: n, x: 0, y: 0, w, h, label, sub, iconPos, iconSize: sc.icon, padX, padY };
}

/** Re-measures a node for a fixed outer width (text wrapped inside it). */
export function resize(sn: SNode, sc: Scale, w: number): SNode {
  const m = measureNode(sn.node, sc, w, { iconPos: sn.iconPos === "none" ? undefined : sn.iconPos, minW: w });
  return { ...m, x: sn.x, y: sn.y, w: Math.max(w, m.w) };
}

export function edgeLabel(e: DEdge, sc: Scale, maxW = 170): TextBlock | undefined {
  return e.label ? fitText(e.label, edgeStyle(sc), maxW, { maxLines: 2, minSize: 16 }) : undefined;
}

export const cx = (b: Box) => b.x + b.w / 2;
export const cy = (b: Box) => b.y + b.h / 2;

/** Bounding box of a scene (nodes, groups, edges, labels, decorations). */
export function sceneBox(s: Scene): Box {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = (b: Box) => {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  };
  for (const n of s.nodes) add({ x: n.x - (n.node.repeat ? 0 : 0), y: n.y - (n.node.repeat ? 12 : 0) - (n.node.badge || n.node.frozen || n.node.trainable ? 12 : 0), w: n.w + (n.node.repeat ? 12 : 0) + (n.node.frozen || n.node.trainable || n.node.badge ? 12 : 0), h: n.h + (n.node.repeat ? 12 : 0) + 6 });
  for (const g of s.groups) add(g);
  for (const e of s.edges) {
    for (const [x, y] of e.pts) add({ x: x - 6, y: y - 6, w: 12, h: 12 });
    if (e.label && e.labelAt) add(labelBox(e.label, e.labelAt));
  }
  for (const d of s.decos) add(d.box);
  for (const t of s.texts) add({ x: t.align === "middle" ? t.x - t.block.width / 2 : t.align === "end" ? t.x - t.block.width : t.x, y: t.y, w: t.block.width, h: t.block.height });
  if (x0 === Infinity) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Edge-label pill around a block centred at `at`. */
export const labelBox = (b: TextBlock, at: Pt): Box => ({ x: at[0] - b.width / 2 - 8, y: at[1] - b.height / 2 - 3, w: b.width + 16, h: b.height + 6 });

/** Moves every element of a scene. */
export function shiftScene(s: Scene, dx: number, dy: number): Scene {
  return {
    nodes: s.nodes.map((n) => ({ ...n, x: n.x + dx, y: n.y + dy })),
    edges: s.edges.map((e) => ({ ...e, pts: e.pts.map(([x, y]) => [x + dx, y + dy] as Pt), ...(e.labelAt ? { labelAt: [e.labelAt[0] + dx, e.labelAt[1] + dy] as Pt } : {}) })),
    groups: s.groups.map((g) => ({ ...g, x: g.x + dx, y: g.y + dy })),
    decos: s.decos.map((d) => ({ svg: `<g transform="translate(${dx} ${dy})">${d.svg}</g>`, box: { ...d.box, x: d.box.x + dx, y: d.box.y + dy } })),
    texts: s.texts.map((t) => ({ ...t, x: t.x + dx, y: t.y + dy })),
  };
}

export function mergeScene(into: Scene, add: Scene) {
  into.nodes.push(...add.nodes);
  into.edges.push(...add.edges);
  into.groups.push(...add.groups);
  into.decos.push(...add.decos);
  into.texts.push(...add.texts);
}

/** Smallest font size used by a scene (labels may have shrunk to fit). */
export function sceneMinFont(s: Scene): number {
  const sizes = [
    ...s.nodes.flatMap((n) => [n.label.style.size, ...(n.sub ? [n.sub.style.size] : [])]),
    ...s.edges.flatMap((e) => (e.label ? [e.label.style.size] : [])),
    ...s.groups.flatMap((g) => [...(g.title ? [g.title.style.size] : []), ...(g.repeat ? [g.repeat.style.size] : [])]),
    ...s.texts.map((t) => t.block.style.size),
  ];
  return sizes.length ? Math.min(...sizes) : 16;
}
