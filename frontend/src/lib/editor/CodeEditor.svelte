<script lang="ts">
  import { onMount } from "svelte";
  import { EditorView } from "@codemirror/view";
  import { t } from "#lib/i18n.svelte.ts";
  import { hubTheme } from "./theme.ts";
  import { createEditorState, newCompartments, readOnlyExtension, type EditorOptions } from "./setup.ts";

  /**
   * Shared CodeMirror 6 editor (notes, Quarto sources, LaTeX). Collaborative when `collab` is given (the text
   * lives in the Y.Text; `value` is ignored), else a plain controlled editor (`value` is bindable).
   * `view` is bindable for toolbars and extensions (suggestion decorations, cursor insertions).
   * `collab`, `language` and `extensions` are read once at mount; re-key the component to change them.
   */
  let {
    view = $bindable(null),
    value = $bindable(""),
    collab,
    language = "markdown",
    readOnly = false,
    fontSize = 15,
    mono = false,
    placeholder,
    label,
    extensions = [],
    class: cls = "",
    onchange,
  }: {
    view?: EditorView | null;
    value?: string;
    collab?: EditorOptions["collab"];
    language?: EditorOptions["language"];
    readOnly?: boolean;
    fontSize?: number;
    mono?: boolean;
    placeholder?: string;
    label: string;
    extensions?: EditorOptions["extensions"];
    class?: string;
    onchange?: (text: string, view: EditorView) => void;
  } = $props();

  let host: HTMLDivElement;
  const compartments = newCompartments();
  let lastValue = "";

  onMount(() => {
    const state = createEditorState(
      {
        collab,
        doc: value,
        language,
        readOnly,
        fontSize,
        mono,
        placeholder: placeholder ?? t("md.placeholder"),
        label,
        extensions,
        formatText: { bold: t("md.boldText"), italic: t("md.italicText"), link: t("md.linkText") },
        onChange: (text, v) => {
          if (!collab) {
            lastValue = text;
            value = text;
          }
          onchange?.(text, v);
        },
      },
      compartments,
    );
    lastValue = value;
    const v = new EditorView({ state, parent: host });
    view = v;
    return () => {
      view = null;
      v.destroy();
    };
  });

  // Controlled value (non-collaborative): external changes replace the document.
  $effect(() => {
    const next = value;
    if (collab || !view || next === lastValue) return;
    lastValue = next;
    // Replace only the changed middle so the scroll position and cursor survive (e.g. an accepted suggestion).
    const current = view.state.doc.toString();
    let start = 0;
    const max = Math.min(current.length, next.length);
    while (start < max && current.charCodeAt(start) === next.charCodeAt(start)) start++;
    let end = 0;
    while (end < max - start && current.charCodeAt(current.length - 1 - end) === next.charCodeAt(next.length - 1 - end)) end++;
    view.dispatch({ changes: { from: start, to: current.length - end, insert: next.slice(start, next.length - end) } });
  });
  $effect(() => {
    view?.dispatch({ effects: compartments.readOnly.reconfigure(readOnlyExtension(readOnly)) });
  });
  $effect(() => {
    view?.dispatch({ effects: compartments.theme.reconfigure(hubTheme({ mono, fontSize })) });
  });
</script>

<div bind:this={host} class="hub-editor min-h-0 {cls}"></div>

<style>
  .hub-editor :global(.cm-editor) {
    height: 100%;
  }
</style>
