import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { drawSelection, dropCursor, EditorView, highlightActiveLine, keymap, placeholder as placeholderExt, rectangularSelection } from "@codemirror/view";
import type { Awareness } from "y-protocols/awareness";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import * as Y from "yjs";
import { md } from "./markdown-commands.ts";
import { hubTheme } from "./theme.ts";

export type EditorLanguage = "markdown" | "plain" | Extension;

export type EditorOptions = {
  /** Collaborative mode: bind to this Y.Text (+ awareness for remote cursors). The document comes from Yjs. */
  collab?: { text: Y.Text; awareness: Awareness | null };
  /** Initial text when not collaborative. */
  doc?: string;
  language?: EditorLanguage;
  readOnly?: boolean;
  fontSize?: number;
  /** Monospace font (code); prose modes use the UI font. */
  mono?: boolean;
  placeholder?: string;
  /** aria-label of the editable area. */
  label?: string;
  /** Called with the text after every change (debounce yourself for heavy work). */
  onChange?: (text: string, view: EditorView) => void;
  /** Placeholder text for formatting commands (e.g. "粗體文字"). */
  formatText?: { bold: string; italic: string; link: string };
  extensions?: Extension[];
};

/** Compartments that callers reconfigure at runtime (`view.dispatch({effects: c.readOnly.reconfigure(...)})`). */
export type EditorCompartments = { readOnly: Compartment; theme: Compartment; extra: Compartment };

export const readOnlyExtension = (readOnly: boolean): Extension => [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];

function languageExtension(language: EditorLanguage | undefined): Extension {
  if (!language || language === "markdown") return markdown({ base: markdownLanguage, codeLanguages: [] });
  if (language === "plain") return [];
  return language;
}

/**
 * The shared CodeMirror 6 base: theme from our tokens, CJK-safe defaults (no input handlers that fight IME
 * composition, soft wrapping), history (or the Yjs undo manager in collaborative mode), search, Markdown
 * shortcuts (Mod-B/I/K/E/Shift-M) and the y-codemirror.next binding with remote cursors.
 */
export function createEditorState(options: EditorOptions, compartments: EditorCompartments): EditorState {
  const ph = options.formatText ?? { bold: "bold", italic: "italic", link: "link" };
  const formatKeys = keymap.of([
    { key: "Mod-b", run: v => md.bold(v, ph.bold) },
    { key: "Mod-i", run: v => md.italic(v, ph.italic) },
    { key: "Mod-k", run: v => md.link(v, ph.link) },
    { key: "Mod-e", run: v => md.code(v) },
    { key: "Mod-Shift-m", run: v => md.math(v) },
  ]);
  const collab = options.collab;
  const extensions: Extension[] = [
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    bracketMatching(),
    indentOnInput(),
    closeBrackets(),
    EditorView.lineWrapping,
    search({ top: true }),
    languageExtension(options.language),
    collab ? [] : history(),
    keymap.of([
      ...(options.language === "markdown" || !options.language ? [] : [indentWithTab]),
      ...closeBracketsKeymap,
      ...(collab ? yUndoManagerKeymap : historyKeymap),
      ...searchKeymap,
      ...defaultKeymap,
    ]),
    options.language === "markdown" || !options.language ? formatKeys : [],
    compartments.theme.of(hubTheme({ mono: options.mono, fontSize: options.fontSize })),
    compartments.readOnly.of(readOnlyExtension(!!options.readOnly)),
    compartments.extra.of(options.extensions ?? []),
    options.placeholder ? placeholderExt(options.placeholder) : [],
    EditorView.contentAttributes.of({ "aria-label": options.label ?? "", "aria-multiline": "true", spellcheck: "false", autocapitalize: "off" }),
    options.onChange
      ? EditorView.updateListener.of(update => {
          if (update.docChanged) options.onChange!(update.state.doc.toString(), update.view);
        })
      : [],
  ];
  if (collab) extensions.push(yCollab(collab.text, collab.awareness, { undoManager: new Y.UndoManager(collab.text) }));
  return EditorState.create({ doc: collab ? collab.text.toString() : (options.doc ?? ""), extensions });
}

export function newCompartments(): EditorCompartments {
  return { readOnly: new Compartment(), theme: new Compartment(), extra: new Compartment() };
}
