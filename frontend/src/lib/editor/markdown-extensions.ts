import { mount, unmount } from "svelte";
import { search } from "@codemirror/search";
import { Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap, type KeyBinding, type ViewUpdate } from "@codemirror/view";
import { t } from "#lib/i18n.svelte.ts";
import type { EditorAction } from "./editor-actions.ts";
import { markdownPaste, type PasteOptions } from "./markdown-paste.ts";
import { slashCommands, type SlashItem } from "./markdown-slash.ts";
import { tableKeymap } from "./markdown-table.ts";
import SearchPanel from "./SearchPanel.svelte";

/**
 * Everything the rich Markdown editor adds on top of the shared CodeMirror base (`setup.ts`): the keymap of all
 * actions, the slash menu, table navigation, HTML → Markdown paste and image drop, our find & replace panel,
 * and `onHelp` (Mod-/). Pass the result as `extensions` to `CodeEditor` (read at mount).
 */
export type MarkdownExtrasOptions = PasteOptions & {
  actions: () => EditorAction[];
  onHelp?: () => void;
  onFullscreen?: () => void;
};

/** CodeMirror search panel rendered by `SearchPanel.svelte`. */
export function searchPanel(): Extension {
  return search({
    top: true,
    createPanel(view) {
      const dom = document.createElement("div");
      dom.className = "hub-search-panel";
      const listeners: ((u: ViewUpdate) => void)[] = [];
      const component = mount(SearchPanel, { target: dom, props: { view, registerUpdate: fn => listeners.push(fn) } });
      return {
        dom,
        top: true,
        update: u => listeners.forEach(fn => fn(u)),
        destroy: () => void unmount(component),
      };
    },
  });
}

const slashSections = () => ({ block: t("mdx.section.blocks"), inline: t("mdx.section.blocks"), insert: t("mdx.section.insert"), history: "", tools: "" });

export function markdownExtras(options: MarkdownExtrasOptions): Extension {
  const keys: KeyBinding[] = [];
  // Actions are read lazily (labels follow the current locale).
  const once = options.actions();
  for (const action of once) {
    if (!action.key || action.id === "undo" || action.id === "redo" || action.id === "find") continue;
    const id = action.id;
    keys.push({ key: action.key, preventDefault: true, run: v => options.actions().find(a => a.id === id)?.run(v) ?? false });
  }
  if (options.onHelp) keys.push({ key: "Mod-/", preventDefault: true, run: () => (options.onHelp!(), true) });
  if (options.onFullscreen) keys.push({ key: "Mod-Shift-f", preventDefault: true, run: () => (options.onFullscreen!(), true) });
  const slashItems = (): SlashItem[] => {
    const sections = slashSections();
    return options
      .actions()
      .filter(a => a.slash)
      .map(a => ({ id: a.id, label: a.label, keywords: a.slash!, section: sections[a.group], run: a.run }));
  };
  return [
    Prec.high(keymap.of(keys)),
    Prec.high(tableKeymap),
    slashCommands(slashItems),
    markdownPaste(options),
    searchPanel(),
    EditorView.theme({
      ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--line)" },
      ".hub-slash-menu": { padding: "4px", minWidth: "220px" },
      ".hub-slash-menu > ul": { maxHeight: "min(320px, 50vh) !important", fontFamily: "inherit !important" },
      ".hub-slash-menu > ul > li": { padding: "6px 10px !important", borderRadius: "8px", lineHeight: "1.4" },
      ".hub-slash-menu > ul > completion-section": { display: "block", padding: "6px 10px 2px", fontSize: "11px", fontWeight: "600", color: "var(--ink-3)", borderBottom: "none" },
      ".hub-slash-menu .cm-completionLabel": { fontSize: "13.5px" },
      ".hub-slash-menu .cm-completionDetail": { marginLeft: "8px", fontStyle: "normal", color: "var(--ink-3)", fontSize: "12px" },
      ".cm-completionMatchedText": { textDecoration: "none", fontWeight: "650" },
    }),
  ];
}
