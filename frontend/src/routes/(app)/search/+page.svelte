<script lang="ts">
  import { untrack } from "svelte";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { ArrowLeft, Info, Search, SlidersHorizontal, Sparkles, X } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { i18n, t } from "#lib/i18n.svelte.ts";
  import { SEARCH_TYPES, typeMeta } from "#lib/search/meta.ts";
  import type { SearchResponse, SearchType } from "#lib/search/types.ts";
  import type { StudyCard } from "#lib/studies/types.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Card from "#lib/components/ui/Card.svelte";
  import DatePicker from "#lib/components/ui/DatePicker.svelte";
  import EmptyState from "#lib/components/ui/EmptyState.svelte";
  import Select from "#lib/components/ui/Select.svelte";
  import Skeleton from "#lib/components/ui/Skeleton.svelte";
  import SearchResultRow from "#lib/components/search/SearchResultRow.svelte";

  type DirectoryUser = { id: string; name: string; role: string };
  const params = page.url.searchParams;
  let q = $state(params.get("q") ?? "");
  let type = $state<"" | SearchType>((params.get("type") as SearchType) ?? "");
  let study = $state(params.get("study") ?? "");
  let author = $state(params.get("author") ?? "");
  let from = $state(params.get("from") ?? "");
  let to = $state(params.get("to") ?? "");
  let showFilters = $state(["study", "author", "from", "to"].some(k => params.get(k)));

  let result = $state<SearchResponse | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let limit = $state(params.get("type") ? 20 : 5);
  let studies = $state<StudyCard[]>([]);
  let users = $state<DirectoryUser[]>([]);
  let input = $state<HTMLInputElement | null>(null);

  $effect(() => {
    api.get<{ studies: StudyCard[] }>("/studies?status=all").then(r => (studies = r.studies), () => {});
    api.get<{ users: DirectoryUser[] }>("/users/directory").then(r => (users = r.users), () => {});
    if (!q) input?.focus();
  });

  let seq = 0;
  async function load() {
    const query = q.trim();
    const id = ++seq;
    if (!query) {
      result = null;
      loading = false;
      error = null;
      return;
    }
    loading = true;
    const p = new URLSearchParams({ q: query, limit: String(limit) });
    if (type) p.set("types", type);
    if (study) p.set("studyId", study);
    if (author) p.set("author", author);
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    try {
      const r = await api.get<SearchResponse>(`/search?${p}`);
      if (id !== seq) return;
      result = r;
      error = null;
    } catch (e) {
      if (id === seq) error = (e as Error).message;
    } finally {
      if (id === seq) loading = false;
    }
  }

  $effect(() => {
    const key = `${q.trim()}|${type}|${study}|${author}|${from}|${to}|${limit}`;
    const timer = setTimeout(
      () => {
        void load();
        const url = new URL(page.url.href);
        for (const [name, value] of [["q", q.trim()], ["type", type], ["study", study], ["author", author], ["from", from], ["to", to]] as const) {
          if (value) url.searchParams.set(name, value);
          else url.searchParams.delete(name);
        }
        if (url.search !== page.url.search) untrack(() => void goto(url, { shallow: true, replace: true }));
      },
      key && untrack(() => result) ? 220 : 0,
    );
    return () => clearTimeout(timer);
  });

  function setType(next: "" | SearchType) {
    type = next;
    limit = next ? 20 : 5;
    window.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }
  const filtering = $derived(Boolean(study || author || from || to));
  function clearFilters() {
    study = author = from = to = "";
  }

  const typeOptions = $derived([{ value: "" as const, label: t("search.filter.allTypes") }, ...SEARCH_TYPES.map(x => ({ value: x.type, label: t(x.label) }))]);
  const studyOptions = $derived([{ value: "", label: t("search.filter.anyStudy") }, ...studies.map(s => ({ value: s.slug, label: s.title }))]);
  const authorOptions = $derived([{ value: "", label: t("search.filter.anyAuthor") }, { value: "me", label: t("search.filter.mine") }, ...users.map(u => ({ value: u.id, label: u.name }))]);
  const groups = $derived(result ? [...result.groups].sort((a, b) => SEARCH_TYPES.findIndex(x => x.type === a.type) - SEARCH_TYPES.findIndex(x => x.type === b.type)) : []);
</script>

<svelte:head><title>{q.trim() ? `${q.trim()} · ` : ""}{t("search.title")} · Speech-AI Hub</title></svelte:head>

<div class="mx-auto w-full max-w-[860px]">
  <header class="mb-4 sm:mb-6">
    <h1 class="text-[26px] leading-tight font-semibold tracking-[-0.02em] text-ink sm:text-[30px]">{t("search.title")}</h1>
    <p class="mt-1 text-[14px] text-ink-3">{t("search.subtitle")}</p>
  </header>

  <form class="flex items-center gap-2" role="search" onsubmit={e => (e.preventDefault(), void load())}>
    <label class="relative min-w-0 flex-1">
      <span class="sr-only">{t("search.inputLabel")}</span>
      <Search class="pointer-events-none absolute top-1/2 left-4 size-[18px] -translate-y-1/2 text-ink-3" />
      <input
        bind:this={input}
        bind:value={q}
        type="search"
        enterkeyhint="search"
        placeholder={t("search.placeholderAll")}
        class="h-12 w-full rounded-full border border-line-2 bg-surface pr-11 pl-11 text-[16px] text-ink outline-none transition-[border-color,box-shadow] placeholder:text-ink-3 focus:border-ink focus:shadow-[0_0_0_3px_var(--surface-3)] [&::-webkit-search-cancel-button]:hidden"
      />
      {#if q}
        <button type="button" class="absolute top-1/2 right-1.5 grid size-10 -translate-y-1/2 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label={t("search.clearQuery")} onclick={() => ((q = ""), input?.focus())}><X class="size-4" /></button>
      {/if}
    </label>
    <Button variant={showFilters || filtering ? "primary" : "secondary"} size="lg" class="shrink-0 rounded-full px-4" aria-label={t("search.filter.show")} aria-expanded={showFilters} aria-controls="search-filters" onclick={() => (showFilters = !showFilters)}>
      <SlidersHorizontal /><span class="hidden sm:inline">{t("search.filter.show")}</span>
    </Button>
  </form>

  <div class="mt-3 flex flex-wrap items-center gap-2">
    <Select value={type} onValueChange={v => setType(v)} label={t("search.filter.type")} options={typeOptions} class="w-[calc(50%-4px)] min-w-0 sm:w-44" />
    {#if result && q.trim() && result.search_mode === "semantic"}
      <span class="ml-auto flex min-h-10 items-center gap-1.5 text-[12.5px] text-ink-3" aria-live="polite"><Sparkles class="size-3.5" />{t("search.semantic")}</span>
    {/if}
  </div>

  {#if showFilters}
    <div id="search-filters" class="mt-3 grid grid-cols-2 gap-2 rounded-2xl border border-line bg-surface p-3 sm:flex sm:flex-wrap sm:items-center">
      <Select bind:value={study} label={t("search.filter.study")} options={studyOptions} class="w-full min-w-0 sm:w-48" />
      <Select bind:value={author} label={t("search.filter.author")} options={authorOptions} class="w-full min-w-0 sm:w-40" />
      <DatePicker bind:value={from} clearable label={t("search.filter.from")} placeholder={t("search.filter.from")} class="w-full min-w-0 sm:w-40" />
      <DatePicker bind:value={to} clearable label={t("search.filter.to")} placeholder={t("search.filter.to")} class="w-full min-w-0 sm:w-40" />
      {#if filtering}<Button variant="ghost" class="col-span-2 sm:col-span-1" onclick={clearFilters}><X />{t("search.filter.clear")}</Button>{/if}
    </div>
  {/if}

  {#if result && result.search_mode === "keyword_only" && q.trim()}
    <div class="mt-4 flex items-start gap-2.5 rounded-2xl border border-line bg-surface-2 px-4 py-3 text-[13px] text-ink-2" role="status">
      <Info class="mt-0.5 size-4 shrink-0 text-ink-3" />
      <span><span class="font-medium text-ink">{t("search.keywordOnly")}</span> · {(i18n.locale === "zh-TW" && result.notice_zh) || t("search.keywordOnlyHint")}</span>
    </div>
  {/if}

  <div class="mt-5 sm:mt-6">
    {#if !q.trim()}
      <Card><EmptyState title={t("search.startTitle")} hint={t("search.startHint")} class="py-14">{#snippet icon()}<Search />{/snippet}</EmptyState></Card>
    {:else if error}
      <Card><EmptyState title={t("common.error")} hint={error} /></Card>
    {:else if !result}
      <Card><div class="flex flex-col gap-3">{#each [0, 1, 2, 3] as i (i)}<Skeleton class="h-16" />{/each}</div></Card>
    {:else if !groups.length}
      <Card>
        <EmptyState title={t("search.noResults", { q: q.trim() })} hint={t("search.noResultsHint")} class="py-14">
          {#snippet icon()}<Search />{/snippet}
          {#snippet action()}{#if filtering || type}<Button variant="secondary" onclick={() => (clearFilters(), setType(""))}>{t("search.filter.clear")}</Button>{/if}{/snippet}
        </EmptyState>
      </Card>
    {:else}
      <div class="flex flex-col gap-4 transition-opacity motion-reduce:transition-none {loading ? 'opacity-60' : ''}">
        {#if type}
          <button type="button" class="-mb-1 flex h-10 items-center gap-1.5 self-start rounded-full px-2 text-[13px] font-medium text-ink-2 hover:bg-surface-3 hover:text-ink" onclick={() => setType("")}><ArrowLeft class="size-4" />{t("search.backToAll")}</button>
        {/if}
        {#each groups as g (g.type)}
          {@const m = typeMeta(g.type)}
          <section aria-labelledby="sr-{g.type}">
            <Card padded={false} class="overflow-hidden">
              <h2 id="sr-{g.type}" class="flex items-center gap-2 border-b border-line px-4 py-3 text-[13px] font-semibold text-ink sm:px-5">
                <m.icon class="size-4 text-ink-3" />{t(m.label)}<span class="font-normal text-ink-3 tabular-nums">{g.results.length}{g.has_more ? "+" : ""}</span>
              </h2>
              <ul class="flex flex-col p-1.5 sm:p-2">
                {#each g.results as hit (hit.id)}<li><SearchResultRow {hit} /></li>{/each}
              </ul>
              {#if g.has_more}
                <div class="border-t border-line px-2 py-1.5">
                  {#if type}
                    <Button variant="ghost" class="w-full" loading={loading} onclick={() => (limit = Math.min(50, limit + 20))} disabled={limit >= 50}>{t("search.loadMore")}</Button>
                  {:else}
                    <Button variant="ghost" class="w-full" onclick={() => setType(g.type)}>{t("search.more", { type: t(m.label) })}</Button>
                  {/if}
                </div>
              {/if}
            </Card>
          </section>
        {/each}
      </div>
    {/if}
  </div>
</div>
