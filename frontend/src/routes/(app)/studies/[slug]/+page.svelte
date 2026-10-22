<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { ArrowLeft, Eye, FlaskConical } from "@lucide/svelte";
  import { api, ApiError } from "#lib/api.ts";
  import { i18n, relativeTime, t } from "#lib/i18n.svelte.ts";
  import { displayName } from "#lib/people.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Card from "#lib/components/ui/Card.svelte";
  import EmptyState from "#lib/components/ui/EmptyState.svelte";
  import Pill from "#lib/components/ui/Pill.svelte";
  import Skeleton from "#lib/components/ui/Skeleton.svelte";
  import AvatarStack from "#lib/components/study/AvatarStack.svelte";
  import StageBar from "#lib/components/study/StageBar.svelte";
  import StudyTitle from "#lib/components/study/StudyTitle.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import { studyTabs, tabByKey } from "#lib/components/study/tabs/registry.ts";
  import type { StudyDetail } from "#lib/studies/types.ts";
  import { memberRoleTone, statusTone } from "#lib/studies/ui.ts";

  const slug = $derived(page.params.slug ?? "");
  let detail = $state<StudyDetail | null>(null);
  let error = $state<{ status: number; message: string } | null>(null);

  async function load() {
    try {
      const next = await api.get<StudyDetail>(`/studies/${encodeURIComponent(slug)}`);
      detail = next;
      error = null;
      // A renamed slug (or an id link) lands on the canonical address.
      if (next.study.slug !== slug) void goto(`/studies/${next.study.slug}${page.url.search}`, { replace: true, reset: false });
    } catch (e) {
      error = { status: e instanceof ApiError ? e.status : 0, message: (e as Error).message };
    }
  }
  /** Optimistic rename (the slug stays, so the address does not change). */
  async function rename(title: string) {
    if (!detail) return;
    const before = detail.study.title;
    detail.study.title = title;
    try {
      detail = await api.patch<StudyDetail>(`/studies/${detail.study.id}`, { title });
      toasts.show(t("studies.rename.saved"), "success");
    } catch (e) {
      if (detail.study.title === title) detail.study.title = before;
      toasts.show((e as Error).message, "error");
    }
  }
  $effect(() => {
    void slug;
    detail = null;
    void load();
  });

  const tab = $derived(tabByKey(page.url.searchParams.get("tab")));
  // Phones scroll the tab bar sideways: keep the active tab (e.g. a deep link to 成員) in view.
  let tabBar = $state<HTMLElement | null>(null);
  $effect(() => {
    void tab.key;
    const active = tabBar?.querySelector<HTMLElement>('[aria-current="page"]');
    if (active && tabBar && tabBar.scrollWidth > tabBar.clientWidth) {
      const left = tabBar.scrollLeft + active.getBoundingClientRect().left - tabBar.getBoundingClientRect().left - (tabBar.clientWidth - active.offsetWidth) / 2;
      tabBar.scrollTo({ left: Math.max(0, left), behavior: "instant" });
    }
  });
  const tabHref = (key: string) => (key === "overview" ? `/studies/${slug}` : `/studies/${slug}?tab=${key}`);
  const current = $derived(detail?.stages.find(s => s.is_current) ?? null);
  const done = $derived(detail?.stages.filter(s => s.completed_at).length ?? 0);
  const team = $derived(detail?.members.filter(m => m.role !== "advisor") ?? []);
  const advisors = $derived(detail?.members.filter(m => m.role === "advisor") ?? []);
</script>

<svelte:head><title>{detail?.study.title ?? t("studies.title")} · Speech-AI Hub</title></svelte:head>

<a href="/studies" class="-ml-2 mb-2 inline-flex h-10 items-center gap-1.5 rounded-full px-2 text-[13px] font-medium text-ink-3 hover:text-ink"><ArrowLeft class="size-4" />{t("studies.back")}</a>

{#if error}
  <Card>
    <EmptyState title={error.status === 404 ? t("studies.notFound") : t("common.error")} hint={error.status === 404 ? t("studies.notFoundHint") : error.message} class="py-14">
      {#snippet icon()}<FlaskConical />{/snippet}
      {#snippet action()}<Button variant="secondary" href="/studies">{t("studies.back")}</Button>{/snippet}
    </EmptyState>
  </Card>
{:else if !detail}
  <Skeleton class="mb-4 h-12 w-2/3" />
  <Skeleton class="mb-6 h-5 w-1/3" />
  <Skeleton class="h-[320px] rounded-[var(--radius-card)]" />
{:else}
  {@const d = detail}
  <header class="mb-5 flex flex-col gap-4 sm:mb-6">
    <div class="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
      <div class="min-w-0">
        <StudyTitle title={d.study.title} canEdit={d.permissions.manage} onRename={rename} />
        <div class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] text-ink-3">
          <Pill tone={statusTone[d.study.status]} size="sm" dot>{t(`studies.status.${d.study.status}` as MessageKey)}</Pill>
          {#if d.permissions.role}<Pill tone={memberRoleTone[d.permissions.role]} size="sm">{t(`studies.role.${d.permissions.role}` as MessageKey)}</Pill>{/if}
          <span>{t("studies.updated", { when: relativeTime(d.study.activity_at) })}</span>
        </div>
      </div>
      <div class="flex shrink-0 items-center gap-3">
        <AvatarStack people={team} max={5} size={32} />
        {#if advisors.length}<span class="text-[12.5px] text-ink-3">{advisors.map(a => displayName(a, "formal")).join(i18n.locale === "en" ? ", " : "、")}</span>{/if}
      </div>
    </div>
    <div class="flex max-w-xl flex-col gap-1.5">
      <div class="flex items-baseline justify-between gap-2 text-[12.5px]">
        <span class="font-medium text-ink-2">{current?.name ?? t("studies.noStage")}</span>
        {#if current}<span class="text-ink-3 tabular-nums">{t("studies.stageOf", { n: current.position + 1, total: d.stages.length })}</span>{/if}
      </div>
      <StageBar count={d.stages.length} {done} current={current?.position ?? null} />
    </div>
    {#if !d.permissions.edit}
      <p class="flex items-center gap-2 text-[12.5px] text-ink-3"><Eye class="size-3.5" />{t("studies.readOnly")}</p>
    {/if}
  </header>

  <nav bind:this={tabBar} class="-mx-4 mb-5 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0" aria-label={t("studies.tabs")}>
    <ul class="flex w-max gap-1 rounded-full border border-line bg-surface-2 p-1">
      {#each studyTabs as item (item.key)}
        {@const active = item.key === tab.key}
        {@const count = item.count?.(d) ?? null}
        <li>
          <a
            href={tabHref(item.key)}
            aria-current={active ? "page" : undefined}
            data-sveltekit-reset="false"
            class="inline-flex h-10 items-center gap-2 rounded-full px-3.5 text-[13.5px] font-medium whitespace-nowrap transition-[background-color,color,box-shadow] {active
              ? 'bg-surface text-ink shadow-card dark:bg-surface-3'
              : 'text-ink-3 hover:text-ink'}"
          >
            <item.icon class="size-4" />{t(item.label)}
            {#if count !== null}<span class="rounded-full bg-surface-3 px-1.5 text-[11px] text-ink-2 tabular-nums">{count}</span>{/if}
          </a>
        </li>
      {/each}
    </ul>
  </nav>

  {#key tab.key}
    {#await tab.load()}
      <Skeleton class="h-[280px] rounded-[var(--radius-card)]" />
    {:then module}
      <module.default detail={d} reload={load} {tab} />
    {/await}
  {/key}
{/if}
