/**
 * Locates a paper figure / table on a PDF page from the page's own layout (pdf.js text positions + drawing operators;
 * no canvas, no vision): find the caption ("Fig. 2:", "Figure 2.", "TABLE II"), take its column (or the full width
 * for a spanning caption), and the band between the caption and the nearest body-text paragraph (above a figure,
 * below a table caption); then tighten to the drawings, images and short labels inside that band. The caption itself
 * and body text are never part of the crop.
 */
export type FigureBox = { top: number; bottom: number; left: number; right: number };
export type LocatedFigure = { box: FigureBox; kind: "figure" | "table"; caption: string };

type Seg = { x0: number; x1: number; y: number; size: number; str: string };
type Rect = { x0: number; y0: number; x1: number; y1: number };

const ROMAN: Record<string, number> = { I: 1, V: 5, X: 10, L: 50 };
const roman = (s: string) => {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const v = ROMAN[s[i]!] ?? 0;
    const next = ROMAN[s[i + 1] ?? ""] ?? 0;
    n += v < next ? -v : v;
  }
  return n;
};

/** "Fig. 2: …", "Figure 3", "Table II", "表 2" → kind + number; null when the caption names none. */
export function figureRefOf(caption: string): { kind: "figure" | "table"; num: number } | null {
  const m = /\b(fig(?:ure)?s?\.?|table|tab\.)\s*([0-9]{1,2}|[IVXL]{1,5})\b/i.exec(caption) ?? /(圖|表)\s*([0-9]{1,2})/.exec(caption);
  if (!m) return null;
  const kind = /^(t|表)/i.test(m[1]!) ? "table" : "figure";
  const num = /^\d+$/.test(m[2]!) ? Number(m[2]) : roman(m[2]!.toUpperCase());
  return num > 0 ? { kind, num } : null;
}

function captionRe(kind: "figure" | "table", num: number): RegExp {
  const n = `(?:${num}|${toRoman(num)})`;
  return kind === "figure" ? new RegExp(`^\\s*(?:fig(?:ure)?\\.?)\\s*${n}\\s*(?:[.:|]|$)`, "i") : new RegExp(`^\\s*(?:table|tab\\.)\\s*${n}\\s*(?:[.:|]|$)`, "i");
}
function toRoman(n: number) {
  const map: [number, string][] = [[50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
  let out = "";
  for (const [v, s] of map) while (n >= v) (out += s), (n -= v);
  return out;
}

const mul = (m: number[], n: number[]) => [m[0]! * n[0]! + m[2]! * n[1]!, m[1]! * n[0]! + m[3]! * n[1]!, m[0]! * n[2]! + m[2]! * n[3]!, m[1]! * n[2]! + m[3]! * n[3]!, m[0]! * n[4]! + m[2]! * n[5]! + m[4]!, m[1]! * n[4]! + m[3]! * n[5]! + m[5]!];
const apply = (m: number[], x: number, y: number): [number, number] => [m[0]! * x + m[2]! * y + m[4]!, m[1]! * x + m[3]! * y + m[5]!];

/** Bounding boxes (PDF user space, y up) of paths and images drawn on the page. */
async function drawingBoxes(page: { getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[] }> }, OPS: Record<string, number>): Promise<Rect[]> {
  const ol = await page.getOperatorList();
  const out: Rect[] = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];
  const add = (pts: [number, number][]) => {
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    out.push({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) });
  };
  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i];
    const args = ol.argsArray[i] as unknown[];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = mul(ctm, (args as number[]).map(Number));
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) add([apply(ctm, 0, 0), apply(ctm, 1, 0), apply(ctm, 0, 1), apply(ctm, 1, 1)]);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      const m = args?.[0];
      if (Array.isArray(m) && m.length === 6) ctm = mul(ctm, m.map(Number));
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.constructPath) {
      const mm = args?.[2] as Record<string, number> | number[] | undefined;
      const v = mm ? [Number((mm as Record<string, number>)[0]), Number((mm as Record<string, number>)[1]), Number((mm as Record<string, number>)[2]), Number((mm as Record<string, number>)[3])] : null;
      if (v && v.every(Number.isFinite) && v[2]! >= v[0]! && v[3]! >= v[1]!) add([apply(ctm, v[0]!, v[1]!), apply(ctm, v[2]!, v[1]!), apply(ctm, v[0]!, v[3]!), apply(ctm, v[2]!, v[3]!)]);
    }
  }
  return out;
}

/** Text segments: runs of items on one baseline without a big horizontal gap. */
function segments(items: { str: string; transform: number[]; width: number; height: number }[]): Seg[] {
  const parts = items
    .filter((t) => t.str.trim())
    .map((t) => ({ x0: t.transform[4]!, x1: t.transform[4]! + t.width, y: t.transform[5]!, size: Math.abs(t.transform[3]!) || t.height || 8, str: t.str }))
    .sort((a, b) => b.y - a.y || a.x0 - b.x0);
  const out: Seg[] = [];
  for (const p of parts) {
    const last = out.at(-1);
    if (last && Math.abs(last.y - p.y) < Math.max(1, 0.35 * Math.min(last.size, p.size)) && p.x0 - last.x1 < Math.max(4, 0.9 * p.size) && p.x0 >= last.x0 - 1) {
      last.x1 = Math.max(last.x1, p.x1);
      last.str += (p.x0 - last.x1 > 0.15 * p.size ? " " : "") + p.str;
      last.size = Math.max(last.size, p.size);
    } else out.push({ ...p });
  }
  return out;
}

export async function locateFigureByLayout(pdf: Buffer, pageNo: number, caption: string, hint?: { top: number; bottom: number }): Promise<LocatedFigure | null> {
  const ref = figureRefOf(caption);
  if (!ref) return null;
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(pdf), disableFontFace: true, useSystemFonts: false, verbosity: 0, stopAtErrors: false });
  try {
    const doc = await task.promise;
    if (pageNo < 1 || pageNo > doc.numPages) return null;
    const page = await doc.getPage(pageNo);
    const [vx0, vy0, vx1, vy1] = page.view as number[];
    const W = vx1! - vx0!;
    const H = vy1! - vy0!;
    const tc = await page.getTextContent();
    const segs = segments(tc.items as unknown as { str: string; transform: number[]; width: number; height: number }[]);
    if (segs.length < 5) return null;
    // Body font: the size covering most text width.
    const bySize = new Map<number, number>();
    for (const s of segs) bySize.set(Math.round(s.size * 2) / 2, (bySize.get(Math.round(s.size * 2) / 2) ?? 0) + (s.x1 - s.x0));
    const bodySize = [...bySize.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    const body = segs.filter((s) => Math.abs(s.size - bodySize) <= 0.8);
    const lm = Math.min(...body.map((s) => s.x0));
    const rm = Math.max(...body.map((s) => s.x1));
    const mid = (lm + rm) / 2;
    const twoCol = body.filter((s) => s.x0 > mid + 4).length > 5 && body.filter((s) => s.x0 < mid - 20 && s.x1 > mid + 20).length < body.length * 0.15;
    // Caption: a segment starting with "Fig. N" / "Table N" (closest to the hint when several match).
    const re = captionRe(ref.kind, ref.num);
    const cands = segs.filter((s) => re.test(s.str));
    if (!cands.length) return null;
    const hintY = hint ? H * (1 - (hint.top + hint.bottom) / 2) : null;
    const cap = cands.sort((a, b) => (hintY === null ? 0 : Math.abs(a.y - hintY) - Math.abs(b.y - hintY)))[0]!;
    // Caption block: the caption line + the lines that continue it (below; same column; tight leading).
    /** A caption line + the lines that continue it (below; overlapping x; tight leading; not body text). */
    const blockOf = (c: Seg): Seg[] => {
      const lines = [c];
      for (;;) {
        const last = lines.at(-1)!;
        const next = segs.filter((s) => s.y < last.y - 0.5 && last.y - s.y < Math.max(last.size, s.size) * 1.65 && s.x0 < Math.max(c.x1, last.x1) && s.x1 > Math.min(c.x0, last.x0) - 2).sort((a, b) => b.y - a.y)[0];
        if (!next || lines.length > 8 || (Math.abs(next.size - bodySize) <= 0.3 && next.size > c.size + 0.3)) break;
        lines.push(next);
      }
      return lines;
    };
    const capLines = blockOf(cap);
    const capX0 = Math.min(...capLines.map((s) => s.x0));
    const capX1 = Math.max(...capLines.map((s) => s.x1));
    const capTop = cap.y + cap.size * 0.85;
    const capBottom = capLines.at(-1)!.y - capLines.at(-1)!.size * 0.3;
    const spans = !twoCol || (capX0 < mid - 25 && capX1 > mid + 25);
    const [ex0, ex1] = spans ? [lm, rm] : (capX0 + capX1) / 2 < mid ? [lm, mid - 4] : [mid + 4, rm];
    const extW = ex1 - ex0;
    const inExt = (s: { x0: number; x1: number }) => s.x1 > ex0 + 2 && s.x0 < ex1 - 2;
    const colW = twoCol ? (rm - lm) / 2 : rm - lm;
    const isBody = (s: Seg) => Math.abs(s.size - bodySize) <= 0.8 && s.x1 - s.x0 >= 0.55 * Math.min(extW, colW) && inExt(s) && !capLines.includes(s);
    const otherCaption = (s: Seg) => s !== cap && /^\s*(fig(?:ure)?\.?|table)\s*([0-9]{1,2}|[IVXL]{1,5})\s*([.:|]|$)/i.test(s.str) && inExt(s);
    let y0: number; // band bottom (PDF y, up)
    let y1: number; // band top
    const heading = (s: Seg) => inExt(s) && s.size >= bodySize - 0.3 && s.x1 - s.x0 < 0.8 * colW && /^\s*(([IVX]{1,4}|[A-H]|\d{1,2}(\.\d{1,2})*)\.?\s+[A-Z]|abstract|references|acknowledg|introduction|conclusion)/i.test(s.str);
    // Other captions stop the band with their whole block (continuation lines included).
    const otherBlocks = segs.filter(otherCaption).flatMap(blockOf).filter((s) => s.x1 > capX0 - 10 && s.x0 < capX1 + 10);
    // Page-level lines (paper title, authors, affiliations) run across the column gap above a single-column float;
    // so do larger title fonts. Neither belongs to the figure.
    const crossesGap = (s: Seg) => twoCol && !spans && s.x1 > ex0 + 2 && s.x0 < ex1 - 2 && (s.x0 < ex0 - 8 || s.x1 > ex1 + 8);
    const titleFont = (s: Seg) => inExt(s) && s.size > bodySize * 1.25 && s.size > cap.size * 1.25;
    if (ref.kind === "figure") {
      y0 = capTop;
      const header = (s: Seg) => s.y > vy0! + H * 0.93;
      let above = segs.filter((s) => s.y > capTop && (isBody(s) || otherBlocks.includes(s) || header(s) || heading(s) || crossesGap(s) || titleFont(s))).sort((a, b) => a.y - b.y)[0];
      // The paragraph's (short) last lines below the first full line belong to it too.
      for (let k = 0; above && k < 6; k++) {
        const a: Seg = above;
        const next = segs.find((s) => s.y < a.y - 0.5 && s.y > capTop && a.y - s.y < a.size * 1.6 && Math.abs(s.size - bodySize) <= 0.8 && Math.abs(s.x0 - a.x0) < 3 && inExt(s));
        if (!next) break;
        above = next;
      }
      y1 = above ? above.y - above.size * 0.35 : vy1! - H * 0.03;
    } else {
      y1 = capBottom;
      const footer = (s: Seg) => s.y < vy0! + H * 0.06;
      const below = segs.filter((s) => s.y < capBottom - 2 && (isBody(s) || otherBlocks.includes(s) || footer(s) || heading(s))).sort((a, b) => b.y - a.y)[0];
      y0 = below ? below.y + below.size * 0.95 : vy0! + H * 0.03;
    }
    if (y1 - y0 < H * 0.04) return null;
    // Tighten to what is drawn / written inside the band (axes, tick labels, images, table rules and cells).
    const inBand = (r: Rect) => r.y1 > y0 + 0.5 && r.y0 < y1 - 0.5 && r.x1 > ex0 - 6 && r.x0 < ex1 + 6;
    const draws = (await drawingBoxes(page as never, pdfjs.OPS as unknown as Record<string, number>).catch(() => [] as Rect[])).filter((r) => inBand(r) && r.x1 - r.x0 < W * 0.98 && r.y1 - r.y0 < H * 0.9);
    const texts = segs.filter((s) => !capLines.includes(s) && !crossesGap(s) && s.y > y0 && s.y + s.size * 0.8 < y1 + 1 && inExt(s)).map((s) => ({ x0: s.x0, y0: s.y - s.size * 0.25, x1: s.x1, y1: s.y + s.size * 0.85 }));
    // Side-by-side floats (e.g. two tables in one band): keep the horizontal cluster under the caption.
    const items = [...draws, ...texts].sort((a, b) => a.x0 - b.x0);
    const clusters: { x0: number; x1: number; items: Rect[] }[] = [];
    for (const it of items) {
      const c = clusters.at(-1);
      if (c && it.x0 <= c.x1 + 12) {
        c.x1 = Math.max(c.x1, it.x1);
        c.items.push(it);
      } else clusters.push({ x0: it.x0, x1: it.x1, items: [it] });
    }
    const capMid = (capX0 + capX1) / 2;
    const under = clusters.find((c) => c.x0 <= capMid && c.x1 >= capMid) ?? clusters.sort((a, b) => Math.abs((a.x0 + a.x1) / 2 - capMid) - Math.abs((b.x0 + b.x1) / 2 - capMid))[0];
    const all = under ? under.items : [];
    let box: Rect = { x0: ex0, y0, x1: ex1, y1 };
    if (all.length) {
      const u = { x0: Math.min(...all.map((r) => r.x0)), y0: Math.min(...all.map((r) => r.y0)), x1: Math.max(...all.map((r) => r.x1)), y1: Math.max(...all.map((r) => r.y1)) };
      const c = { x0: Math.max(ex0 - 6, u.x0), y0: Math.max(y0, u.y0), x1: Math.min(ex1 + 6, u.x1), y1: Math.min(y1, u.y1) };
      if (c.y1 - c.y0 > (y1 - y0) * 0.25 && c.x1 - c.x0 > extW * 0.2) box = c;
    }
    const pad = 4;
    // The padding never reaches into the caption (below a figure, above a table).
    // …nor into the line that ended the band on the other side.
    const yTop = Math.min(box.y1 + pad, ref.kind === "table" ? capBottom - 1 : y1);
    const yBottom = Math.max(box.y0 - pad, ref.kind === "figure" ? capTop + 1 : y0);
    const frac: FigureBox = {
      top: Math.max(0, 1 - (yTop - vy0!) / H),
      bottom: Math.min(1, 1 - (yBottom - vy0!) / H),
      left: Math.max(0, (box.x0 - pad - vx0!) / W),
      right: Math.min(1, (box.x1 + pad - vx0!) / W),
    };
    if (frac.bottom - frac.top < 0.04 || frac.right - frac.left < 0.15) return null;
    page.cleanup();
    return { box: frac, kind: ref.kind, caption: capLines.map((s) => s.str).join(" ").slice(0, 200) };
  } catch {
    return null;
  } finally {
    await task.destroy().catch(() => {});
  }
}

export type ListedFigure = LocatedFigure & { page: number; label: string };

/**
 * Every captioned figure / table of the first `maxPages` pages, located like `locateFigureByLayout` (first caption per
 * figure number; references to a figure inside body text do not start a line with "Fig. N:" and are skipped).
 */
export async function listFigures(pdf: Buffer, opts: { maxPages?: number; max?: number } = {}): Promise<ListedFigure[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(pdf), disableFontFace: true, useSystemFonts: false, verbosity: 0, stopAtErrors: false });
  const found: { page: number; caption: string; kind: "figure" | "table"; num: number }[] = [];
  try {
    const doc = await task.promise;
    const seen = new Set<string>();
    for (let p = 1; p <= Math.min(doc.numPages, opts.maxPages ?? 20); p++) {
      const page = await doc.getPage(p);
      const segs = segments((await page.getTextContent()).items as unknown as { str: string; transform: number[]; width: number; height: number }[]);
      for (const s of segs) {
        const m = /^\s*(fig(?:ure)?\.?|table)\s*([0-9]{1,2}|[IVXL]{1,5})\s*[.:|]/i.exec(s.str);
        if (!m) continue;
        const ref = figureRefOf(`${m[1]} ${m[2]}`);
        if (!ref || seen.has(`${ref.kind}${ref.num}`)) continue;
        seen.add(`${ref.kind}${ref.num}`);
        found.push({ page: p, caption: s.str, ...ref });
      }
      page.cleanup();
    }
  } catch {
    return [];
  } finally {
    await task.destroy().catch(() => {});
  }
  const out: ListedFigure[] = [];
  for (const f of found.slice(0, opts.max ?? 16)) {
    const located = await locateFigureByLayout(pdf, f.page, f.caption).catch(() => null);
    if (located) out.push({ ...located, page: f.page, label: `${f.kind === "figure" ? "Fig." : "Table"} ${f.num}` });
  }
  return out;
}
