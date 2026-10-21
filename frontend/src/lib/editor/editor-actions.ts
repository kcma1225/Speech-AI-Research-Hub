import type { Component } from "svelte";
import { redo as cmRedo, redoDepth as cmRedoDepth, undo as cmUndo, undoDepth as cmUndoDepth } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { ySyncFacet, yUndoManagerKeymap } from "y-codemirror.next";
import {
  Bold, Code, FileCode, Superscript, Heading1, Heading2, Heading3, Heading4, Image, Italic, Link, List, ListChecks, ListOrdered, Minus, Pilcrow,
  Quote, Redo2, Search, Sigma, SquareFunction, Strikethrough, Table, Undo2, Workflow, MessageSquareWarning, Lightbulb, Info, TriangleAlert, OctagonAlert,
} from "@lucide/svelte";
import { t } from "#lib/i18n.svelte.ts";
import type { MessageKey } from "#lib/messages.ts";
import { md, type CalloutKind } from "./markdown-commands.ts";

/**
 * Every Markdown editor action in one list: the toolbar, the slash menu and the shortcut sheet are generated from
 * it, so labels, icons and keys stay consistent. `ctx` opens the dialogs that need input (link, table, code, image).
 */
export type ActionContext = {
  openLink: (view: EditorView) => void;
  openTable: (view: EditorView) => void;
  openCode: (view: EditorView) => void;
  /** Image upload (null when the editor has nowhere to store images: then the link dialog inserts a URL). */
  pickImage: ((view: EditorView) => void) | null;
};

/** Trailing toolbar buttons supplied by the host (outline, import, shortcuts, fullscreen…). */
export type ToolItem = { id: string; label: string; icon: Component; run: () => void; active?: boolean; key?: string; disabled?: boolean };

export type EditorAction = {
  id: string;
  label: string;
  icon: Component;
  group: "history" | "inline" | "block" | "insert" | "tools";
  /** CodeMirror key (e.g. "Mod-b"), shown in titles and the shortcut sheet. */
  key?: string;
  /** Slash-menu entry (keywords in both languages). */
  slash?: string;
  run: (view: EditorView) => boolean;
  /** Toolbar: only enabled when this returns true. */
  enabled?: (state: EditorState) => boolean;
};

const isCollab = (state: EditorState) => !!state.facet(ySyncFacet);
const yRun = (key: string) => yUndoManagerKeymap.find(k => k.key === key)!.run!;
export const editorUndo = (v: EditorView) => (isCollab(v.state) ? yRun("Mod-z")(v) : cmUndo(v));
export const editorRedo = (v: EditorView) => (isCollab(v.state) ? yRun("Mod-y")(v) : cmRedo(v));

const calloutIcons: Record<CalloutKind, Component> = { note: Info, tip: Lightbulb, important: MessageSquareWarning, warning: TriangleAlert, caution: OctagonAlert };

export function editorActions(ctx: ActionContext): EditorAction[] {
  const heading = (level: number, icon: Component): EditorAction => ({
    id: `h${level}`,
    label: t(`mdx.heading${level}` as MessageKey),
    icon,
    group: "block",
    key: `Mod-Alt-${level}`,
    slash: `h${level} heading title 標題 ${"#".repeat(level)}`,
    run: v => md.setHeading(v, level),
  });
  return [
    { id: "undo", label: t("mdx.undo"), icon: Undo2, group: "history", key: "Mod-z", run: editorUndo, enabled: s => (isCollab(s) ? true : cmUndoDepth(s) > 0) },
    { id: "redo", label: t("mdx.redo"), icon: Redo2, group: "history", key: "Mod-Shift-z", run: editorRedo, enabled: s => (isCollab(s) ? true : cmRedoDepth(s) > 0) },
    heading(1, Heading1),
    heading(2, Heading2),
    heading(3, Heading3),
    heading(4, Heading4),
    { id: "paragraph", label: t("mdx.paragraph"), icon: Pilcrow, group: "block", key: "Mod-Alt-0", slash: "paragraph text 內文 段落", run: v => md.setHeading(v, 0) },
    { id: "bold", label: t("md.bold"), icon: Bold, group: "inline", key: "Mod-b", run: v => md.bold(v, t("md.boldText")) },
    { id: "italic", label: t("md.italic"), icon: Italic, group: "inline", key: "Mod-i", run: v => md.italic(v, t("md.italicText")) },
    { id: "strike", label: t("mdx.strike"), icon: Strikethrough, group: "inline", key: "Mod-Shift-x", run: v => md.strike(v, t("mdx.strikeText")) },
    { id: "code", label: t("mdx.inlineCode"), icon: Code, group: "inline", key: "Mod-e", run: md.code },
    { id: "link", label: t("md.link"), icon: Link, group: "inline", key: "Mod-k", slash: "link url 連結 網址", run: v => (ctx.openLink(v), true) },
    { id: "bullet", label: t("md.list"), icon: List, group: "block", key: "Mod-Shift-8", slash: "bullet list ul 項目 清單", run: md.list },
    { id: "ordered", label: t("editor.ordered"), icon: ListOrdered, group: "block", key: "Mod-Shift-7", slash: "numbered ordered list ol 編號 清單", run: md.ordered },
    { id: "task", label: t("md.task"), icon: ListChecks, group: "block", key: "Mod-Shift-9", slash: "todo task checkbox 待辦 勾選", run: md.task },
    { id: "quote", label: t("editor.quote"), icon: Quote, group: "block", key: "Mod-Shift-.", slash: "quote blockquote 引言 引用", run: md.quote },
    { id: "image", label: t("mdx.image"), icon: Image, group: "insert", slash: "image picture photo 圖片 照片", run: v => (ctx.pickImage ? ctx.pickImage(v) : ctx.openLink(v), true) },
    { id: "table", label: t("mdx.table"), icon: Table, group: "insert", slash: "table grid 表格", run: v => (ctx.openTable(v), true) },
    { id: "codeblock", label: t("mdx.codeBlock"), icon: FileCode, group: "insert", key: "Mod-Alt-c", slash: "code block fence 程式碼 區塊", run: v => (ctx.openCode(v), true) },
    { id: "math", label: t("mdx.mathInline"), icon: Sigma, group: "insert", key: "Mod-Shift-m", slash: "math inline latex katex 數學 公式 行內", run: md.math },
    { id: "mathblock", label: t("mdx.mathBlock"), icon: SquareFunction, group: "insert", slash: "math block equation 數學 公式 方程式 區塊", run: md.mathBlock },
    { id: "hr", label: t("mdx.hr"), icon: Minus, group: "insert", slash: "divider hr rule line 分隔線", run: md.hr },
    { id: "footnote", label: t("mdx.footnote"), icon: Superscript, group: "insert", slash: "footnote note reference 註腳 腳註", run: v => md.footnote(v, t("mdx.footnoteText")) },
    ...(["note", "tip", "important", "warning", "caution"] as CalloutKind[]).map(
      (kind): EditorAction => ({
        id: `callout-${kind}`,
        label: t("mdx.calloutOf", { kind: t(`mdx.callout.${kind}` as MessageKey) }),
        icon: calloutIcons[kind],
        group: "insert",
        slash: `callout admonition ${kind} 提示 標註 ${t(`mdx.callout.${kind}` as MessageKey)}`,
        run: v => md.callout(v, kind, t("mdx.calloutText")),
      }),
    ),
    { id: "mermaid", label: t("mdx.mermaid"), icon: Workflow, group: "insert", slash: "mermaid diagram flowchart chart 圖表 流程圖", run: md.mermaid },
    { id: "find", label: t("mdx.find"), icon: Search, group: "tools", key: "Mod-f", run: v => openSearchPanel(v) },
  ];
}

/** "Mod-Shift-x" → "Ctrl+Shift+X" / "⌘⇧X". */
export function formatKey(key: string): string {
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const parts = key.split("-").map(p => (p === "" ? "-" : p));
  // "Mod-Shift-." splits fine; "Mod--" would not occur.
  const names = parts.map(p => {
    if (p === "Mod") return mac ? "⌘" : "Ctrl";
    if (p === "Shift") return mac ? "⇧" : "Shift";
    if (p === "Alt") return mac ? "⌥" : "Alt";
    if (p === "Enter") return mac ? "↩" : "Enter";
    return p.length === 1 ? p.toUpperCase() : p;
  });
  return mac ? names.join("") : names.join("+");
}
