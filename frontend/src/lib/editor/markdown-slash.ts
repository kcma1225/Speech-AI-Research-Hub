import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/**
 * Slash command menu: typing `/` at the start of a line or after a space opens a list of blocks to insert
 * (filtered by what follows, matching Chinese and English keywords). Built on @codemirror/autocomplete, so it is
 * keyboard driven (↑/↓, Enter, Esc) and announced to screen readers.
 */
export type SlashItem = {
  id: string;
  label: string;
  /** Extra words to match (both languages, e.g. "table 表格 grid"). */
  keywords: string;
  detail?: string;
  /** Section shown as a header in the menu. */
  section: string;
  run: (view: EditorView) => boolean;
};

/** Ranks `items` for `query` (prefix > word start > substring; empty query keeps the order). */
export function filterSlash(items: SlashItem[], query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  const scored: { item: SlashItem; score: number; index: number }[] = [];
  items.forEach((item, index) => {
    const label = item.label.toLowerCase();
    const words = `${item.id} ${item.keywords}`.toLowerCase();
    let score = -1;
    if (label.startsWith(q) || item.id.startsWith(q)) score = 3;
    else if (words.split(/\s+/).some(w => w.startsWith(q))) score = 2;
    else if (label.includes(q) || words.includes(q)) score = 1;
    if (score > 0) scored.push({ item, score, index });
  });
  return scored.sort((a, b) => b.score - a.score || a.index - b.index).map(s => s.item);
}

export function slashSource(getItems: () => SlashItem[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const match = context.matchBefore(/(?:^|[\s　])\/[^\s/]{0,24}$/u);
    if (!match) return null;
    const slash = match.text.lastIndexOf("/");
    const from = match.from + slash;
    // Not inside a fenced code block / math block: look for an odd number of fences above.
    const before = context.state.sliceDoc(Math.max(0, from - 20000), from);
    if ((before.match(/^\s{0,3}(```|~~~)/gm)?.length ?? 0) % 2 === 1) return null;
    const query = match.text.slice(slash + 1);
    const items = filterSlash(getItems(), query);
    if (!items.length) return null;
    const options: Completion[] = items.map((item, i) => ({
      label: item.label,
      detail: item.detail,
      section: item.section,
      // Keep our ranking: CodeMirror sorts by boost when filter is off.
      boost: 99 - Math.min(i, 198),
      apply: (view: EditorView, _c: Completion, a: number, b: number) => {
        view.dispatch({ changes: { from: a, to: b, insert: "" }, userEvent: "delete.slash" });
        item.run(view);
      },
    }));
    return { from, to: context.pos, options, filter: false };
  };
}

/** The autocompletion extension with the slash source (markdown editors only). */
export function slashCommands(getItems: () => SlashItem[]): Extension {
  return autocompletion({
    override: [slashSource(getItems)],
    activateOnTyping: true,
    icons: false,
    closeOnBlur: true,
    maxRenderedOptions: 40,
    tooltipClass: () => "hub-slash-menu",
  });
}
