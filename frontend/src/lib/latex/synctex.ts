/**
 * SyncTeX (`output.synctex.gz`, already decompressed) parsed in the browser: forward search (file + line → boxes on a
 * page) and inverse search (page + point → file + line). Own implementation of the documented text format
 * (`Input:`, `{page` … `}page`, box records `[ ( v h` and point records `x k g $`); coordinates are in scaled points
 * and returned in PDF points from the top-left of the page.
 *
 * Paths: the runner compiles inside `/work`, so inputs look like `/work/./sections/a.tex`; they are made
 * project-relative. Files outside the project (TeX tree) are ignored.
 */

export type SyncBox = { page: number; x: number; y: number; width: number; height: number; depth: number; file: number; line: number; kind: "vbox" | "hbox" | "point" };
export type SyncData = { inputs: Map<number, string>; boxes: SyncBox[]; byFile: Map<string, SyncBox[]> };

/** sp → bp (big points, PDF units): 65536 sp per TeX pt, 72.27 TeX pt per 72 bp. */
const SP_PER_BP = 65781.76;

export function normalizeInput(raw: string, workRoot = "/work/"): string | null {
  let p = raw.trim();
  if (p.startsWith(workRoot)) p = p.slice(workRoot.length);
  else if (p.startsWith("/")) return null; // TeX tree, fonts, …
  p = p.replace(/\/\.\//g, "/").replace(/^\.\//, "");
  while (p.startsWith("./")) p = p.slice(2);
  if (!/\.[A-Za-z0-9]+$/.test(p)) p += ".tex";
  return p;
}

export function parseSynctex(text: string, workRoot = "/work/"): SyncData {
  const inputs = new Map<number, string>();
  const boxes: SyncBox[] = [];
  let unit = 1;
  let xOffset = 0;
  let yOffset = 0;
  let mag = 1000;
  let page = 0;
  let inContent = false;
  const scale = () => (unit * mag) / 1000 / SP_PER_BP;
  for (const line of text.split("\n")) {
    if (!line) continue;
    if (line.startsWith("Input:")) {
      const m = /^Input:(\d+):(.*)$/.exec(line);
      if (m) {
        const path = normalizeInput(m[2]!, workRoot);
        if (path) inputs.set(Number(m[1]), path);
      }
      continue;
    }
    if (!inContent) {
      if (line.startsWith("Unit:")) unit = Number(line.slice(5)) || 1;
      else if (line.startsWith("X Offset:")) xOffset = Number(line.slice(9)) || 0;
      else if (line.startsWith("Y Offset:")) yOffset = Number(line.slice(9)) || 0;
      else if (line.startsWith("Magnification:")) mag = Number(line.slice(14)) || 1000;
      else if (line.startsWith("Content:")) inContent = true;
      continue;
    }
    const c = line[0];
    if (c === "{") {
      page = Number(line.slice(1)) || page + 1;
      continue;
    }
    if (c === "}" || c === "]" || c === ")" || c === "!") continue;
    if (line.startsWith("Postamble:")) break;
    if (c !== "[" && c !== "(" && c !== "v" && c !== "h" && c !== "x" && c !== "k" && c !== "g" && c !== "$") continue;
    // <c><input>,<line>[,<column>]:<h>,<v>[:<W>,<H>,<D>]
    const m = /^.(\d+),(\d+)(?:,-?\d+)?:(-?\d+),(-?\d+)(?::(-?\d+)(?:,(-?\d+),(-?\d+))?)?/.exec(line);
    if (!m) continue;
    const file = Number(m[1]);
    if (!inputs.has(file)) continue;
    const s = scale();
    const isBox = c === "[" || c === "(" || c === "v" || c === "h";
    boxes.push({
      page,
      file,
      line: Number(m[2]),
      x: (Number(m[3]) + xOffset) * s,
      y: (Number(m[4]) + yOffset) * s,
      width: isBox && m[5] ? Number(m[5]) * s : 0,
      height: isBox && m[6] ? Number(m[6]) * s : 0,
      depth: isBox && m[7] ? Number(m[7]) * s : 0,
      kind: c === "[" || c === "v" ? "vbox" : c === "(" || c === "h" ? "hbox" : "point",
    });
  }
  const byFile = new Map<string, SyncBox[]>();
  for (const b of boxes) {
    const path = inputs.get(b.file)!;
    let list = byFile.get(path);
    if (!list) byFile.set(path, (list = []));
    list.push(b);
  }
  return { inputs, boxes, byFile };
}

export type Rect = { page: number; x: number; y: number; width: number; height: number };

/**
 * Forward search: rectangles (PDF points, top-left origin) for `line` of `file`. Uses the closest line that has
 * records (same file), on the first page where it appears. Records of that line are grouped by baseline; each group
 * spans from its leftmost to its rightmost record, with the height of the line box on that baseline.
 */
export function forwardSearch(data: SyncData, file: string, line: number): Rect[] {
  const records = data.byFile.get(file);
  if (!records?.length) return [];
  const distance = (r: SyncBox) => Math.abs(r.line - line) + (r.line < line ? 0.5 : 0);
  let best = Infinity;
  for (const r of records) best = Math.min(best, distance(r));
  const matches = records.filter((r) => distance(r) === best && !(r.kind === "vbox"));
  if (!matches.length) return [];
  const page = matches[0]!.page;
  const groups = new Map<number, SyncBox[]>();
  for (const r of matches) {
    if (r.page !== page) continue;
    const key = Math.round(r.y);
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const rects: Rect[] = [];
  for (const [baseline, list] of [...groups].sort((a, b) => a[0] - b[0])) {
    const left = Math.min(...list.map((r) => r.x));
    let right = Math.max(...list.map((r) => r.x + r.width));
    // Height/depth from the widest line box on this baseline (any file: the paragraph's box may be attributed elsewhere).
    const lineBox = data.boxes.filter((b) => b.page === page && b.kind === "hbox" && Math.abs(b.y - baseline) < 1 && b.height > 0).sort((a, b) => b.width - a.width)[0];
    const height = lineBox?.height || Math.max(...list.map((r) => r.height)) || 9;
    const depth = lineBox?.depth ?? 2;
    if (right - left < 8) right = left + 40;
    rects.push({ page, x: left, y: baseline - height, width: right - left, height: height + depth });
  }
  return rects.slice(0, 12);
}

/**
 * Inverse search: the source line under a point (PDF points, top-left origin) on `page`. The smallest line box
 * containing the point gives the baseline; the nearest record on that baseline (preferring the one just left of the
 * point) gives the line — line boxes of a paragraph are often attributed to where the paragraph ended.
 */
export function inverseSearch(data: SyncData, page: number, x: number, y: number): { file: string; line: number } | null {
  const onPage = data.boxes.filter((b) => b.page === page);
  let box: SyncBox | null = null;
  for (const b of onPage) {
    if (b.kind !== "hbox" || b.width <= 0) continue;
    const inside = x >= b.x && x <= b.x + b.width && y >= b.y - Math.max(b.height, 6) && y <= b.y + Math.max(b.depth, 3);
    if (inside && (!box || b.width * (b.height + b.depth) < box.width * (box.height + box.depth))) box = b;
  }
  let baseline: number;
  if (box) baseline = box.y;
  else {
    // Nothing contains the point: the closest baseline.
    let nearest: SyncBox | null = null;
    for (const b of onPage) if (b.kind !== "vbox" && (!nearest || Math.abs(b.y - y) < Math.abs(nearest.y - y))) nearest = b;
    if (!nearest) return null;
    baseline = nearest.y;
  }
  let pick: SyncBox | null = null;
  let score = Infinity;
  for (const b of onPage) {
    if (b.kind === "vbox" || Math.abs(b.y - baseline) > 1) continue;
    if (b.kind === "hbox" && box && b.width >= box.width && b !== box) continue;
    const s = b.x <= x ? x - b.x : (b.x - x) * 3;
    if (s < score) {
      score = s;
      pick = b;
    }
  }
  const hit = pick ?? box;
  return hit ? { file: data.inputs.get(hit.file)!, line: hit.line } : null;
}
