import { diffLines } from "diff";

export type RawHunk = { from: number; to: number; before: string; after: string };

/**
 * Hunks turning `base` into `proposed`: a line diff (a Markdown paragraph or a code line is one line), with
 * adjacent changed lines merged into one hunk. Offsets are into `base`. The frontend shows a word diff inside
 * each hunk.
 */
export function computeHunks(base: string, proposed: string): RawHunk[] {
  const hunks: RawHunk[] = [];
  let index = 0;
  let open: RawHunk | null = null;
  for (const part of diffLines(base, proposed)) {
    if (!part.added && !part.removed) {
      if (open) hunks.push(open);
      open = null;
      index += part.value.length;
      continue;
    }
    open ??= { from: index, to: index, before: "", after: "" };
    if (part.removed) {
      open.before += part.value;
      open.to += part.value.length;
      index += part.value.length;
    } else open.after += part.value;
  }
  if (open) hunks.push(open);
  return hunks;
}

/**
 * Finds `hunk.before` in `text`: at its recorded offset, else at its only occurrence (text targets edited since).
 * Returns null when it is ambiguous or gone (the hunk is stale).
 */
export function locate(text: string, hunk: RawHunk): { from: number; to: number } | null {
  if (hunk.to <= text.length && text.slice(hunk.from, hunk.to) === hunk.before) return { from: hunk.from, to: hunk.to };
  if (!hunk.before) return null;
  const first = text.indexOf(hunk.before);
  if (first === -1 || text.indexOf(hunk.before, first + 1) !== -1) return null;
  return { from: first, to: first + hunk.before.length };
}
