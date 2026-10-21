<script lang="ts">
  import { page } from "$app/state";
  import { ChevronRight, MessageSquare, Workflow as WorkflowIcon } from "@lucide/svelte";
  import { i18n, t, relativeTime } from "#lib/i18n.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import PageHeader from "#lib/components/ui/PageHeader.svelte";
  import Pill from "#lib/components/ui/Pill.svelte";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import EmptyState from "#lib/components/ui/EmptyState.svelte";
  import Skeleton from "#lib/components/ui/Skeleton.svelte";
  import WorkflowCard from "#lib/components/workflows/WorkflowCard.svelte";
  import { STATUS_TONE } from "#lib/components/workflows/meta.ts";
  import { workflowsApi } from "#lib/workflows/api.ts";
  import type { Workflow } from "#lib/workflows/types.ts";

  let filter = $state<"active" | "all">("all");
  let list = $state<Workflow[] | null>(null);
  let error = $state<string | null>(null);
  let expanded = $state<string | null>(page.url.searchParams.get("id"));

  async function load() {
    error = null;
    try {
      list = (await workflowsApi.list({ active: filter === "active", limit: 60 })).workflows;
    } catch (e) {
      error = (e as Error).message;
      list = [];
    }
  }
  $effect(() => {
    void filter;
    void load();
  });
</script>

<svelte:head><title>{t("wf.pageTitle")} · Speech-AI Hub</title></svelte:head>

<div class="mx-auto w-full max-w-[880px] px-4 py-6 sm:px-6">
  <PageHeader title={t("wf.pageTitle")} subtitle={t("wf.pageDesc")} />
  <div class="mb-3 flex items-center justify-between gap-2">
    <Segmented label={t("wf.title")} guardIgnore bind:value={filter} options={[{ value: "all", label: t("wf.filter.all") }, { value: "active", label: t("wf.filter.active") }]} />
    <a href="/assistant" class="inline-flex min-h-10 items-center gap-1.5 rounded-full px-3 text-[13px] text-ink-2 hover:bg-surface-3 hover:text-ink"><MessageSquare class="size-4" />{t("wf.openChat")}</a>
  </div>
  {#if list === null}
    <div class="flex flex-col gap-2"><Skeleton class="h-16" /><Skeleton class="h-16" /></div>
  {:else if error}
    <p class="text-[13px] text-danger">{t("wf.loadFailed")}：{error}</p>
  {:else if !list.length}
    <EmptyState title={t("wf.empty")} hint={t("wf.emptyHint")} />
  {:else}
    <ul class="flex flex-col gap-2">
      {#each list as w (w.id)}
        <li class="rounded-[20px] border border-line bg-surface">
          <button type="button" class="flex min-h-14 w-full items-center gap-3 rounded-[20px] px-3 py-2 text-left hover:bg-surface-2 sm:px-4" aria-expanded={expanded === w.id} onclick={() => (expanded = expanded === w.id ? null : w.id)}>
            <span class="grid size-9 shrink-0 place-items-center rounded-full bg-surface-3 text-ink-2"><WorkflowIcon class="size-4" /></span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-[14px] font-medium text-ink">{w.title}</span>
              <span class="block truncate text-[12px] text-ink-3">{i18n.locale === "en" ? w.playbook_title_en : w.playbook_title}{#if w.study} · {w.study.title}{/if} · {relativeTime(w.updated_at)}</span>
            </span>
            <Pill size="sm" tone={STATUS_TONE[w.status]}>{t(`wf.status.${w.status}` as MessageKey)}</Pill>
            <ChevronRight class="size-4 shrink-0 text-ink-3 transition-transform duration-150 {expanded === w.id ? 'rotate-90' : ''}" />
          </button>
          {#if expanded === w.id}
            <div class="px-2 pb-2 sm:px-3 sm:pb-3">
              {#if w.conversation_id}<a href="/assistant/{w.conversation_id}?workflow={w.id}" class="ml-1 inline-flex min-h-10 items-center gap-1 text-[12.5px] text-ink-2 hover:text-ink"><MessageSquare class="size-3.5" />{t("wf.openChat")}</a>{/if}
              <WorkflowCard id={w.id} onRemoved={() => ((list = list!.filter((x) => x.id !== w.id)), (expanded = null))} />
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>
