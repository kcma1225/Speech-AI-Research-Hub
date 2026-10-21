import { Prec, RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, keymap, WidgetType, type DecorationSet } from "@codemirror/view";
import type { LiveHunk } from "./types.ts";

/**
 * Inline suggestion review for CodeMirror: replaced text is struck through in red, the proposed text is shown
 * in green right after it with 接受 / 拒絕 buttons. Feed it with `setHunks` (positions already resolved against
 * the editor document, e.g. from Yjs anchors by SuggestionReview). Keyboard: Alt-] / Alt-[ next / previous hunk,
 * Alt-Enter accept, Alt-Backspace reject (the hunk at or after the cursor).
 */
export type SuggestActions = {
  accept(h: LiveHunk): void;
  reject(h: LiveHunk): void;
  /** Labels (i18n) and whether the viewer may decide. */
  labels: { accept: string; reject: string; stale: string; by: (h: LiveHunk) => string };
  canReview: () => boolean;
};

export const setHunks = StateEffect.define<{ hunks: LiveHunk[]; focus: string | null }>();

class InsertWidget extends WidgetType {
  constructor(
    readonly hunk: LiveHunk,
    readonly actions: SuggestActions,
    readonly focused: boolean,
  ) {
    super();
  }
  eq(other: InsertWidget) {
    return (
      other.hunk.hunkId === this.hunk.hunkId &&
      other.hunk.after === this.hunk.after &&
      other.hunk.stale === this.hunk.stale &&
      other.focused === this.focused &&
      other.actions.canReview() === this.actions.canReview()
    );
  }
  toDOM() {
    const wrap = document.createElement("span");
    wrap.className = `cm-sugg-ins${this.hunk.stale ? " cm-sugg-is-stale" : ""}${this.focused ? " cm-sugg-focus" : ""}`;
    wrap.dataset.hunk = this.hunk.hunkId;
    // A stale hunk only shows its label and 拒絕 (its text is in the side list); the proposal no longer fits here.
    if (this.hunk.after && !this.hunk.stale) {
      const text = document.createElement("span");
      text.className = "cm-sugg-ins-text";
      text.textContent = this.hunk.after;
      wrap.append(text);
    }
    const bar = document.createElement("span");
    bar.className = "cm-sugg-bar";
    bar.title = this.actions.labels.by(this.hunk);
    if (this.hunk.stale) {
      const s = document.createElement("span");
      s.className = "cm-sugg-stale-label";
      s.textContent = this.actions.labels.stale;
      bar.append(s);
    }
    if (this.actions.canReview()) {
      if (!this.hunk.stale) bar.append(this.button("accept", this.actions.labels.accept, () => this.actions.accept(this.hunk)));
      bar.append(this.button("reject", this.actions.labels.reject, () => this.actions.reject(this.hunk)));
    }
    wrap.append(bar);
    return wrap;
  }
  private button(kind: string, label: string, run: () => void) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `cm-sugg-btn cm-sugg-${kind}`;
    b.textContent = label;
    b.addEventListener("mousedown", e => e.preventDefault());
    b.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      run();
    });
    return b;
  }
  ignoreEvent() {
    return true;
  }
}

function build(hunks: LiveHunk[], focus: string | null, docLength: number, actions: SuggestActions): DecorationSet {
  const items: { from: number; to: number; deco: Decoration }[] = [];
  for (const h of hunks) {
    const from = Math.max(0, Math.min(h.from, docLength));
    const to = Math.max(from, Math.min(h.to, docLength));
    if (to > from) items.push({ from, to, deco: Decoration.mark({ class: h.stale ? "cm-sugg-del cm-sugg-is-stale" : "cm-sugg-del", attributes: { "data-hunk": h.hunkId } }) });
    items.push({ from: to, to, deco: Decoration.widget({ widget: new InsertWidget(h, actions, focus === h.hunkId), side: 1 }) });
  }
  items.sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const i of items) builder.add(i.from, i.to, i.deco);
  return builder.finish();
}

const hunksField = StateField.define<LiveHunk[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setHunks)) return e.value.hunks;
    if (!tr.docChanged) return value;
    // Keep positions roughly right between two refreshes from the anchors. Positions come from the Yjs text and
    // can be ahead of the editor (hunks set before the first sync reached CodeMirror): clamp before mapping, or
    // mapPos throws and the Yjs → editor sync transaction is lost (empty editor over a non-empty document).
    const len = tr.startState.doc.length;
    const clamp = (n: number) => Math.max(0, Math.min(n, len));
    return value.map(h => ({ ...h, from: tr.changes.mapPos(clamp(h.from), 1), to: tr.changes.mapPos(clamp(h.to), -1) }));
  },
});
const focusField = StateField.define<string | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setHunks)) return e.value.focus;
    return value;
  },
});

function hunkNear(view: EditorView, dir: 1 | -1 | 0) {
  const hunks = [...view.state.field(hunksField)].sort((a, b) => a.from - b.from);
  if (!hunks.length) return null;
  const pos = view.state.selection.main.head;
  if (dir === 0) return hunks.find(h => pos >= h.from && pos <= h.to) ?? hunks.find(h => h.from >= pos) ?? null;
  if (dir === 1) return hunks.find(h => h.from > pos) ?? hunks[0]!;
  return [...hunks].reverse().find(h => h.to < pos) ?? hunks.at(-1)!;
}

export function revealHunk(view: EditorView, h: LiveHunk) {
  view.dispatch({ selection: { anchor: h.from }, effects: EditorView.scrollIntoView(h.from, { y: "center" }) });
}

/** The CodeMirror extension; `actions` is read at call time (labels and permission may change). */
export function suggestionReview(actions: SuggestActions): Extension {
  const decorations = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(_value, tr) {
      return build(tr.state.field(hunksField), tr.state.field(focusField), tr.state.doc.length, actions);
    },
    provide: f => EditorView.decorations.from(f),
  });
  return [
    hunksField,
    focusField,
    decorations,
    Prec.high(
      keymap.of([
        { key: "Alt-]", run: v => (hunkNear(v, 1) ? (revealHunk(v, hunkNear(v, 1)!), true) : false) },
        { key: "Alt-[", run: v => (hunkNear(v, -1) ? (revealHunk(v, hunkNear(v, -1)!), true) : false) },
        {
          key: "Alt-Enter",
          run: v => {
            const h = hunkNear(v, 0);
            if (!h || h.stale || !actions.canReview()) return false;
            actions.accept(h);
            return true;
          },
        },
        {
          key: "Alt-Backspace",
          run: v => {
            const h = hunkNear(v, 0);
            if (!h || !actions.canReview()) return false;
            actions.reject(h);
            return true;
          },
        },
      ]),
    ),
    suggestTheme,
  ];
}

const suggestTheme = EditorView.baseTheme({
  ".cm-sugg-del": {
    backgroundColor: "color-mix(in srgb, var(--danger) 13%, transparent)",
    textDecoration: "line-through",
    textDecorationColor: "color-mix(in srgb, var(--danger) 70%, transparent)",
    borderRadius: "3px",
    animation: "cm-sugg-in var(--sugg-dur, 200ms) ease-out",
  },
  ".cm-sugg-del.cm-sugg-is-stale": { backgroundColor: "color-mix(in srgb, var(--ink-3) 14%, transparent)", textDecorationColor: "var(--ink-3)" },
  ".cm-sugg-ins": { whiteSpace: "pre-wrap" },
  ".cm-sugg-ins-text": {
    backgroundColor: "color-mix(in srgb, var(--success) 15%, transparent)",
    color: "color-mix(in srgb, var(--success) 75%, var(--ink))",
    borderRadius: "3px",
    animation: "cm-sugg-in var(--sugg-dur, 200ms) ease-out",
  },
  ".cm-sugg-is-stale .cm-sugg-ins-text": { backgroundColor: "color-mix(in srgb, var(--ink-3) 12%, transparent)", color: "var(--ink-3)" },
  ".cm-sugg-bar": { display: "inline-flex", gap: "4px", marginLeft: "6px", verticalAlign: "1px", whiteSpace: "nowrap" },
  ".cm-sugg-btn": {
    font: "600 11.5px/1 var(--font-sans, sans-serif)",
    height: "24px",
    minWidth: "40px",
    padding: "0 9px",
    borderRadius: "999px",
    border: "1px solid var(--line-2)",
    background: "var(--surface)",
    color: "var(--ink)",
    cursor: "pointer",
  },
  ".cm-sugg-btn:hover": { background: "var(--surface-3)" },
  ".cm-sugg-btn.cm-sugg-accept": { background: "var(--primary)", color: "var(--primary-ink)", borderColor: "var(--primary)" },
  ".cm-sugg-stale-label": { font: "500 11px/24px var(--font-sans, sans-serif)", color: "var(--ink-3)", padding: "0 4px" },
  ".cm-sugg-focus .cm-sugg-ins-text": { outline: "2px solid color-mix(in srgb, var(--success) 45%, transparent)", outlineOffset: "1px" },
  "@keyframes cm-sugg-in": { from: { opacity: "0" }, to: { opacity: "1" } },
  "@media (prefers-reduced-motion: reduce)": { ".cm-sugg-del, .cm-sugg-ins-text": { animation: "none" } },
});
