/**
 * Space estimates for visuals of generated decks (1280×800, hub-deck.css): how wide / tall a diagram or chart can be
 * on its slide, from the slide's source (column width, other blocks above/below). The diagram engine and the chart
 * renderer lay out for this box so they are shown at ≈ 1:1 (text stays ≥ 16 px) and fill the slide.
 * Calibrated on a Quarto render: the h2 ends at y ≈ 83; bullets ≈ 44 px; `.takeaway` ≈ 91 px; body text 26 px.
 */
export const SLIDE_W = 1280;
export const SLIDE_H = 800;
const BODY_TOP = 86;
const BOTTOM = 26;
const CONTENT_W = 1220;
const COLUMN_GAP = 36;

export type VisualFit = { w: number; h: number; column: boolean };

/** Slide (`## …` section) of the body containing `offset`: [start, end). */
function slideAt(body: string, offset: number): [number, number] {
  let start = 0;
  for (const m of body.matchAll(/^## /gm)) {
    if (m.index! <= offset) start = m.index!;
    else return [start, m.index!];
  }
  return [start, body.length];
}

/** Estimated height (px) of the Markdown blocks in `text` (fences / visual blocks excluded by the caller). */
function textHeight(text: string): number {
  let h = 0;
  const lines = text.split("\n");
  let inTable = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || /^:::+/.test(line) || /^<!--/.test(line)) continue;
    if (/^\|/.test(line)) {
      if (!/^\|[\s:-|]+\|$/.test(line)) inTable++;
      continue;
    }
    if (/^#{3,}\s/.test(line)) h += 50;
    else if (/^([-*+]|\d+\.)\s/.test(line)) h += 44 + Math.max(0, Math.ceil(visibleLen(line) / 62) - 1) * 34;
    else if (/^!\[/.test(line)) h += 300;
    else h += 36 * Math.max(1, Math.ceil(visibleLen(line) / 70));
  }
  if (inTable) h += inTable * 42 + 16;
  return h;
}

const visibleLen = (s: string) => [...s.replace(/[*_`$\\]/g, "")].reduce((n, ch) => n + (/[　-鿿＀-￯]/.test(ch) ? 1.9 : 1), 0);

/**
 * Box for the visual block at [start, end) of the body: column width when it sits in a `.column` div, height = the
 * slide body minus the other blocks that share its column (takeaways, bullets, paragraphs, other visuals).
 */
export function visualFit(body: string, start: number, end: number): VisualFit {
  const [s0, s1] = slideAt(body, start);
  const slide = body.slice(s0, s1);
  const rel = start - s0;
  // Column context: the innermost open `.column` div around the block (div fences matched with a stack).
  let colWidth: number | null = null;
  let colStart = -1;
  let colEnd = slide.length;
  const stack: { at: number; width: number | null }[] = [];
  let pos = 0;
  for (const line of slide.split("\n")) {
    const lineEnd = pos + line.length + 1;
    const open = /^:{3,}\s*\{([^}]*)\}\s*$/.exec(line) ?? /^:{3,}\s*[A-Za-z]/.exec(line);
    if (open) {
      const attrs = open[1] ?? "";
      const isCol = /(^|\s)\.column(\s|$)/.test(attrs);
      const wm = /width\s*=\s*"?(\d{1,3})%/.exec(attrs);
      stack.push({ at: pos, width: isCol ? (wm ? Number(wm[1]) : 50) : null });
    } else if (/^:{3,}\s*$/.test(line)) {
      const top = stack.pop();
      if (top && top.width !== null && top.at < rel && lineEnd > rel && colStart === top.at) colEnd = pos;
    }
    if (pos <= rel && rel < lineEnd) {
      const col = [...stack].reverse().find((x) => x.width !== null);
      if (col) {
        colWidth = col.width;
        colStart = col.at;
      }
    }
    pos = lineEnd;
  }
  const scope = colStart >= 0 ? slide.slice(colStart, colEnd) : slide;
  const w = colWidth ? Math.max(300, (CONTENT_W * colWidth) / 100 - COLUMN_GAP / 2) : CONTENT_W - 40;
  // Everything in scope except this block, other fences, the title and notes.
  const relInScope = colWidth ? rel - colStart : rel;
  const others = (scope.slice(0, Math.max(0, relInScope)) + scope.slice(Math.max(0, relInScope + (end - start))))
    .replace(/^:::+\s*\{\.notes\}[\s\S]*?^:::+\s*$/m, "")
    .replace(/^## .*$/m, "")
    .replace(/^```[\s\S]*?^```\s*$/gm, (f) => (/^```\s*\{?\.?(chart|diagram|mermaid)/.test(f) ? "![](x)" : ""));
  let used = 0;
  const take = (others.match(/^:::+\s*\{\.takeaway\}[\s\S]*?^:::+\s*$/gm) ?? []);
  used += take.length * 92;
  const big = (others.match(/^:::+\s*\{\.big-number(?:-label)?\}[\s\S]*?^:::+\s*$/gm) ?? []);
  used += big.length * 70;
  const rest = others.replace(/^:::+\s*\{\.(takeaway|big-number(?:-label)?)\}[\s\S]*?^:::+\s*$/gm, "");
  used += textHeight(rest);
  // Full-width blocks outside the column also take height (e.g. a takeaway below the columns).
  if (colWidth) {
    const outside = slide.replace(scope, "").replace(/^:::+\s*\{\.column[\s\S]*?^:::\s*$/gm, "");
    used += (outside.match(/^:::+\s*\{\.takeaway\}/gm) ?? []).length * 92;
  }
  const h = Math.max(220, Math.min(600, SLIDE_H - BODY_TOP - BOTTOM - used - 8));
  return { w: Math.round(w), h: Math.round(h), column: !!colWidth };
}

/** A visual block of a slide body: a ```chart / ```diagram fence or an image line (paper figure, generated SVG). */
const VISUAL_START_RE = /^```[ \t]*\{?\.?(?:chart|diagram)\}?[^\n]*$/;
const IMAGE_LINE_RE = /^!\[[^\]\n]*\]\([^)\n]+\)(?:\{[^}\n]*\})?\s*$/;

/**
 * Two or more visuals stacked one under another on a slide (production 61666f10: three result charts on 「Main results」
 * ran 463 px off the slide; shrinking the page could not save it) are put side by side: a run of consecutive top-level
 * visuals (only blank lines between them, outside any ::: div) becomes `.columns` — 2 or 3 visuals one per column, 4
 * as two columns of two. Visuals inside columns, or separated by text, are left as written. Pure.
 */
export function arrangeVisuals(body: string): { body: string; arranged: string[] } {
  const arranged: string[] = [];
  const parts = body.split(/^(?=## )/m);
  const out = parts.map((part) => {
    if (!part.startsWith("## ")) return part;
    const lines = part.split("\n");
    type Block = { from: number; to: number };
    const blocks: Block[] = [];
    let depth = 0;
    for (let i = 1; i < lines.length; i++) {
      const l = lines[i]!;
      if (/^```/.test(l)) {
        // Find the fence's end; a visual fence at depth 0 is a block.
        let j = i + 1;
        while (j < lines.length && !/^```\s*$/.test(lines[j]!)) j++;
        if (depth === 0 && VISUAL_START_RE.test(l)) blocks.push({ from: i, to: Math.min(j, lines.length - 1) });
        i = j;
        continue;
      }
      if (/^:{3,}\s*[^:\s]/.test(l)) depth++;
      else if (/^:{3,}\s*$/.test(l)) depth = Math.max(0, depth - 1);
      else if (depth === 0 && IMAGE_LINE_RE.test(l.trim())) blocks.push({ from: i, to: i });
    }
    // Runs of consecutive visuals (blank lines only between them).
    const runs: Block[][] = [];
    for (const b of blocks) {
      const run = runs.at(-1);
      const prev = run?.at(-1);
      if (run && prev && lines.slice(prev.to + 1, b.from).every((x) => !x.trim())) run.push(b);
      else runs.push([b]);
    }
    const todo = runs.filter((r) => r.length >= 2 && r.length <= 4);
    if (!todo.length) return part;
    let next = [...lines];
    for (const run of [...todo].reverse()) {
      const chunks = run.map((b) => lines.slice(b.from, b.to + 1).join("\n"));
      const cols = run.length === 4 ? [`${chunks[0]}\n\n${chunks[1]}`, `${chunks[2]}\n\n${chunks[3]}`] : chunks;
      const width = Math.floor(100 / cols.length);
      const block = [":::: {.columns}", ...cols.map((c) => `::: {.column width="${width}%"}\n${c}\n:::`), "::::"].join("\n");
      next = [...next.slice(0, run[0]!.from), block, ...next.slice(run.at(-1)!.to + 1)];
    }
    arranged.push(lines[0]!.replace(/^##\s+/, "").replace(/\{[^}]*\}\s*$/, "").trim());
    return next.join("\n");
  });
  return { body: out.join(""), arranged };
}
