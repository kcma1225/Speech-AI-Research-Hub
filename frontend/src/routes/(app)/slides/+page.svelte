<script lang="ts">
  import { untrack } from "svelte";
  import { Presentation, Search, Upload, X } from "@lucide/svelte";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { api } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Card from "#lib/components/ui/Card.svelte";
  import EmptyState from "#lib/components/ui/EmptyState.svelte";
  import PageHeader from "#lib/components/ui/PageHeader.svelte";
  import Select from "#lib/components/ui/Select.svelte";
  import Skeleton from "#lib/components/ui/Skeleton.svelte";
  import DeckCard from "#lib/components/slides/DeckCard.svelte";
  import DeleteDeckDialog from "#lib/components/slides/DeleteDeckDialog.svelte";
  import UploadSheet from "#lib/components/slides/UploadSheet.svelte";
  import type { SlideSummary, UploadLimits } from "#lib/slides/types.ts";
  import { DEFAULT_LIMITS, isBusy } from "#lib/slides/util.ts";

  const params = page.url.searchParams;
  let q = $state(params.get("q") ?? "");
  /** Study filter: a study id, or "" for all studies. */
  let study = $state(params.get("study") ?? "");
  let studies = $state<{ id: string; title: string }[]>([]);
  $effect(() => {
    api.get<{ studies: { id: string; title: string }[] }>("/studies?status=all").then(r => (studies = r.studies), () => {});
  });
  let slides = $state<SlideSummary[] | null>(null);
  let limits = $state<UploadLimits>(DEFAULT_LIMITS);
  let error = $state<string | null>(null);
  let uploadOpen = $state(false);
  let deleting = $state<SlideSummary | null>(null);
  let deleteOpen = $state(false);

  let seq = 0;
  async function load() {
    const id = ++seq;
    const query = new URLSearchParams();
    if (q.trim()) query.set("q", q.trim());
    if (study) query.set("studyId", study);
    try {
      const result = await api.get<{ slides: SlideSummary[]; limits?: UploadLimits }>(`/slides${query.size ? `?${query}` : ""}`);
      if (id !== seq) return;
      slides = result.slides;
      if (result.limits) limits = result.limits;
      error = null;
    } catch (e) {
      if (id === seq) error = (e as Error).message;
    }
  }

  // Reload (debounced for typing) whenever the filters change, and mirror them in the URL.
  $effect(() => {
    const key = `${q.trim()}|${study}`;
    const timer = setTimeout(() => {
      void load();
      const url = new URL(page.url.href);
      for (const [name, value] of [["q", q.trim()], ["study", study]] as const) {
        if (value) url.searchParams.set(name, value);
        else url.searchParams.delete(name);
      }
      if (url.search !== page.url.search) untrack(() => void goto(url, { shallow: true, replace: true }));
    }, key && untrack(() => slides) ? 220 : 0);
    return () => clearTimeout(timer);
  });

  // Keep cards of decks that are rendering fresh.
  $effect(() => {
    if (!slides?.some(s => isBusy(s.latest_status))) return;
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  });

  // Links such as `/slides?upload=1` or `/slides?study=<id>` can arrive while this page is open.
  $effect(() => {
    const url = page.url;
    untrack(() => {
      const fromUrl = url.searchParams.get("study");
      if (fromUrl !== null && fromUrl !== study) study = fromUrl;
      if (url.searchParams.get("upload") === "1") {
        uploadOpen = true;
        const next = new URL(url.href);
        next.searchParams.delete("upload");
        void goto(next, { shallow: true, replace: true });
      }
    });
  });

  const filtering = $derived(Boolean(q.trim() || study));
  const studyOptions = $derived([{ value: "", label: t("slides.filter.allStudies") }, ...studies.map(s => ({ value: s.id, label: s.title }))]);
</script>

<svelte:head><title>{t("nav.slides")} · Speech-AI Hub</title></svelte:head>

<PageHeader title={t("slides.title")} subtitle={slides ? t("slides.count", { n: slides.length }) : t("slides.subtitle")}>
  {#snippet actions()}
    <Button variant="primary" onclick={() => (uploadOpen = true)}><Upload />{t("action.upload")}</Button>
  {/snippet}
</PageHeader>

<div class="mb-5 flex flex-col gap-3 sm:mb-6">
  <div class="flex items-center gap-2">
    <label class="relative min-w-0 flex-1 sm:max-w-md">
      <span class="sr-only">{t("slides.search")}</span>
      <Search class="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-ink-3" />
      <input
        bind:value={q}
        type="search"
        placeholder={t("slides.search")}
        class="h-11 w-full rounded-full border border-line-2 bg-surface pr-10 pl-10 text-[15px] text-ink outline-none transition-[border-color,box-shadow] placeholder:text-ink-3 focus:border-ink focus:shadow-[0_0_0_3px_var(--surface-3)] sm:h-10 sm:text-sm [&::-webkit-search-cancel-button]:hidden"
      />
      {#if q}
        <button type="button" class="absolute top-1/2 right-1.5 grid size-8 -translate-y-1/2 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label={t("slides.filter.clear")} onclick={() => (q = "")}><X class="size-4" /></button>
      {/if}
    </label>
    <Select bind:value={study} label={t("slides.filter.study")} options={studyOptions} class="max-w-[46vw] sm:max-w-64" />
  </div>
</div>

{#if error}
  <Card><EmptyState title={t("common.error")} hint={error} /></Card>
{:else if !slides}
  <div class="grid gap-4 sm:grid-cols-2 sm:gap-5 lg:grid-cols-3">
    {#each [0, 1, 2] as i (i)}
      <div class="overflow-hidden rounded-[22px] border border-line/70 bg-surface">
        <Skeleton class="aspect-[16/10] rounded-none" />
        <div class="flex flex-col gap-2.5 p-4"><Skeleton class="h-5 w-3/4" /><Skeleton class="h-4 w-1/2" /></div>
      </div>
    {/each}
  </div>
{:else if !slides.length}
  <Card>
    <EmptyState title={filtering ? t("slides.empty.filtered") : t("slides.empty")} hint={filtering ? t("slides.empty.filteredHint") : t("slides.empty.hint")} class="py-14">
      {#snippet icon()}<Presentation />{/snippet}
      {#snippet action()}
        {#if filtering}
          <Button variant="secondary" onclick={() => ((q = ""), (study = ""))}>{t("slides.filter.clear")}</Button>
        {:else}
          <Button variant="primary" onclick={() => (uploadOpen = true)}><Upload />{t("action.upload")}</Button>
        {/if}
      {/snippet}
    </EmptyState>
  </Card>
{:else}
  <div class="grid gap-4 sm:grid-cols-2 sm:gap-5 lg:grid-cols-3">
    {#each slides as deck (deck.id)}<DeckCard {deck} canDelete={!!deck.can_edit} onDelete={() => ((deleting = deck), (deleteOpen = true))} />{/each}
  </div>
{/if}

<UploadSheet bind:open={uploadOpen} {limits} studyId={study || undefined} onUploaded={() => void load()} onRendered={() => void load()} />
<DeleteDeckDialog bind:open={deleteOpen} deck={deleting} onDeleted={id => void ((slides = slides?.filter(d => d.id !== id) ?? null), load())} />
