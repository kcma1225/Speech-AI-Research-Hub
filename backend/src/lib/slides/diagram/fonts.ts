/**
 * Fonts of the diagram engine (vendored under `backend/assets/fonts/`, OFL / MIT):
 *  - Source Sans 3 (Regular / Semibold / Bold / Italic; the deck's Latin face), subset to Latin, Greek, arrows, maths;
 *  - Noto Sans TC (Regular / Bold), subset to Big5 level 1 + GB2312 level 1 + CJK punctuation (~7.8k characters);
 *  - KaTeX Main / Math-Italic / AMS for `$…$` labels.
 * Text is measured with the real glyph advances (+ kerning) and drawn as glyph outlines (`<path>` in `<defs>`, placed
 * with `<use>`), so what we measure is exactly what every viewer sees: no font loading, no fallback drift inside an
 * `<img>`. A character none of the fonts has is measured as 0.6 em and drawn as plain `<text>`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import opentype, { type Font, type Glyph } from "opentype.js";

/** `<backend>/assets/fonts`: the same relative path from `src/lib/slides/diagram` and `dist/lib/slides/diagram`. */
const FONT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../assets/fonts");

export type FaceId = "sans" | "sans-semibold" | "sans-bold" | "sans-italic" | "cjk" | "cjk-bold" | "math-italic" | "math-bolditalic" | "main" | "main-bold" | "ams";
const FILES: Record<FaceId, string> = {
  sans: "SourceSans3-Regular.ttf",
  "sans-semibold": "SourceSans3-Semibold.ttf",
  "sans-bold": "SourceSans3-Bold.ttf",
  "sans-italic": "SourceSans3-It.ttf",
  cjk: "NotoSansTC-Regular-subset.otf",
  "cjk-bold": "NotoSansTC-Bold-subset.otf",
  "math-italic": "KaTeX_Math-Italic.ttf",
  "math-bolditalic": "KaTeX_Math-BoldItalic.ttf",
  main: "KaTeX_Main-Regular.ttf",
  "main-bold": "KaTeX_Main-Bold.ttf",
  ams: "KaTeX_AMS-Regular.ttf",
};

const cache = new Map<FaceId, Font>();
export function face(id: FaceId): Font {
  let f = cache.get(id);
  if (!f) {
    const buf = readFileSync(path.join(FONT_DIR, FILES[id]));
    f = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
    cache.set(id, f);
  }
  return f;
}

export type Weight = 400 | 600 | 700;
export type TextStyle = { size: number; weight?: Weight; italic?: boolean; color?: string };

const has = (f: Font, ch: string) => f.charToGlyphIndex(ch) > 0;
export const hasGlyph = (id: FaceId, ch: string) => has(face(id), ch);
const CJK_RE = /[⺀-鿿豈-﫿＀-￯　-〿]/;

/** Font for one character of plain (non-math) text. */
export function faceFor(ch: string, style: TextStyle): FaceId | null {
  const w = style.weight ?? 400;
  const latin: FaceId = style.italic ? "sans-italic" : w >= 700 ? "sans-bold" : w >= 600 ? "sans-semibold" : "sans";
  if (!CJK_RE.test(ch) && has(face(latin), ch)) return latin;
  const cjk: FaceId = w >= 600 ? "cjk-bold" : "cjk";
  if (has(face(cjk), ch)) return cjk;
  if (has(face(latin), ch)) return latin;
  for (const id of ["main", "ams"] as const) if (has(face(id), ch)) return id;
  return null;
}

/** A positioned run of glyphs of one face (x relative to the run start, at `size`). */
export type GlyphRun = { face: FaceId | null; text: string; size: number; dx: number; dy: number; width: number; color?: string; glyphs: { g: Glyph | null; x: number }[] };

/** Splits plain text into face runs and measures them (kerning within a run). */
export function shapeText(text: string, style: TextStyle): { runs: GlyphRun[]; width: number } {
  const runs: GlyphRun[] = [];
  let x = 0;
  let cur = null as { face: FaceId | null; text: string } | null;
  const flush = () => {
    if (!cur || !cur.text) return;
    const run = shapeRun(cur.face, cur.text, style.size);
    run.dx = x;
    run.color = style.color;
    x += run.width;
    runs.push(run);
  };
  for (const ch of text) {
    const f: FaceId | null = ch === " " ? (cur?.face ?? faceFor("a", style)) : faceFor(ch, style);
    if (cur && cur.face === f) cur.text += ch;
    else {
      flush();
      cur = { face: f, text: ch };
    }
  }
  flush();
  return { runs, width: x };
}

/** One face: glyph positions via opentype's own advance + kerning loop. */
export function shapeRun(id: FaceId | null, text: string, size: number, dy = 0): GlyphRun {
  if (!id) return { face: null, text, size, dx: 0, dy, width: [...text].length * size * 0.6, glyphs: [] };
  const f = face(id);
  const glyphs: GlyphRun["glyphs"] = [];
  const width = f.forEachGlyph(text, 0, 0, size, { kerning: true, features: { liga: false, rlig: false } }, (g, gx) => glyphs.push({ g, x: gx }));
  return { face: id, text, size, dx: 0, dy, width, glyphs };
}

/** Width of plain text (px). */
export const measure = (text: string, style: TextStyle) => shapeText(text, style).width;

/**
 * Collects glyph outlines used by one SVG: each glyph once in `<defs>` (font units, y up flipped), placed by `<use>`.
 */
export class GlyphSink {
  private defs = new Map<string, string>();
  use(run: GlyphRun, x: number, y: number, color: string): string {
    if (!run.face) return `<text x="${r(x + run.dx)}" y="${r(y + run.dy)}" font-size="${r(run.size)}" fill="${color}" font-family="sans-serif">${escXml(run.text)}</text>`;
    const f = face(run.face);
    const s = run.size / f.unitsPerEm;
    const parts: string[] = [];
    for (const { g, x: gx } of run.glyphs) {
      if (!g || !g.index) continue;
      const id = `${FACE_KEY[run.face]}${g.index}`;
      if (!this.defs.has(id)) {
        const d = g.getPath(0, 0, f.unitsPerEm).toPathData(0);
        if (!d) {
          this.defs.set(id, "");
          continue;
        }
        this.defs.set(id, `<path id="${id}" d="${d}"/>`);
      }
      if (!this.defs.get(id)) continue;
      parts.push(`<use href="#${id}" transform="translate(${r(x + run.dx + gx)} ${r(y + run.dy)}) scale(${+s.toFixed(5)})"/>`);
    }
    return parts.length ? `<g fill="${color}">${parts.join("")}</g>` : "";
  }
  defsXml() {
    return [...this.defs.values()].filter(Boolean).join("");
  }
}

const FACE_KEY: Record<FaceId, string> = { sans: "a", "sans-semibold": "b", "sans-bold": "c", "sans-italic": "d", cjk: "e", "cjk-bold": "f", "math-italic": "g", "math-bolditalic": "h", main: "i", "main-bold": "j", ams: "k" };

export const r = (v: number) => (Math.round(v * 10) / 10).toString();
export const escXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
