<script lang="ts">
  import { untrack } from "svelte";
  import { EditorView, keymap } from "@codemirror/view";
  import { Lock, Sparkles, X } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import { viewport } from "#lib/media.svelte.ts";
  import { session as hubSession } from "#lib/stores/session.svelte.ts";
  import { openCollab, type CollabSession } from "#lib/collab/session.svelte.ts";
  import CodeEditor from "#lib/editor/CodeEditor.svelte";
  import { revealHunk, suggestionReview } from "#lib/components/suggest/extension.ts";
  import { SuggestionReview } from "#lib/components/suggest/review.svelte.ts";
  import SuggestionPanel from "#lib/components/suggest/SuggestionPanel.svelte";
  import type { LiveHunk } from "#lib/components/suggest/types.ts";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import { bibLanguage, latexCompletion, latexLanguage } from "#lib/latex/language.ts";
  import type { LatexFile, Symbols } from "#lib/latex/types.ts";

  /**
   * One collaborative file of a LaTeX project (Yjs doc `latex:<projectId>:<fileId>`): CodeMirror with LaTeX
   * highlighting + completion, remote cursors, inline suggestion review (target `latex_file`) and a side list.
   * Mounted per file (the parent re-keys it), so the document name never changes during its life.
   */
  let {
    projectId, file, canEdit, symbols, view = $bindable(null), session = $bindable(null), review = $bindable(null), jump = null,
    onCompile, onForward, onMessage, onSelection,
  }: {
    projectId: string;
    file: LatexFile;
    canEdit: boolean;
    symbols: () => Symbols | null;
    view?: EditorView | null;
    session?: CollabSession | null;
    review?: SuggestionReview | null;
    /** Line to reveal once the document is synced. */
    jump?: { fileId: string; line: number; seq: number } | null;
    onCompile: () => void;
    onForward: () => void;
    onMessage: (msg: Record<string, unknown>) => void;
    onSelection?: (empty: boolean) => void;
  } = $props();

  const me = hubSession.user!;
  const initial = untrack(() => ({ projectId, file }));
  const collab = openCollab(`latex:${initial.projectId}:${initial.file.id}`, { id: me.id, name: me.name });
  const suggestions = new SuggestionReview({ targetType: "latex_file", targetId: initial.file.id, doc: collab.doc, text: collab.text, onError: m => toasts.show(m, "error") });
  session = collab;
  review = suggestions;
  const editable = $derived(canEdit && !file.generated && !collab.readOnly && collab.status !== "denied");
  const fontSize = $derived(hubSession.user?.preferences.editor.fontSize ?? 15);

  let panelOpen = $state(false);
  const pending = $derived(suggestions.live.length);
  // New suggestions open the side list on wide screens (closing it stays closed until more arrive).
  let seen = 0;
  $effect(() => {
    const n = pending;
    if (n > seen && viewport.desktop) untrack(() => (panelOpen = true));
    seen = n;
  });

  $effect(() => {
    const off = collab.onMessage(msg => {
      if (msg.type === "suggestions") void suggestions.refresh();
      onMessage(msg);
    });
    void suggestions.refresh();
    return () => {
      off();
      suggestions.destroy();
      collab.destroy();
      session = null;
      review = null;
    };
  });
  $effect(() => suggestions.attach(view));

  // Reveal a line (log click, inverse search) once the text is there.
  $effect(() => {
    const j = jump;
    if (!j || j.fileId !== initial.file.id || !view || !collab.synced) return;
    untrack(() => {
      const doc = view!.state.doc;
      const line = doc.line(Math.min(Math.max(j.line, 1), doc.lines));
      view!.dispatch({ selection: { anchor: line.from, head: line.to }, effects: EditorView.scrollIntoView(line.from, { y: "center" }) });
      view!.focus();
    });
  });

  const labels = {
    get accept() { return t("suggest.accept"); },
    get reject() { return t("suggest.reject"); },
    get stale() { return t("suggest.stale"); },
    by: (h: LiveHunk) => t("suggest.by", { title: h.title || t("suggest.untitled"), name: h.author ?? "AI" }),
  };
  const isBib = /\.bib$/i.test(initial.file.path);
  const isTex = /\.(tex|ltx|sty|cls|bst|bbx|cbx|cfg|def|clo)$/i.test(initial.file.path);
  const extensions = [
    keymap.of([
      { key: "Mod-s", preventDefault: true, run: () => (onCompile(), true) },
      { key: "Mod-Enter", preventDefault: true, run: () => (onCompile(), true) },
      { key: "Mod-Alt-j", preventDefault: true, run: () => (onForward(), true) },
      // macOS: Chrome reserves ⌘⌥J (console); ⌃⌥J reaches the page.
      { key: "Ctrl-Alt-j", preventDefault: true, run: () => (onForward(), true) },
    ]),
    suggestionReview(suggestions.actions(labels)),
    isTex ? latexCompletion(() => symbols()) : [],
    EditorView.updateListener.of(u => {
      if (u.selectionSet) onSelection?.(u.state.selection.main.empty);
    }),
  ];
  function reveal(h: LiveHunk) {
    if (view) revealHunk(view, h);
    if (!viewport.desktop) panelOpen = false;
  }
</script>

<div class="flex h-full min-h-0 flex-col">
  {#if file.generated}
    <p class="flex shrink-0 items-start gap-2 border-b border-line px-4 py-2 text-[12.5px] leading-relaxed" style="background:var(--pill-mint);color:var(--pill-mint-ink)"><Lock class="mt-0.5 size-3.5 shrink-0" />{t("latex.bibReadonly")}</p>
  {:else if !canEdit}
    <p class="flex shrink-0 items-start gap-2 border-b border-line bg-surface-2 px-4 py-2 text-[12.5px] text-ink-3"><Lock class="mt-0.5 size-3.5 shrink-0" />{t("latex.readonly")}</p>
  {/if}
  {#if pending || suggestions.list.length}
    <div class="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5" style="background:var(--pill-butter);color:var(--pill-butter-ink)">
      <Sparkles class="size-3.5" />
      <span class="flex-1 text-[12.5px] font-semibold">{t("suggest.count", { n: pending })}</span>
      <button type="button" class="inline-flex h-10 items-center rounded-full px-3 text-[12.5px] font-semibold hover:bg-black/5 lg:h-8" aria-expanded={panelOpen} onclick={() => (panelOpen = !panelOpen)}>{panelOpen ? t("common.close") : t("latex.suggestions.open")}</button>
    </div>
  {/if}
  <div class="grid min-h-0 flex-1 {panelOpen && viewport.desktop ? 'grid-cols-[minmax(0,1fr)_300px]' : 'grid-cols-1'}">
    <div class="min-h-0 min-w-0">
      <CodeEditor
        bind:view
        collab={{ text: collab.text, awareness: collab.awareness }}
        readOnly={!editable}
        {fontSize}
        mono
        language={isTex ? latexLanguage : isBib ? bibLanguage : "plain"}
        label={t("latex.editorLabel", { path: file.path })}
        {extensions}
        class="h-full overflow-hidden"
      />
    </div>
    {#if panelOpen && viewport.desktop}
      <aside class="min-h-0 overflow-y-auto border-l border-line bg-surface-2/50 p-3" aria-label={t("suggest.title")}>
        <div class="mb-2 flex items-center justify-between px-1">
          <h2 class="text-[13px] font-semibold text-ink-2">{t("suggest.title")}</h2>
          <button type="button" class="grid size-8 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label={t("common.close")} onclick={() => (panelOpen = false)}><X class="size-4" /></button>
        </div>
        <SuggestionPanel review={suggestions} onReveal={reveal} />
      </aside>
    {/if}
  </div>
</div>

{#if !viewport.desktop}
  <Sheet bind:open={panelOpen} title={t("suggest.title")} side="right">
    <SuggestionPanel review={suggestions} onReveal={reveal} />
  </Sheet>
{/if}
