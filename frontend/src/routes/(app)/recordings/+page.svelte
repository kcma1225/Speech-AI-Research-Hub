<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { untrack } from "svelte";
  import { AudioLines, Captions, FileText, Mic, Search, X } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { formatDate, t } from "#lib/i18n.svelte.ts";
  import { formatClock, type RecordingSummary } from "#lib/recordings/types.ts";
  import Avatar from "#lib/components/ui/Avatar.svelte";
  import Button from "#lib/components/ui/Button.svelte";
  import Card from "#lib/components/ui/Card.svelte";
  import EmptyState from "#lib/components/ui/EmptyState.svelte";
  import PageHeader from "#lib/components/ui/PageHeader.svelte";
  import Pill, { tagTone, toneFor } from "#lib/components/ui/Pill.svelte";
  import Skeleton from "#lib/components/ui/Skeleton.svelte";

  const PAGE = 24;
  let query = $state(page.url.searchParams.get("q") ?? "");
  /** IME composition in progress (zhuyin/pinyin): wait for the committed text before searching. */
  let composing = $state(false);
  let items = $state<RecordingSummary[] | null>(null);
  let cursor = $state<string | null>(null);
  let loadingMore = $state(false);
  let error = $state<string | null>(null);
  let generation = 0;
  let firstLoad = true;

  async function load(q: string, after: string | null = null) {
    const id = ++generation;
    const params = new URLSearchParams({ audio: "1", limit: String(PAGE) });
    if (q) params.set("q", q);
    if (after) params.set("cursor", after);
    try {
      const result = await api.get<{ items: RecordingSummary[]; nextCursor: string | null }>(`/items?${params}`);
      if (id !== generation) return;
      items = after ? [...(items ?? []), ...result.items] : result.items;
      cursor = result.nextCursor;
      error = null;
    } catch (e) {
      if (id === generation) error = (e as Error).message;
    }
  }

  // Debounced search, mirrored into ?q= so the view survives a reload.
  const trimmed = $derived(query.trim());
  $effect(() => {
    const q = trimmed;
    if (composing) return;
    const timer = setTimeout(() => {
      void load(q);
      untrack(() => {
        const url = new URL(page.url.href);
        if (q) url.searchParams.set("q", q);
        else url.searchParams.delete("q");
        if (url.search !== page.url.search) void goto(url, { state: page.state, shallow: true, replace: true });
      });
    }, firstLoad ? 0 : 250);
    firstLoad = false;
    return () => clearTimeout(timer);
  });

  async function more() {
    if (!cursor) return;
    loadingMore = true;
    await load(trimmed, cursor);
    loadingMore = false;
  }

  const longest = $derived(Math.max(1, ...(items ?? []).map(i => i.audio_duration_seconds ?? 0)));
  const totalSeconds = $derived((items ?? []).reduce((sum, i) => sum + (i.audio_duration_seconds ?? 0), 0));
</script>

<svelte:head><title>{t("recordings.title")} · Speech-AI Hub</title></svelte:head>

<PageHeader
  title={t("recordings.title")}
  subtitle={items && items.length && !trimmed
    ? t(cursor ? "recordings.list.summaryMore" : "recordings.list.summary", { n: items.length, time: formatClock(totalSeconds) })
    : t("recordings.list.subtitle")}
>
  {#snippet actions()}
    <div class="relative w-full sm:w-72">
      <Search class="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-ink-3" />
      <input
        type="search"
        bind:value={query}
        oncompositionstart={() => (composing = true)}
        oncompositionend={() => (composing = false)}
        placeholder={t("recordings.list.search")}
        aria-label={t("recordings.list.search")}
        class="h-10 w-full rounded-full border border-line-2 bg-surface pr-10 pl-10 text-[15px] text-ink outline-none transition-[border-color,box-shadow] placeholder:text-ink-3 focus:border-ink focus:shadow-[0_0_0_3px_var(--surface-3)] sm:text-sm [&::-webkit-search-cancel-button]:hidden"
      />
      {#if query}
        <button type="button" class="absolute top-1/2 right-1.5 grid size-7 -translate-y-1/2 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label={t("recordings.list.clear")} onclick={() => (query = "")}>
          <X class="size-4" />
        </button>
      {/if}
    </div>
  {/snippet}
</PageHeader>

{#if error && !items}
  <Card>
    <EmptyState title={t("common.error")} hint={error}>
      {#snippet action()}<Button onclick={() => load(trimmed)}>{t("action.retry")}</Button>{/snippet}
    </EmptyState>
  </Card>
{:else if !items}
  <div class="grid gap-3 sm:gap-4 md:grid-cols-2 xl:grid-cols-3">
    {#each [0, 1, 2, 3, 4, 5] as i (i)}<Skeleton class="h-[188px] rounded-[22px]" />{/each}
  </div>
{:else if !items.length}
  <Card>
    {#if trimmed}
      <EmptyState title={t("recordings.list.noMatch", { q: trimmed })} hint={t("recordings.list.noMatchHint")}>
        {#snippet icon()}<Search />{/snippet}
        {#snippet action()}<Button onclick={() => (query = "")}>{t("recordings.list.clear")}</Button>{/snippet}
      </EmptyState>
    {:else}
      <EmptyState title={t("recordings.list.empty")} hint={t("recordings.list.emptyHint")} class="py-14">
        {#snippet icon()}<Mic />{/snippet}
        {#snippet action()}<Button variant="primary" href="/notes"><FileText />{t("recordings.list.toNotes")}</Button>{/snippet}
      </EmptyState>
    {/if}
  </Card>
{:else}
  <ul class="grid gap-3 sm:gap-4 md:grid-cols-2 xl:grid-cols-3">
    {#each items as item (item.id)}
      {@const share = (item.audio_duration_seconds ?? 0) / longest}
      <li>
        <a
          href="/recordings/{item.id}"
          class="group flex h-full flex-col gap-4 rounded-[22px] border border-line/70 bg-surface p-4 shadow-card transition-[border-color,transform] hover:border-line-2 sm:p-5"
        >
          <div class="flex items-start gap-3">
            <span class="grid size-11 shrink-0 place-items-center rounded-2xl transition-transform group-hover:scale-105" style="background:var(--pill-mint);color:var(--pill-mint-ink)">
              <AudioLines class="size-5" />
            </span>
            <div class="min-w-0 flex-1">
              <h2 class="line-clamp-2 text-[15px] leading-snug font-semibold text-ink">{item.title}</h2>
              <p class="mt-1 text-[12.5px] text-ink-3">{formatDate(item.event_date)}</p>
            </div>
            {#if item.has_transcript}
              <Pill tone="sky" size="sm" class="shrink-0"><Captions class="size-3" />{t("recordings.list.hasTranscript")}</Pill>
            {/if}
          </div>

          <!-- Duration bar: length relative to the longest recording on the page. -->
          <div class="flex items-center gap-3">
            <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3" aria-hidden="true">
              <div class="h-full rounded-full bg-ink/70" style="width:{Math.max(6, share * 100)}%"></div>
            </div>
            <span class="text-[13px] font-semibold text-ink tabular-nums">{formatClock(item.audio_duration_seconds)}</span>
          </div>

          <div class="mt-auto flex flex-col gap-3">
            {#if item.tags.length}
              <div class="flex flex-wrap gap-1.5">
                {#each item.tags.slice(0, 4) as tag (tag.id)}<Pill tone={tagTone(tag)} size="sm">{tag.name}</Pill>{/each}
                {#if item.tags.length > 4}<Pill size="sm">+{item.tags.length - 4}</Pill>{/if}
              </div>
            {/if}
            <div class="flex items-center gap-2 border-t border-line pt-3 text-[12.5px] text-ink-3">
              {#if item.created_by_name}
                <Avatar name={item.created_by_name} size={22} class="ring-0" />
                <span class="shrink-0 text-ink-2">{item.created_by_name}</span>
                <span aria-hidden="true">·</span>
              {/if}
              <span class="min-w-0 truncate" title={item.audio_name ?? ""}>{item.audio_name ?? "—"}</span>
            </div>
          </div>
        </a>
      </li>
    {/each}
  </ul>
  {#if cursor}
    <div class="mt-6 flex justify-center">
      <Button loading={loadingMore} onclick={more}>{t("recordings.list.more")}</Button>
    </div>
  {/if}
  {#if error}<p class="mt-4 text-center text-[13px] text-danger">{error}</p>{/if}
{/if}
