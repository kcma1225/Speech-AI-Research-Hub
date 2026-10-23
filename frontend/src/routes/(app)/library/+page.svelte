<script lang="ts">
  import { untrack } from "svelte";
  import { onChanged } from "#lib/changes.ts";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { BookOpen, Globe, Plus, Search, SlidersHorizontal, X } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import { authorsShort, venueLine } from "#lib/library/format.ts";
  import type { LabPaper } from "#lib/library/types.ts";
  import type { StudyCard } from "#lib/studies/types.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Card from "#lib/components/ui/Card.svelte";
  import EmptyState from "#lib/components/ui/EmptyState.svelte";
  import PageHeader from "#lib/components/ui/PageHeader.svelte";
  import Pill from "#lib/components/ui/Pill.svelte";
  import Select from "#lib/components/ui/Select.svelte";
  import Skeleton from "#lib/components/ui/Skeleton.svelte";
  import LibraryScopeSwitch from "#lib/components/library/LibraryScopeSwitch.svelte";
  import { initialLibraryScope, rememberLibraryScope, type LibraryScope, type LibraryScopeCounts } from "#lib/library/scope.ts";
  import AddPaperSheet from "#lib/components/library/AddPaperSheet.svelte";
  import OnlineSearchSheet from "#lib/components/library/OnlineSearchSheet.svelte";
  import PaperSheet from "#lib/components/library/PaperSheet.svelte";

  type Facets = { venues: { value: string; count: number }[]; years: { value: number; count: number }[] };
  const params = page.url.searchParams;
  let q = $state(params.get("q") ?? "");
  let venue = $state(params.get("venue") ?? "");
  let year = $state(params.get("year") ?? "");
  let study = $state(params.get("study") ?? "");
  let pdf = $state(params.get("has_pdf") ?? "");
  let sort = $state<"recent" | "year" | "title">((params.get("sort") as "recent") ?? "recent");
  /** 我的研究 (papers of studies I own, the default) or 全部文獻; the choice is remembered per browser. */
  let scope = $state<LibraryScope>(initialLibraryScope(params));
  let counts = $state<LibraryScopeCounts | null>(null);
  let papers = $state<LabPaper[] | null>(null);
  let total = $state(0);
  let facets = $state<Facets>({ venues: [], years: [] });
  let error = $state<string | null>(null);
  let loadingMore = $state(false);
  let studies = $state<StudyCard[]>([]);
  const PAGE = 50;

  $effect(() => {
    api.get<{ studies: StudyCard[] }>("/studies?status=all").then(r => (studies = r.studies), () => {});
  });

  function query(offset = 0) {
    const p = new URLSearchParams();
    p.set("scope", scope);
    if (q.trim()) p.set("q", q.trim());
    if (venue) p.set("venue", venue);
    if (year) p.set("year", year);
    if (study) p.set("study", study);
    if (pdf) p.set("has_pdf", pdf);
    if (sort !== "recent") p.set("sort", sort);
    p.set("limit", String(PAGE));
    if (offset) p.set("offset", String(offset));
    return p;
  }

  let seq = 0;
  async function load() {
    const id = ++seq;
    try {
      const r = await api.get<{ papers: LabPaper[]; total: number; counts: LibraryScopeCounts; facets: Facets }>(`/library/papers?${query()}`);
      if (id !== seq) return;
      papers = r.papers;
      total = r.total;
      counts = r.counts;
      // Keep facet options for the active filter so it can be switched off.
      facets = r.facets;
      error = null;
    } catch (e) {
      if (id === seq) error = (e as Error).message;
    }
  }
  async function more() {
    if (!papers) return;
    loadingMore = true;
    try {
      const r = await api.get<{ papers: LabPaper[]; total: number }>(`/library/papers?${query(papers.length)}`);
      papers = [...papers, ...r.papers.filter(p => !papers!.some(x => x.id === p.id))];
    } finally {
      loadingMore = false;
    }
  }

  $effect(() => {
    const key = `${scope}|${q.trim()}|${venue}|${year}|${study}|${pdf}|${sort}`;
    const timer = setTimeout(() => {
      void load();
      const url = new URL(page.url.href);
      for (const [name, value] of [["scope", scope === "mine" ? "" : scope], ["q", q.trim()], ["venue", venue], ["year", year], ["study", study], ["has_pdf", pdf], ["sort", sort === "recent" ? "" : sort]] as const) {
        if (value) url.searchParams.set(name, value);
        else url.searchParams.delete(name);
      }
      if (url.search !== page.url.search) untrack(() => void goto(url, { shallow: true, replace: true }));
    }, key && untrack(() => papers) ? 220 : 0);
    return () => clearTimeout(timer);
  });

  const filtering = $derived(Boolean(q.trim() || venue || year || study || pdf));
  /** Selects in use (not the text search); shown as a badge on the phone 「篩選」 toggle. */
  const activeFilters = $derived([venue, year, study, pdf].filter(Boolean).length + (sort !== "recent" ? 1 : 0));
  let filtersOpen = $state(false);
  const venueOptions = $derived([{ value: "", label: t("library.filter.anyVenue") }, ...(venue && !facets.venues.some(v => v.value === venue) ? [{ value: venue, label: venue }] : []), ...facets.venues.map(v => ({ value: v.value, label: v.value, hint: String(v.count) }))]);
  const yearOptions = $derived([{ value: "", label: t("library.filter.anyYear") }, ...(year && !facets.years.some(y => String(y.value) === year) ? [{ value: year, label: year }] : []), ...facets.years.map(y => ({ value: String(y.value), label: String(y.value), hint: String(y.count) }))]);
  const studyOptions = $derived([{ value: "", label: t("library.filter.anyStudy") }, ...studies.map(s => ({ value: s.slug, label: s.title }))]);
  const pdfOptions = $derived([{ value: "", label: t("library.filter.anyPdf") }, { value: "true", label: t("library.filter.hasPdf") }, { value: "false", label: t("library.filter.noPdf") }]);
  const sortOptions = $derived([{ value: "recent" as const, label: t("library.sort.recent") }, { value: "year" as const, label: t("library.sort.year") }, { value: "title" as const, label: t("library.sort.title") }]);
  function clear() {
    q = venue = year = study = pdf = "";
  }

  let sheetOpen = $state(false);
  let current = $state<string | null>(params.get("paper"));
  $effect(() => {
    if (current && untrack(() => !sheetOpen)) sheetOpen = true;
  });
  function openPaper(id: string) {
    current = id;
    sheetOpen = true;
  }
  let addOpen = $state(false);
  let searchOpen = $state(false);
  // The AI (chat or a workflow) wrote ["papers"] in the background: reload without a page refresh (changes.ts).
  $effect(() => onChanged(["papers"], () => void load()));
</script>

<svelte:head><title>{t("library.title")} · Speech-AI Hub</title></svelte:head>

<PageHeader title={t("library.title")} subtitle={papers ? t("library.count", { n: total }) : t("library.subtitle")}>
  {#snippet actions()}
    <Button onclick={() => (searchOpen = true)}><Globe />{t("library.onlineSearch")}</Button>
    <Button variant="primary" onclick={() => (addOpen = true)}><Plus />{t("library.add")}</Button>
  {/snippet}
</PageHeader>

<!-- Scope switch and search share a row from lg up; the five filters get their own row (equal columns from xl),
     so the search box is never squeezed by the selects. On phones the filters fold behind 「篩選」. -->
<div class="mb-5 flex flex-col gap-2.5 sm:mb-6">
  <div class="flex flex-col gap-2.5 lg:flex-row lg:items-center lg:gap-3">
    <LibraryScopeSwitch bind:value={scope} {counts} onValueChange={rememberLibraryScope} />
    <div class="flex min-w-0 flex-1 items-center gap-2">
      <label class="relative min-w-0 flex-1">
        <span class="sr-only">{t("library.search")}</span>
        <Search class="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-ink-3" />
        <input
          bind:value={q}
          type="search"
          placeholder={t("library.search")}
          class="h-11 w-full rounded-full border border-line-2 bg-surface pr-10 pl-10 text-[15px] text-ink outline-none transition-[border-color,box-shadow] placeholder:text-ink-3 focus:border-ink focus:shadow-[0_0_0_3px_var(--surface-3)] sm:text-sm [&::-webkit-search-cancel-button]:hidden"
        />
        {#if q}<button type="button" class="absolute top-1/2 right-1 grid size-9 -translate-y-1/2 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label={t("library.filter.clear")} onclick={() => (q = "")}><X class="size-4" /></button>{/if}
      </label>
      <Button class="h-11 shrink-0 sm:hidden" variant={filtersOpen || activeFilters ? "secondary" : "ghost"} aria-expanded={filtersOpen} aria-controls="library-filters" onclick={() => (filtersOpen = !filtersOpen)}>
        <SlidersHorizontal />{t("library.filters")}{#if activeFilters}<span class="inline-grid h-5 min-w-5 place-items-center rounded-full bg-ink px-1 text-[11px] font-semibold text-surface tabular-nums">{activeFilters}</span>{/if}
      </Button>
      {#if filtering}<Button variant="ghost" onclick={clear} class="hidden h-11 shrink-0 sm:inline-flex"><X />{t("library.filter.clear")}</Button>{/if}
    </div>
  </div>
  <div id="library-filters" class="{filtersOpen ? 'grid' : 'hidden'} grid-cols-2 gap-2 sm:grid sm:grid-cols-3 xl:grid-cols-5">
    <Select bind:value={venue} label={t("library.filter.venue")} options={venueOptions} class="w-full min-w-0!" />
    <Select bind:value={year} label={t("library.filter.year")} options={yearOptions} class="w-full min-w-0!" />
    <Select bind:value={study} label={t("library.filter.study")} options={studyOptions} class="w-full min-w-0!" />
    <Select bind:value={pdf} label={t("library.filter.pdf")} options={pdfOptions} class="w-full min-w-0!" />
    <Select bind:value={sort} label={t("library.sort")} options={sortOptions} class="w-full min-w-0!" />
    {#if filtering}<Button variant="ghost" onclick={clear} class="w-full sm:hidden"><X />{t("library.filter.clear")}</Button>{/if}
  </div>
</div>

{#if error}
  <Card><EmptyState title={t("common.error")} hint={error} /></Card>
{:else if !papers}
  <Card><div class="flex flex-col gap-2">{#each [0, 1, 2, 3] as i (i)}<Skeleton class="h-14" />{/each}</div></Card>
{:else if !papers.length && scope === "mine" && !filtering && counts?.all}
  <Card>
    <EmptyState title={t("library.scope.emptyMine")} hint={t("library.scope.emptyMineHint", { n: counts.all })} class="py-14">
      {#snippet icon()}<BookOpen />{/snippet}
      {#snippet action()}<Button variant="secondary" onclick={() => ((scope = "all"), rememberLibraryScope("all"))}>{t("library.scope.showAll")}</Button>{/snippet}
    </EmptyState>
  </Card>
{:else if !papers.length}
  <Card>
    <EmptyState title={filtering ? t("library.emptyFiltered") : t("library.empty")} hint={filtering ? undefined : t("library.emptyHint")} class="py-14">
      {#snippet icon()}<BookOpen />{/snippet}
      {#snippet action()}
        {#if filtering}<Button variant="secondary" onclick={clear}>{t("library.filter.clear")}</Button>{:else}<Button variant="primary" onclick={() => (addOpen = true)}><Plus />{t("library.add")}</Button>{/if}
      {/snippet}
    </EmptyState>
  </Card>
{:else}
  <Card padded={false} class="overflow-hidden">
    <table class="hidden w-full table-fixed text-left md:table">
      <thead class="border-b border-line text-[12px] text-ink-3">
        <tr>
          <th class="py-3 pr-3 pl-5 font-medium">{t("library.col.title")}</th>
          <th class="hidden w-[170px] py-3 pr-3 font-medium lg:table-cell">{t("library.col.venue")}</th>
          <th class="w-[64px] py-3 pr-3 font-medium">{t("library.col.year")}</th>
          <th class="hidden w-[210px] py-3 pr-5 font-medium xl:table-cell">{t("library.col.studies")}</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-line">
        {#each papers as p (p.id)}
          <tr class="cursor-pointer transition-colors hover:bg-surface-2/70" onclick={() => openPaper(p.id)}>
            <td class="min-w-0 py-3 pr-3 pl-5 align-top">
              <button type="button" class="block w-full text-left outline-none focus-visible:underline" onclick={e => (e.stopPropagation(), openPaper(p.id))}>
                <span class="block text-[14px] leading-snug font-medium break-words text-ink">{p.title}</span>
                <span class="mt-0.5 block truncate text-[12.5px] text-ink-3">{authorsShort(p.authors)}<span class="lg:hidden">{p.venue ? ` · ${p.venue}` : ""}</span></span>
              </button>
              {#if p.has_pdf}<span class="mt-1.5 inline-flex"><Pill tone="rose" size="sm">PDF</Pill></span>{/if}
            </td>
            <td class="hidden py-3 pr-3 align-top text-[12.5px] text-ink-2 lg:table-cell"><span class="line-clamp-2">{p.venue ?? p.container_title ?? "—"}</span></td>
            <td class="py-3 pr-3 align-top text-[12.5px] text-ink-2 tabular-nums">{p.year ?? "—"}</td>
            <td class="hidden py-3 pr-5 align-top xl:table-cell">
              <span class="flex flex-wrap gap-1">
                {#each p.studies.slice(0, 2) as s (s.id)}<Pill tone="stone" size="sm" class="max-w-[190px]">{s.title}</Pill>{/each}
                {#if p.studies.length > 2}<span class="text-[11px] text-ink-3">+{p.studies.length - 2}</span>{/if}
              </span>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    <ul class="flex flex-col divide-y divide-line md:hidden">
      {#each papers as p (p.id)}
        <li>
          <button type="button" class="flex w-full flex-col gap-1 px-4 py-3.5 text-left active:bg-surface-2" onclick={() => openPaper(p.id)}>
            <span class="text-[14.5px] leading-snug font-medium break-words text-ink">{p.title}</span>
            <span class="text-[12.5px] break-words text-ink-3">{authorsShort(p.authors, 2)}{venueLine(p) ? ` · ${venueLine(p)}` : ""}</span>
            {#if p.has_pdf || p.studies.length}
              <span class="mt-0.5 flex flex-wrap items-center gap-1">
                {#if p.has_pdf}<Pill tone="rose" size="sm">PDF</Pill>{/if}
                {#if p.studies.length}<span class="text-[11.5px] text-ink-3">{t("library.inStudies", { n: p.studies.length })}</span>{/if}
              </span>
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  </Card>
  {#if papers.length < total}
    <div class="mt-4 flex justify-center"><Button variant="ghost" loading={loadingMore} onclick={more}>{t("library.loadMore")}</Button></div>
  {/if}
{/if}

<PaperSheet bind:open={sheetOpen} paperId={current} onChanged={load} />
<AddPaperSheet bind:open={addOpen} onAdded={id => (void load(), openPaper(id))} />
<OnlineSearchSheet bind:open={searchOpen} onAdded={load} />
