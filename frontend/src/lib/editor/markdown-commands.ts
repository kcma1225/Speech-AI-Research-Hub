import { EditorSelection, type ChangeSpec, type EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/**
 * Markdown formatting commands for CodeMirror (toolbar buttons, slash menu and keyboard shortcuts). Each returns
 * true when it handled the view (CodeMirror command signature) and works on every selection range. All edits are
 * ordinary transactions, so they go through Yjs in collaborative mode and stay undoable.
 */
export function wrap(view: EditorView, before: string, after: string, placeholder: string): boolean {
  if (view.state.readOnly) return false;
  const tr = view.state.changeByRange(range => {
    const text = view.state.sliceDoc(range.from, range.to);
    // Toggle off when the selection is already wrapped (inside or just outside the markers).
    if (text.startsWith(before) && text.endsWith(after) && text.length >= before.length + after.length) {
      const inner = text.slice(before.length, text.length - after.length);
      return { changes: { from: range.from, to: range.to, insert: inner }, range: EditorSelection.range(range.from, range.from + inner.length) };
    }
    const outerFrom = range.from - before.length;
    if (
      outerFrom >= 0 &&
      view.state.sliceDoc(outerFrom, range.from) === before &&
      view.state.sliceDoc(range.to, range.to + after.length) === after &&
      // `**bold**` vs `*`: do not strip one star of a bold marker when toggling italic.
      !(before === "*" && view.state.sliceDoc(outerFrom - 1, outerFrom) === "*")
    ) {
      return {
        changes: [
          { from: outerFrom, to: range.from, insert: "" },
          { from: range.to, to: range.to + after.length, insert: "" },
        ],
        range: EditorSelection.range(outerFrom, outerFrom + text.length),
      };
    }
    const body = text || placeholder;
    return {
      changes: { from: range.from, to: range.to, insert: before + body + after },
      range: EditorSelection.range(range.from + before.length, range.from + before.length + body.length),
    };
  });
  view.dispatch(view.state.update(tr, { scrollIntoView: true, userEvent: "input.format" }));
  view.focus();
  return true;
}

/** Lines touched by the selection ranges (each once, in document order). */
function selectedLines(state: EditorState) {
  const lines = new Map<number, { from: number; text: string }>();
  for (const range of state.selection.ranges) {
    for (let pos = range.from; pos <= range.to; ) {
      const line = state.doc.lineAt(pos);
      lines.set(line.from, { from: line.from, text: line.text });
      if (line.to + 1 > range.to) break;
      pos = line.to + 1;
    }
  }
  return [...lines.values()].sort((a, b) => a.from - b.from);
}

const LIST_MARKER = /^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/;

/**
 * Toggles a line prefix (headings, lists, task items, quotes) on every selected line. Indentation is kept; with
 * `replace`, another marker already on the line (e.g. `- ` when switching to `1. `) is replaced instead of nested.
 */
export function prefixLines(view: EditorView, prefix: string | ((index: number) => string), pattern: RegExp, replace?: RegExp): boolean {
  if (view.state.readOnly) return false;
  const lines = selectedLines(view.state);
  const all = lines.every(line => pattern.test(line.text));
  const changes: ChangeSpec[] = [];
  lines.forEach((line, index) => {
    const own = pattern.exec(line.text);
    const other = !all && replace ? replace.exec(line.text) : null;
    const match = own && own.index === 0 ? own : other && other.index === 0 ? other : null;
    const strip = match ? match[0].length : (/^\s*/.exec(line.text)?.[0].length ?? 0);
    const indent = /^\s*/.exec(line.text.slice(0, strip))?.[0] ?? "";
    const insert = all ? indent : indent + (typeof prefix === "function" ? prefix(index) : prefix);
    changes.push({ from: line.from, to: line.from + strip, insert });
  });
  view.dispatch({ changes, userEvent: "input.format", scrollIntoView: true });
  view.focus();
  return true;
}

/** Sets heading level `level` (0 = paragraph) on the selected lines; the same level again removes it. */
export function setHeading(view: EditorView, level: number): boolean {
  if (view.state.readOnly) return false;
  const lines = selectedLines(view.state);
  const marker = level > 0 ? `${"#".repeat(level)} ` : "";
  const same = level > 0 && lines.every(line => line.text.startsWith(marker) && !line.text.startsWith(`${marker.trim()}#`));
  const changes = lines.map(line => {
    const current = /^#{1,6}\s+/.exec(line.text)?.[0].length ?? 0;
    return { from: line.from, to: line.from + current, insert: same ? "" : marker };
  });
  view.dispatch({ changes, userEvent: "input.format", scrollIntoView: true });
  view.focus();
  return true;
}

export function insertText(view: EditorView, text: string): boolean {
  if (view.state.readOnly) return false;
  view.dispatch(view.state.replaceSelection(text), { scrollIntoView: true, userEvent: "input" });
  view.focus();
  return true;
}

/**
 * Inserts a block (table, fence, callout…) on its own lines at the cursor, replacing the selection: blank lines
 * are added before/after when the neighbours are not empty. `cursor` is an offset inside `block` to place the
 * caret (default: end); `select` selects `[cursor, cursor + select)`.
 */
export function insertBlock(view: EditorView, block: string, cursor = block.length, select = 0): boolean {
  if (view.state.readOnly) return false;
  const { state } = view;
  const sel = state.selection.main;
  const startLine = state.doc.lineAt(sel.from);
  const endLine = state.doc.lineAt(sel.to);
  // An empty current line is replaced; otherwise the block goes after the current line(s).
  const replaceLine = startLine.number === endLine.number && !startLine.text.trim();
  const from = replaceLine ? startLine.from : sel.empty ? endLine.to : sel.from;
  const to = replaceLine ? startLine.to : sel.empty ? endLine.to : sel.to;
  const before = state.sliceDoc(0, from);
  const after = state.sliceDoc(to);
  const lead = !before ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const trail = !after ? "\n" : after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
  const insert = lead + block + trail;
  const anchor = from + lead.length + cursor;
  view.dispatch({ changes: { from, to, insert }, selection: EditorSelection.range(anchor, anchor + select), scrollIntoView: true, userEvent: "input.format" });
  view.focus();
  return true;
}

export type CalloutKind = "note" | "tip" | "important" | "warning" | "caution";
export const CALLOUT_KINDS: CalloutKind[] = ["note", "tip", "important", "warning", "caution"];

/** `rows` × `cols` GFM table skeleton with header labels. */
export function tableSkeleton(rows: number, cols: number, header: (i: number) => string, cell = ""): string {
  const r = Math.max(1, Math.min(rows, 50));
  const c = Math.max(1, Math.min(cols, 12));
  const head = Array.from({ length: c }, (_, i) => header(i));
  const width = head.map(h => Math.max(3, displayWidth(h), displayWidth(cell)));
  const line = (cells: string[]) => `| ${cells.map((x, i) => x + " ".repeat(Math.max(0, width[i]! - displayWidth(x)))).join(" | ")} |`;
  return [line(head), `| ${width.map(w => "-".repeat(w)).join(" | ")} |`, ...Array.from({ length: r }, () => line(Array(c).fill(cell)))].join("\n");
}

/** Monospace display width: CJK and full-width characters count as 2 (keeps tables aligned in the editor). */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    width += (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1faff) || (code >= 0x20000 && code <= 0x3fffd) ? 2 : 1;
  }
  return width;
}

/** Next free footnote label (`[^1]`, `[^2]`…) in the document. */
export function nextFootnote(doc: string): number {
  let max = 0;
  for (const m of doc.matchAll(/\[\^(\d+)\]/g)) max = Math.max(max, Number(m[1]));
  return max + 1;
}

/** Escapes text for use inside `[…]` link/image labels. */
export const escapeLabel = (text: string) => text.replace(/([\[\]\\])/g, "\\$1").replace(/\n+/g, " ");
/** URLs with spaces or parentheses go in `<…>` so the Markdown stays valid. */
export const formatUrl = (url: string) => (/[\s()<>]/.test(url) ? `<${url.replace(/[<>]/g, encodeURIComponent)}>` : url);

export const md = {
  bold: (v: EditorView, ph: string) => wrap(v, "**", "**", ph),
  italic: (v: EditorView, ph: string) => wrap(v, "*", "*", ph),
  strike: (v: EditorView, ph: string) => wrap(v, "~~", "~~", ph),
  inlineCode: (v: EditorView) => wrap(v, "`", "`", "code"),
  heading: (v: EditorView) => prefixLines(v, "## ", /^#{1,6}\s+/),
  setHeading,
  list: (v: EditorView) => prefixLines(v, "- ", /^\s*[-*+]\s+(?!\[[ xX]\])/, LIST_MARKER),
  ordered: (v: EditorView) => prefixLines(v, i => `${i + 1}. `, /^\s*\d+[.)]\s+/, LIST_MARKER),
  task: (v: EditorView) => prefixLines(v, "- [ ] ", /^\s*[-*+]\s+\[[ xX]\]\s+/, LIST_MARKER),
  quote: (v: EditorView) => prefixLines(v, "> ", /^\s*>\s?/),
  code(v: EditorView) {
    const sel = v.state.selection.main;
    return v.state.sliceDoc(sel.from, sel.to).includes("\n") ? md.codeBlock(v, "") : wrap(v, "`", "`", "code");
  },
  math(v: EditorView) {
    const sel = v.state.selection.main;
    return v.state.sliceDoc(sel.from, sel.to).includes("\n") ? md.mathBlock(v) : wrap(v, "$", "$", "x^2");
  },
  /** Fenced code block; wraps the selected lines when there is a selection. */
  codeBlock(v: EditorView, lang: string) {
    const sel = v.state.selection.main;
    const body = v.state.sliceDoc(sel.from, sel.to);
    const fence = /```/.test(body) ? "````" : "```";
    return insertBlock(v, `${fence}${lang}\n${body}\n${fence}`, fence.length + lang.length + 1, body.length);
  },
  mathBlock(v: EditorView) {
    const sel = v.state.selection.main;
    const body = v.state.sliceDoc(sel.from, sel.to) || "E = mc^2";
    return insertBlock(v, `$$\n${body}\n$$`, 3, body.length);
  },
  hr: (v: EditorView) => insertBlock(v, "---"),
  table: (v: EditorView, rows: number, cols: number, header: (i: number) => string) => insertBlock(v, tableSkeleton(rows, cols, header), 2, header(0).length),
  callout(v: EditorView, kind: CalloutKind, placeholder: string) {
    const sel = v.state.selection.main;
    const body = v.state.sliceDoc(sel.from, sel.to) || placeholder;
    const marker = `> [!${kind.toUpperCase()}]\n`;
    const text = marker + body.split("\n").map(line => `> ${line}`).join("\n");
    return insertBlock(v, text, marker.length + 2, sel.empty ? placeholder.length : 0);
  },
  mermaid(v: EditorView) {
    const sample = "flowchart LR\n  A[資料] --> B[模型]\n  B --> C[結果]";
    return insertBlock(v, "```mermaid\n" + sample + "\n```", 11, sample.length);
  },
  footnote(v: EditorView, placeholder: string) {
    if (v.state.readOnly) return false;
    const n = nextFootnote(v.state.doc.toString());
    const sel = v.state.selection.main;
    const ref = `[^${n}]`;
    const end = v.state.doc.length;
    const tail = v.state.sliceDoc(Math.max(0, end - 2));
    const defLead = !end ? "" : tail.endsWith("\n\n") ? "" : tail.endsWith("\n") ? "\n" : "\n\n";
    const def = `${defLead}${ref}: ${placeholder}`;
    const defStart = end + ref.length + defLead.length + ref.length + 2;
    v.dispatch({
      changes: [{ from: sel.to, insert: ref }, { from: end, insert: def }],
      selection: EditorSelection.range(defStart, defStart + placeholder.length),
      scrollIntoView: true,
      userEvent: "input.format",
    });
    v.focus();
    return true;
  },
  /** `[text](url)`; without a URL the caret lands in `(https://)` for typing. */
  link(v: EditorView, ph: string, url?: string, text?: string) {
    if (v.state.readOnly) return false;
    const sel = v.state.selection.main;
    const label = escapeLabel(text || v.state.sliceDoc(sel.from, sel.to) || ph);
    if (url) {
      const insert = `[${label}](${formatUrl(url)})`;
      v.dispatch({ changes: { from: sel.from, to: sel.to, insert }, selection: EditorSelection.cursor(sel.from + insert.length), userEvent: "input.format", scrollIntoView: true });
    } else {
      const insert = `[${label}](https://)`;
      v.dispatch({ changes: { from: sel.from, to: sel.to, insert }, selection: EditorSelection.range(sel.from + label.length + 3, sel.from + insert.length - 1), userEvent: "input.format" });
    }
    v.focus();
    return true;
  },
  image(v: EditorView, url: string, alt: string, at?: number) {
    if (v.state.readOnly) return false;
    const sel = v.state.selection.main;
    const from = at ?? sel.from;
    const to = at ?? sel.to;
    const insert = `![${escapeLabel(alt)}](${formatUrl(url)})`;
    v.dispatch({ changes: { from, to, insert }, selection: EditorSelection.cursor(from + insert.length), userEvent: "input.image", scrollIntoView: true });
    v.focus();
    return true;
  },
};
