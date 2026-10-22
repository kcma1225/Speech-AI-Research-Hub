<script lang="ts">
  import { untrack } from "svelte";
  import { goto } from "$app/navigation";
  import { EditorView } from "@codemirror/view";
  import { DropdownMenu } from "bits-ui";
  import {
    ArrowLeft, BookmarkPlus, CopyPlus, Download, Ellipsis, History, ListTree, Mic, PenLine, PenTool, Scissors, SpellCheck, Sparkles, Wand2, X,
  } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { relativeTime, t } from "#lib/i18n.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import { viewport } from "#lib/media.svelte.ts";
  import { session } from "#lib/stores/session.svelte.ts";
  import AiGate from "#lib/components/ai/AiGate.svelte";
  import { aiStatus } from "#lib/ai/status.svelte.ts";
  import ConnectionStatus from "#lib/collab/ConnectionStatus.svelte";
  import PresenceAvatars from "#lib/collab/PresenceAvatars.svelte";
  import { openCollab } from "#lib/collab/session.svelte.ts";
  import ToolbarButton from "#lib/editor/ToolbarButton.svelte";
  import MarkdownEditor from "#lib/components/markdown/MarkdownEditor.svelte";
  import DocImportSheet from "#lib/components/doc-import/DocImportSheet.svelte";
  import { uploadMdImage, type ImportedDocument } from "#lib/components/doc-import/api.ts";
  import { revealHunk, suggestionReview } from "#lib/components/suggest/extension.ts";
  import { SuggestionReview } from "#lib/components/suggest/review.svelte.ts";
  import SuggestionPanel from "#lib/components/suggest/SuggestionPanel.svelte";
  import type { LiveHunk } from "#lib/components/suggest/types.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import ConfirmDialog from "#lib/components/ui/ConfirmDialog.svelte";
  import DatePicker from "#lib/components/ui/DatePicker.svelte";
  import { menuContent, menuItem, menuSeparator } from "#lib/components/ui/menu.ts";
  import DeleteButton from "#lib/components/ui/DeleteButton.svelte";
  import DeleteMenuItem from "#lib/components/ui/DeleteMenuItem.svelte";
  import Pill from "#lib/components/ui/Pill.svelte";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import Textarea from "#lib/components/ui/Textarea.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import { postAiStream } from "./ai-stream.ts";
  import { kindTone, templateName, type NoteDetail } from "./types.ts";
  import VersionSheet from "./VersionSheet.svelte";
  import VoiceInput from "./VoiceInput.svelte";

  /**
   * Collaborative note editor: Yjs document `note:<id>` in CodeMirror with remote cursors, live preview
   * (layout from the `editor.layout` preference), suggestions reviewed inline + in a side list, voice input,
   * AI 草擬/改寫/接續 (role writing → suggestions), versions and export.
   */
  let { detail, reload }: { detail: NoteDetail; reload: () => Promise<void> } = $props();

  const note = $derived(detail.note);
  const canEdit = $derived(detail.permissions.edit);
  const me = session.user!;
  // The page re-keys this component per note, so the initial document name is the only one.
  const initial = untrack(() => detail);
  const collab = openCollab(initial.doc_name, { id: me.id, name: me.name });
  const review = new SuggestionReview({ targetType: "note", targetId: initial.note.id, doc: collab.doc, text: collab.text, onError: m => toasts.show(m, "error") });
  const editable = $derived(canEdit && !collab.readOnly && collab.status !== "denied");

  let view = $state<EditorView | null>(null);
  let selectionEmpty = $state(true);
  let title = $state(initial.note.title);
  let date = $state(initial.note.event_date ?? "");
  // `?versions=1` (e.g. the assistant's 「復原」 link after an autopilot edit) opens the version history.
  let versionsOpen = $state(typeof window !== "undefined" && new URLSearchParams(window.location.search).get("versions") === "1");
  let voiceOpen = $state(false);
  let draftOpen = $state(false);
  let draftInstruction = $state("");
  let deleting = $state(false);
  let panelOpen = $state(false);
  let importOpen = $state(false);

  type Layout = "split" | "edit" | "preview";
  let layout = $state<Layout>(session.user?.preferences.editor.layout ?? "split");
  const fontSize = $derived(session.user?.preferences.editor.fontSize ?? 15);
  function setLayout(next: Layout) {
    if (viewport.desktop || next !== "split") void session.update({ preferences: { editor: { layout: next } } }).catch(() => {});
  }

  // Server messages: new/decided suggestions, metadata changes by others.
  $effect(() => {
    const off = collab.onMessage(msg => {
      if (msg.type === "suggestions") void review.refresh();
      if (msg.type === "meta") void reload();
    });
    void review.refresh();
    return () => {
      off();
      review.destroy();
      collab.destroy();
    };
  });
  $effect(() => review.attach(view));
  $effect(() => aiStatus.watch());

  // Metadata from the server (another member renamed it) unless we are editing the field.
  let titleFocused = false;
  $effect(() => {
    const next = detail.note.title;
    if (!titleFocused) title = next;
  });
  $effect(() => {
    date = detail.note.event_date ?? "";
  });

  async function saveMeta(patch: { title?: string; event_date?: string | null }) {
    try {
      await api.patch(`/notes/${note.id}`, patch);
      await reload();
    } catch (e) {
      toasts.show((e as Error).message, "error");
    }
  }
  function commitTitle() {
    titleFocused = false;
    const next = title.trim();
    if (!next) title = note.title;
    else if (next !== note.title) void saveMeta({ title: next });
  }

  const labels = {
    get accept() {
      return t("suggest.accept");
    },
    get reject() {
      return t("suggest.reject");
    },
    get stale() {
      return t("suggest.stale");
    },
    by: (h: LiveHunk) => t("suggest.by", { title: h.title || t("suggest.untitled"), name: h.author ?? "AI" }),
  };
  const extensions = [
    suggestionReview(review.actions(labels)),
    EditorView.updateListener.of(u => {
      if (u.selectionSet || u.docChanged) selectionEmpty = u.state.selection.main.empty;
    }),
  ];

  const pendingHunks = $derived(review.live.length);
  $effect(() => {
    // Suggestions arriving while the panel is closed open it on wide screens.
    if (pendingHunks && viewport.desktop && !panelOpen) panelOpen = true;
  });
  function reveal(h: LiveHunk) {
    if (view) revealHunk(view, h);
    if (!viewport.desktop) panelOpen = false;
  }

  // ---- versions / export / delete
  async function saveVersion() {
    try {
      const r = await api.post<{ version: { version: number } }>(`/notes/${note.id}/versions`, {});
      toasts.show(t("versions.saved", { n: r.version.version }), "success");
    } catch (e) {
      toasts.show((e as Error).message, "error");
    }
  }
  // ---- save as my template (the current text becomes the skeleton)
  let tplOpen = $state(false);
  let tplName = $state("");
  let tplDescription = $state("");
  let tplSaving = $state(false);
  function openTemplate() {
    tplName = note.title.slice(0, 60);
    tplDescription = "";
    tplOpen = true;
  }
  async function saveTemplate() {
    if (!tplName.trim()) return;
    tplSaving = true;
    try {
      await api.post("/note-templates", { name: tplName.trim(), kind: note.kind, description: tplDescription.trim(), body_md: collab.text.toString().slice(0, 20000) });
      tplOpen = false;
      toasts.show(t("notes.template.saved", { name: tplName.trim() }), "success");
    } catch (e) {
      toasts.show((e as Error).message, "error");
    } finally {
      tplSaving = false;
    }
  }

  async function remove() {
    try {
      await api.del(`/notes/${note.id}`);
      await goto(`/studies/${detail.study.slug}?tab=notes`);
    } catch (e) {
      toasts.show((e as Error).message, "error");
    }
  }

  // ---- AI + voice
  let aiBusy = $state<string | null>(null);
  let aiText = $state("");
  let aiAbort: AbortController | null = null;

  /** Waits until our local edits reached the server (AI actions read the server's copy). */
  async function flushed() {
    for (let i = 0; i < 60 && collab.unsynced > 0; i++) await new Promise(r => setTimeout(r, 50));
  }

  async function runAi(kind: "draft" | "rewrite" | "continue", body: Record<string, unknown>, label: string) {
    if (aiBusy) return;
    await flushed();
    aiBusy = label;
    aiText = "";
    aiAbort = new AbortController();
    try {
      await postAiStream(`/notes/${note.id}/ai/${kind}`, body, { signal: aiAbort.signal, onDelta: d => (aiText = (aiText + d).slice(-600)) });
      await review.refresh();
      panelOpen = true;
      toasts.show(t("notes.ai.ready"), "success");
    } catch (e) {
      if ((e as Error).name !== "AbortError") toasts.show((e as Error).message, "error");
    } finally {
      aiBusy = null;
      aiAbort = null;
    }
  }
  function selection() {
    if (!view) return null;
    const { from, to } = view.state.selection.main;
    return from === to ? null : { from, to, before: view.state.sliceDoc(from, to) };
  }
  function rewrite(mode: "rewrite" | "bullets" | "shorten" | "fix") {
    const sel = selection();
    if (!sel) return toasts.show(t("notes.ai.selectFirst"));
    void runAi("rewrite", { ...sel, mode }, t(`notes.ai.${mode}` as MessageKey));
  }
  function continueWriting() {
    if (!view) return;
    void runAi("continue", { at: view.state.selection.main.head }, t("notes.ai.continue"));
  }
  function draft() {
    draftOpen = false;
    void runAi("draft", draftInstruction.trim() ? { instruction: draftInstruction.trim() } : {}, t("notes.ai.draft"));
  }

  /** 「匯入文件」: inserted at the cursor; while others are editing it becomes a suggestion instead. */
  async function insertImported(markdown: string, doc: ImportedDocument) {
    if (!view || !editable || !markdown.trim()) return;
    const at = view.state.selection.main.head;
    const before = view.state.sliceDoc(Math.max(0, at - 2), at);
    const lead = at === 0 || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
    const text = `${lead}${markdown.trim()}\n`;
    if (collab.peers.length > 0) {
      try {
        await flushed();
        await api.post("/suggestions", { target_type: "note", target_id: note.id, title: t("docimport.done", { name: doc.filename }).slice(0, 200), hunks: [{ from: at, to: at, after: text, before: "" }] });
        await review.refresh();
        panelOpen = true;
        toasts.show(t("docimport.doneCollab"), "success");
      } catch (e) {
        toasts.show((e as Error).message, "error");
      }
      return;
    }
    view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length }, scrollIntoView: true, userEvent: "input.import" });
    view.focus();
    toasts.show(doc.truncated ? t("docimport.truncated") : t("docimport.done", { name: doc.filename }), doc.truncated ? "default" : "success");
  }

  async function insertVoice(text: string, bullets: boolean) {
    if (!view || !editable) return;
    const { from, to } = view.state.selection.main;
    const before = from > 0 && !/\s$/.test(view.state.sliceDoc(from - 1, from)) ? " " : "";
    const insert = `${before}${text}`;
    view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, scrollIntoView: true, userEvent: "input.voice" });
    view.focus();
    if (bullets && aiStatus.available("writing")) {
      await runAi("rewrite", { from: from + before.length, to: from + insert.length, before: text, mode: "bullets" }, t("notes.ai.bullets"));
    }
  }

  const aiItems = $derived([
    { key: "rewrite", icon: Wand2, label: t("notes.ai.rewrite"), needsSelection: true, run: () => rewrite("rewrite") },
    { key: "bullets", icon: ListTree, label: t("notes.ai.bullets"), needsSelection: true, run: () => rewrite("bullets") },
    { key: "shorten", icon: Scissors, label: t("notes.ai.shorten"), needsSelection: true, run: () => rewrite("shorten") },
    { key: "fix", icon: SpellCheck, label: t("notes.ai.fix"), needsSelection: true, run: () => rewrite("fix") },
  ]);
  const showAside = $derived(viewport.desktop && panelOpen && (pendingHunks > 0 || review.list.length > 0));
</script>

<a href="/studies/{detail.study.slug}?tab=notes" class="-ml-2 mb-1 inline-flex h-10 max-w-full items-center gap-1.5 rounded-full px-2 text-[13px] font-medium text-ink-3 hover:text-ink">
  <ArrowLeft class="size-4 shrink-0" /><span class="truncate">{detail.study.title}</span>
</a>

<header class="mb-3 flex flex-col gap-2.5 sm:mb-4">
  <div class="flex items-start gap-3">
    {#if canEdit}
      <!-- A one-line field that wraps long titles instead of clipping them (field-sizing grows it; Enter commits). -->
      <textarea
        bind:value={title}
        rows="1"
        onfocus={() => (titleFocused = true)}
        onblur={commitTitle}
        oninput={e => {
          const el = e.currentTarget as HTMLTextAreaElement;
          if (/[\r\n]/.test(el.value)) title = el.value.replace(/[\r\n]+/g, " ");
        }}
        onkeydown={e => {
          if (e.key !== "Enter" || e.isComposing) return;
          e.preventDefault();
          (e.currentTarget as HTMLTextAreaElement).blur();
        }}
        maxlength={200}
        aria-label={t("notes.titleLabel")}
        title={title}
        class="-mx-1.5 min-w-0 flex-1 resize-none overflow-hidden rounded-xl bg-transparent px-1.5 font-display text-[28px] leading-tight text-ink outline-none [field-sizing:content] hover:bg-surface-2/70 focus:bg-surface sm:text-[36px]"
      ></textarea>
    {:else}
      <h1 class="min-w-0 flex-1 font-display text-[28px] leading-tight text-balance text-ink sm:text-[36px]">{note.title}</h1>
    {/if}
    <div class="flex shrink-0 items-center gap-2 pt-2">
      <PresenceAvatars peers={collab.peers} />
    </div>
  </div>
  <div class="flex flex-wrap items-center gap-x-3 gap-y-2 text-[12.5px] text-ink-3">
    <Pill size="sm" tone={kindTone[note.kind]}>{detail.template ? templateName(detail.template.name, detail.template.scope === "user" ? "user" : "system") : t(`notes.kind.${note.kind}` as MessageKey)}</Pill>
    {#if canEdit}
      <DatePicker label={t("notes.date")} bind:value={date} clearable onValueChange={v => saveMeta({ event_date: v || null })} class="[&_button]:h-8 [&_button]:text-[12.5px]" />
    {:else if note.event_date}
      <span class="font-medium text-ink-2 tabular-nums">{note.event_date}</span>
    {/if}
    <span>{t("notes.edited", { when: relativeTime(note.updated_at) })}{note.updater_name ? ` · ${note.updater_name}` : ""}</span>
    <ConnectionStatus session={collab} compact />
    <div class="ml-auto flex items-center gap-1">
      <Button variant="ghost" size={viewport.desktop ? "sm" : "md"} onclick={() => (versionsOpen = true)}><History />{t("versions.title")}</Button>
      {#if canEdit}<DeleteButton class="hidden sm:inline-flex lg:size-8 lg:min-h-8" label={t("notes.delete")} onclick={() => (deleting = true)} />{/if}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger class="grid size-10 place-items-center rounded-full text-ink-2 hover:bg-surface-3 hover:text-ink lg:size-8" aria-label={t("notes.actions")}><Ellipsis class="size-4" /></DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={6} class="{menuContent} w-56">
            {#if canEdit}<DropdownMenu.Item class={menuItem} onSelect={saveVersion}><BookmarkPlus />{t("versions.save")}</DropdownMenu.Item>{/if}
            <DropdownMenu.Item class={menuItem} onSelect={() => (window.location.href = `/api/notes/${note.id}/export`)}><Download />{t("notes.export")}</DropdownMenu.Item>
            <DropdownMenu.Item class={menuItem} onSelect={openTemplate}><CopyPlus />{t("notes.template.saveAs")}</DropdownMenu.Item>
            <DeleteMenuItem label={t("notes.delete")} reason={canEdit ? null : t("crud.deny.study")} onSelect={() => (deleting = true)} />
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  </div>
</header>

<MarkdownEditor
  bind:view
  bind:layout
  collab={{ text: collab.text, awareness: collab.awareness }}
  readOnly={!editable}
  {fontSize}
  label={t("notes.editorLabel", { title: note.title })}
  {extensions}
  fill={viewport.desktop}
  imageUpload={canEdit ? file => uploadMdImage(`note:${initial.note.id}`, file) : undefined}
  onImport={canEdit ? () => (importOpen = true) : undefined}
  onLayoutChange={setLayout}
  class="rounded-[22px] shadow-card lg:h-[calc(100dvh-246px)] lg:min-h-[520px]"
>
  {#snippet toolbarEnd()}
    {#if canEdit}
      <AiGate role="asr" inline>
        <ToolbarButton icon={Mic} label={t("voice.title")} disabled={!editable} onclick={() => (voiceOpen = true)} />
        {#snippet fallback()}<ToolbarButton icon={Mic} label={`${t("voice.title")} · ${t("ai.maintenance")}`} disabled />{/snippet}
      </AiGate>
      <AiGate role="writing" inline>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            class="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full bg-ink px-3.5 text-[12.5px] font-semibold text-surface transition-opacity hover:opacity-90 disabled:opacity-40 lg:h-8"
            disabled={!editable || !!aiBusy}
            aria-label={t("notes.ai.menu")}><Sparkles class="size-3.5" />{t("notes.ai.button")}</DropdownMenu.Trigger
          >
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="end" sideOffset={6} class="{menuContent} w-60">
              <DropdownMenu.Item class={menuItem} onSelect={() => (draftOpen = true)}><PenTool />{t("notes.ai.draft")}</DropdownMenu.Item>
              <DropdownMenu.Item class={menuItem} onSelect={continueWriting}><PenLine />{t("notes.ai.continue")}</DropdownMenu.Item>
              <DropdownMenu.Separator class={menuSeparator} />
              {#each aiItems as item (item.key)}
                <DropdownMenu.Item class="{menuItem} data-disabled:opacity-45" disabled={item.needsSelection && selectionEmpty} onSelect={item.run}><item.icon />{item.label}</DropdownMenu.Item>
              {/each}
              {#if selectionEmpty}<p class="px-2.5 pt-1 pb-1.5 text-[11.5px] text-ink-3">{t("notes.ai.selectFirst")}</p>{/if}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </AiGate>
    {/if}
    {#if pendingHunks || review.list.length}
      <button
        type="button"
        class="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-semibold lg:h-8 {panelOpen && viewport.desktop ? 'bg-surface-3 text-ink' : 'text-ink-2 hover:bg-surface-3'}"
        style="background:{panelOpen && viewport.desktop ? '' : 'var(--pill-butter)'};color:{panelOpen && viewport.desktop ? '' : 'var(--pill-butter-ink)'}"
        aria-expanded={panelOpen}
        onclick={() => (panelOpen = !panelOpen)}><Sparkles class="size-3.5" />{t("suggest.count", { n: pendingHunks })}</button
      >
    {/if}
  {/snippet}
  {#snippet aside()}
    {#if showAside}
      <aside class="hidden w-[300px] shrink-0 overflow-y-auto border-l 2xl:w-[360px] border-line bg-surface-2/50 p-3 lg:block" aria-label={t("suggest.title")}>
        <div class="mb-2 flex items-center justify-between px-1">
          <h2 class="text-[13px] font-semibold text-ink-2">{t("suggest.title")}</h2>
          <button type="button" class="grid size-8 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label={t("common.close")} onclick={() => (panelOpen = false)}><X class="size-4" /></button>
        </div>
        <SuggestionPanel {review} onReveal={reveal} />
      </aside>
    {/if}
  {/snippet}
</MarkdownEditor>
<p class="mt-2 hidden text-[11.5px] text-ink-3 lg:block">{t("suggest.keys")}</p>

{#if !viewport.desktop}
  <Sheet bind:open={panelOpen} title={t("suggest.title")} side="right">
    <SuggestionPanel {review} onReveal={reveal} />
  </Sheet>
{/if}

{#if aiBusy}
  <div class="fixed inset-x-4 bottom-[calc(88px+env(safe-area-inset-bottom))] z-40 mx-auto max-w-lg rounded-2xl border border-line bg-surface p-3.5 shadow-pop lg:bottom-6" role="status" aria-live="polite">
    <div class="flex items-center gap-2">
      <Sparkles class="size-4 text-ink-2" />
      <p class="ai-shimmer flex-1 text-[13px] font-semibold text-ink">{t("notes.ai.working", { action: aiBusy })}</p>
      <Button size="sm" variant="ghost" onclick={() => aiAbort?.abort()}>{t("notes.cancel")}</Button>
    </div>
    {#if aiText}<p class="mt-2 line-clamp-4 text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-3">{aiText}</p>{/if}
  </div>
{/if}

<Sheet bind:open={tplOpen} title={t("notes.template.saveAs")} description={t("notes.template.saveHint")} side="center">
  <div class="flex flex-col gap-4 pt-1">
    <TextField label={t("notes.template.name")} bind:value={tplName} maxlength={60} required />
    <TextField label={t("notes.template.description")} bind:value={tplDescription} maxlength={300} placeholder={t("notes.template.descriptionPlaceholder")} />
  </div>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (tplOpen = false)}>{t("notes.cancel")}</Button>
    <Button variant="primary" loading={tplSaving} disabled={!tplName.trim()} onclick={saveTemplate}>{t("notes.template.save")}</Button>
  {/snippet}
</Sheet>

{#if canEdit}
  <DocImportSheet bind:open={importOpen} target={{ kind: "draft", purpose: "note", studyId: detail.study.id }} onMarkdown={insertImported} />
{/if}
<VersionSheet bind:open={versionsOpen} noteId={note.id} current={() => collab.text.toString()} {canEdit} onRestored={reload} />
{#if canEdit}
  <VoiceInput bind:open={voiceOpen} noteId={note.id} onText={insertVoice} />
  <Sheet bind:open={draftOpen} title={t("notes.ai.draft")} description={t("notes.ai.draftHint")} side="center">
    <Textarea label={t("notes.ai.instruction")} bind:value={draftInstruction} rows={3} placeholder={t("notes.ai.instructionPlaceholder")} maxlength={1000} />
    {#snippet footer()}
      <Button variant="ghost" onclick={() => (draftOpen = false)}>{t("notes.cancel")}</Button>
      <Button variant="primary" onclick={draft}><Sparkles />{t("notes.ai.generate")}</Button>
    {/snippet}
  </Sheet>
  <ConfirmDialog bind:open={deleting} title={t("notes.deleteTitle", { title: note.title })} description={t("notes.deleteBody")} confirmLabel={t("notes.delete")} onConfirm={remove} />
{/if}

<style>
  .ai-shimmer {
    background: linear-gradient(90deg, var(--ink) 0%, var(--ink-3) 50%, var(--ink) 100%) 0 0 / 200% 100%;
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    animation: shimmer 1.6s linear infinite;
  }
  @keyframes shimmer {
    to {
      background-position: -200% 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .ai-shimmer {
      animation: none;
      color: var(--ink);
    }
  }
</style>
