<script lang="ts">
  import { AudioLines, Captions, FileText, Plus, Search, SearchX, X } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { formatDate, t } from "#lib/i18n.svelte.ts";
  import { session } from "#lib/stores/session.svelte.ts";
  import { notesList } from "#lib/notes/list.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import EmptyState from "#lib/components/ui/EmptyState.svelte";
  import Pill, { tagTone, toneFor } from "#lib/components/ui/Pill.svelte";
  import Skeleton from "#lib/components/ui/Skeleton.svelte";
  import Spinner from "#lib/components/ui/Spinner.svelte";
  import TagFilter from "./TagFilter.svelte";

  let { activeId, onNew }: { activeId: string | null; onNew: () => void } = $props();

  let tags = $state<{ id: string; name: string; count: number }[]>([]);
  let search = $state(notesList.q);
  let sentinel = $state<HTMLElement | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** IME composition in progress (zhuyin/pinyin): search only once the text is committed. */
  let composing = false;

  $effect(() => {
    api.get<{ tags: { id: string; name: string; count: number }[] }>("/tags").then(r => (tags = r.tags), () => {});
  });

  function onSearch() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (notesList.q === search) return;
      notesList.q = search;
      void notesList.reload();
    }, 250);
  }
  function clearSearch() {
    search = "";
    clearTimeout(timer);
    notesList.q = "";
    void notesList.reload();
  }
  function setTags(ids: string[]) {
    notesList.tags = ids;
    void notesList.reload();
  }

  $effect(() => {
    if (!sentinel) return;
    const observer = new IntersectionObserver(entries => entries.some(e => e.isIntersecting) && notesList.more(), { rootMargin: "240px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  });

  const tagName = (id: string) => (id === "none" ? t("notes.filter.untagged") : (tags.find(tag => tag.id === id)?.name ?? "…"));
  const filtering = $derived(!!notesList.q.trim() || notesList.tags.length > 0);
</script>

<div class="flex min-h-0 flex-1 flex-col">
  <div class="flex items-center justify-between gap-3 px-1 pb-4 lg:px-5 lg:pt-5 lg:pb-3">
    <h1 class="font-display text-[34px] leading-[1.05] text-ink lg:text-[30px]">{t("nav.notes")}</h1>
    {#if session.canEdit}
      <span class="lg:hidden"><Button variant="primary" size="sm" onclick={onNew}><Plus />{t("notes.new")}</Button></span>
      <span class="hidden lg:block"><Button variant="primary" size="icon-sm" onclick={onNew} aria-label={t("notes.new")} title={t("notes.new")}><Plus /></Button></span>
    {/if}
  </div>

  <div class="flex items-center gap-2 px-1 pb-3 lg:px-4">
    <label class="relative flex h-10 min-w-0 flex-1 items-center rounded-full border border-line bg-surface transition-colors focus-within:border-ink lg:bg-surface-2">
      <Search class="pointer-events-none absolute left-3.5 size-4 text-ink-3" />
      <span class="sr-only">{t("notes.search")}</span>
      <input
        type="search"
        bind:value={search}
        oninput={() => !composing && onSearch()}
        oncompositionstart={() => (composing = true)}
        oncompositionend={() => {
          composing = false;
          onSearch();
        }}
        onkeydown={e => !e.isComposing && e.key === "Escape" && search && clearSearch()}
        placeholder={t("notes.search")}
        class="h-full w-full min-w-0 rounded-full bg-transparent pl-10 {search ? 'pr-9' : 'pr-3'} text-[15px] text-ink outline-none placeholder:text-ink-3 sm:text-sm [&::-webkit-search-cancel-button]:hidden"
      />
      {#if search}
        <button type="button" onclick={clearSearch} class="absolute right-1.5 grid size-7 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label={t("notes.search.clear")}><X class="size-3.5" /></button>
      {/if}
    </label>
    <TagFilter {tags} selected={notesList.tags} onChange={setTags} />
  </div>

  {#if notesList.tags.length}
    <div class="flex flex-wrap gap-1.5 px-1 pb-3 lg:px-4">
      {#each notesList.tags as id (id)}
        <button type="button" onclick={() => setTags(notesList.tags.filter(x => x !== id))} class="group inline-flex" aria-label={t("notes.filter.remove", { name: tagName(id) })}>
          <Pill tone={id === "none" ? "stone" : toneFor(id)} size="md">{tagName(id)}<X class="-mr-1 size-3 opacity-60 group-hover:opacity-100" /></Pill>
        </button>
      {/each}
    </div>
  {/if}

  <div class="min-h-0 flex-1 lg:overflow-y-auto lg:px-2.5 lg:pb-3" aria-busy={notesList.loading}>
    {#if !notesList.loaded && notesList.loading}
      <div class="flex flex-col gap-2 px-1 lg:px-0">{#each [0, 1, 2, 3, 4] as i (i)}<Skeleton class="h-[104px] rounded-2xl" />{/each}</div>
    {:else if notesList.error && !notesList.items.length}
      <EmptyState title={t("common.error")} hint={notesList.error}>
        {#snippet action()}<Button size="sm" onclick={() => notesList.reload()}>{t("action.retry")}</Button>{/snippet}
      </EmptyState>
    {:else if !notesList.items.length}
      {#if filtering}
        <EmptyState title={t("notes.list.noMatch")} hint={t("notes.list.noMatchHint")}>
          {#snippet icon()}<SearchX />{/snippet}
          {#snippet action()}<Button size="sm" onclick={() => { clearSearch(); setTags([]); }}>{t("notes.filter.clear")}</Button>{/snippet}
        </EmptyState>
      {:else}
        <EmptyState title={t("notes.list.empty")} hint={session.canEdit ? t("notes.list.emptyHint") : undefined}>
          {#snippet icon()}<FileText />{/snippet}
          {#snippet action()}{#if session.canEdit}<Button variant="primary" size="sm" onclick={onNew}><Plus />{t("notes.new")}</Button>{/if}{/snippet}
        </EmptyState>
      {/if}
    {:else}
      <ul class="flex flex-col gap-2 lg:gap-0.5">
        {#each notesList.items as note (note.id)}
          {@const active = note.id === activeId}
          <li>
            <a
              href="/notes/{note.id}"
              aria-current={active ? "page" : undefined}
              class="group block rounded-2xl border px-4 py-3.5 transition-colors lg:px-3.5 lg:py-3 {active
                ? 'border-transparent bg-surface-3'
                : 'border-line/70 bg-surface hover:bg-surface-2 lg:border-transparent lg:bg-transparent'}"
            >
              <div class="flex items-start gap-2">
                <h2 class="line-clamp-2 min-w-0 flex-1 text-[14.5px] leading-snug font-semibold text-ink lg:text-[14px]">{note.title}</h2>
                {#if note.has_audio || note.has_transcript}
                  <span class="mt-0.5 flex shrink-0 items-center gap-1 text-ink-3">
                    {#if note.has_audio}<span class="grid size-5 place-items-center rounded-md" style="background:var(--pill-mint);color:var(--pill-mint-ink)" title={t("notes.hasAudio")}><AudioLines class="size-3" /></span>{/if}
                    {#if note.has_transcript}<span class="grid size-5 place-items-center rounded-md" style="background:var(--pill-sky);color:var(--pill-sky-ink)" title={t("notes.hasTranscript")}><Captions class="size-3" /></span>{/if}
                  </span>
                {/if}
              </div>
              {#if note.excerpt}<p class="mt-1 line-clamp-2 text-[13px] leading-relaxed text-ink-3">{note.excerpt}</p>{/if}
              <div class="mt-2 flex items-center gap-2 text-[12px] text-ink-3">
                <span class="shrink-0 tabular-nums">{formatDate(`${note.event_date}T12:00:00+08:00`, { month: "short", day: "numeric", year: "numeric" })}</span>
                {#if note.created_by_name}<span aria-hidden="true">·</span><span class="max-w-[8em] shrink-0 truncate">{note.created_by_name}</span>{/if}
                {#if note.tags.length}
                  <span class="ml-auto flex min-w-0 justify-end gap-1 overflow-hidden">
                    {#each note.tags.slice(0, 2) as tag (tag.id)}<Pill tone={tagTone(tag)} size="sm" class="shrink">{tag.name}</Pill>{/each}
                    {#if note.tags.length > 2}<Pill size="sm" class="shrink-0">+{note.tags.length - 2}</Pill>{/if}
                  </span>
                {/if}
              </div>
            </a>
          </li>
        {/each}
      </ul>
      <div bind:this={sentinel} class="flex h-12 items-center justify-center">
        {#if notesList.nextCursor && notesList.loading}<Spinner />{/if}
      </div>
    {/if}
  </div>
</div>
