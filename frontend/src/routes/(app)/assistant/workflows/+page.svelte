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
  import ConfirmDialog from "#lib/components/ui/ConfirmDialog.svelte";
  import DeleteButton from "#lib/components/ui/DeleteButton.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import { STATUS_TONE } from "#lib/components/workflows/meta.ts";
  import { workflowsApi } from "#lib/workflows/api.ts";
  import type { Workflow } from "#lib/workflows/types.ts";
  import { prefersReducedMotion } from "svelte/motion";
  import { revealAndPulse, runFromUrl, waitForFocus } from "#lib/agent/focus.ts";

  let filter = $state<"active" | "all">("all");
  let list = $state<Workflow[] | null>(null);
  let error = $state<string | null>(null);
  // `?run=<id>` (or the older `?id=`): a deep link from the Agent overview / notifications opens that run's card,
  // scrolled to and pulsed (lib/agent/focus.ts). Runs not in the list are fetched into it.
  let expanded = $state<string | null>(runFromUrl(page.url));
  let listEl = $state<HTMLElement | null>(null);
  let focusing = 0;
  let pulsed: string | null = null;
  $effect(() => {
    const id = runFromUrl(page.url);
    if (!id || !list || !listEl || pulsed === id) return;
    expanded = id;
    const mine = ++focusing;
    void waitForFocus<HTMLElement>(listEl, { type: "workflow", id }, {
      cancelled: () => mine !== focusing,
      found: (el) => {
        pulsed = id;
        setTimeout(() => revealAndPulse(el, null, prefersReducedMotion.current), 120);
      },
    });
  });

  // Row 刪除 (the server refuses runs that still work: planning / running / verifying / paused → stop first).
  const UNDELETABLE = ["planning", "running", "verifying", "paused"];
  let deleting = $state<Workflow | null>(null);
  let deleteOpen = $state(false);
  async function removeRun() {
    const w = deleting;
    if (!w) return;
    await workflowsApi.remove(w.id);
    list = list?.filter((x) => x.id !== w.id) ?? null;
    if (expanded === w.id) expanded = null;
    toasts.show(t("crud.workflow.deleted"), "success");
  }

  async function load() {
    error = null;
    try {
      const rows = (await workflowsApi.list({ active: filter === "active", limit: 60 })).workflows;
      const want = runFromUrl(page.url);
      if (want && !rows.some((w) => w.id === want)) {
        const one = await workflowsApi.get(want).then((d) => d.workflow, () => null);
        if (one) rows.unshift(one);
      }
      list = rows;
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

<div class="mx-auto w-full max-w-[1200px] px-4 py-6 sm:px-6">
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
    <ul class="flex flex-col gap-2" bind:this={listEl}>
      {#each list as w (w.id)}
        <li class="group relative rounded-[20px] border border-line bg-surface">
          <div class="absolute top-2 right-11 z-[1] sm:right-12"><DeleteButton reveal label={t("crud.workflow.delete")} reason={UNDELETABLE.includes(w.status) ? t("crud.deny.workflowActive") : null} onclick={() => ((deleting = w), (deleteOpen = true))} /></div>
          <button type="button" class="flex min-h-14 w-full items-center gap-3 rounded-[20px] py-2 pr-3 pl-3 text-left hover:bg-surface-2 sm:pl-4" aria-expanded={expanded === w.id} onclick={() => (expanded = expanded === w.id ? null : w.id)}>
            <span class="grid size-9 shrink-0 place-items-center rounded-full bg-surface-3 text-ink-2 max-sm:hidden"><WorkflowIcon class="size-4" /></span>
            <!-- Phones: the title gets two lines and the status moves under it (a row of pills left ~6 characters of title). -->
            <span class="min-w-0 flex-1">
              <span class="block text-[14px] font-medium text-ink max-sm:line-clamp-2 sm:truncate" title={w.title}>{w.title}</span>
              <span class="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] text-ink-3">
                <span class="shrink-0 sm:hidden"><Pill size="sm" tone={STATUS_TONE[w.status]}>{t(`wf.status.${w.status}` as MessageKey)}</Pill></span>
                <span class="min-w-0 truncate">{i18n.locale === "en" ? w.playbook_title_en : w.playbook_title}{#if w.study} · {w.study.title}{/if} · {relativeTime(w.updated_at)}</span>
              </span>
            </span>
            <span class="shrink-0 max-sm:hidden"><Pill size="sm" tone={STATUS_TONE[w.status]}>{t(`wf.status.${w.status}` as MessageKey)}</Pill></span>
            <span class="w-10 shrink-0" aria-hidden="true"></span>
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

<ConfirmDialog bind:open={deleteOpen} title={t("crud.workflow.deleteNamed", { title: deleting?.title ?? "" })} description={t("crud.workflow.deleteDescription")} confirmLabel={t("crud.workflow.delete")} onConfirm={removeRun} />
