import { EditorSelection, type ChangeSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/**
 * Markdown formatting commands for CodeMirror (toolbar buttons and Mod-B/I/K/E/M). Each returns true when it
 * handled the view (CodeMirror command signature) and works on every selection range.
 */
export function wrap(view: EditorView, before: string, after: string, placeholder: string): boolean {
  if (view.state.readOnly) return false;
  const tr = view.state.changeByRange(range => {
    const text = view.state.sliceDoc(range.from, range.to);
    // Toggle off when the selection is already wrapped.
    if (text.startsWith(before) && text.endsWith(after) && text.length >= before.length + after.length) {
      const inner = text.slice(before.length, text.length - after.length);
      return { changes: { from: range.from, to: range.to, insert: inner }, range: EditorSelection.range(range.from, range.from + inner.length) };
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

/** Toggles a line prefix (headings, lists, task items, quotes) on every selected line. */
export function prefixLines(view: EditorView, prefix: string, pattern: RegExp): boolean {
  if (view.state.readOnly) return false;
  const { state } = view;
  const lines = new Map<number, { from: number; text: string }>();
  for (const range of state.selection.ranges) {
    for (let pos = range.from; pos <= range.to; ) {
      const line = state.doc.lineAt(pos);
      lines.set(line.from, { from: line.from, text: line.text });
      if (line.to + 1 > range.to) break;
      pos = line.to + 1;
    }
  }
  const all = [...lines.values()].every(line => pattern.test(line.text));
  const changes: ChangeSpec[] = [];
  for (const line of lines.values()) {
    const match = pattern.exec(line.text);
    const strip = match && match.index === 0 ? match[0].length : 0;
    changes.push({ from: line.from, to: line.from + strip, insert: all ? "" : prefix });
  }
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

export const md = {
  bold: (v: EditorView, ph: string) => wrap(v, "**", "**", ph),
  italic: (v: EditorView, ph: string) => wrap(v, "*", "*", ph),
  heading: (v: EditorView) => prefixLines(v, "## ", /^#{1,6}\s+/),
  list: (v: EditorView) => prefixLines(v, "- ", /^\s*[-*+]\s+(?!\[[ xX]\])/),
  ordered: (v: EditorView) => prefixLines(v, "1. ", /^\s*\d+[.)]\s+/),
  task: (v: EditorView) => prefixLines(v, "- [ ] ", /^\s*[-*+]\s+\[[ xX]\]\s+/),
  quote: (v: EditorView) => prefixLines(v, "> ", /^\s*>\s?/),
  code(v: EditorView) {
    const sel = v.state.selection.main;
    return v.state.sliceDoc(sel.from, sel.to).includes("\n") ? wrap(v, "```\n", "\n```", "") : wrap(v, "`", "`", "code");
  },
  math(v: EditorView) {
    const sel = v.state.selection.main;
    return v.state.sliceDoc(sel.from, sel.to).includes("\n") ? wrap(v, "$$\n", "\n$$", "") : wrap(v, "$", "$", "x^2");
  },
  link(v: EditorView, ph: string) {
    if (v.state.readOnly) return false;
    const sel = v.state.selection.main;
    const text = v.state.sliceDoc(sel.from, sel.to) || ph;
    const insert = `[${text}](https://)`;
    v.dispatch({ changes: { from: sel.from, to: sel.to, insert }, selection: EditorSelection.range(sel.from + text.length + 3, sel.from + insert.length - 1), userEvent: "input.format" });
    v.focus();
    return true;
  },
};
