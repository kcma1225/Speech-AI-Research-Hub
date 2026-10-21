// Minimal typings for the parts of opentype.js (MIT) used by the diagram text engine.
declare module "opentype.js" {
  export interface PathCommand { type: string; x?: number; y?: number; x1?: number; y1?: number; x2?: number; y2?: number }
  export interface Path { commands: PathCommand[]; toPathData(decimalPlaces?: number): string }
  export interface Glyph { index: number; advanceWidth?: number; unicode?: number; getPath(x: number, y: number, fontSize: number): Path }
  export interface Font {
    unitsPerEm: number;
    ascender: number;
    descender: number;
    charToGlyph(ch: string): Glyph;
    charToGlyphIndex(ch: string): number;
    forEachGlyph(text: string, x: number, y: number, fontSize: number, options: Record<string, unknown>, cb: (g: Glyph, x: number, y: number) => void): number;
  }
  export function parse(buffer: ArrayBuffer): Font;
  const opentype: { parse: typeof parse };
  export default opentype;
}
