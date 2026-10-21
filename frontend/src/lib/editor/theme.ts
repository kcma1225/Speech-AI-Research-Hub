import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";

/**
 * Editor theme built on the app's CSS tokens (app.css), so light/dark follow `data-theme` without reconfiguring.
 * Fonts: the UI sans stack (Inter + Noto Sans TC) for prose modes, a monospace stack with CJK fallback for code.
 */
export function hubTheme(options: { mono?: boolean; fontSize?: number } = {}): Extension {
  const font = options.mono
    ? // Generic `monospace` before the CJK web font: where none of the named mono fonts exist (Linux, Android) Latin text
      // would otherwise fall back to the proportional Noto Sans TC. CJK glyphs still fall through to Noto.
      `ui-monospace, "SFMono-Regular", "JetBrains Mono", Menlo, Consolas, "Liberation Mono", "DejaVu Sans Mono", monospace, "Noto Sans TC Variable"`
    : `"Inter Variable", "Noto Sans TC Variable", ui-sans-serif, system-ui, sans-serif`;
  return [
    EditorView.theme({
      "&": {
        color: "var(--ink)",
        backgroundColor: "transparent",
        fontSize: `${options.fontSize ?? 15}px`,
        height: "100%",
      },
      "&.cm-focused": { outline: "none" },
      ".cm-scroller": { fontFamily: font, lineHeight: "1.75", overflowX: "auto" },
      ".cm-content": { padding: "14px 0 40vh", caretColor: "var(--ink)", minHeight: "100%" },
      ".cm-line": { padding: "0 18px", wordBreak: "break-word" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--ink)", borderLeftWidth: "2px" },
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
        { backgroundColor: "color-mix(in srgb, var(--hero-b) 45%, transparent) !important" },
      ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--surface-3) 55%, transparent)" },
      ".cm-gutters": { backgroundColor: "transparent", color: "var(--ink-3)", border: "none" },
      ".cm-placeholder": { color: "var(--ink-3)" },
      ".cm-panels": { backgroundColor: "var(--surface-2)", color: "var(--ink)", borderColor: "var(--line)" },
      ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--line)" },
      ".cm-panel.cm-search": { padding: "8px 10px", fontFamily: "inherit" },
      ".cm-panel.cm-search input, .cm-panel.cm-search button": { fontSize: "13px" },
      ".cm-textfield": { backgroundColor: "var(--surface)", border: "1px solid var(--line-2)", borderRadius: "8px", color: "var(--ink)", padding: "4px 8px" },
      ".cm-button": { backgroundImage: "none", backgroundColor: "var(--surface-3)", border: "1px solid var(--line-2)", borderRadius: "8px", color: "var(--ink)" },
      ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--pill-butter) 80%, transparent)" },
      ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--pill-peach)" },
      ".cm-tooltip": { backgroundColor: "var(--surface)", border: "1px solid var(--line-2)", borderRadius: "12px", boxShadow: "var(--shadow-pop)", color: "var(--ink)" },
      ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--surface-3)", color: "var(--ink)" },
      // Remote cursors (y-codemirror.next): label text readable on the user's colour in both themes.
      ".cm-ySelectionInfo": { color: "var(--surface)", fontFamily: `"Inter Variable", "Noto Sans TC Variable", sans-serif`, fontSize: "11px", fontWeight: "600", padding: "1px 5px", borderRadius: "6px 6px 6px 0", top: "-1.35em", opacity: "1" },
      ".cm-ySelectionCaret": { borderLeftWidth: "2px" },
    }),
    syntaxHighlighting(hubHighlight),
  ];
}

export const hubHighlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.32em", fontWeight: "700" },
  { tag: t.heading2, fontSize: "1.18em", fontWeight: "700" },
  { tag: [t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: "700" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "var(--pill-sky-ink)", textDecoration: "underline" },
  { tag: t.monospace, fontFamily: `ui-monospace, Menlo, Consolas, monospace`, color: "var(--pill-lilac-ink)" },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: "var(--ink-3)" },
  { tag: t.quote, color: "var(--ink-2)", fontStyle: "italic" },
  { tag: t.list, color: "var(--pill-peach-ink)" },
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword], color: "var(--pill-lilac-ink)" },
  { tag: [t.string, t.special(t.string)], color: "var(--pill-mint-ink)" },
  { tag: [t.number, t.bool, t.atom], color: "var(--pill-peach-ink)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--ink-3)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.macroName, t.tagName], color: "var(--pill-sky-ink)" },
  { tag: [t.typeName, t.className, t.attributeName], color: "var(--pill-butter-ink)" },
  { tag: t.invalid, color: "var(--danger)" },
]);
