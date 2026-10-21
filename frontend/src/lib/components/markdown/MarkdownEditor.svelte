<script lang="ts">
  import { untrack, type Snippet } from "svelte";
  import { EditorView } from "@codemirror/view";
  import type { EditorState, Extension } from "@codemirror/state";
  import { Columns2, Eye, FileInput, Keyboard, Maximize2, Minimize2, PenLine, TableOfContents } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import { viewport } from "#lib/media.svelte.ts";
  import { session } from "#lib/stores/session.svelte.ts";
  import CodeEditor from "#lib/editor/CodeEditor.svelte";
  import EditorStatus from "#lib/editor/EditorStatus.svelte";
  import { editorActions, type ToolItem } from "#lib/editor/editor-actions.ts";
  import InsertDialogs from "#lib/editor/InsertDialogs.svelte";
  import { markdownExtras } from "#lib/editor/markdown-extensions.ts";
  import { outline, textStats, type Heading, type TextStats } from "#lib/editor/markdown-text.ts";
  import MarkdownToolbar from "#lib/editor/MarkdownToolbar.svelte";
  import OutlinePanel from "#lib/editor/OutlinePanel.svelte";
  import { revealPreviewLine, syncScroll } from "#lib/editor/scroll-sync.ts";
  import ShortcutsSheet from "#lib/editor/ShortcutsSheet.svelte";
  import type { EditorOptions } from "#lib/editor/setup.ts";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import MarkdownView from "./MarkdownView.svelte";

  type Layout = "split" | "edit" | "preview";
  /**
   * The hub's Markdown editor (study summary, paper notes, notes, meeting drafts…): CodeMirror 6 with a responsive
   * toolbar, slash menu (/), shortcuts (Mod-/ sheet), find & replace, tables, math, callouts, footnotes, Mermaid,
   * image upload (paste / drop / button → `imageUpload`), HTML → Markdown paste, outline, word count, live preview
   * with synchronized scrolling, and fullscreen. Collaborative when `collab` is given (the text lives in the
   * Y.Text; `value` is ignored), else `value` is bindable. `layout` defaults to the user's `editor.layout`
   * preference (split); phones and tablets fall back to an edit/preview toggle.
   * `collab`, `extensions`, `imageUpload` are read at mount (re-key to change).
   */
  let {
    value = $bindable(""),
    view = $bindable(null),
    layout = $bindable(untrack(() => session.user?.preferences.editor.layout ?? "split")),
    collab,
    readOnly = false,
    fontSize = 15,
    label,
    placeholder,
    fill = false,
    extensions = [],
    imageUpload,
    onImport,
    onLayoutChange,
    toolbarEnd,
    aside,
    class: cls = "",
  }: {
    value?: string;
    view?: EditorView | null;
    layout?: Layout;
    collab?: EditorOptions["collab"];
    readOnly?: boolean;
    fontSize?: number;
    label: string;
    placeholder?: string;
    /** Fill the parent's height (panes scroll inside) instead of growing with the text on phones. */
    fill?: boolean;
    extensions?: Extension[];
    /** Stores an image and returns its URL (enables the image button, paste and drop). */
    imageUpload?: (file: File) => Promise<string>;
    /** Shows 「匯入文件」 in the toolbar. */
    onImport?: () => void;
    onLayoutChange?: (layout: Layout) => void;
    toolbarEnd?: Snippet;
    /** Right-hand panel inside the editor frame (e.g. suggestions); shown when the snippet renders something. */
    aside?: Snippet;
    class?: string;
  } = $props();

  const effective = $derived<Layout>(!viewport.desktop && layout === "split" ? "edit" : layout);
  let segment = $state<Layout>("edit");
  $effect(() => {
    segment = effective;
  });
  function setLayout(next: Layout) {
    layout = next;
    onLayoutChange?.(next);
  }

  let edState = $state.raw<EditorState | null>(null);
  let previewSource = $state(untrack(() => (collab ? collab.text.toString() : value)));
  let previewEl = $state<HTMLElement | null>(null);
  let fullscreen = $state(false);
  let outlineOpen = $state(false);
  let helpOpen = $state(false);
  let dialogs = $state<ReturnType<typeof InsertDialogs> | null>(null);
  let fileInput = $state<HTMLInputElement | null>(null);
  let pickTarget: EditorView | null = null;

  // ---- text-derived panels (debounced so typing stays smooth on long notes)
  let stats = $state<TextStats>(textStats(untrack(() => previewSource)));
  let headings = $state<Heading[]>(outline(untrack(() => previewSource)));
  let selection = $state<TextStats | null>(null);
  let cursor = $state({ line: 1, col: 1 });
  let textTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleText(text: string) {
    clearTimeout(textTimer);
    textTimer = setTimeout(() => {
      previewSource = text;
      stats = textStats(text);
      headings = outline(text);
    }, text.length > 50_000 ? 400 : 160);
  }
  $effect(() => () => clearTimeout(textTimer));
  // Controlled value changed from outside (e.g. an accepted suggestion, a reset).
  $effect(() => {
    const next = value;
    if (!collab && next !== untrack(() => previewSource)) scheduleText(next);
  });

  const ctx = {
    openLink: (v: EditorView) => dialogs?.show("link", v),
    openTable: (v: EditorView) => dialogs?.show("table", v),
    openCode: (v: EditorView) => dialogs?.show("code", v),
    pickImage: untrack(() => imageUpload)
      ? (v: EditorView) => {
          pickTarget = v;
          fileInput?.click();
        }
      : (v: EditorView) => dialogs?.show("image", v),
  };
  const actions = $derived(editorActions(ctx));

  // ---- images: placeholder while uploading, replaced (wherever it moved) when done
  const MAX_IMAGE = 10 * 1024 * 1024;
  let uploadSeq = 0;
  async function uploadImages(files: File[], v: EditorView, at: number) {
    const upload = imageUpload;
    if (!upload) return;
    for (const file of files) {
      if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) {
        toasts.show(t("mdx.image.badType"), "error");
        continue;
      }
      if (file.size > MAX_IMAGE) {
        toasts.show(t("mdx.image.tooLarge"), "error");
        continue;
      }
      const token = `![${t("mdx.image.uploading")}](#upload-${Date.now().toString(36)}-${++uploadSeq})`;
      const pos = Math.min(at, v.state.doc.length);
      v.dispatch({ changes: { from: pos, insert: token }, userEvent: "input.image" });
      at = pos + token.length;
      const replace = (insert: string) => {
        const text = v.state.doc.toString();
        const index = text.indexOf(token);
        if (index >= 0) v.dispatch({ changes: { from: index, to: index + token.length, insert }, userEvent: "input.image" });
      };
      try {
        const url = await upload(file);
        const alt = file.name.replace(/\.[a-z0-9]+$/i, "").slice(0, 80) || "image";
        replace(`![${alt.replace(/[[\]\\]/g, "")}](${url})`);
      } catch (e) {
        replace("");
        toasts.show((e as Error).message, "error");
      }
    }
  }
  function picked(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = "";
    const v = pickTarget ?? view;
    if (v && files.length) void uploadImages(files, v, v.state.selection.main.from);
  }

  const allExtensions: Extension[] = [
    markdownExtras({
      actions: () => actions,
      onHelp: () => (helpOpen = true),
      onFullscreen: () => (fullscreen = !fullscreen),
      onImages: untrack(() => imageUpload) ? (files, v, at) => void uploadImages(files, v, at) : undefined,
    }),
    EditorView.updateListener.of(u => {
      if (u.docChanged) scheduleText(u.state.doc.toString());
      if (u.docChanged || u.selectionSet || u.focusChanged || u.transactions.length) edState = u.state;
      if (u.selectionSet || u.docChanged) {
        const sel = u.state.selection.main;
        const line = u.state.doc.lineAt(sel.head);
        cursor = { line: line.number, col: sel.head - line.from + 1 };
        selection = sel.empty ? null : textStats(u.state.sliceDoc(sel.from, sel.to).slice(0, 200_000));
      }
    }),
    // Phones (page scroll): no 40vh bottom padding under a growing editor.
    ...(untrack(() => fill) ? [] : [EditorView.theme({ ".cm-content": { paddingBottom: "28px" } })]),
    ...untrack(() => extensions),
  ];

  $effect(() => {
    if (view) edState = view.state;
  });
  $effect(() => {
    if (!view || !previewEl || effective !== "split") return;
    return syncScroll(view, previewEl);
  });

  function jump(h: Heading) {
    if (!view) return;
    const pos = Math.min(h.from, view.state.doc.length);
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 16 }) });
    if (effective !== "preview") view.focus();
    if (previewEl && effective !== "edit") revealPreviewLine(previewEl, h.line);
    if (!viewport.desktop) outlineOpen = false;
  }

  function keydown(e: KeyboardEvent) {
    if (fullscreen && e.key === "Escape" && !e.defaultPrevented) {
      // Let CodeMirror close its own panels/menus first.
      if ((e.target as HTMLElement).closest(".cm-panel, .cm-tooltip")) return;
      fullscreen = false;
    }
  }

  const layoutOptions = $derived(
    viewport.desktop
      ? [
          { value: "edit" as const, label: t("md.edit"), icon: PenLine },
          { value: "split" as const, label: t("md.split"), icon: Columns2 },
          { value: "preview" as const, label: t("md.preview"), icon: Eye },
        ]
      : [
          { value: "edit" as const, label: t("md.edit"), icon: PenLine },
          { value: "preview" as const, label: t("md.preview"), icon: Eye },
        ],
  );
  const tools = $derived<ToolItem[]>([
    { id: "outline", label: t("mdx.outline"), icon: TableOfContents, run: () => (outlineOpen = !outlineOpen), active: outlineOpen },
    ...(onImport && !readOnly ? [{ id: "import", label: t("docimport.button"), icon: FileInput, run: () => onImport!() }] : []),
    { id: "help", label: t("mdx.shortcuts"), icon: Keyboard, key: "Mod-/", run: () => (helpOpen = true) },
    { id: "fullscreen", label: fullscreen ? t("mdx.exitFullscreen") : t("mdx.fullscreen"), icon: fullscreen ? Minimize2 : Maximize2, key: "Mod-Shift-f", run: () => (fullscreen = !fullscreen), active: fullscreen },
  ]);
  const showOutline = $derived(outlineOpen && viewport.desktop);
  // Fixed-height panes on desktop (and in fill/fullscreen mode) so editor and preview scroll side by side.
  const framed = $derived(fill || fullscreen || viewport.desktop);

</script>

<!-- overflow-clip (not hidden) keeps the rounded corners without creating a scroll container, so the toolbar can stick. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="hub-md-editor flex flex-col overflow-clip border-line-2 bg-surface focus-within:border-ink/60 {fullscreen
    ? 'fixed inset-0 z-[60] rounded-none border-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]'
    : `rounded-2xl border ${fill ? 'min-h-0 flex-1' : ''}`} {cls}"
  onkeydown={keydown}
  role={fullscreen ? "dialog" : undefined}
  aria-modal={fullscreen ? "true" : undefined}
  aria-label={fullscreen ? label : undefined}
>
  <!-- Phones/tablets: the page scrolls with the growing editor, so the toolbar sticks below the top bar. -->
  <div
    class="flex flex-wrap items-center gap-1 border-b border-line px-1.5 py-1.5 lg:flex-nowrap {framed
      ? 'bg-surface-2/70'
      : 'sticky top-[calc(max(12px,env(safe-area-inset-top))+52px)] z-10 bg-surface-2'}"
  >
    <Segmented bind:value={segment} options={layoutOptions} label={t("md.layout")} onValueChange={setLayout} class="order-first w-full shrink-0 lg:order-none lg:w-auto [&_button]:h-10 [&_button]:text-[12px] lg:[&_button]:h-8 lg:[&_button]:px-2.5" />
    <div class="flex min-w-0 flex-1 items-center {effective === 'preview' || readOnly ? 'opacity-60' : ''}">
      <MarkdownToolbar {view} editorState={edState} {actions} {tools} disabled={readOnly || effective === "preview"} end={toolbarEnd} />
    </div>
  </div>

  <div class="flex min-h-0 flex-1 {framed && !fill && !fullscreen ? 'h-[min(68dvh,720px)] min-h-[360px] flex-none' : ''}">
    {#if showOutline}
      <aside class="hidden w-56 shrink-0 overflow-y-auto border-r border-line bg-surface-2/40 lg:block">
        <OutlinePanel {headings} current={cursor.line} onJump={jump} />
      </aside>
    {/if}
    <div class="grid min-h-0 min-w-0 flex-1 {effective === 'split' ? 'grid-cols-2 divide-x divide-line' : 'grid-cols-1'}">
      <div class="min-w-0 {framed ? 'min-h-0' : 'min-h-[45dvh]'} {effective === 'preview' ? 'hidden' : ''}">
        <CodeEditor bind:view bind:value {collab} {readOnly} {fontSize} label={label} {placeholder} extensions={allExtensions} class="h-full {framed ? 'overflow-hidden' : ''}" />
      </div>
      {#if effective !== "edit"}
        <div bind:this={previewEl} class="min-w-0 overflow-y-auto px-4 py-3.5 sm:px-6 sm:py-4 {framed ? 'min-h-0' : 'min-h-[45dvh]'}" tabindex="-1" aria-label={t("md.preview")} role="region">
          {#if previewSource.trim()}
            <MarkdownView source={previewSource} {fontSize} sourceLines />
          {:else}
            <p class="text-[13px] text-ink-3">{t("md.previewEmpty")}</p>
          {/if}
        </div>
      {/if}
    </div>
    {@render aside?.()}
  </div>
  <EditorStatus {stats} {selection} line={cursor.line} column={cursor.col} />
</div>

{#if imageUpload}
  <input bind:this={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple class="sr-only" tabindex="-1" aria-hidden="true" onchange={picked} />
{/if}
<InsertDialogs bind:this={dialogs} />
<ShortcutsSheet bind:open={helpOpen} {actions} />
{#if !viewport.desktop}
  <Sheet bind:open={outlineOpen} title={t("mdx.outline")} side="right" hideTitle>
    <OutlinePanel {headings} current={cursor.line} onJump={jump} />
  </Sheet>
{/if}
