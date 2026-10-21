import { EditorSelection, type EditorState } from "@codemirror/state";
import { keymap, type EditorView } from "@codemirror/view";
import { displayWidth } from "./markdown-commands.ts";

/**
 * GFM table editing: find the table around the cursor, reformat it (CJK-aware column widths), add/remove rows
 * and columns, set column alignment, and move between cells with Tab / Shift-Tab (Enter on the last row adds a
 * row). Pure text functions are exported for tests; the commands apply them as one transaction.
 */
export type Align = "none" | "left" | "center" | "right";
export type Table = { from: number; to: number; firstLine: number; rows: string[][]; align: Align[] };
export type CellPos = { row: number; col: number };

const ROW = /^\s*\|.*\|\s*$|^\s*[^|\s][^|]*\|/;
const isRow = (line: string) => line.includes("|") && ROW.test(line);
const DELIM_CELL = /^\s*:?-{1,}:?\s*$/;

/** Splits `| a | b \| c |` into cells (escaped pipes and pipes inside inline code stay in the cell). */
export function splitRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  let code = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\\" && text[i + 1] === "|") {
      cell += "\\|";
      i++;
    } else if (ch === "`") {
      code = !code;
      cell += ch;
    } else if (ch === "|" && !code) {
      cells.push(cell.trim());
      cell = "";
    } else cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

const alignOf = (cell: string): Align => {
  const c = cell.trim();
  const l = c.startsWith(":");
  const r = c.endsWith(":");
  return l && r ? "center" : r ? "right" : l ? "left" : "none";
};

/** The table containing line `lineNo` (1-based), or null. Needs a header row and a delimiter row. */
export function findTable(state: EditorState, pos: number): Table | null {
  const doc = state.doc;
  const at = doc.lineAt(pos);
  if (!isRow(at.text)) return null;
  let first = at.number;
  while (first > 1 && isRow(doc.line(first - 1).text)) first--;
  let last = at.number;
  while (last < doc.lines && isRow(doc.line(last + 1).text)) last++;
  if (last - first < 1) return null;
  const lines: string[] = [];
  for (let n = first; n <= last; n++) lines.push(doc.line(n).text);
  const delim = splitRow(lines[1]!);
  if (!delim.every(c => DELIM_CELL.test(c))) return null;
  const header = splitRow(lines[0]!);
  const cols = Math.max(header.length, delim.length);
  const pad = (cells: string[]) => [...cells, ...Array(Math.max(0, cols - cells.length)).fill("")].slice(0, Math.max(cols, cells.length));
  const rows = [pad(header), ...lines.slice(2).map(l => pad(splitRow(l)))];
  const width = Math.max(...rows.map(r => r.length));
  return {
    from: doc.line(first).from,
    to: doc.line(last).to,
    firstLine: first,
    rows: rows.map(r => [...r, ...Array(width - r.length).fill("")]),
    align: Array.from({ length: width }, (_, i) => alignOf(delim[i] ?? "---")),
  };
}

/** Table → aligned Markdown text. */
export function formatTable(rows: string[][], align: Align[]): string {
  const cols = Math.max(align.length, ...rows.map(r => r.length));
  const width = Array.from({ length: cols }, (_, c) => Math.max(3, ...rows.map(r => displayWidth(r[c] ?? ""))));
  const padCell = (text: string, c: number) => {
    const gap = width[c]! - displayWidth(text);
    const a = align[c] ?? "none";
    if (a === "right") return " ".repeat(gap) + text;
    if (a === "center") return " ".repeat(Math.floor(gap / 2)) + text + " ".repeat(Math.ceil(gap / 2));
    return text + " ".repeat(gap);
  };
  const line = (r: string[]) => `| ${Array.from({ length: cols }, (_, c) => padCell(r[c] ?? "", c)).join(" | ")} |`;
  const delim = `| ${width
    .map((w, c) => {
      const a = align[c] ?? "none";
      const dashes = "-".repeat(Math.max(1, w - (a === "center" ? 2 : a === "none" ? 0 : 1)));
      return a === "center" ? `:${dashes}:` : a === "left" ? `:${dashes}` : a === "right" ? `${dashes}:` : dashes;
    })
    .join(" | ")} |`;
  return [line(rows[0] ?? []), delim, ...rows.slice(1).map(line)].join("\n");
}

/** Cell under `pos` (row 0 = header; the delimiter line maps to row 0). */
export function cellAt(state: EditorState, table: Table, pos: number): CellPos {
  const line = state.doc.lineAt(pos);
  const index = line.number - table.firstLine;
  const row = index <= 1 ? 0 : index - 1;
  const before = line.text.slice(0, pos - line.from);
  let col = -1;
  let code = false;
  for (let i = 0; i < before.length; i++) {
    if (before[i] === "\\" && before[i + 1] === "|") i++;
    else if (before[i] === "`") code = !code;
    else if (before[i] === "|" && !code) col++;
  }
  if (!line.text.trim().startsWith("|")) col++;
  return { row, col: Math.max(0, Math.min(col, table.align.length - 1)) };
}

/** Range of cell `p`'s content (trimmed) in the formatted `text` (which starts at `from`). */
function cellRange(text: string, from: number, p: CellPos): { from: number; to: number } {
  const start = cellOffset(text, from, p);
  const rest = text.slice(start - from);
  let end = 0;
  while (end < rest.length && rest[end] !== "\n" && !(rest[end] === "|" && rest[end - 1] !== "\\")) end++;
  const content = rest.slice(0, end).replace(/\s+$/, "");
  return { from: start, to: start + content.length };
}

/** Offset of the start of cell `p`'s content in the formatted `text` (which starts at `from`). */
function cellOffset(text: string, from: number, p: CellPos): number {
  const lines = text.split("\n");
  const lineIndex = p.row === 0 ? 0 : p.row + 1;
  let offset = from;
  for (let i = 0; i < lineIndex; i++) offset += lines[i]!.length + 1;
  const line = lines[lineIndex] ?? "";
  let col = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\" && line[i + 1] === "|") i++;
    else if (line[i] === "|") {
      col++;
      if (col === p.col) {
        let j = i + 1;
        while (line[j] === " ") j++;
        return offset + Math.min(j, line.length);
      }
    }
  }
  return offset + line.length;
}

type Edit = (t: Table, at: CellPos) => { rows: string[][]; align: Align[]; cursor: CellPos } | null;

/** Applies `edit` to the table under the cursor and reformats it; false when the cursor is not in a table. */
export function editTable(view: EditorView, edit: Edit): boolean {
  if (view.state.readOnly) return false;
  const pos = view.state.selection.main.head;
  const table = findTable(view.state, pos);
  if (!table) return false;
  const result = edit(table, cellAt(view.state, table, pos));
  if (!result) return false;
  const text = formatTable(result.rows, result.align);
  // The target cell's content is selected, so typing replaces it (like a spreadsheet).
  const cell = cellRange(text, table.from, result.cursor);
  view.dispatch({ changes: { from: table.from, to: table.to, insert: text }, selection: EditorSelection.range(cell.from, cell.to), scrollIntoView: true, userEvent: "input.table" });
  view.focus();
  return true;
}

const emptyRow = (n: number) => Array(n).fill("");

export const table = {
  inTable: (state: EditorState) => !!findTable(state, state.selection.main.head),
  format: (v: EditorView) => editTable(v, (t, at) => ({ rows: t.rows, align: t.align, cursor: at })),
  addRowBelow: (v: EditorView) =>
    editTable(v, (t, at) => {
      const rows = [...t.rows];
      rows.splice(at.row + 1, 0, emptyRow(t.align.length));
      return { rows, align: t.align, cursor: { row: at.row + 1, col: at.col } };
    }),
  addRowAbove: (v: EditorView) =>
    editTable(v, (t, at) => {
      if (at.row === 0) return null;
      const rows = [...t.rows];
      rows.splice(at.row, 0, emptyRow(t.align.length));
      return { rows, align: t.align, cursor: at };
    }),
  deleteRow: (v: EditorView) =>
    editTable(v, (t, at) => {
      if (at.row === 0 || t.rows.length <= 2) return null;
      const rows = t.rows.filter((_, i) => i !== at.row);
      return { rows, align: t.align, cursor: { row: Math.min(at.row, rows.length - 1), col: at.col } };
    }),
  addColRight: (v: EditorView) =>
    editTable(v, (t, at) => ({
      rows: t.rows.map(r => [...r.slice(0, at.col + 1), "", ...r.slice(at.col + 1)]),
      align: [...t.align.slice(0, at.col + 1), "none" as Align, ...t.align.slice(at.col + 1)],
      cursor: { row: at.row, col: at.col + 1 },
    })),
  addColLeft: (v: EditorView) =>
    editTable(v, (t, at) => ({
      rows: t.rows.map(r => [...r.slice(0, at.col), "", ...r.slice(at.col)]),
      align: [...t.align.slice(0, at.col), "none" as Align, ...t.align.slice(at.col)],
      cursor: at,
    })),
  deleteCol: (v: EditorView) =>
    editTable(v, (t, at) => {
      if (t.align.length <= 1) return null;
      return { rows: t.rows.map(r => r.filter((_, i) => i !== at.col)), align: t.align.filter((_, i) => i !== at.col), cursor: { row: at.row, col: Math.min(at.col, t.align.length - 2) } };
    }),
  align: (v: EditorView, a: Align) => editTable(v, (t, at) => ({ rows: t.rows, align: t.align.map((x, i) => (i === at.col ? a : x)), cursor: at })),
  /** Tab: next cell (wraps to the next row; a new row after the last). */
  nextCell: (v: EditorView) =>
    editTable(v, (t, at) => {
      const cols = t.align.length;
      if (at.col + 1 < cols) return { rows: t.rows, align: t.align, cursor: { row: at.row, col: at.col + 1 } };
      if (at.row + 1 < t.rows.length) return { rows: t.rows, align: t.align, cursor: { row: at.row + 1, col: 0 } };
      return { rows: [...t.rows, emptyRow(cols)], align: t.align, cursor: { row: at.row + 1, col: 0 } };
    }),
  prevCell: (v: EditorView) =>
    editTable(v, (t, at) => {
      if (at.col > 0) return { rows: t.rows, align: t.align, cursor: { row: at.row, col: at.col - 1 } };
      if (at.row > 0) return { rows: t.rows, align: t.align, cursor: { row: at.row - 1, col: t.align.length - 1 } };
      return { rows: t.rows, align: t.align, cursor: at };
    }),
};

/**
 * Tab / Shift-Tab between cells and Mod-Enter for a new row, only while the cursor is in a table (elsewhere the
 * keys keep their default behaviour, so Tab still leaves the editor for keyboard users outside tables).
 */
export const tableKeymap = keymap.of([
  { key: "Tab", run: v => (table.inTable(v.state) ? table.nextCell(v) : false), shift: v => (table.inTable(v.state) ? table.prevCell(v) : false) },
  { key: "Mod-Enter", run: v => (table.inTable(v.state) ? table.addRowBelow(v) : false) },
]);
