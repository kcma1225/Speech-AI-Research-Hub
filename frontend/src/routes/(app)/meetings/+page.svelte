<script lang="ts">
  import { untrack } from "svelte";
  import { CalendarClock, Plus, Search, UsersRound, X } from "@lucide/svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { api } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Card from "#lib/components/ui/Card.svelte";
  import EmptyState from "#lib/components/ui/EmptyState.svelte";
  import PageHeader from "#lib/components/ui/PageHeader.svelte";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import Select from "#lib/components/ui/Select.svelte";
  import Skeleton from "#lib/components/ui/Skeleton.svelte";
  import MeetingCardView from "#lib/components/meetings/MeetingCard.svelte";
  import type { MeetingCard } from "#lib/meetings/types.ts";
  import type { DirectoryUser, StudyCard } from "#lib/studies/types.ts";

  type When = "upcoming" | "past" | "all";
  const params = page.url.searchParams;
  const initialWhen = params.get("when");
  let when = $state<When>(initialWhen === "upcoming" || initialWhen === "past" ? initialWhen : "all");
  let study = $state(params.get("study") ?? "");
  let person = $state(params.get("person") ?? "");
  let q = $state(params.get("q") ?? "");
  let meetings = $state<MeetingCard[] | null>(null);
  let error = $state<string | null>(null);
  let directory = $state<DirectoryUser[]>([]);
  let studies = $state<StudyCard[]>([]);

  $effect(() => {
    api.get<{ users: DirectoryUser[] }>("/users/directory").then(r => (directory = r.users), () => {});
    api.get<{ studies: StudyCard[] }>("/studies?status=all").then(r => (studies = r.studies), () => {});
  });

  let seq = 0;
  async function load() {
    const id = ++seq;
    const query = new URLSearchParams({ when });
    if (study) query.set("study", study);
    if (person) query.set("person", person);
    if (q.trim()) query.set("q", q.trim());
    try {
      const r = await api.get<{ meetings: MeetingCard[] }>(`/meetings?${query}`);
      if (id !== seq) return;
      meetings = r.meetings;
      error = null;
    } catch (e) {
      if (id === seq) error = (e as Error).message;
    }
  }

  $effect(() => {
    const key = `${when}|${study}|${person}|${q.trim()}`;
    const timer = setTimeout(() => {
      void load();
      const url = new URL(page.url.href);
      for (const [name, value] of [["when", when === "all" ? "" : when], ["study", study], ["person", person], ["q", q.trim()]] as const) {
        if (value) url.searchParams.set(name, value);
        else url.searchParams.delete(name);
      }
      if (url.search !== page.url.search) untrack(() => void goto(url, { shallow: true, replace: true }));
    }, key && untrack(() => meetings) ? 200 : 0);
    return () => clearTimeout(timer);
  });

  const filtering = $derived(Boolean(study || person || q.trim()));
  const studyOptions = $derived([
    { value: "", label: t("meet.filter.anyStudy") },
    ...studies.map(s => ({ value: s.id, label: s.title, hint: s.members.find(m => m.role === "owner")?.name })),
  ]);
  const personOptions = $derived([
    { value: "", label: t("meet.filter.anyone") },
    { value: "me", label: t("meet.filter.me") },
    ...directory.map(u => ({ value: u.id, label: u.name })),
  ]);
  const whenOptions = $derived([
    { value: "all" as When, label: t("meet.filter.all") },
    { value: "upcoming" as When, label: t("meet.filter.upcoming") },
    { value: "past" as When, label: t("meet.filter.past") },
  ]);
  /** Upcoming first (soonest), then past (newest) when showing everything. */
  const groups = $derived.by(() => {
    if (!meetings) return [];
    if (when !== "all") return [{ key: when, label: when === "upcoming" ? t("meet.filter.upcoming") : t("meet.filter.past"), items: meetings }];
    const cutoff = Date.now() - 3600_000;
    const upcoming = meetings.filter(m => new Date(m.held_at).getTime() >= cutoff).reverse();
    const past = meetings.filter(m => new Date(m.held_at).getTime() < cutoff);
    return [
      { key: "upcoming", label: t("meet.filter.upcoming"), items: upcoming },
      { key: "past", label: t("meet.filter.past"), items: past },
    ].filter(g => g.items.length);
  });
  function clear() {
    study = person = q = "";
  }
</script>

<svelte:head><title>{t("pages.meetings.title")} · Speech-AI Hub</title></svelte:head>

<PageHeader title={t("pages.meetings.title")} subtitle={meetings ? t("meet.list.count", { n: meetings.length }) : t("meet.list.subtitle")}>
  {#snippet actions()}<Button variant="primary" href="/meetings/new"><Plus />{t("meet.new")}</Button>{/snippet}
</PageHeader>

<div class="mb-5 flex flex-col gap-2.5 sm:mb-6 xl:flex-row xl:items-center">
  <Segmented bind:value={when} options={whenOptions} label={t("meet.filter.when")} class="w-full sm:w-auto" />
  <label class="relative min-w-0 flex-1 xl:max-w-sm">
    <span class="sr-only">{t("meet.filter.search")}</span>
    <Search class="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-ink-3" />
    <input
      bind:value={q}
      type="search"
      placeholder={t("meet.filter.search")}
      class="h-11 w-full rounded-full border border-line-2 bg-surface pr-10 pl-10 text-[15px] text-ink outline-none transition-[border-color,box-shadow] placeholder:text-ink-3 focus:border-ink focus:shadow-[0_0_0_3px_var(--surface-3)] sm:h-10 sm:text-sm [&::-webkit-search-cancel-button]:hidden"
    />
    {#if q}
      <button type="button" class="absolute top-1/2 right-1.5 grid size-8 -translate-y-1/2 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label={t("meet.filter.clear")} onclick={() => (q = "")}><X class="size-4" /></button>
    {/if}
  </label>
  <div class="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
    <Select bind:value={study} label={t("meet.filter.study")} options={studyOptions} class="w-full min-w-0 sm:w-52" />
    <Select bind:value={person} label={t("meet.filter.person")} options={personOptions} class="w-full min-w-0 sm:w-40" />
    {#if filtering}<Button variant="ghost" onclick={clear} class="col-span-2 w-full sm:w-auto"><X />{t("meet.filter.clear")}</Button>{/if}
  </div>
</div>

{#if error}
  <Card><EmptyState title={t("common.error")} hint={error} /></Card>
{:else if !meetings}
  <div class="flex flex-col gap-3">{#each [0, 1, 2] as i (i)}<Skeleton class="h-[128px] rounded-[20px]" />{/each}</div>
{:else if !meetings.length}
  <Card>
    <EmptyState title={filtering ? t("meet.list.emptyFiltered") : t("meet.list.empty")} hint={filtering ? t("meet.list.emptyFilteredHint") : t("meet.list.emptyHint")} class="py-14">
      {#snippet icon()}<UsersRound />{/snippet}
      {#snippet action()}
        {#if filtering}<Button onclick={clear}>{t("meet.filter.clear")}</Button>{:else}<Button variant="primary" href="/meetings/new"><Plus />{t("meet.new")}</Button>{/if}
      {/snippet}
    </EmptyState>
  </Card>
{:else}
  <div class="flex flex-col gap-7">
    {#each groups as group (group.key)}
      <section aria-label={group.label}>
        <h2 class="mb-3 flex items-center gap-2 text-[13px] font-semibold tracking-wide text-ink-3">
          {#if group.key === "upcoming"}<CalendarClock class="size-4" />{/if}{group.label}
          <span class="font-normal tabular-nums">{group.items.length}</span>
        </h2>
        <div class="grid grid-cols-[minmax(0,1fr)] gap-3 lg:grid-cols-2">
          {#each group.items as meeting (meeting.id)}<MeetingCardView {meeting} onDeleted={id => (meetings = meetings?.filter(m => m.id !== id) ?? null)} />{/each}
        </div>
      </section>
    {/each}
  </div>
{/if}
