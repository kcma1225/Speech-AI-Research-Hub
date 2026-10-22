/**
 * Hand-written layouts per diagram type (pipeline, architecture stack, encoder–decoder, comparison panels, cycle,
 * timeline, tree) plus a layered layout (dagre, MIT) for free graphs. All sizes derive from measured text.
 */
import dagre from "@dagrejs/dagre";
import type { DEdge, DiagramSpec, DLayer, DNode, DTree } from "./spec.js";
import { fitText } from "./text.js";
import { cx, cy, edgeLabel, emptyScene, labelBox, measureNode, mergeScene, resize, shiftScene, type Box, type Pt, type Scale, type Scene, type SEdge, type SGroup, type SNode } from "./scene.js";

/** Fit box (deck px); `rows` forces the number of pipeline rows (snake). */
export type Fit = { w: number; h: number; rows?: number };
type Ctx = { spec: DiagramSpec; sc: Scale; fit: Fit };

const node = (ctx: Ctx, id: string): DNode => ctx.spec.nodes.get(id)!;
const edgeBase = (e: DEdge): Omit<SEdge, "pts"> => ({ kind: e.kind, style: e.style, arrowEnd: true, arrowStart: !!e.both });

// ---------------------------------------------------------------- pipeline (left → right, snake when too wide)

export function pipeline(ctx: Ctx, stages: string[][], edgesIn: DEdge[] | null, groupsIn = ctx.spec.groups): Scene {
  const { sc, fit } = ctx;
  const n = stages.length;
  const gap0 = 64 * sc.gap;
  const anyIcon = stages.flat().some((id) => node(ctx, id).icon);
  const perRow0 = Math.ceil(n / (fit.rows ?? 1));
  const maxNodeW = Math.max(150, Math.min(fit.rows ? 300 : 260, (fit.w - (perRow0 - 1) * gap0) / Math.max(1, perRow0)));
  // Edges: explicit, or consecutive stages chained (equal-size parallel stages pair up).
  const edges: DEdge[] = edgesIn ?? autoChain(stages);
  const colOf = new Map<string, number>();
  stages.forEach((st, i) => st.forEach((id) => colOf.set(id, i)));
  // Measure.
  let cols: SNode[][] = stages.map((st) => st.map((id) => measureNode(node(ctx, id), sc, maxNodeW, { iconPos: "top" })));
  const colW = cols.map((c) => Math.max(...c.map((x) => x.w)));
  cols = cols.map((c, i) => c.map((x) => resize(x, sc, colW[i]!)));
  const singleH = Math.max(0, ...cols.filter((c) => c.length === 1).map((c) => c[0]!.h));
  cols = cols.map((c) => {
    const h = c.length === 1 ? Math.max(singleH, c[0]!.h) : Math.max(...c.map((x) => x.h));
    return c.map((x) => ({ ...x, h: anyIcon || c.length > 1 ? h : Math.max(h, singleH) }));
  });
  // Gaps between columns: edge labels and group frames need room.
  const gaps = new Array(Math.max(0, n - 1)).fill(gap0) as number[];
  const labels = new Map<DEdge, ReturnType<typeof edgeLabel>>();
  for (const e of edges) {
    const a = colOf.get(e.from);
    const b = colOf.get(e.to);
    const lab = edgeLabel(e, sc, 150);
    labels.set(e, lab);
    if (lab && a !== undefined && b === a + 1) gaps[a] = Math.max(gaps[a]!, lab.width + 40);
  }
  const groupCols = groupsIn.map((g) => {
    const cs = g.nodes.map((id) => colOf.get(id)).filter((x): x is number => x !== undefined);
    return { g, a: Math.min(...cs), b: Math.max(...cs) };
  }).filter((x) => Number.isFinite(x.a));
  for (const { a, b } of groupCols) {
    if (a > 0) gaps[a - 1]! += 22;
    if (b < n - 1) gaps[b]! += 22;
  }
  // Rows (snake) when one row is wider than the fit box.
  const total = colW.reduce((s, w) => s + w, 0) + gaps.reduce((s, g) => s + g, 0);
  const rowsN = fit.rows ? Math.min(fit.rows, n) : n >= 4 && total > fit.w * 1.02 ? Math.min(3, Math.ceil(total / fit.w)) : 1;
  const perRow = Math.ceil(n / rowsN);
  const rowOf = (i: number) => Math.floor(i / perRow);
  const vgap = 26 * sc.gap;
  const colH = cols.map((c) => c.reduce((s, x) => s + x.h, 0) + (c.length - 1) * vgap);
  const hasTitles = groupCols.some((x) => x.g.label);
  const rowGap = 76 * sc.gap + (hasTitles ? 30 : 0);
  // x of each column centre; rows alternate direction.
  const cxs: number[] = new Array(n).fill(0);
  let cursor = 0;
  let dir = 1;
  for (let i = 0; i < n; i++) {
    if (i > 0 && rowOf(i) !== rowOf(i - 1)) {
      dir = -dir;
      // The first column of the new row sits under the last column of the previous one.
      cxs[i] = cxs[i - 1]!;
      cursor = cxs[i]! + (dir * colW[i]!) / 2;
      continue;
    }
    if (i === 0) {
      cxs[0] = colW[0]! / 2;
      cursor = colW[0]!;
      continue;
    }
    const gap = gaps[i - 1]!;
    cxs[i] = cursor + dir * (gap + colW[i]! / 2);
    cursor = cxs[i]! + (dir * colW[i]!) / 2;
  }
  const rowH: number[] = [];
  for (let i = 0; i < n; i++) rowH[rowOf(i)] = Math.max(rowH[rowOf(i)] ?? 0, colH[i]!);
  const rowMid: number[] = [];
  let y = 0;
  for (let k = 0; k < rowsN; k++) {
    rowMid[k] = y + (rowH[k] ?? 0) / 2;
    y += (rowH[k] ?? 0) + rowGap;
  }
  const scene = emptyScene();
  const pos = new Map<string, SNode>();
  cols.forEach((c, i) => {
    let top = rowMid[rowOf(i)]! - colH[i]! / 2;
    for (const x of c) {
      const p = { ...x, x: cxs[i]! - x.w / 2, y: top };
      top += x.h + vgap;
      pos.set(p.id, p);
      scene.nodes.push(p);
    }
  });
  const dirOfRow = (k: number) => (k % 2 === 0 ? 1 : -1);
  // Arc lanes above / below a row for skip & feedback edges.
  const laneUp = new Map<number, number>();
  const laneDown = new Map<number, number>();
  for (const e of edges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) continue;
    const ia = colOf.get(e.from)!;
    const ib = colOf.get(e.to)!;
    const lab = labels.get(e);
    const base = edgeBase(e);
    const ra = rowOf(ia);
    const rb = rowOf(ib);
    if (ia === ib) {
      const [top, bot] = a.y < b.y ? [a, b] : [b, a];
      scene.edges.push({ ...base, pts: [[cx(top), top.y + top.h], [cx(bot), bot.y]], ...(a !== top ? { arrowEnd: !!e.both, arrowStart: true } : {}), ...(lab ? { label: lab, labelAt: [cx(top) + lab.width / 2 + 14, (top.y + top.h + bot.y) / 2] as Pt } : {}) });
      continue;
    }
    if (ra !== rb && Math.abs(ib - ia) === 1) {
      // Row turn: straight down from the end of one row into the start of the next.
      const [up, down] = a.y < b.y ? [a, b] : [b, a];
      const x = (cx(a) + cx(b)) / 2;
      scene.edges.push({ ...base, pts: up === a ? [[x, a.y + a.h], [x, b.y]] : [[x, a.y], [x, b.y + b.h]], ...(lab ? { label: lab, labelAt: [x + lab.width / 2 + 14, (up.y + up.h + down.y) / 2] as Pt } : {}) });
      continue;
    }
    const d = dirOfRow(ra);
    if (ra === rb && ib === ia + 1) {
      const sx = d > 0 ? a.x + a.w : a.x;
      const tx = d > 0 ? b.x : b.x + b.w;
      const mid = (sx + tx) / 2;
      const pts: Pt[] = Math.abs(cy(a) - cy(b)) < 1 ? [[sx, cy(a)], [tx, cy(b)]] : [[sx, cy(a)], [mid, cy(a)], [mid, cy(b)], [tx, cy(b)]];
      const labelAt: Pt | undefined = lab ? (Math.abs(cy(a) - cy(b)) < 1 ? [mid, cy(a) - lab.height / 2 - 9] : [mid, (cy(a) + cy(b)) / 2]) : undefined;
      scene.edges.push({ ...base, pts, ...(lab ? { label: lab, labelAt } : {}) });
      continue;
    }
    // Skip (forward) above the row, feedback (backward) below; across rows: an elbow through the row gap.
    const forward = ib > ia;
    if (ra === rb) {
      const rowNodes = scene.nodes.filter((x) => rowOf(colOf.get(x.id)!) === ra);
      const between = rowNodes.filter((x) => {
        const c = colOf.get(x.id)!;
        return c >= Math.min(ia, ib) && c <= Math.max(ia, ib);
      });
      if (forward) {
        const k = laneUp.get(ra) ?? 0;
        laneUp.set(ra, k + 1);
        const top = Math.min(...between.map((x) => x.y)) - 30 - k * 24;
        // A node stacked above the source / target: leave / enter from the side instead of through it.
        const blockedA = scene.nodes.some((x) => x !== a && colOf.get(x.id) === ia && x.y < a.y);
        const blockedB = scene.nodes.some((x) => x !== b && colOf.get(x.id) === ib && x.y < b.y);
        const sx = d > 0 ? a.x + a.w : a.x;
        const tx = d > 0 ? b.x : b.x + b.w;
        const start: Pt[] = blockedA ? [[sx, cy(a)], [sx + 16 * d, cy(a)], [sx + 16 * d, top]] : [[cx(a) + 8 * d, a.y], [cx(a) + 8 * d, top]];
        const end: Pt[] = blockedB ? [[tx - 16 * d, top], [tx - 16 * d, cy(b)], [tx, cy(b)]] : [[cx(b) - 8 * d, top], [cx(b) - 8 * d, b.y]];
        const pts: Pt[] = [...start, ...end];
        scene.edges.push({ ...base, pts, ...(lab ? { label: lab, labelAt: [(cx(a) + cx(b)) / 2, top] as Pt } : {}) });
      } else {
        const k = laneDown.get(ra) ?? 0;
        laneDown.set(ra, k + 1);
        const bot = Math.max(...between.map((x) => x.y + x.h)) + 30 + k * 24;
        const pts: Pt[] = [[cx(a) - 8 * d, a.y + a.h], [cx(a) - 8 * d, bot], [cx(b) + 8 * d, bot], [cx(b) + 8 * d, b.y + b.h]];
        scene.edges.push({ ...base, pts, ...(lab ? { label: lab, labelAt: [(cx(a) + cx(b)) / 2, bot] as Pt } : {}) });
      }
      continue;
    }
    const [up, down] = a.y < b.y ? [a, b] : [b, a];
    const midY = (up.y + up.h + down.y) / 2;
    const pts: Pt[] = up === a ? [[cx(a), a.y + a.h], [cx(a), midY], [cx(b), midY], [cx(b), b.y]] : [[cx(a), a.y], [cx(a), midY], [cx(b), midY], [cx(b), b.y + b.h]];
    scene.edges.push({ ...base, pts, ...(lab ? { label: lab, labelAt: [(cx(a) + cx(b)) / 2, midY] as Pt } : {}) });
  }
  addGroups(ctx, scene, groupsIn);
  return scene;
}

/** Does the axis-aligned segment p–q pass through box n (with a small margin)? */
function segHits(p: Pt, q: Pt, n: Box, m = 6): boolean {
  const x0 = Math.min(p[0], q[0]);
  const x1 = Math.max(p[0], q[0]);
  const y0 = Math.min(p[1], q[1]);
  const y1 = Math.max(p[1], q[1]);
  return x1 > n.x - m && x0 < n.x + n.w + m && y1 > n.y - m && y0 < n.y + n.h + m;
}

function autoChain(stages: string[][]): DEdge[] {
  const out: DEdge[] = [];
  for (let i = 0; i + 1 < stages.length; i++) {
    const a = stages[i]!;
    const b = stages[i + 1]!;
    if (a.length === b.length && a.length > 1) a.forEach((x, k) => out.push({ from: x, to: b[k]!, style: "solid", kind: "flow" }));
    else for (const x of a) for (const y of b) out.push({ from: x, to: y, style: "solid", kind: "flow" });
  }
  return out;
}

/** Group frames around their nodes (+ title tab). */
function addGroups(ctx: Ctx, scene: Scene, groups = ctx.spec.groups) {
  const pad = 14;
  for (const g of groups) {
    const ns = scene.nodes.filter((x) => g.nodes.includes(x.id));
    if (!ns.length) continue;
    const title = g.label ? fitText(g.label, { size: ctx.sc.group, weight: 600 }, 420, { maxLines: 1, minSize: 16 }) : undefined;
    const x0 = Math.min(...ns.map((x) => x.x)) - pad;
    const x1 = Math.max(...ns.map((x) => x.x + x.w + (x.node.repeat ? 12 : 0))) + pad;
    const y0 = Math.min(...ns.map((x) => x.y - (x.node.repeat ? 12 : 0) - (x.node.frozen || x.node.trainable ? 8 : 0))) - pad - (title ? title.height + 8 : 0);
    const y1 = Math.max(...ns.map((x) => x.y + x.h)) + pad;
    const w = Math.max(x1 - x0, (title?.width ?? 0) + 28);
    scene.groups.push({ x: x0 - (w - (x1 - x0)) / 2, y: y0, w, h: y1 - y0, ...(title ? { title } : {}), style: g.style });
  }
}

// ---------------------------------------------------------------- architecture stack (bottom → top)

type Placed = { first: SNode[]; last: SNode[]; all: SNode[] };

export function architecture(ctx: Ctx, layers: DLayer[], opts: { flow?: "up" | "down"; side?: boolean; edges?: DEdge[]; maxW?: number } = {}): Scene {
  const { sc, spec } = ctx;
  const flow = opts.flow ?? spec.flow;
  const inLayers = new Set<string>();
  const walk = (ls: DLayer[]) => ls.forEach((l) => ("node" in l ? inLayers.add(l.node) : "row" in l ? l.row.forEach((x) => inLayers.add(x)) : walk(l.layers)));
  walk(layers);
  const explicit = opts.edges ?? spec.edges;
  const sideIds = opts.side === false ? [] : [...spec.nodes.keys()].filter((id) => !inLayers.has(id) && explicit.some((e) => e.from === id || e.to === id));
  const sideMax = sideIds.length ? Math.min(250, ctx.fit.w * 0.26) : 0;
  const maxW = opts.maxW ?? Math.min(520, Math.max(260, ctx.fit.w - (sideIds.length ? sideMax + 140 : 0) - 120));
  const PADR = 16;
  const stretch = (n: DNode) => n.kind !== "input" && n.kind !== "output";
  // Natural width.
  const natural = (ls: DLayer[], inner: number): number =>
    Math.max(
      0,
      ...ls.map((l) => {
        if ("node" in l) return measureNode(node(ctx, l.node), sc, inner, { iconPos: "left" }).w;
        if ("row" in l) return l.row.reduce((s, id) => s + measureNode(node(ctx, id), sc, Math.max(150, (inner - 16 * (l.row.length - 1)) / l.row.length), { iconPos: "top" }).w, 0) + 16 * (l.row.length - 1);
        return natural(l.layers, inner - 2 * PADR) + 2 * PADR;
      }),
    );
  const W = Math.min(maxW, Math.max(240, natural(layers, maxW)));
  const vgap = 30 * sc.gap;
  const scene = emptyScene();
  // Lay out top → bottom in drawing order (flow up = reversed list).
  const order = (ls: DLayer[]) => (flow === "up" ? [...ls].reverse() : ls);
  let y = 0;
  const pos = new Map<string, SNode>();
  const placeList = (ls: DLayer[], x0: number, width: number): Placed => {
    const placed: Placed[] = [];
    for (const l of order(ls)) {
      placed.push(placeLayer(l, x0, width));
      y += vgap;
    }
    y -= vgap;
    // Auto edges between consecutive layers (drawing order top→bottom; arrows point along the flow).
    for (let i = 0; i + 1 < placed.length; i++) {
      const upper = placed[i]!;
      const lower = placed[i + 1]!;
      const [from, to] = flow === "up" ? [lower.first, upper.last] : [upper.last, lower.first];
      connectVertical(from, to, flow);
    }
    return { first: placed[0]?.first ?? [], last: placed.at(-1)?.last ?? [], all: placed.flatMap((p) => p.all) };
  };
  const placeLayer = (l: DLayer, x0: number, width: number): Placed => {
    if ("node" in l) {
      const d = node(ctx, l.node);
      let m = measureNode(d, sc, width, { iconPos: "left" });
      if (stretch(d)) m = resize(m, sc, width);
      const p = { ...m, x: x0 + (width - m.w) / 2, y };
      y += p.h;
      pos.set(p.id, p);
      scene.nodes.push(p);
      return { first: [p], last: [p], all: [p] };
    }
    if ("row" in l) {
      const k = l.row.length;
      const each = (width - 16 * (k - 1)) / k;
      const ms = l.row.map((id) => resize(measureNode(node(ctx, id), sc, each, { iconPos: "top" }), sc, each));
      const h = Math.max(...ms.map((m) => m.h));
      const tot = ms.reduce((s, m) => s + m.w, 0) + 16 * (k - 1);
      let x = x0 + (width - tot) / 2;
      const ps = ms.map((m) => {
        const p = { ...m, h, x, y };
        x += m.w + 16;
        pos.set(p.id, p);
        scene.nodes.push(p);
        return p;
      });
      y += h;
      return { first: ps, last: ps, all: ps };
    }
    // Repeated block: frame; "× N" (and a long title) on the left, like the classic Transformer figure.
    const title0 = l.label ? fitText(l.label, { size: sc.group, weight: 600 }, width - 28, { maxLines: 1, minSize: 16 }) : undefined;
    const inside = !!title0 && title0.width <= width / 2 - 34;
    const top = y;
    y += (inside ? title0!.height + 12 : 0) + PADR;
    const inner = placeList(l.layers, x0 + PADR, width - 2 * PADR);
    y += PADR;
    scene.groups.push({ x: x0, y: top, w: width, h: y - top, ...(inside ? { title: title0! } : {}), style: "default" });
    const rep = l.repeat ? fitText(`${l.repeat}×`, { size: sc.label + 4, weight: 700 }, 120, { maxLines: 1 }) : undefined;
    const side = !inside && l.label ? fitText(l.label, { size: sc.group, weight: 600 }, 150, { maxLines: 3, minSize: 16 }) : undefined;
    const stackH = (rep?.height ?? 0) + (side ? 4 + side.height : 0);
    let ty = top + (y - top) / 2 - stackH / 2;
    if (rep) {
      scene.texts.push({ block: rep, x: x0 - 14, y: ty, align: "end", color: "#1d4ed8" });
      ty += rep.height + 4;
    }
    if (side) scene.texts.push({ block: side, x: x0 - 14, y: ty, align: "end", color: "#1e40af" });
    return inner;
  };
  const connectVertical = (from: SNode[], to: SNode[], f: "up" | "down") => {
    for (const a of from)
      for (const b of to) {
        if (from.length > 1 && to.length > 1 && from.length === to.length && from.indexOf(a) !== to.indexOf(b)) continue;
        const ax = from.length === 1 && to.length > 1 ? cx(b) : cx(a);
        const bx = to.length === 1 && from.length > 1 ? cx(a) : cx(b);
        const x0 = Math.max(a.x + 10, Math.min(a.x + a.w - 10, ax));
        const x1 = Math.max(b.x + 10, Math.min(b.x + b.w - 10, bx));
        const [sy, ty] = f === "up" ? [a.y, b.y + b.h] : [a.y + a.h, b.y];
        const mid = (sy + ty) / 2;
        const pts: Pt[] = Math.abs(x0 - x1) < 1 ? [[x0, sy], [x1, ty]] : [[x0, sy], [x0, mid], [x1, mid], [x1, ty]];
        scene.edges.push({ pts, kind: "flow", style: "solid", arrowEnd: true, arrowStart: false });
      }
  };
  placeList(layers, 0, W);

  // Explicit edges: labels on auto edges, residual lanes on the left, side nodes on the right.
  const stackBox = boundsOf(scene);
  const stackLeft = stackBox.x;
  const stackRight = stackBox.x + stackBox.w;
  const sideSet = new Set(sideIds);
  const sideNodes = new Map(sideIds.map((id) => [id, measureNode(node(ctx, id), sc, sideMax, { iconPos: "top" })]));
  const sideColW = Math.max(0, ...[...sideNodes.values()].map((m) => m.w));
  const sideX = stackRight + Math.max(110, ...explicit.filter((e) => sideSet.has(e.to) !== sideSet.has(e.from)).map((e) => (edgeLabel(e, sc, 140)?.width ?? 0) + 60));
  const anchorY = (id: string) => {
    const ys = explicit.filter((e) => (e.from === id && !sideSet.has(e.to)) || (e.to === id && !sideSet.has(e.from))).map((e) => pos.get(e.from === id ? e.to : e.from)).filter((p): p is SNode => !!p).map(cy);
    return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : null;
  };
  // Anchored side nodes sit level with their stack neighbours; side nodes fed only by side nodes chain on in the flow.
  const sideY = new Map<string, number>();
  for (const id of sideIds) {
    const a = anchorY(id);
    if (a !== null) sideY.set(id, a - sideNodes.get(id)!.h / 2);
  }
  for (let pass = 0; pass < sideIds.length; pass++) {
    for (const id of sideIds) {
      if (sideY.has(id)) continue;
      const nb = explicit.map((e) => (e.from === id ? e.to : e.to === id ? e.from : null)).find((x) => x && sideY.has(x));
      if (!nb) continue;
      const m = sideNodes.get(id)!;
      const pn = sideNodes.get(nb)!;
      sideY.set(id, flow === "up" ? sideY.get(nb)! - 34 - m.h : sideY.get(nb)! + pn.h + 34);
    }
  }
  const sideOrder = sideIds.map((id) => ({ id, y: sideY.get(id) ?? 0 })).sort((a, b) => a.y - b.y);
  let lastBottom = -Infinity;
  for (const { id, y: y0 } of sideOrder) {
    const m = sideNodes.get(id)!;
    const top = Math.max(y0, lastBottom + 22);
    const p = { ...m, x: sideX + (sideColW - m.w) / 2, y: top };
    lastBottom = top + m.h;
    pos.set(p.id, p);
    scene.nodes.push(p);
  }
  let lane = 0;
  let bus = 0;
  const busOf = new Map<string, number>();
  for (const e of explicit) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) continue;
    const lab = edgeLabel(e, sc, 150);
    const base = edgeBase(e);
    const aSide = sideIds.includes(a.id);
    const bSide = sideIds.includes(b.id);
    if (aSide && bSide) {
      const [up, down] = a.y < b.y ? [a, b] : [b, a];
      const x = cx(up);
      scene.edges.push({ ...base, pts: up === a ? [[x, a.y + a.h], [x, b.y]] : [[x, a.y], [x, b.y + b.h]], ...(lab ? { label: lab, labelAt: [x + lab.width / 2 + 14, (up.y + up.h + down.y) / 2] as Pt } : {}) });
      continue;
    }
    if (aSide || bSide) {
      const [s, t] = [a, b];
      const sideNode = bSide ? b : a;
      const key = sideNode.id;
      if (!busOf.has(key)) busOf.set(key, stackRight + 26 + 14 * bus++);
      const bx = Math.min(busOf.get(key)!, sideX - 30);
      const pts: Pt[] = bSide
        ? (Math.abs(cy(s) - cy(t)) < 2 ? [[s.x + s.w, cy(s)], [t.x, cy(t)]] : [[s.x + s.w, cy(s)], [bx, cy(s)], [bx, cy(t)], [t.x, cy(t)]])
        : Math.abs(cy(s) - cy(t)) < 2 ? [[s.x, cy(s)], [t.x + t.w, cy(t)]] : [[s.x, cy(s)], [bx, cy(s)], [bx, cy(t)], [t.x + t.w, cy(t)]];
      scene.edges.push({ ...base, pts, ...(lab ? { label: lab, labelAt: [(bx + sideX) / 2, cy(sideNode) - lab.height / 2 - 9] as Pt } : {}) });
      continue;
    }
    // Same as an auto edge: put the label on it.
    const auto = scene.edges.find((x) => x.kind === "flow" && !x.label && sameEnds(x, a, b, flow));
    if (auto && e.kind === "flow") {
      if (lab) {
        const [p0, p1] = [auto.pts[0]!, auto.pts.at(-1)!];
        auto.label = lab;
        auto.labelAt = [p0[0] + lab.width / 2 + 16, (p0[1] + p1[1]) / 2];
      }
      if (e.style !== "solid") auto.style = e.style;
      continue;
    }
    // Residual / skip / long edges: lanes on the left of the stack.
    const lx = stackLeft - 26 - 18 * lane++;
    const pts: Pt[] = [[a.x, cy(a)], [lx, cy(a)], [lx, cy(b)], [b.x, cy(b)]];
    scene.edges.push({ ...base, kind: e.kind === "flow" ? "skip" : e.kind, pts, ...(lab ? { label: lab, labelAt: [lx, (cy(a) + cy(b)) / 2] as Pt } : {}) });
  }
  addGroups(ctx, scene, spec.groups.filter((g) => g.nodes.some((id) => pos.has(id))));
  return scene;
}

function sameEnds(e: SEdge, a: SNode, b: SNode, flow: "up" | "down") {
  const p0 = e.pts[0]!;
  const p1 = e.pts.at(-1)!;
  const inX = (n: SNode, p: Pt) => p[0] >= n.x - 1 && p[0] <= n.x + n.w + 1;
  const sy = flow === "up" ? a.y : a.y + a.h;
  const ty = flow === "up" ? b.y + b.h : b.y;
  return inX(a, p0) && inX(b, p1) && Math.abs(p0[1] - sy) < 1 && Math.abs(p1[1] - ty) < 1;
}

// ---------------------------------------------------------------- encoder–decoder

export function encoderDecoder(ctx: Ctx): Scene {
  const { spec, sc } = ctx;
  const towers = spec.towers;
  const crossEdges = spec.edges;
  const half = (ctx.fit.w - 160) / 2;
  const subs = towers.map((t) => architecture(ctx, t.layers, { side: false, edges: [], maxW: Math.min(420, half) }));
  const gapLab = Math.max(0, ...crossEdges.map((e) => edgeLabel(e, sc, 150)?.width ?? 0));
  const gap = Math.max(150, gapLab + 70);
  const scene = emptyScene();
  let x = 0;
  const boxes: Box[] = [];
  const bottoms = subs.map((s) => {
    const ys = s.nodes.map((n) => n.y + n.h);
    return Math.max(...ys, ...s.groups.map((g) => g.y + g.h));
  });
  const maxBottom = Math.max(...bottoms);
  subs.forEach((s, i) => {
    const minX = Math.min(...s.nodes.map((n) => n.x), ...s.groups.map((g) => g.x));
    const maxX = Math.max(...s.nodes.map((n) => n.x + n.w), ...s.groups.map((g) => g.x + g.w + (g.repeat ? g.repeat.width + 18 : 0)));
    const moved = shiftScene(s, x - minX, maxBottom - bottoms[i]!);
    mergeScene(scene, moved);
    const minY = Math.min(...moved.nodes.map((n) => n.y), ...moved.groups.map((g) => g.y));
    boxes.push({ x, y: minY, w: maxX - minX, h: maxBottom - minY });
    const title = towers[i]!.title;
    if (title) scene.texts.push({ block: fitText(title, { size: sc.title - 1, weight: 700 }, maxX - minX, { maxLines: 1 }), x: x + (maxX - minX) / 2, y: minY - 40, align: "middle", color: "#1e3a8a" });
    x += maxX - minX + gap;
  });
  // Cross edges (encoder → decoder): from the right side of the source to the left side of the target.
  const encIds = new Set(subs[0]!.nodes.map((n) => n.id));
  const decIds = new Set(subs[1]?.nodes.map((n) => n.id) ?? []);
  let edges = crossEdges;
  if (!edges.length && subs[1]) {
    const encTop = [...subs[0]!.nodes].sort((a, b) => a.y - b.y)[0];
    const dec = [...scene.nodes.filter((n) => decIds.has(n.id))];
    const target = dec.find((n) => /cross|attn|attention|交叉/i.test(n.node.label)) ?? dec.sort((a, b) => a.y - b.y)[Math.floor(dec.length / 2)];
    if (encTop && target) edges = [{ from: encTop.id, to: target.id, kind: "cross", style: "solid" }];
  }
  const pos = new Map(scene.nodes.map((n) => [n.id, n]));
  const encRight = boxes[0] ? boxes[0].x + boxes[0].w : 0;
  const decLeft = boxes[1]?.x ?? encRight + gap;
  edges.forEach((e, i) => {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) return;
    const lab = edgeLabel(e, sc, 150);
    const fwd = encIds.has(a.id) && decIds.has(b.id);
    const bx = (encRight + decLeft) / 2 + (i - (edges.length - 1) / 2) * 14;
    const pts: Pt[] = fwd ? [[a.x + a.w, cy(a)], [bx, cy(a)], [bx, cy(b)], [b.x, cy(b)]] : [[a.x, cy(a)], [bx, cy(a)], [bx, cy(b)], [b.x + b.w, cy(b)]];
    scene.edges.push({ ...edgeBase(e), kind: e.kind === "flow" ? "cross" : e.kind, pts, ...(lab ? { label: lab, labelAt: [bx, (cy(a) + cy(b)) / 2] as Pt } : {}) });
  });
  return scene;
}

// ---------------------------------------------------------------- comparison panels

export function comparison(ctx: Ctx): Scene {
  const { spec, sc } = ctx;
  const panels = spec.panels;
  const k = panels.length;
  const scene = emptyScene();
  const lr = spec.direction === "LR";
  const headerOf = (p: (typeof panels)[number], w: number) => ({
    title: fitText(p.title, { size: sc.label + 1, weight: 700 }, w, { maxLines: 2 }),
    sub: p.sub ? fitText(p.sub, { size: sc.sub }, w, { maxLines: 2, minSize: 16 }) : undefined,
  });
  const PAD = 20;
  if (!lr) {
    const pw = (ctx.fit.w - (k - 1) * 40) / k;
    const subs = panels.map((p) => architecture({ ...ctx, fit: { w: pw - 2 * PAD, h: ctx.fit.h } }, p.stages.map((st) => (st.length === 1 ? { node: st[0]! } : { row: st })), { flow: "down", side: false, edges: [], maxW: Math.min(320, pw - 2 * PAD) }));
    const widths = subs.map((s) => {
      const b = boundsOf(s);
      return b.w;
    });
    const innerW = Math.max(...widths, ...panels.map((p) => headerOf(p, pw - 2 * PAD).title.width));
    const heads = panels.map((p) => headerOf(p, innerW));
    const headH = Math.max(...heads.map((h) => h.title.height + (h.sub ? 4 + h.sub.height : 0)));
    const bodyH = Math.max(...subs.map((s) => boundsOf(s).h));
    const cardW = innerW + 2 * PAD;
    const cardH = PAD + headH + 16 + bodyH + PAD;
    panels.forEach((p, i) => {
      const x0 = i * (cardW + 40);
      const hl = !!p.highlight;
      scene.decos.push({ svg: card(x0, 0, cardW, cardH, headH + PAD + 8, hl), box: { x: x0, y: 0, w: cardW, h: cardH } });
      scene.texts.push({ block: heads[i]!.title, x: x0 + cardW / 2, y: PAD - 2, align: "middle", color: hl ? "#9a4a00" : "#0f172a" });
      if (heads[i]!.sub) scene.texts.push({ block: heads[i]!.sub!, x: x0 + cardW / 2, y: PAD - 2 + heads[i]!.title.height + 4, align: "middle", color: "#475569" });
      const b = boundsOf(subs[i]!);
      mergeScene(scene, shiftScene(subs[i]!, x0 + (cardW - b.w) / 2 - b.x, PAD + headH + 16 + (bodyH - b.h) / 2 - b.y));
    });
    if (k === 2) scene.texts.push({ block: fitText("vs.", { size: sc.label, weight: 700, italic: true }, 60, { maxLines: 1 }), x: cardW + 20, y: cardH / 2 - 14, align: "middle", color: "#64748b" });
    return scene;
  }
  // LR: one row per approach (header on the left, pipeline on the right).
  const headW = Math.min(220, ctx.fit.w * 0.2);
  const heads = panels.map((p) => headerOf(p, headW));
  const subs = panels.map((p) => pipeline({ ...ctx, fit: { w: ctx.fit.w - headW - 3 * PAD, h: ctx.fit.h } }, p.stages, p.edges ?? null, []));
  const bodyW = Math.max(...subs.map((s) => boundsOf(s).w));
  const realHeadW = Math.max(...heads.map((h) => Math.max(h.title.width, h.sub?.width ?? 0)));
  const cardW = PAD + realHeadW + 2 * PAD + bodyW + PAD;
  let y = 0;
  panels.forEach((p, i) => {
    const b = boundsOf(subs[i]!);
    const hh = heads[i]!.title.height + (heads[i]!.sub ? 4 + heads[i]!.sub!.height : 0);
    const h = Math.max(b.h, hh) + 2 * PAD;
    const hl = !!p.highlight;
    scene.decos.push({ svg: cardLR(0, y, cardW, h, PAD + realHeadW + PAD, hl), box: { x: 0, y, w: cardW, h } });
    scene.texts.push({ block: heads[i]!.title, x: PAD + realHeadW / 2, y: y + (h - hh) / 2, align: "middle", color: hl ? "#9a4a00" : "#0f172a" });
    if (heads[i]!.sub) scene.texts.push({ block: heads[i]!.sub!, x: PAD + realHeadW / 2, y: y + (h - hh) / 2 + heads[i]!.title.height + 4, align: "middle", color: "#475569" });
    mergeScene(scene, shiftScene(subs[i]!, PAD + realHeadW + 2 * PAD - b.x, y + (h - b.h) / 2 - b.y));
    y += h + 22;
  });
  return scene;
}

function card(x: number, y: number, w: number, h: number, headH: number, hl: boolean): string {
  const stroke = hl ? "#e58a00" : "#cbd5e1";
  const head = hl ? "#fff3dc" : "#f1f5f9";
  return `<g filter="url(#sh)"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" fill="#ffffff" stroke="${stroke}" stroke-width="${hl ? 2.6 : 1.5}"/></g><path d="M${x + 1} ${y + headH} V${y + 16} Q${x + 1} ${y + 1} ${x + 16} ${y + 1} H${x + w - 16} Q${x + w - 1} ${y + 1} ${x + w - 1} ${y + 16} V${y + headH} Z" fill="${head}"/><line x1="${x}" y1="${y + headH}" x2="${x + w}" y2="${y + headH}" stroke="${stroke}" stroke-width="1.2"/>`;
}
function cardLR(x: number, y: number, w: number, h: number, headW: number, hl: boolean): string {
  const stroke = hl ? "#e58a00" : "#cbd5e1";
  const head = hl ? "#fff3dc" : "#f1f5f9";
  return `<g filter="url(#sh)"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" fill="#ffffff" stroke="${stroke}" stroke-width="${hl ? 2.6 : 1.5}"/></g><path d="M${x + headW} ${y + 1} H${x + 16} Q${x + 1} ${y + 1} ${x + 1} ${y + 16} V${y + h - 16} Q${x + 1} ${y + h - 1} ${x + 16} ${y + h - 1} H${x + headW} Z" fill="${head}"/><line x1="${x + headW}" y1="${y}" x2="${x + headW}" y2="${y + h}" stroke="${stroke}" stroke-width="1.2"/>`;
}

export function boundsOf(s: Scene): Box {
  const xs: number[] = [];
  const ys: number[] = [];
  const add = (b: Box) => {
    xs.push(b.x, b.x + b.w);
    ys.push(b.y, b.y + b.h);
  };
  s.nodes.forEach((n) => add({ x: n.x, y: n.y - (n.node.repeat ? 12 : 0) - (n.node.frozen || n.node.trainable ? 9 : 0), w: n.w + (n.node.repeat ? 12 : 0) + (n.node.frozen || n.node.trainable ? 9 : 0), h: n.h + (n.node.repeat ? 12 : 0) + (n.node.frozen || n.node.trainable ? 9 : 0) }));
  s.groups.forEach((g) => add({ ...g, w: g.w + (g.repeat ? g.repeat.width + 18 : 0) }));
  s.edges.forEach((e) => {
    e.pts.forEach(([x, y]) => add({ x, y, w: 0, h: 0 }));
    if (e.label && e.labelAt) add(labelBox(e.label, e.labelAt));
  });
  s.decos.forEach((d) => add(d.box));
  s.texts.forEach((t) => add({ x: t.align === "middle" ? t.x - t.block.width / 2 : t.x, y: t.y, w: t.block.width, h: t.block.height }));
  if (!xs.length) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

// ---------------------------------------------------------------- cycle

export function cycle(ctx: Ctx, ids: string[]): Scene {
  const { sc } = ctx;
  const n = ids.length;
  const ms = ids.map((id) => measureNode(node(ctx, id), sc, Math.min(230, ctx.fit.w / 3.2), { iconPos: "top" }));
  const maxW = Math.max(...ms.map((m) => m.w));
  const maxH = Math.max(...ms.map((m) => m.h));
  const ratio = 0.62;
  const angle = (i: number) => -Math.PI / 2 + (2 * Math.PI * i) / n;
  let rx = 120;
  const placeAt = (rxv: number) => ms.map((m, i) => ({ ...m, x: Math.cos(angle(i)) * rxv - m.w / 2, y: Math.sin(angle(i)) * rxv * ratio - m.h / 2 }));
  for (; rx < 900; rx += 8) {
    const ps = placeAt(rx);
    let ok = true;
    for (let i = 0; i < n && ok; i++)
      for (let j = i + 1; j < n && ok; j++) {
        const a = ps[i]!;
        const b = ps[j]!;
        const sepX = Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w);
        const sepY = Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h);
        if (Math.max(sepX, sepY) < 46) ok = false;
      }
    // The centre label needs room as well.
    if (ok && ctx.spec.center && rx * ratio < maxH / 2 + 60) ok = false;
    if (ok) break;
  }
  const scene = emptyScene();
  const ps = placeAt(rx);
  scene.nodes.push(...ps);
  const ry = rx * ratio;
  const inside = (b: SNode, x: number, y: number) => x >= b.x - 8 && x <= b.x + b.w + 8 && y >= b.y - 8 && y <= b.y + b.h + 8;
  for (let i = 0; i < n; i++) {
    const a = ps[i]!;
    const b = ps[(i + 1) % n]!;
    const t0 = angle(i);
    const t1 = angle(i + 1);
    const pts: Pt[] = [];
    for (let s = 0; s <= 60; s++) {
      const t = t0 + ((t1 - t0) * s) / 60;
      const x = Math.cos(t) * rx;
      const y = Math.sin(t) * ry;
      if (!inside(a, x, y) && !inside(b, x, y)) pts.push([x, y]);
    }
    if (pts.length < 2) continue;
    const thin = pts.filter((_, k) => k % 4 === 0 || k === pts.length - 1);
    const e = ctx.spec.edges.find((x) => x.from === a.id && x.to === b.id);
    const lab = e ? edgeLabel(e, sc, 140) : undefined;
    const mid = pts[Math.floor(pts.length / 2)]!;
    const out: Pt = [mid[0] * 1.0, mid[1]];
    scene.edges.push({ kind: "flow", style: e?.style ?? "solid", arrowEnd: true, arrowStart: false, pts: thin, smooth: true, color: "#3b5b8f", width: 2.4, ...(lab ? { label: lab, labelAt: out } : {}) });
  }
  if (ctx.spec.center) {
    const block = fitText(ctx.spec.center, { size: sc.label + 1, weight: 700 }, Math.max(140, rx * 0.9), { maxLines: 2 });
    const rr = Math.max(block.width, block.height) / 2 + 22;
    scene.decos.push({ svg: `<circle cx="0" cy="0" r="${rr.toFixed(1)}" fill="url(#gk-model)" stroke="#2f63d6" stroke-width="1.6" stroke-dasharray="4 4"/>`, box: { x: -rr, y: -rr, w: 2 * rr, h: 2 * rr } });
    scene.texts.push({ block, x: 0, y: -block.height / 2, align: "middle", color: "#0b1f4d" });
  }
  void maxW;
  return scene;
}

// ---------------------------------------------------------------- timeline

export function timeline(ctx: Ctx): Scene {
  const { spec, sc } = ctx;
  const ev = spec.events;
  const n = ev.length;
  const alternate = n > 4;
  const slot = Math.max(150, Math.min(260, ctx.fit.w / n));
  const cardMax = alternate ? Math.min(260, slot * 1.75) : slot - 24;
  const scene = emptyScene();
  const cards = ev.map((e) => measureNode({ ...node(ctx, e.id), sub: e.sub }, sc, cardMax));
  const dates = ev.map((e) => (e.date ? fitText(e.date, { size: sc.label, weight: 700 }, slot - 10, { maxLines: 1 }) : undefined));
  const maxCardH = Math.max(...cards.map((c) => c.h));
  const axisY = maxCardH + 70;
  const x0 = slot / 2;
  const axisEnd = x0 + slot * (n - 1);
  scene.decos.push({ svg: `<line x1="${x0 - 40}" y1="${axisY}" x2="${axisEnd + 50}" y2="${axisY}" stroke="#94a3b8" stroke-width="3" stroke-linecap="round" marker-end="url(#ah94a3b8)"/>`, box: { x: x0 - 40, y: axisY - 7, w: axisEnd - x0 + 100, h: 14 } });
  scene.edges.push({ pts: [[axisEnd + 40, axisY], [axisEnd + 52, axisY]], kind: "flow", style: "solid", arrowEnd: true, arrowStart: false, color: "#94a3b8", width: 0.01 });
  ev.forEach((e, i) => {
    const x = x0 + slot * i;
    const up = !alternate || i % 2 === 0;
    const c = cards[i]!;
    const hl = e.kind === "highlight";
    const y = up ? axisY - 40 - c.h : axisY + 40;
    scene.nodes.push({ ...c, x: x - c.w / 2, y });
    scene.decos.push({ svg: `<line x1="${x}" y1="${up ? y + c.h : axisY}" x2="${x}" y2="${up ? axisY : y}" stroke="${hl ? "#e58a00" : "#94a3b8"}" stroke-width="1.8" stroke-dasharray="3 3"/><circle cx="${x}" cy="${axisY}" r="${hl ? 10 : 8}" fill="${hl ? "#f59e0b" : "#2563eb"}" stroke="#fff" stroke-width="3"/>`, box: { x: x - 10, y: Math.min(y, axisY - 10), w: 20, h: Math.abs(axisY - y) + 20 } });
    const d = dates[i];
    if (d) scene.texts.push({ block: d, x, y: up ? axisY + 16 : axisY - 16 - d.height, align: "middle", color: hl ? "#9a4a00" : "#1e3a8a" });
  });
  return scene;
}

// ---------------------------------------------------------------- tree

export function tree(ctx: Ctx): Scene {
  const { spec, sc } = ctx;
  const root = spec.tree!;
  const depthOf = (t: DTree): number => 1 + Math.max(0, ...t.children.map(depthOf));
  const leaves = (t: DTree): number => (t.children.length ? t.children.reduce((s, c) => s + leaves(c), 0) : 1);
  const maxW = Math.max(130, Math.min(220, (ctx.fit.w - 24 * (leaves(root) - 1)) / leaves(root)));
  const m = new Map<string, SNode>();
  const measureAll = (t: DTree, w: number) => {
    m.set(t.id, measureNode(node(ctx, t.id), sc, w, { iconPos: "top" }));
    t.children.forEach((c) => measureAll(c, w));
  };
  measureAll(root, maxW);
  const scene = emptyScene();
  const levelH: number[] = [];
  const measureLevels = (t: DTree, d: number) => {
    levelH[d] = Math.max(levelH[d] ?? 0, m.get(t.id)!.h);
    t.children.forEach((c) => measureLevels(c, d + 1));
  };
  measureLevels(root, 0);
  const vgap = 62 * sc.gap;
  const levelY: number[] = [];
  levelH.reduce((y, h, i) => ((levelY[i] = y), y + h + vgap), 0);
  // Tidy: subtree width, children centred under the parent.
  const widthOf = (t: DTree): number => Math.max(m.get(t.id)!.w, t.children.reduce((s, c) => s + widthOf(c), 0) + 26 * Math.max(0, t.children.length - 1));
  const tb = widthOf(root) <= ctx.fit.w * 1.05 || depthOf(root) > 3;
  if (tb) {
    const place = (t: DTree, x0: number, d: number) => {
      const w = widthOf(t);
      const me = m.get(t.id)!;
      const p = { ...me, x: x0 + (w - me.w) / 2, y: levelY[d]!, h: levelH[d]! };
      scene.nodes.push(p);
      let x = x0 + (w - (t.children.reduce((s, c) => s + widthOf(c), 0) + 26 * Math.max(0, t.children.length - 1))) / 2;
      const kids: SNode[] = [];
      for (const c of t.children) {
        kids.push(place(c, x, d + 1));
        x += widthOf(c) + 26;
      }
      const busY = p.y + p.h + vgap / 2;
      if (kids.length === 1 && Math.abs(cx(kids[0]!) - cx(p)) < 1) scene.edges.push({ kind: "flow", style: "solid", arrowEnd: true, arrowStart: false, pts: [[cx(p), p.y + p.h], [cx(p), kids[0]!.y]] });
      else if (kids.length) {
        // Stem, bus, drops (clean T-junctions).
        const xs = [...kids.map(cx), cx(p)];
        scene.edges.push({ kind: "flow", style: "solid", arrowEnd: false, arrowStart: false, pts: [[cx(p), p.y + p.h], [cx(p), busY]] });
        scene.edges.push({ kind: "flow", style: "solid", arrowEnd: false, arrowStart: false, pts: [[Math.min(...xs), busY], [Math.max(...xs), busY]] });
        for (const k of kids) scene.edges.push({ kind: "flow", style: "solid", arrowEnd: true, arrowStart: false, pts: [[cx(k), busY], [cx(k), k.y]] });
      }
      return p;
    };
    place(root, 0, 0);
  } else {
    // Left → right (wide trees): depth columns, leaves stacked.
    const colW: number[] = [];
    const walkW = (t: DTree, d: number) => {
      colW[d] = Math.max(colW[d] ?? 0, m.get(t.id)!.w);
      t.children.forEach((c) => walkW(c, d + 1));
    };
    walkW(root, 0);
    const colX: number[] = [];
    colW.reduce((x, w, i) => ((colX[i] = x), x + w + 70 * sc.gap), 0);
    const heightOf = (t: DTree): number => Math.max(m.get(t.id)!.h, t.children.reduce((s, c) => s + heightOf(c), 0) + 16 * Math.max(0, t.children.length - 1));
    const place = (t: DTree, y0: number, d: number): SNode => {
      const h = heightOf(t);
      const me = m.get(t.id)!;
      const p = { ...me, x: colX[d]!, y: y0 + (h - me.h) / 2 };
      scene.nodes.push(p);
      let y = y0 + (h - (t.children.reduce((s, c) => s + heightOf(c), 0) + 16 * Math.max(0, t.children.length - 1))) / 2;
      const busX = colX[d]! + colW[d]! + 35 * sc.gap;
      const kids: SNode[] = [];
      for (const c of t.children) {
        kids.push(place(c, y, d + 1));
        y += heightOf(c) + 16;
      }
      if (kids.length) {
        const ys = [...kids.map(cy), cy(p)];
        scene.edges.push({ kind: "flow", style: "solid", arrowEnd: false, arrowStart: false, pts: [[p.x + p.w, cy(p)], [busX, cy(p)]] });
        scene.edges.push({ kind: "flow", style: "solid", arrowEnd: false, arrowStart: false, pts: [[busX, Math.min(...ys)], [busX, Math.max(...ys)]] });
        for (const k of kids) scene.edges.push({ kind: "flow", style: "solid", arrowEnd: true, arrowStart: false, pts: [[busX, cy(k)], [k.x, cy(k)]] });
      }
      return p;
    };
    place(root, 0, 0);
  }
  return scene;
}

// ---------------------------------------------------------------- free graph (dagre)

export function graph(ctx: Ctx): Scene {
  const { spec, sc } = ctx;
  const g = new dagre.graphlib.Graph({ compound: true, multigraph: true });
  const lr = spec.direction === "LR";
  g.setGraph({ rankdir: lr ? "LR" : "TB", nodesep: 36 * sc.gap, ranksep: 74 * sc.gap, edgesep: 18, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  const maxW = Math.min(240, ctx.fit.w / 4);
  const ms = new Map<string, SNode>();
  for (const id of spec.nodes.keys()) {
    const m = measureNode(node(ctx, id), sc, maxW, { iconPos: "top" });
    ms.set(id, m);
    g.setNode(id, { width: m.w, height: m.h });
  }
  spec.groups.forEach((gr, i) => {
    g.setNode(`__g${i}`, { paddingTop: gr.label ? 36 : 14, paddingBottom: 14, paddingLeft: 14, paddingRight: 14 });
    for (const id of gr.nodes) if (ms.has(id)) g.setParent(id, `__g${i}`);
  });
  const edges = spec.edges.length ? spec.edges : autoChain([...spec.nodes.keys()].map((id) => [id]));
  edges.forEach((e, i) => {
    const lab = edgeLabel(e, sc, 150);
    g.setEdge(e.from, e.to, { ...(lab ? { width: lab.width + 16, height: lab.height + 6, labelpos: "c" } : {}), minlen: 1 }, `e${i}`);
  });
  dagre.layout(g);
  const scene = emptyScene();
  for (const [id, m] of ms) {
    const p = g.node(id) as { x: number; y: number } | undefined;
    if (!p) continue;
    scene.nodes.push({ ...m, x: p.x - m.w / 2, y: p.y - m.h / 2 });
  }
  // dagre bends the main chain around skip / feedback edges (a diagonal "staircase"): put it back on one line.
  const straightened = !spec.groups.length && straightenSpine(scene.nodes, edges, lr, 36 * sc.gap);
  const lanes: Lane[] = [];
  const pos = new Map(scene.nodes.map((n) => [n.id, n]));
  type Info = { e: DEdge; i: number; a: SNode; b: SNode; d: { points: { x: number; y: number }[]; x?: number; y?: number }; clear: boolean };
  const infos: Info[] = [];
  edges.forEach((e, i) => {
    const d = g.edge({ v: e.from, w: e.to, name: `e${i}` }) as Info["d"] | undefined;
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!d?.points || !a || !b) return;
    // Forward edges between consecutive layers with nothing in the way: orthogonal connectors.
    const forward = lr ? a.x + a.w < b.x - 8 : a.y + a.h < b.y - 8;
    const clear = forward && !scene.nodes.some((n) => n !== a && n !== b && (lr ? n.x < b.x && n.x + n.w > a.x + a.w : n.y < b.y && n.y + n.h > a.y + a.h) && (lr ? n.y < Math.max(cy(a), cy(b)) + 10 && n.y + n.h > Math.min(cy(a), cy(b)) - 10 : n.x < Math.max(cx(a), cx(b)) + 10 && n.x + n.w > Math.min(cx(a), cx(b)) - 10));
    infos.push({ e, i, a, b, d, clear });
  });
  // Ports: several orthogonal edges on one side of a node are spread along it (ordered by the other end).
  const cross = (n: SNode) => (lr ? cy(n) : cx(n));
  const span = (n: SNode) => (lr ? n.h : n.w);
  const portOut = new Map<Info, number>();
  const portIn = new Map<Info, number>();
  const spread = (key: (x: Info) => SNode, other: (x: Info) => SNode, into: Map<Info, number>) => {
    const by = new Map<SNode, Info[]>();
    for (const x of infos.filter((y) => y.clear)) by.set(key(x), [...(by.get(key(x)) ?? []), x]);
    for (const [n, list] of by) {
      list.sort((p, q) => cross(other(p)) - cross(other(q)));
      const k = list.length;
      const step = Math.min(22, span(n) / (k + 1));
      list.forEach((x, j) => into.set(x, cross(n) + (j - (k - 1) / 2) * step));
    }
  };
  spread((x) => x.a, (x) => x.b, portOut);
  spread((x) => x.b, (x) => x.a, portIn);
  for (const { e, a, b, d, clear } of infos) {
    const info = infos.find((x) => x.e === e)!;
    const lab = edgeLabel(e, sc, 150);
    if (clear) {
      const ps = portOut.get(info) ?? cross(a);
      let pt = portIn.get(info) ?? cross(b);
      // A port a few px off the source line would draw a tiny jog: go straight when that point is still on b's side.
      if (Math.abs(ps - pt) < 12 && Math.abs(ps - cross(b)) < span(b) / 2 - 8) pt = ps;
      const m = lab && d.x !== undefined && d.y !== undefined ? (lr ? d.x : d.y) : lr ? (a.x + a.w + b.x) / 2 : (a.y + a.h + b.y) / 2;
      const straight = Math.abs(ps - pt) < 2;
      const pts: Pt[] = lr
        ? straight ? [[a.x + a.w, ps], [b.x, ps]] : [[a.x + a.w, ps], [m, ps], [m, pt], [b.x, pt]]
        : straight ? [[ps, a.y + a.h], [ps, b.y]] : [[ps, a.y + a.h], [ps, m], [pt, m], [pt, b.y]];
      const labelAt: Pt | undefined = lab ? (lr ? (straight ? [m, ps - lab.height / 2 - 9] : [m, (ps + pt) / 2]) : straight ? [ps + lab.width / 2 + 14, m] : [(ps + pt) / 2, m]) : undefined;
      scene.edges.push({ ...edgeBase(e), pts, ...(lab ? { label: lab, labelAt } : {}) });
      continue;
    }
    // Blocked in the middle: an elbow right after the source or right before the target, when its segments are free.
    if (lr ? a.x + a.w < b.x - 40 : a.y + a.h < b.y - 40) {
      const ps = cross(a);
      const pt = cross(b);
      const others = scene.nodes.filter((n) => n !== a && n !== b);
      let routed = false;
      for (const m of lr ? [a.x + a.w + 26, b.x - 26] : [a.y + a.h + 26, b.y - 26]) {
        const pts: Pt[] = lr ? [[a.x + a.w, ps], [m, ps], [m, pt], [b.x, pt]] : [[ps, a.y + a.h], [ps, m], [pt, m], [pt, b.y]];
        if (pts.slice(1).every((q, k) => !others.some((n) => segHits(pts[k]!, q, n)))) {
          const longest = lr ? (m < (a.x + a.w + b.x) / 2 ? [(m + b.x) / 2, pt] : [(a.x + a.w + m) / 2, ps]) : m < (a.y + a.h + b.y) / 2 ? [pt, (m + b.y) / 2] : [ps, (a.y + a.h + m) / 2];
          const labelAt: Pt | undefined = lab ? (lr ? [longest[0]!, longest[1]! - lab.height / 2 - 9] : [longest[0]! + lab.width / 2 + 14, longest[1]!]) : undefined;
          scene.edges.push({ ...edgeBase(e), pts, ...(lab ? { label: lab, labelAt } : {}) });
          routed = true;
          break;
        }
      }
      if (routed) continue;
    }
    // Straightened layouts: dagre's own route is stale; bridge over (forward) or under (feedback) the nodes in between.
    const bridge = straightened ? bridgeRoute(a, b, scene.nodes, lr, lanes) : null;
    if (bridge) {
      scene.edges.push({ ...edgeBase(e), pts: bridge.pts, ...(lab ? { label: lab, labelAt: bridge.labelAt } : {}) });
      continue;
    }
    const pts = d.points.map((p) => [p.x, p.y] as Pt);
    scene.edges.push({ ...edgeBase(e), pts, smooth: pts.length > 2, ...(lab && d.x !== undefined && d.y !== undefined ? { label: lab, labelAt: [d.x, d.y] as Pt } : {}) });
  }
  spec.groups.forEach((gr, i) => {
    const c = g.node(`__g${i}`) as { x: number; y: number; width: number; height: number } | undefined;
    if (!c || !c.width) return;
    const title = gr.label ? fitText(gr.label, { size: sc.group, weight: 600 }, c.width - 24, { maxLines: 1, minSize: 16 }) : undefined;
    const grp: SGroup = { x: c.x - c.width / 2, y: c.y - c.height / 2, w: c.width, h: c.height, ...(title ? { title } : {}), style: gr.style };
    scene.groups.push(grp);
  });
  return scene;
}

/**
 * Puts the longest forward chain of a dagre layout (its "spine") on one line: every rank (nodes sharing a main-axis
 * centre) is re-stacked around its spine node, keeping dagre's order on each side. Returns false when there is no
 * chain of ≥ 3 nodes or nothing had to move.
 */
export function straightenSpine(nodes: SNode[], edges: DEdge[], lr: boolean, sep: number): boolean {
  const main = (n: SNode) => (lr ? n.x + n.w / 2 : n.y + n.h / 2);
  const cross = (n: SNode) => (lr ? n.y + n.h / 2 : n.x + n.w / 2);
  const span = (n: SNode) => (lr ? n.h : n.w);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const fwd = edges.filter((e) => byId.has(e.from) && byId.has(e.to) && main(byId.get(e.to)!) > main(byId.get(e.from)!) + 1);
  // Longest path (node count) in the forward DAG, ties broken by the edge order of the spec.
  const order = [...nodes].sort((p, q) => main(p) - main(q));
  const best = new Map<string, { len: number; prev: string | null }>();
  for (const n of order) {
    let b = { len: 1, prev: null as string | null };
    for (const e of fwd) if (e.to === n.id) { const f = best.get(e.from); if (f && f.len + 1 > b.len) b = { len: f.len + 1, prev: e.from }; }
    best.set(n.id, b);
  }
  let end: string | null = null;
  for (const [id, b] of best) if (!end || b.len > best.get(end)!.len) end = id;
  const spine: SNode[] = [];
  for (let id = end; id; id = best.get(id)!.prev) spine.unshift(byId.get(id)!);
  if (spine.length < 3) return false;
  const line = spine.map(cross).sort((a, b) => a - b)[Math.floor(spine.length / 2)]!;
  if (spine.every((n) => Math.abs(cross(n) - line) < 2)) return false;
  // Ranks = nodes whose main-axis extents overlap a spine node's.
  const set = (n: SNode, c: number) => { if (lr) n.y = c - n.h / 2; else n.x = c - n.w / 2; };
  const placed = new Set<SNode>();
  for (const s of spine) {
    const lo = lr ? s.x : s.y;
    const hi = lo + (lr ? s.w : s.h);
    const rank = nodes.filter((n) => !placed.has(n) && (n === s || (!spine.includes(n) && (lr ? n.x : n.y) < hi && (lr ? n.x + n.w : n.y + n.h) > lo)));
    rank.sort((p, q) => cross(p) - cross(q));
    const k = rank.indexOf(s);
    set(s, line);
    let edge = line - span(s) / 2;
    for (let i = k - 1; i >= 0; i--) { const n = rank[i]!; set(n, edge - sep - span(n) / 2); edge -= sep + span(n); }
    edge = line + span(s) / 2;
    for (let i = k + 1; i < rank.length; i++) { const n = rank[i]!; set(n, edge + sep + span(n) / 2); edge += sep + span(n); }
    rank.forEach((n) => placed.add(n));
  }
  return true;
}

/** Orthogonal route over (forward) or under (feedback) everything between a and b; null when it would cross a node. */
type Lane = { side: number; lo: number; hi: number; level: number };
function bridgeRoute(a: SNode, b: SNode, nodes: SNode[], lr: boolean, lanes: Lane[]): { pts: Pt[]; labelAt: Pt } | null {
  const forward = lr ? cx(b) > cx(a) : b.y + b.h / 2 > a.y + a.h / 2;
  const between = nodes.filter((n) => n !== a && n !== b && (lr ? n.x + n.w > Math.min(a.x, b.x) && n.x < Math.max(a.x + a.w, b.x + b.w) : n.y + n.h > Math.min(a.y, b.y) && n.y < Math.max(a.y + a.h, b.y + b.h)));
  const others = nodes.filter((n) => n !== a && n !== b);
  // Interleaved bridges on one side would cross: an edge whose span overlaps a bridge already drawn goes to the other side.
  const sa = lr ? cx(a) : a.y + a.h / 2;
  const sb = lr ? cx(b) : b.y + b.h / 2;
  const busy = (side: number) => lanes.some((l) => l.side === side && l.lo < Math.max(sa, sb) && l.hi > Math.min(sa, sb));
  const pref = forward ? -1 : 1;
  for (const side of busy(pref) && !busy(-pref) ? [-pref, pref] : [pref, -pref]) {
    const all = [a, b, ...between];
    let level = lr
      ? side < 0 ? Math.min(...all.map((n) => n.y)) - 28 : Math.max(...all.map((n) => n.y + n.h)) + 28
      : side < 0 ? Math.min(...all.map((n) => n.x)) - 28 : Math.max(...all.map((n) => n.x + n.w)) + 28;
    // Leave a and b from the side facing the bridge, a little off-centre so it does not meet the chain's own arrows.
    const pa = lr ? a.x + a.w * 0.62 : a.y + a.h * 0.62;
    const pb = lr ? b.x + b.w * 0.38 : b.y + b.h * 0.38;
    const ea = lr ? (side < 0 ? a.y : a.y + a.h) : side < 0 ? a.x : a.x + a.w;
    const eb = lr ? (side < 0 ? b.y : b.y + b.h) : side < 0 ? b.x : b.x + b.w;
    // Bridges whose spans overlap get their own lane further out.
    const lo = Math.min(pa, pb) - 6;
    const hi = Math.max(pa, pb) + 6;
    while (lanes.some((l) => l.side === side && Math.abs(l.level - level) < 12 && l.lo < hi && l.hi > lo)) level += side * 20;
    const pts: Pt[] = lr ? [[pa, ea], [pa, level], [pb, level], [pb, eb]] : [[ea, pa], [level, pa], [level, pb], [eb, pb]];
    if (pts.slice(1).every((q, k) => !others.some((n) => segHits(pts[k]!, q, n, 4)))) {
      lanes.push({ side, lo, hi, level });
      const mid = (pa + pb) / 2;
      return { pts, labelAt: lr ? [mid, level + side * 14] : [level + side * 40, mid] };
    }
  }
  return null;
}
