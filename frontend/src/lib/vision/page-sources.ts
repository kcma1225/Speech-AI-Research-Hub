import type { SyncData } from "../latex/synctex.ts";

export type PageSource = { path: string; from: number; to: number };

/**
 * Source line ranges that produced a PDF page (SyncTeX records of that page, per project file). Lines closer than
 * `gap` are merged; at most `max` ranges, the ones with most records first. Used by the AI layout review.
 */
export function pageSources(data: SyncData, page: number, gap = 25, max = 6): PageSource[] {
  const lines = new Map<string, number[]>();
  for (const b of data.boxes) {
    if (b.page !== page || b.line <= 0) continue;
    const path = data.inputs.get(b.file);
    if (!path) continue;
    const list = lines.get(path) ?? [];
    list.push(b.line);
    lines.set(path, list);
  }
  const out: Array<PageSource & { n: number }> = [];
  for (const [path, list] of lines) {
    list.sort((a, b) => a - b);
    let start = list[0]!;
    let end = start;
    let n = 1;
    for (const l of list.slice(1)) {
      if (l - end > gap) {
        out.push({ path, from: start, to: end, n });
        start = l;
        n = 0;
      }
      end = l;
      n++;
    }
    out.push({ path, from: start, to: end, n });
  }
  return out
    .sort((a, b) => b.n - a.n)
    .slice(0, max)
    .map(({ path, from, to }) => ({ path, from, to }));
}
