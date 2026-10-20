<script lang="ts">
  import { untrack } from "svelte";
  import { beforeNavigate, goto } from "$app/navigation";
  import { page } from "$app/state";
  import { CalendarDays, ChevronLeft, FileQuestion, History, PenLine, Trash2, X } from "@lucide/svelte";
  import { api, ApiError } from "#lib/api.ts";
  import { formatDate, relativeTime, t } from "#lib/i18n.svelte.ts";
  import { session } from "#lib/stores/session.svelte.ts";
  import { notesList } from "#lib/notes/list.svelte.ts";
  import { clearDraft, readDraft, writeDraft, type NoteDraft } from "#lib/notes/draft.ts";
  import type { NoteDetail } from "#lib/notes/types.ts";
  import type { TagRef } from "#lib/types.ts";
  import Avatar from "#lib/components/ui/Avatar.svelte";
  import Button from "#lib/components/ui/Button.svelte";
  import ConfirmDialog from "#lib/components/ui/ConfirmDialog.svelte";
  import EmptyState from "#lib/components/ui/EmptyState.svelte";
  import Kbd from "#lib/components/ui/Kbd.svelte";
  import Pill, { toneFor } from "#lib/components/ui/Pill.svelte";
  import Skeleton from "#lib/components/ui/Skeleton.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import DatePicker from "#lib/components/notes/DatePicker.svelte";
  import MarkdownEditor from "#lib/components/notes/MarkdownEditor.svelte";
  import MarkdownView from "#lib/components/notes/MarkdownView.svelte";
  import NoteMedia from "#lib/components/notes/NoteMedia.svelte";
  import NoteTags from "#lib/components/notes/NoteTags.svelte";
  import { viewport } from "#lib/media.svelte.ts";

  const id = $derived(page.params.id!);
  const prefs = $derived(session.user?.preferences.editor ?? { fontSize: 15, layout: "split" as const });

  let note = $state<NoteDetail | null>(null);
  let loadError = $state<{ status: number; message: string } | null>(null);
  let editing = $state(false);
  let saving = $state(false);
  let deleteOpen = $state(false);
  let leaveOpen = $state(false);
  let pendingUrl: URL | null = null;
  let bypassGuard = false;

  // Editor form + the server snapshot it is compared with.
  let title = $state("");
  let content = $state("");
  let eventDate = $state("");
  let tagIds = $state<string[]>([]);
  let base = $state({ title: "", content: "", event_date: "", tagIds: [] as string[] });
  let layout = $state<"split" | "edit" | "preview">("split");
  let titleError = $state<string | null>(null);
  let draft = $state<NoteDraft | null>(null);
  let draftSavedAt = $state<number | null>(null);

  const sameTags = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
  const dirty = $derived(editing && (title !== base.title || content !== base.content || eventDate !== base.event_date || !sameTags(tagIds, base.tagIds)));

  function snapshot(n: NoteDetail) {
    return { title: n.title, content: n.content, event_date: n.event_date, tagIds: n.tags.map(tag => tag.id) };
  }
  const draftDiffers = (d: NoteDraft, n: NoteDetail) => {
    const s = snapshot(n);
    return d.title !== s.title || d.content !== s.content || d.event_date !== s.event_date || !sameTags(d.tagIds, s.tagIds);
  };

  async function fetchNote(target: string) {
    return (await api.get<{ item: NoteDetail }>(`/items/${target}`)).item;
  }

  // Load whenever the route id changes (the component is reused between notes).
  $effect(() => {
    const target = id;
    untrack(() => {
      note = null;
      loadError = null;
      editing = false;
      draft = null;
      draftSavedAt = null;
      layout = prefs.layout;
    });
    fetchNote(target).then(
      item => {
        if (target !== id) return;
        note = item;
        const saved = session.canEdit ? readDraft(target) : null;
        draft = saved && draftDiffers(saved, item) ? saved : null;
        if (saved && !draft) clearDraft(target);
        if (page.url.searchParams.get("edit") === "1") {
          const url = new URL(page.url.href);
          url.searchParams.delete("edit");
          void goto(url, { state: page.state, shallow: true, replace: true });
          if (session.canEdit) startEditing(false);
        }
      },
      e => {
        if (target === id) loadError = { status: e instanceof ApiError ? e.status : 0, message: (e as Error).message };
      },
    );
  });

  /** Refetch after media/transcript changes without touching the editor form. */
  async function refresh() {
    const item = await fetchNote(id);
    if (item.id !== id) return;
    note = item;
    notesList.patch(item.id, { has_audio: !!item.audio, has_transcript: !!item.transcript, audio_name: item.audio?.name ?? null, audio_duration_seconds: item.audio?.duration_seconds ?? null, updated_at: item.updated_at });
  }

  function startEditing(restoreDraft: boolean) {
    if (!note) return;
    const s = snapshot(note);
    base = s;
    const from = restoreDraft && draft ? draft : s;
    title = from.title;
    content = from.content;
    eventDate = from.event_date;
    tagIds = [...from.tagIds];
    titleError = null;
    draftSavedAt = restoreDraft && draft ? draft.savedAt : null;
    draft = null;
    editing = true;
  }

  function stopEditing() {
    editing = false;
    clearDraft(id);
    draftSavedAt = null;
  }

  // Autosave the unsaved form to localStorage (best effort; cleared on save/discard).
  $effect(() => {
    if (!dirty) return;
    const snap = { title, content, event_date: eventDate, tagIds: [...tagIds], base: note?.updated_at ?? "" };
    const target = id;
    const timer = setTimeout(() => {
      writeDraft(target, snap);
      draftSavedAt = Date.now();
    }, 700);
    return () => clearTimeout(timer);
  });

  async function save() {
    if (!note || saving) return;
    if (!title.trim()) {
      titleError = t("notes.titleRequired");
      return;
    }
    if (!dirty) return;
    saving = true;
    const target = note.id;
    try {
      const patch: Record<string, string> = {};
      if (title.trim() !== base.title) patch.title = title.trim();
      if (content !== base.content) patch.content = content;
      if (eventDate !== base.event_date) patch.event_date = eventDate;
      if (Object.keys(patch).length) await api.patch(`/items/${target}`, patch);
      let tags: TagRef[] | undefined;
      if (!sameTags(tagIds, base.tagIds)) tags = (await api.put<{ tags: TagRef[] }>(`/items/${target}/tags`, { tagIds })).tags;
      const savedForm = { title: title.trim(), content, event_date: eventDate, tagIds: [...tagIds] };
      clearDraft(target);
      draftSavedAt = null;
      const item = await fetchNote(target);
      if (target !== id) return;
      note = item;
      title = savedForm.title;
      base = savedForm;
      notesList.patch(target, { title: item.title, content: item.content, event_date: item.event_date, tags: tags ?? item.tags, updated_at: item.updated_at, updated_by_name: item.updated_by.name });
      toasts.show(t("notes.saved"), "success");
    } catch (e) {
      toasts.show((e as Error).message, "error");
    } finally {
      saving = false;
    }
  }

  async function saveAndClose() {
    if (dirty) await save();
    if (!dirty) stopEditing();
  }

  async function remove() {
    if (!note) return;
    try {
      await api.del(`/items/${note.id}`);
      clearDraft(note.id);
      notesList.remove(note.id);
      toasts.show(t("notes.deleted"));
      bypassGuard = true;
      await goto("/notes");
    } catch (e) {
      toasts.show((e as Error).message, "error");
      throw e;
    } finally {
      bypassGuard = false;
    }
  }

  beforeNavigate(nav => {
    if (!dirty || bypassGuard || nav.shallow) return;
    // Tab close / reload: SvelteKit shows the browser's own beforeunload prompt when cancelled.
    if (nav.type === "leave") return nav.cancel();
    nav.cancel();
    pendingUrl = nav.to?.url ?? null;
    leaveOpen = true;
  });

  function requestClose() {
    if (dirty) {
      pendingUrl = null;
      leaveOpen = true;
    } else stopEditing();
  }

  async function discardAndLeave() {
    stopEditing();
    if (pendingUrl) {
      bypassGuard = true;
      try {
        await goto(pendingUrl);
      } finally {
        bypassGuard = false;
      }
    }
  }

  function onKeydown(event: KeyboardEvent) {
    if (!editing) return;
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void save();
    }
  }

  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const longDate = (d: string) => formatDate(`${d}T12:00:00+08:00`, { year: "numeric", month: "long", day: "numeric", weekday: "short" });
</script>

<svelte:window onkeydown={onKeydown} />
<svelte:head><title>{note?.title ?? t("nav.notes")}</title></svelte:head>

{#snippet back()}
  <a href="/notes" class="-ml-2 inline-flex h-9 items-center gap-1 rounded-full pr-3 pl-1.5 text-[14px] font-medium text-ink-2 hover:bg-surface-3 hover:text-ink lg:hidden">
    <ChevronLeft class="size-5" />{t("nav.notes")}
  </a>
{/snippet}

<section class="flex min-h-0 flex-1 flex-col lg:overflow-hidden lg:rounded-[var(--radius-card)] lg:border lg:border-line/70 lg:bg-surface lg:shadow-card">
  {#if loadError}
    <div class="px-1 pb-2 lg:hidden">{@render back()}</div>
    <div class="flex flex-1 items-center justify-center rounded-[var(--radius-card)] border border-line/70 bg-surface lg:border-0">
      <EmptyState title={loadError.status === 404 ? t("notes.notFound") : t("common.error")} hint={loadError.status === 404 ? t("notes.notFoundHint") : loadError.message}>
        {#snippet icon()}<FileQuestion />{/snippet}
        {#snippet action()}<Button size="sm" href="/notes">{t("notes.backToList")}</Button>{/snippet}
      </EmptyState>
    </div>
  {:else if !note}
    <div class="flex flex-col gap-4 px-1 lg:p-8">
      <div class="lg:hidden">{@render back()}</div>
      <Skeleton class="h-5 w-40" />
      <Skeleton class="h-11 w-3/4" />
      <Skeleton class="h-5 w-64" />
      <Skeleton class="mt-4 h-64" />
    </div>
  {:else if editing}
    <!-- Editor -->
    <div class="flex min-h-0 flex-1 flex-col gap-3 lg:p-5">
      <div class="flex items-center gap-2">
        <Button variant="ghost" size="sm" onclick={requestClose} class="-ml-1"><X />{t("notes.editor.close")}</Button>
        <span class="min-w-0 flex-1 truncate text-[12.5px] text-ink-3" aria-live="polite">
          {#if saving}{t("action.saving")}{:else if dirty}{draftSavedAt ? t("notes.editor.draftSaved") : t("notes.editor.unsaved")}{:else}{t("notes.editor.clean")}{/if}
        </span>
        <span class="hidden items-center gap-1 text-[12px] text-ink-3 sm:flex"><Kbd>{mac ? "⌘" : "Ctrl"}</Kbd><Kbd>S</Kbd></span>
        <span class="hidden sm:block"><Button variant="secondary" size="sm" onclick={saveAndClose} disabled={saving}>{t("notes.editor.saveClose")}</Button></span>
        <Button variant="primary" size="sm" onclick={save} loading={saving} disabled={!dirty}>{t("action.save")}</Button>
      </div>
      <div class="flex flex-col gap-3 rounded-2xl lg:gap-2.5">
        <input
          bind:value={title}
          oninput={() => (titleError = null)}
          maxlength={200}
          aria-label={t("notes.field.title")}
          aria-invalid={titleError ? true : undefined}
          placeholder={t("notes.field.titlePlaceholder")}
          class="w-full rounded-xl border bg-surface px-3.5 py-2 font-display text-[26px] leading-tight text-ink outline-none placeholder:text-ink-3 focus:border-ink sm:text-[30px] {titleError ? 'border-danger' : 'border-line-2 lg:border-transparent lg:hover:border-line-2'}"
        />
        {#if titleError}<p class="-mt-1.5 px-1 text-[12.5px] text-danger">{titleError}</p>{/if}
        <div class="flex flex-wrap items-center gap-2">
          <DatePicker bind:value={eventDate} label={t("notes.field.date")} />
          <NoteTags bind:selected={tagIds} known={note.tags} editable />
        </div>
      </div>
      <MarkdownEditor bind:value={content} bind:layout fontSize={prefs.fontSize} label={t("notes.field.content")} fill={viewport.desktop} />
    </div>
  {:else}
    <!-- Reader -->
    <div class="min-h-0 flex-1 lg:overflow-y-auto">
      <article class="mx-auto w-full max-w-[760px] px-1 pb-8 lg:px-10 lg:pt-8 lg:pb-12">
        <div class="mb-3 flex items-center justify-between gap-2 lg:mb-4">
          <div class="flex min-w-0 items-center gap-2">
            {@render back()}
            <span class="hidden items-center gap-1.5 text-[13px] text-ink-3 tabular-nums lg:inline-flex"><CalendarDays class="size-3.5" />{longDate(note.event_date)}</span>
          </div>
          {#if session.canEdit}
            <div class="flex shrink-0 items-center gap-1.5">
              <Button variant="ghost" size="icon-sm" onclick={() => (deleteOpen = true)} aria-label={t("notes.delete")} title={t("notes.delete")}><Trash2 /></Button>
              <Button variant="primary" size="sm" onclick={() => startEditing(false)}><PenLine />{t("notes.edit")}</Button>
            </div>
          {/if}
        </div>

        {#if draft}
          <div class="mb-5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl px-4 py-3 text-[13px]" style="background:var(--pill-butter);color:var(--pill-butter-ink)">
            <History class="size-4 shrink-0" />
            <span class="min-w-0 flex-1">{t("notes.draft.found", { when: relativeTime(new Date(draft.savedAt).toISOString()) })}</span>
            <span class="flex gap-1.5">
              <button type="button" class="h-8 rounded-full px-3 font-medium hover:bg-black/5 dark:hover:bg-white/10" onclick={() => { clearDraft(id); draft = null; }}>{t("notes.draft.discard")}</button>
              <button type="button" class="h-8 rounded-full bg-[var(--pill-butter-ink)] px-3 font-medium text-[var(--pill-butter)]" onclick={() => startEditing(true)}>{t("notes.draft.restore")}</button>
            </span>
          </div>
        {/if}

        <p class="mb-2 inline-flex items-center gap-1.5 text-[13px] text-ink-3 tabular-nums lg:hidden"><CalendarDays class="size-3.5" />{longDate(note.event_date)}</p>
        <h1 class="font-display text-[32px] leading-[1.1] text-balance text-ink sm:text-[40px]">{note.title}</h1>

        <div class="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-ink-3">
          {#if note.created_by.name}
            <span class="inline-flex items-center gap-2"><Avatar name={note.created_by.name} size={24} class="ring-0" /><span><span class="text-ink-2">{note.created_by.name}</span> {t("notes.meta.created", { when: relativeTime(note.created_at) })}</span></span>
          {/if}
          {#if note.updated_at !== note.created_at && note.updated_by.name}
            <span>{t("notes.meta.updated", { name: note.updated_by.name, when: relativeTime(note.updated_at) })}</span>
          {/if}
        </div>

        {#if note.tags.length}
          <div class="mt-4 flex flex-wrap gap-1.5">
            {#each note.tags as tag (tag.id)}<a href="/notes?tags={tag.id}" class="inline-flex hover:brightness-95"><Pill tone={toneFor(tag.name)}>{tag.name}</Pill></a>{/each}
          </div>
        {/if}

        <div class="mt-6">
          {#key note.id}
            <NoteMedia {note} canEdit={session.canEdit} onChanged={refresh} />
          {/key}
        </div>

        <div class="mt-7 border-t border-line pt-7">
          {#if note.content.trim()}
            <MarkdownView source={note.content} fontSize={prefs.fontSize} />
          {:else}
            <div class="rounded-2xl border border-dashed border-line-2 px-6 py-10 text-center">
              <p class="text-sm font-medium text-ink">{t("notes.content.empty")}</p>
              {#if session.canEdit}
                <Button size="sm" class="mt-3" onclick={() => startEditing(false)}><PenLine />{t("notes.content.start")}</Button>
              {/if}
            </div>
          {/if}
        </div>
      </article>
    </div>
  {/if}
</section>

<ConfirmDialog bind:open={deleteOpen} title={t("notes.deleteTitle")} description={t("notes.deleteHint", { title: note?.title ?? "" })} confirmLabel={t("notes.delete")} onConfirm={remove} />
<ConfirmDialog bind:open={leaveOpen} title={t("notes.leave.title")} description={t("notes.leave.hint")} confirmLabel={t("notes.leave.confirm")} onConfirm={discardAndLeave} />
