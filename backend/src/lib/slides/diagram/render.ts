/** Scene → standalone SVG (glyph-outline text, gradients, soft shadows, arrow markers). */
import { escXml, GlyphSink, r } from "./fonts.js";
import { flame, icon, snowflake } from "./icons.js";
import { EDGE_COLOR, GROUP_STYLE, KIND_STYLE, labelBox, type Box, type Pt, type Scene, type SEdge, type SNode } from "./scene.js";
import { drawText } from "./text.js";

export function roundedPath(pts: Pt[], radius = 10): string {
  if (pts.length < 2) return "";
  let d = `M${r(pts[0]![0])} ${r(pts[0]![1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i - 1]!;
    const [x1, y1] = pts[i]!;
    const [x2, y2] = pts[i + 1]!;
    const l1 = Math.hypot(x1 - x0, y1 - y0);
    const l2 = Math.hypot(x2 - x1, y2 - y1);
    const rr = Math.min(radius, l1 / 2, l2 / 2);
    if (rr < 0.5 || l1 === 0 || l2 === 0) {
      d += ` L${r(x1)} ${r(y1)}`;
      continue;
    }
    const ax = x1 - ((x1 - x0) / l1) * rr;
    const ay = y1 - ((y1 - y0) / l1) * rr;
    const bx = x1 + ((x2 - x1) / l2) * rr;
    const by = y1 + ((y2 - y1) / l2) * rr;
    d += ` L${r(ax)} ${r(ay)} Q${r(x1)} ${r(y1)} ${r(bx)} ${r(by)}`;
  }
  const last = pts.at(-1)!;
  return `${d} L${r(last[0])} ${r(last[1])}`;
}

/** Catmull-Rom through the points as cubic Béziers. */
export function smoothPath(pts: Pt[]): string {
  if (pts.length < 3) return roundedPath(pts);
  let d = `M${r(pts[0]![0])} ${r(pts[0]![1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[Math.min(pts.length - 1, i + 2)]!;
    const c1: Pt = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: Pt = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${r(c1[0])} ${r(c1[1])} ${r(c2[0])} ${r(c2[1])} ${r(p2[0])} ${r(p2[1])}`;
  }
  return d;
}

/** Pulls the end of a polyline back by `by` px (the arrowhead covers the gap). */
function trimEnd(pts: Pt[], by: number): Pt[] {
  const out = pts.map((p) => [...p] as Pt);
  const a = out.at(-2);
  const b = out.at(-1);
  if (!a || !b) return out;
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (l <= by + 1) return out;
  b[0] -= ((b[0] - a[0]) / l) * by;
  b[1] -= ((b[1] - a[1]) / l) * by;
  return out;
}

const markerId = (color: string) => `ah${color.replace("#", "")}`;

function nodeShape(n: SNode, fill: string, stroke: string, sw: number, dash?: string, filter?: string): string {
  const f = filter ? ` filter="url(#${filter})"` : "";
  const ds = dash ? ` stroke-dasharray="${dash}"` : "";
  if (n.node.shape === "circle") return `<circle cx="${r(n.x + n.w / 2)}" cy="${r(n.y + n.h / 2)}" r="${r(n.w / 2)}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${ds}${f}/>`;
  if (n.node.shape === "cylinder") {
    const e = 9;
    const { x, y, w, h } = n;
    return `<path d="M${r(x)} ${r(y + e)} A${r(w / 2)} ${e} 0 0 1 ${r(x + w)} ${r(y + e)} V${r(y + h - e)} A${r(w / 2)} ${e} 0 0 1 ${r(x)} ${r(y + h - e)} Z" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${ds}${f}/><path d="M${r(x)} ${r(y + e)} A${r(w / 2)} ${e} 0 0 0 ${r(x + w)} ${r(y + e)}" fill="none" stroke="${stroke}" stroke-width="${sw}"/>`;
  }
  const rx = n.node.shape === "pill" ? n.h / 2 : Math.min(12, n.h / 4);
  return `<rect x="${r(n.x)}" y="${r(n.y)}" width="${r(n.w)}" height="${r(n.h)}" rx="${r(rx)}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${ds}${f}/>`;
}

function drawNode(n: SNode, sink: GlyphSink): string {
  const st = KIND_STYLE[n.node.kind];
  const out: string[] = [];
  const grad = `url(#gk-${n.node.kind})`;
  if (n.node.repeat) {
    // Stacked copies behind (a repeated block, e.g. × 12 layers).
    for (const k of [2, 1]) out.push(nodeShape({ ...n, x: n.x + 6 * k, y: n.y - 6 * k }, st.fill2, st.stroke, 1.2, undefined));
  }
  out.push(nodeShape(n, grad, st.stroke, st.sw, st.dash || (n.node.frozen && n.node.kind !== "highlight" ? undefined : undefined), n.node.kind === "highlight" ? "glow" : n.node.kind === "note" ? undefined : "sh"));
  // Content: icon + label + sub, centred as one unit.
  const cyc = n.node.shape === "cylinder" ? 7 : 0;
  const textH = n.label.height + (n.sub ? 3 + n.sub.height : 0);
  const textW = Math.max(n.label.width, n.sub?.width ?? 0);
  if (n.iconPos === "top") {
    const contentH = n.iconSize + 7 + textH;
    const top = n.y + cyc + (n.h - cyc - contentH) / 2;
    out.push(icon(n.node.icon!, n.x + n.w / 2 - n.iconSize / 2, top, n.iconSize, st.ink, st.accent));
    out.push(drawText(n.label, n.x + n.w / 2, top + n.iconSize + 7, "middle", sink, st.ink));
    if (n.sub) out.push(drawText(n.sub, n.x + n.w / 2, top + n.iconSize + 7 + n.label.height + 3, "middle", sink, st.sub));
  } else if (n.iconPos === "left") {
    const unitW = n.iconSize + 12 + textW;
    const left = n.x + Math.max(n.padX, (n.w - unitW) / 2);
    const top = n.y + cyc + (n.h - cyc - textH) / 2;
    out.push(icon(n.node.icon!, left, n.y + cyc + (n.h - cyc - n.iconSize) / 2, n.iconSize, st.ink, st.accent));
    const tx = left + n.iconSize + 12 + textW / 2;
    out.push(drawText(n.label, tx, top, "middle", sink, st.ink));
    if (n.sub) out.push(drawText(n.sub, tx, top + n.label.height + 3, "middle", sink, st.sub));
  } else {
    const top = n.y + cyc + (n.h - cyc - textH) / 2;
    out.push(drawText(n.label, n.x + n.w / 2, top, "middle", sink, st.ink));
    if (n.sub) out.push(drawText(n.sub, n.x + n.w / 2, top + n.label.height + 3, "middle", sink, st.sub));
  }
  // Corner marks: frozen (snowflake) / trainable (flame) / badge.
  const mx = n.x + n.w - 4;
  const my = n.y + 4;
  if (n.node.frozen || n.node.trainable) {
    out.push(`<circle cx="${r(mx)}" cy="${r(my)}" r="13" fill="#fff" stroke="${n.node.frozen ? "#93c5fd" : "#fdba74"}" stroke-width="1.6"/>`);
    out.push(n.node.frozen ? snowflake(mx - 9, my - 9, 18, "#2563eb") : flame(mx - 9, my - 9.5, 18, "#f97316"));
  }
  return out.join("");
}

function drawBadges(n: SNode, sink: GlyphSink, badges: Map<SNode, import("./text.js").TextBlock>): string {
  const b = badges.get(n);
  if (!b) return "";
  const st = KIND_STYLE[n.node.kind];
  const w = b.width + 16;
  const h = b.height + 4;
  const x = n.x + n.w - w - (n.node.frozen || n.node.trainable ? 22 : 8);
  const y = n.y - h / 2;
  return `<rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" rx="${r(h / 2)}" fill="${st.accent}"/>${drawText(b, x + w / 2, y + 2, "middle", sink, "#ffffff")}`;
}

function drawEdge(e: SEdge): string {
  const color = e.color ?? EDGE_COLOR[e.kind];
  const w = e.width ?? (e.kind === "cross" ? 2.3 : e.kind === "residual" || e.kind === "skip" ? 1.8 : 2);
  const dash = e.style === "dashed" ? ` stroke-dasharray="7 5"` : e.style === "dotted" ? ` stroke-dasharray="1.5 5"` : "";
  let pts = e.arrowEnd ? trimEnd(e.pts, 3) : e.pts;
  if (e.arrowStart) pts = trimEnd([...pts].reverse(), 3).reverse();
  const d = e.smooth ? smoothPath(pts) : roundedPath(pts, 12);
  const m = markerId(color);
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"${dash}${e.arrowEnd ? ` marker-end="url(#${m})"` : ""}${e.arrowStart ? ` marker-start="url(#${m}s)"` : ""}/>`;
}

function drawEdgeLabel(e: SEdge, sink: GlyphSink): string {
  if (!e.label || !e.labelAt) return "";
  const b = labelBox(e.label, e.labelAt);
  return `<rect x="${r(b.x)}" y="${r(b.y)}" width="${r(b.w)}" height="${r(b.h)}" rx="7" fill="#ffffff" fill-opacity="0.96" stroke="#e2e8f0" stroke-width="1"/>${drawText(e.label, e.labelAt[0], b.y + 3, "middle", sink, "#334155")}`;
}

export type RenderOpts = { width: number; height: number; view: Box; title: string; minFont: number; badges: Map<SNode, import("./text.js").TextBlock> };

export function renderScene(s: Scene, sink: GlyphSink, o: RenderOpts): string {
  const body: string[] = [];
  for (const g of s.groups) {
    const st = GROUP_STYLE[g.style];
    body.push(`<rect x="${r(g.x)}" y="${r(g.y)}" width="${r(g.w)}" height="${r(g.h)}" rx="16" fill="${st.fill}" stroke="${st.stroke}" stroke-width="1.5" stroke-dasharray="7 5"/>`);
    if (g.title) body.push(g.titleAt === "end" ? drawText(g.title, g.x + g.w - 14, g.y + 8, "end", sink, st.ink) : drawText(g.title, g.x + 14, g.y + 8, "start", sink, st.ink));
    if (g.repeat) body.push(drawText(g.repeat, g.x + g.w + 12, g.y + g.h / 2 - g.repeat.height / 2, "start", sink, "#1d4ed8"));
  }
  for (const d of s.decos) body.push(d.svg);
  for (const e of s.edges) body.push(drawEdge(e));
  for (const n of s.nodes) body.push(drawNode(n, sink));
  for (const n of s.nodes) body.push(drawBadges(n, sink, o.badges));
  for (const e of s.edges) body.push(drawEdgeLabel(e, sink));
  for (const t of s.texts) {
    if (t.bg) {
      const x = t.align === "middle" ? t.x - t.block.width / 2 : t.align === "end" ? t.x - t.block.width : t.x;
      body.push(`<rect x="${r(x - 8)}" y="${r(t.y - 3)}" width="${r(t.block.width + 16)}" height="${r(t.block.height + 6)}" rx="7" fill="#ffffff" fill-opacity="0.96"/>`);
    }
    body.push(drawText(t.block, t.x, t.y, t.align, sink, t.color));
  }
  const colors = new Set<string>([...s.edges.map((e) => e.color ?? EDGE_COLOR[e.kind])]);
  const markers = [...colors].map((c) => `<marker id="${markerId(c)}" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="13" markerHeight="13" markerUnits="userSpaceOnUse" orient="auto"><path d="M1 1.2 11 6 1 10.8 3.8 6z" fill="${c}"/></marker><marker id="${markerId(c)}s" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="13" markerHeight="13" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M1 1.2 11 6 1 10.8 3.8 6z" fill="${c}"/></marker>`);
  const grads = Object.entries(KIND_STYLE).map(([k, v]) => `<linearGradient id="gk-${k}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${v.fill1}"/><stop offset="1" stop-color="${v.fill2}"/></linearGradient>`);
  const filters = `<filter id="sh" x="-10%" y="-15%" width="120%" height="140%"><feDropShadow dx="0" dy="2" stdDeviation="2.4" flood-color="#0f172a" flood-opacity="0.13"/></filter><filter id="glow" x="-15%" y="-25%" width="130%" height="160%"><feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="#f59e0b" flood-opacity="0.38"/></filter>`;
  const v = o.view;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${r(v.x)} ${r(v.y)} ${r(v.w)} ${r(v.h)}" width="${Math.round(o.width)}" height="${Math.round(o.height)}" role="img" aria-label="${escXml(o.title)}" data-hub-diagram="1" data-min-font="${o.minFont.toFixed(1)}"><title>${escXml(o.title)}</title><defs>${grads.join("")}${filters}${markers.join("")}${sink.defsXml()}</defs>${body.join("")}</svg>\n`;
}
