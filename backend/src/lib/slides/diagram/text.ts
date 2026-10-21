/**
 * Label text: plain text (Latin / CJK mixed) with inline `$…$` maths, explicit line breaks (`\n`), wrapped to a width
 * with real glyph metrics. Latin breaks at spaces, CJK between characters (never before closing punctuation), maths
 * is atomic. `fitText` picks the narrowest balanced wrap within a width and never returns a block wider than it says.
 */
import { GlyphSink, r, shapeText, type TextStyle } from "./fonts.js";
import { layoutMath, type MathBox } from "./math.js";

type Piece = { kind: "text"; text: string; width: number; space: boolean } | { kind: "math"; box: MathBox; width: number; space: boolean } | { kind: "break" };
export type Line = { width: number; ascent: number; descent: number; pieces: Piece[] };
export type TextBlock = { width: number; height: number; lines: Line[]; style: TextStyle; lineHeight: number };

const CJK = /[⺀-鿿豈-﫿　-〿＀-￯]/;
const NO_BREAK_BEFORE = /[，。、；：？！）」』】〉》,.;:?!)\]}%]/;

/** Strips Markdown emphasis / code marks and stray LaTeX outside `$…$` from a label. */
export function cleanLabel(s: string): string {
  return s
    .replace(/\*\*|__|`/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function pieces(label: string, style: TextStyle): Piece[] {
  const out: Piece[] = [];
  const parts = label.split(/(\$[^$]+\$)/g);
  for (const part of parts) {
    if (!part) continue;
    if (/^\$[^$]+\$$/.test(part)) {
      const box = layoutMath(part.slice(1, -1), style.size, style);
      out.push({ kind: "math", box, width: box.width, space: false });
      continue;
    }
    const lines = part.split("\n");
    lines.forEach((ln, li) => {
      if (li > 0) out.push({ kind: "break" });
      // Tokens: Latin words (with their trailing space), single CJK characters (+ trailing closing punctuation).
      const re = /([⺀-鿿豈-﫿][　-〿＀-￯，。、；：？！）」』】〉》]*)|([^\s⺀-鿿豈-﫿]+)|(\s+)/g;
      for (const m of ln.matchAll(re)) {
        if (m[3]) {
          const last = out.at(-1);
          if (last && last.kind !== "break") last.space = true;
          continue;
        }
        const text = m[0];
        out.push({ kind: "text", text, width: shapeText(text, style).width, space: false });
      }
    });
  }
  return out;
}

const spaceW = (style: TextStyle) => shapeText(" ", style).width;

function breakLines(ps: Piece[], maxWidth: number, style: TextStyle): Line[] {
  const sw = spaceW(style);
  const lines: Line[] = [];
  let cur: Piece[] = [];
  let w = 0;
  const push = () => {
    // Trailing space does not count.
    lines.push(measureLine(cur, style, sw));
    cur = [];
    w = 0;
  };
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i]!;
    if (p.kind === "break") {
      push();
      continue;
    }
    const prev = cur.at(-1);
    const gap = prev && prev.kind !== "break" && prev.space ? sw : 0;
    const add = gap + p.width;
    const nextPunct = p.kind === "text" && NO_BREAK_BEFORE.test(p.text[0] ?? "") && !CJK.test(p.text[0] ?? "") && !gap;
    if (cur.length && w + add > maxWidth + 0.01 && !nextPunct) {
      push();
      cur.push(p);
      w = p.width;
    } else {
      cur.push(p);
      w += add;
    }
  }
  if (cur.length || !lines.length) push();
  return lines;
}

function measureLine(ps: Piece[], style: TextStyle, sw: number): Line {
  let width = 0;
  let ascent = style.size * 0.78;
  let descent = style.size * 0.24;
  ps.forEach((p, i) => {
    if (p.kind === "break") return;
    const prev = ps[i - 1];
    if (prev && prev.kind !== "break" && prev.space) width += sw;
    width += p.width;
    if (p.kind === "math") {
      ascent = Math.max(ascent, p.box.height + style.size * 0.06);
      descent = Math.max(descent, p.box.depth + style.size * 0.04);
    }
  });
  return { width, ascent, descent, pieces: ps };
}

export function layoutText(label: string, style: TextStyle, maxWidth = Infinity, lineHeight = 1.22): TextBlock {
  const ps = pieces(cleanLabel(label), style);
  const lines = breakLines(ps, maxWidth, style);
  return blockOf(lines, style, lineHeight);
}

function blockOf(lines: Line[], style: TextStyle, lineHeight: number): TextBlock {
  const lh = style.size * lineHeight;
  let height = 0;
  for (const l of lines) height += Math.max(lh, l.ascent + l.descent + style.size * 0.08);
  return { width: Math.max(0, ...lines.map((l) => l.width)), height, lines, style, lineHeight };
}

/** Width of the longest unbreakable piece (a long word / formula). */
export function minTextWidth(label: string, style: TextStyle): number {
  return Math.max(0, ...pieces(cleanLabel(label), style).map((p) => (p.kind === "break" ? 0 : p.width)));
}

/**
 * Wraps `label` into at most `maxLines` lines within `maxWidth`, balanced (the narrowest width with the same line
 * count). Shrinks the font (down to `minSize`) when even that does not fit; the result reports its real width, which
 * may exceed `maxWidth` only when a single word is wider at `minSize` (the caller then widens the box).
 */
export function fitText(label: string, style: TextStyle, maxWidth: number, opts: { maxLines?: number; minSize?: number; lineHeight?: number } = {}): TextBlock {
  const maxLines = opts.maxLines ?? 3;
  const minSize = opts.minSize ?? Math.min(style.size, 16);
  let size = style.size;
  let best: TextBlock | null = null;
  for (;;) {
    const st = { ...style, size };
    const ps = pieces(cleanLabel(label), st);
    const lines = breakLines(ps, maxWidth, st);
    let block = blockOf(lines, st, opts.lineHeight ?? 1.22);
    if (lines.length > 1) {
      // Balance: the narrowest width that keeps the same number of lines.
      let lo = Math.max(...ps.map((p) => (p.kind === "break" ? 0 : p.width)));
      let hi = maxWidth;
      for (let k = 0; k < 14 && hi - lo > 1; k++) {
        const mid = (lo + hi) / 2;
        if (breakLines(ps, mid, st).length <= lines.length) hi = mid;
        else lo = mid;
      }
      block = blockOf(breakLines(ps, hi, st), st, opts.lineHeight ?? 1.22);
    }
    best = block;
    const fits = block.lines.length <= maxLines && block.width <= maxWidth + 0.5;
    if (fits || size <= minSize) break;
    size = Math.max(minSize, size - 1);
  }
  return best!;
}

/** Draws a block: `x` = left / centre / right edge per `align`, `y` = top. */
export function drawText(block: TextBlock, x: number, y: number, align: "start" | "middle" | "end", sink: GlyphSink, color: string): string {
  const out: string[] = [];
  const sw = spaceW(block.style);
  const lh = block.style.size * block.lineHeight;
  let top = y;
  for (const line of block.lines) {
    const h = Math.max(lh, line.ascent + line.descent + block.style.size * 0.08);
    // Baseline: centre the ascent/descent box of the line in its slot.
    const base = top + (h - (line.ascent + line.descent)) / 2 + line.ascent;
    let cx = align === "middle" ? x - line.width / 2 : align === "end" ? x - line.width : x;
    line.pieces.forEach((p, i) => {
      if (p.kind === "break") return;
      const prev = line.pieces[i - 1];
      if (prev && prev.kind !== "break" && prev.space) cx += sw;
      if (p.kind === "text") {
        for (const run of shapeText(p.text, block.style).runs) out.push(sink.use(run, cx, base, color));
      } else {
        for (const it of p.box.items) {
          if (it.kind === "run") out.push(sink.use(it.run, cx, base, color));
          else out.push(`<rect x="${r(cx + it.x)}" y="${r(base + it.y)}" width="${r(it.w)}" height="${r(it.h)}" fill="${color}"/>`);
        }
      }
      cx += p.width;
    });
    top += h;
  }
  return out.join("");
}

/** Plain-text version of a label (aria / title). */
export const plainLabel = (s: string) => cleanLabel(s).replace(/\$([^$]+)\$/g, (_a, t: string) => t.replace(/\\([A-Za-z]+)/g, "$1").replace(/[{}]/g, "")).replace(/\n/g, " ");
