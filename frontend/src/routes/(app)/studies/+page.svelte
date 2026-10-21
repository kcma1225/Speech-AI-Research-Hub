<script lang="ts">
  import { untrack } from "svelte";
  import { FlaskConical, Plus, Search, X } from "@lucide/svelte";
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
  import StudyCard from "#lib/components/study/StudyCard.svelte";
  import type { DirectoryUser, StudyCard as Card_ } from "#lib/studies/types.ts";

  const params = page.url.searchParams;
  let q = $state(params.get("q") ?? "");
  let member = $state(params.get("member") ?? "");
  let status = $state(params.get("status") ?? "");
  let stage = $state(params.get("stage") ?? "");
  let studies = $state<Card_[] | null>(null);
  let error = $state<string | null>(null);
  let directory = $state<DirectoryUser[]>([]);
  // Stage names seen in unfiltered results, so the stage filter offers what exists.
  let stageNames = $state<string[]>(["題目發想", "文獻探討", "實驗", "撰寫", "投稿/口試"]);

  $effect(() => {
    api.get<{ users: DirectoryUser[] }>("/users/directory").then(r => (directory = r.users), () => {});
  });

  let seq = 0;
  async function load() {
    const id = ++seq;
    const query = new URLSearchParams();
    if (q.trim()) query.set("q", q.trim());
    if (member) query.set("member", member);
    if (status) query.set("status", status);
    if (stage) query.set("stage", stage);
    try {
      const result = await api.get<{ studies: Card_[] }>(`/studies${query.size ? `?${query}` : ""}`);
      if (id !== seq) return;
      studies = result.studies;
      const names = result.studies.flatMap(s => (s.current_stage ? [s.current_stage.name] : []));
      untrack(() => (stageNames = [...new Set([...stageNames, ...names])]));
      error = null;
    } catch (e) {
      if (id === seq) error = (e as Error).message;
    }
  }

  // Reload (debounced while typing) when filters change, mirrored in the URL.
  $effect(() => {
    const key = `${q.trim()}|${member}|${status}|${stage}`;
    const timer = setTimeout(() => {
      void load();
      const url = new URL(page.url.href);
      for (const [name, value] of [["q", q.trim()], ["member", member], ["status", status], ["stage", stage]] as const) {
        if (value) url.searchParams.set(name, value);
        else url.searchParams.delete(name);
      }
      if (url.search !== page.url.search) untrack(() => void goto(url, { shallow: true, replace: true }));
    }, key && untrack(() => studies) ? 220 : 0);
    return () => clearTimeout(timer);
  });

  const filtering = $derived(Boolean(q.trim() || member || status || stage));
  const memberOptions = $derived([
    { value: "", label: t("studies.filter.anyone") },
    { value: "me", label: t("studies.filter.mine") },
    ...directory.map(u => ({ value: u.id, label: u.name })),
  ]);
  const statusOptions = $derived([
    { value: "", label: t("studies.filter.notArchived") },
    { value: "active", label: t("studies.status.active") },
    { value: "paused", label: t("studies.status.paused") },
    { value: "completed", label: t("studies.status.completed") },
    { value: "archived", label: t("studies.status.archived") },
    { value: "all", label: t("studies.filter.allStatus") },
  ]);
  const stageOptions = $derived([{ value: "", label: t("studies.filter.anyStage") }, ...stageNames.map(name => ({ value: name, label: name }))]);
  function clear() {
    q = member = status = stage = "";
  }
</script>

<svelte:head><title>{t("studies.title")} · Speech-AI Hub</title></svelte:head>

<PageHeader title={t("studies.title")} subtitle={studies ? t("studies.count", { n: studies.length }) : t("studies.subtitle")}>
  {#snippet actions()}<Button variant="primary" href="/studies/new"><Plus />{t("studies.new")}</Button>{/snippet}
</PageHeader>

<div class="mb-5 flex flex-col gap-2.5 sm:mb-6 lg:flex-row lg:items-center">
  <label class="relative min-w-0 flex-1 lg:max-w-md">
    <span class="sr-only">{t("studies.search")}</span>
    <Search class="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-ink-3" />
    <input
      bind:value={q}
      type="search"
      placeholder={t("studies.search")}
      class="h-11 w-full rounded-full border border-line-2 bg-surface pr-10 pl-10 text-[15px] text-ink outline-none transition-[border-color,box-shadow] placeholder:text-ink-3 focus:border-ink focus:shadow-[0_0_0_3px_var(--surface-3)] sm:h-10 sm:text-sm [&::-webkit-search-cancel-button]:hidden"
    />
    {#if q}
      <button type="button" class="absolute top-1/2 right-1.5 grid size-8 -translate-y-1/2 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label={t("studies.filter.clear")} onclick={() => (q = "")}><X class="size-4" /></button>
    {/if}
  </label>
  <div class="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
    <Select bind:value={member} label={t("studies.filter.member")} options={memberOptions} class="w-full min-w-0 sm:w-44" />
    <Select bind:value={stage} label={t("studies.filter.stage")} options={stageOptions} class="w-full min-w-0 sm:w-40" />
    <Select bind:value={status} label={t("studies.filter.status")} options={statusOptions} class="w-full min-w-0 sm:w-40" />
    {#if filtering}<Button variant="ghost" onclick={clear} class="w-full sm:w-auto"><X />{t("studies.filter.clear")}</Button>{/if}
  </div>
</div>

{#if error}
  <Card><EmptyState title={t("common.error")} hint={error} /></Card>
{:else if !studies}
  <div class="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2 sm:gap-5 xl:grid-cols-3">
    {#each [0, 1, 2] as i (i)}<Skeleton class="h-[230px] rounded-[22px]" />{/each}
  </div>
{:else if !studies.length}
  <Card>
    <EmptyState title={filtering ? t("studies.emptyFiltered") : t("studies.empty")} hint={filtering ? t("studies.emptyFilteredHint") : t("studies.emptyHint")} class="py-14">
      {#snippet icon()}<FlaskConical />{/snippet}
      {#snippet action()}
        {#if filtering}<Button variant="secondary" onclick={clear}>{t("studies.filter.clear")}</Button>{:else}<Button variant="primary" href="/studies/new"><Plus />{t("studies.new")}</Button>{/if}
      {/snippet}
    </EmptyState>
  </Card>
{:else}
  <div class="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2 sm:gap-5 xl:grid-cols-3">
    {#each studies as study (study.id)}<StudyCard {study} />{/each}
  </div>
{/if}
