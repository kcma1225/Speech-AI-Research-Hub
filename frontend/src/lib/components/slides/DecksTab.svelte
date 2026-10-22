<script lang="ts">
  import { untrack } from "svelte";
  import { replaceState } from "$app/navigation";
  import { page } from "$app/state";
  import { Plus, Presentation } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Card from "#lib/components/ui/Card.svelte";
  import EmptyState from "#lib/components/ui/EmptyState.svelte";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import Skeleton from "#lib/components/ui/Skeleton.svelte";
  import type { StudyTabProps } from "#lib/components/study/tabs/registry.ts";
  import type { DeckKind, SlideSummary, UploadLimits } from "#lib/slides/types.ts";
  import { DEFAULT_LIMITS, isBusy } from "#lib/slides/util.ts";
  import CreateDeckSheet from "./CreateDeckSheet.svelte";
  import DeckCard from "./DeckCard.svelte";
  import UploadSheet from "./UploadSheet.svelte";
  import DeleteDeckDialog from "./DeleteDeckDialog.svelte";

  /** Study tab 簡報: the study's progress reports and paper reports (`?tab=decks&kind=progress|paper_report`). */
  let { detail }: StudyTabProps = $props();
  const canEdit = $derived(detail.permissions.edit);
  const studyId = $derived(detail.study.id);

  type Filter = "all" | DeckKind;
  const fromUrl = (): Filter => {
    const value = page.url.searchParams.get("kind");
    return value === "progress" || value === "paper_report" ? value : "all";
  };
  let filter = $state<Filter>(fromUrl());
  let decks = $state<SlideSummary[] | null>(null);
  let limits = $state<UploadLimits>(DEFAULT_LIMITS);
  let error = $state<string | null>(null);
  let createOpen = $state(false);
  let uploadOpen = $state(false);
  let uploadKind = $state<DeckKind>("progress");
  let deleting = $state<SlideSummary | null>(null);
  let deleteOpen = $state(false);

  async function load() {
    try {
      const result = await api.get<{ slides: SlideSummary[]; limits?: UploadLimits }>(`/slides?studyId=${studyId}`);
      decks = result.slides;
      if (result.limits) limits = result.limits;
      error = null;
    } catch (e) {
      error = (e as Error).message;
    }
  }
  $effect(() => {
    void studyId;
    untrack(() => void load());
  });
  // Keep rendering decks fresh.
  $effect(() => {
    if (!decks?.some(d => isBusy(d.latest_status))) return;
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  });
  // Mirror the filter in the URL (shareable, survives reload).
  $effect(() => {
    const value = filter;
    untrack(() => {
      const url = new URL(page.url.href);
      if (value === "all") url.searchParams.delete("kind");
      else url.searchParams.set("kind", value);
      if (url.search !== page.url.search) replaceState(url, page.state);
    });
  });
  // `?tab=decks&new=1` opens the create sheet once.
  $effect(() => {
    if (page.url.searchParams.get("new") === "1" && untrack(() => canEdit)) untrack(() => (createOpen = true));
  });

  const counts = $derived({
    all: decks?.length ?? 0,
    progress: decks?.filter(d => d.kind === "progress").length ?? 0,
    paper_report: decks?.filter(d => d.kind === "paper_report").length ?? 0,
  });
  const sections = $derived.by(() => {
    const list = decks ?? [];
    const kinds: DeckKind[] = filter === "all" ? ["progress", "paper_report"] : [filter];
    return kinds.map(kind => ({ kind, decks: list.filter(d => d.kind === kind) })).filter(s => filter !== "all" || s.decks.length);
  });
  const filterOptions = $derived([
    { value: "all" as const, label: `${t("slides.filter.all")} ${counts.all}` },
    { value: "progress" as const, label: `${t("slides.kind.progress")} ${counts.progress}` },
    { value: "paper_report" as const, label: `${t("slides.kind.paper_report")} ${counts.paper_report}` },
  ]);
</script>

<div class="mb-5 flex flex-wrap items-center justify-between gap-3">
  <Segmented bind:value={filter} label={t("slides.filter.kind")} options={filterOptions} class="max-w-full overflow-x-auto" />
  {#if canEdit}
    <Button variant="primary" onclick={() => (createOpen = true)}><Plus />{t("slides.create.open")}</Button>
  {/if}
</div>

{#if error}
  <Card><EmptyState title={t("common.error")} hint={error} /></Card>
{:else if !decks}
  <div class="grid gap-4 sm:grid-cols-2 sm:gap-5 xl:grid-cols-3 2xl:grid-cols-4">
    {#each [0, 1, 2] as i (i)}
      <div class="overflow-hidden rounded-[22px] border border-line/70 bg-surface">
        <Skeleton class="aspect-[16/10] rounded-none" />
        <div class="flex flex-col gap-2.5 p-4"><Skeleton class="h-5 w-3/4" /><Skeleton class="h-4 w-1/2" /></div>
      </div>
    {/each}
  </div>
{:else if !sections.some(s => s.decks.length)}
  <Card>
    <EmptyState
      title={filter === "all" ? t("slides.study.empty") : t("slides.study.emptyKind", { kind: t(`slides.kind.${filter}`) })}
      hint={canEdit ? t("slides.study.emptyHint") : t("slides.study.emptyHintViewer")}
      class="py-14"
    >
      {#snippet icon()}<Presentation />{/snippet}
      {#snippet action()}
        {#if canEdit}<Button variant="primary" onclick={() => (createOpen = true)}><Plus />{t("slides.create.open")}</Button>{/if}
      {/snippet}
    </EmptyState>
  </Card>
{:else}
  <div class="flex flex-col gap-8">
    {#each sections as section (section.kind)}
      <section aria-labelledby="decks-{section.kind}">
        {#if filter === "all"}
          <h2 id="decks-{section.kind}" class="mb-3 flex items-baseline gap-2 text-[15px] font-semibold text-ink">
            {t(`slides.kind.${section.kind}`)}<span class="text-[13px] font-normal text-ink-3 tabular-nums">{section.decks.length}</span>
          </h2>
        {/if}
        {#if section.decks.length}
          <div class="grid gap-4 sm:grid-cols-2 sm:gap-5 xl:grid-cols-3 2xl:grid-cols-4">
            {#each section.decks as deck (deck.id)}<DeckCard {deck} showStudy={false} canDelete={canEdit} onDelete={() => ((deleting = deck), (deleteOpen = true))} />{/each}
          </div>
        {:else}
          <p class="rounded-2xl border border-dashed border-line-2 px-4 py-6 text-center text-[13px] text-ink-3">{t("slides.study.emptyKind", { kind: t(`slides.kind.${section.kind}`) })}</p>
        {/if}
      </section>
    {/each}
  </div>
{/if}

{#if canEdit}
  <CreateDeckSheet
    bind:open={createOpen}
    study={detail.study}
    kind={filter === "all" ? "progress" : filter}
    onUpload={kind => ((uploadKind = kind), (uploadOpen = true))}
  />
  <DeleteDeckDialog bind:open={deleteOpen} deck={deleting} onDeleted={id => void ((decks = decks?.filter(d => d.id !== id) ?? null), load())} />
  <UploadSheet bind:open={uploadOpen} {limits} studyId={detail.study.id} kind={uploadKind} onUploaded={() => void load()} onRendered={() => void load()} />
{/if}
