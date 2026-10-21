<script lang="ts">
  import { ChevronRight, ExternalLink, X, Ban, Undo2 } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import { t, relativeTime } from "#lib/i18n.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import { argsSummary, linkLabel, toolIcon, toolTitle } from "#lib/agent/tools.ts";
  import type { ToolCall } from "#lib/agent/types.ts";
  import DraftJobChip from "./DraftJobChip.svelte";
  import WorkflowCard from "#lib/components/workflows/WorkflowCard.svelte";
  import WorkflowBatchCard from "#lib/components/workflows/WorkflowBatchCard.svelte";

  /** One tool call in the timeline: icon, verb + object, status, duration; expands to arguments and result. */
  let { call, nested = false, bare = false }: { call: ToolCall; nested?: boolean; /** Job chip, workflow card and 復原 live in the turn's result chips. */ bare?: boolean } = $props();
  let open = $state(false);
  const Icon = $derived(toolIcon(call.tool));
  // Delete/remove summaries only know ids ("刪除待辦"); name the object from the resolved target.
  const targetName = $derived(call.target?.label?.split(" · ").pop() ?? "");
  const baseSummary = $derived(call.summary || toolTitle(call));
  const summary = $derived(call.risk === "destructive" && targetName && !baseSummary.includes(targetName) ? `${baseSummary}〈${targetName}〉` : baseSummary);
  const detail = $derived(argsSummary(call));
  // Execution time only: user-approved calls start counting at the decision, not while the card waited.
  const duration = $derived(call.finished_at ? Math.max(0, new Date(call.finished_at).getTime() - new Date(call.decided_at ?? call.created_at).getTime()) : null);
  const links = $derived(call.result?.links ?? []);
  // create_deck starts a background AI draft: show its live status under the row.
  const draftJob = $derived.by(() => {
    const data = call.result?.data as { job_id?: unknown; deck?: { id?: unknown } } | null | undefined;
    return call.tool === "create_deck" && typeof data?.job_id === "string" && typeof data.deck?.id === "string" ? { jobId: data.job_id, deckId: data.deck.id } : null;
  });
  // start_workflow: the live workflow card (plan approval, steps, verification) under the row.
  const workflowId = $derived.by(() => {
    const data = call.result?.data as { workflow_id?: unknown } | null | undefined;
    return call.tool === "start_workflow" && typeof data?.workflow_id === "string" ? data.workflow_id : null;
  });
  // A batch (one run per paper): the batch card.
  const batchId = $derived.by(() => {
    const data = call.result?.data as { batch_id?: unknown } | null | undefined;
    return call.tool === "start_workflow" && typeof data?.batch_id === "string" ? data.batch_id : null;
  });
  const muted = $derived(call.status === "denied" || call.status === "cancelled" || call.status === "expired");
  const uid = $props.id();
  let undoing = $state(false);
  let undoneLocal = $state(false);
  const undone = $derived(call.undo === "done" || undoneLocal);
  async function undo() {
    undoing = true;
    try {
      await api.post(`/agent/tool-calls/${call.id}/undo`);
      undoneLocal = true;
      toasts.show(t("agent.tool.undoDone"), "success");
    } catch (e) {
      toasts.show((e as Error).message, "error");
    } finally {
      undoing = false;
    }
  }
</script>

<li class="row {nested ? 'pl-1' : ''}" data-status={call.status}>
  <div class="flex min-h-10 items-start gap-2.5">
    <span class="relative mt-1 grid size-7 shrink-0 place-items-center rounded-full {call.risk === 'destructive' ? 'bg-danger-soft text-danger' : 'bg-surface-3 text-ink-2'}">
      <Icon class="size-3.5" />
      <span class="badge" aria-hidden="true">
        {#if call.status === "running" || call.status === "approved"}
          <span class="spin"></span>
        {:else if call.status === "done"}
          <svg viewBox="0 0 12 12" class="check"><path d="M2.5 6.2 5 8.5 9.5 3.5" /></svg>
        {:else if call.status === "failed"}
          <X class="size-2.5 text-danger" />
        {:else if muted}
          <Ban class="size-2.5 text-ink-3" />
        {/if}
      </span>
    </span>
    <button
      type="button"
      class="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-xl px-1.5 text-left hover:bg-surface-2"
      aria-expanded={open}
      aria-controls="tool-{uid}"
      onclick={() => (open = !open)}
    >
      <span class="min-w-0 flex-1">
        <span class="block truncate text-[13.5px] {muted ? 'text-ink-3 line-through decoration-ink-3/50' : 'text-ink'} {call.status === 'running' ? 'running' : ''} {call.status === 'failed' ? 'shake' : ''}">{summary}</span>
        {#if detail && !summary.includes(detail)}<span class="block truncate text-[12px] text-ink-3">{detail}</span>{/if}
      </span>
      {#if call.approved_via === "autopilot"}<span class="tag">{t("agent.tool.auto")}</span>{/if}
      {#if call.approved_via === "conversation_grant"}<span class="tag">{t("agent.tool.granted")}</span>{/if}
      <span class="shrink-0 text-[12px] text-ink-3 tabular-nums">
        {t(`agent.tool.status.${call.status}` as MessageKey)}{#if duration !== null && call.status === "done"} · {duration < 1000 ? `${duration} ms` : `${(duration / 1000).toFixed(1)} s`}{/if}
      </span>
      <ChevronRight class="size-3.5 shrink-0 text-ink-3 transition-transform duration-150 {open ? 'rotate-90' : ''}" />
    </button>
    {#if undone}
      <span class="tag mt-2.5 shrink-0">{t("agent.tool.undone")}</span>
    {:else if call.undo === "available" && !bare}
      <button type="button" class="mt-0.5 inline-flex min-h-10 shrink-0 items-center gap-1 rounded-full px-3 text-[12.5px] font-medium text-ink-2 hover:bg-surface-3 hover:text-ink disabled:opacity-50" title={t("agent.tool.undoTitle")} disabled={undoing} onclick={undo}><Undo2 class="size-3.5" />{t("agent.tool.undo")}</button>
    {/if}
  </div>
  {#if draftJob && !bare}
    <DraftJobChip deckId={draftJob.deckId} jobId={draftJob.jobId} />
  {/if}
  {#if batchId && !bare}
    <div class="sm:ml-[38px]">{#key batchId}<WorkflowBatchCard {batchId} compact={nested} />{/key}</div>
  {:else if workflowId && !bare}
    <div class="sm:ml-[38px]">{#key workflowId}<WorkflowCard id={workflowId} compact={nested} />{/key}</div>
  {/if}
  {#if links.length}
    <div class="mt-0.5 mb-1 ml-[38px] flex flex-wrap gap-1.5">
      {#each links as link (link.url + link.label)}
        <a href={link.url} class="inline-flex min-h-8 items-center gap-1 rounded-full border border-line bg-surface px-3 text-[12.5px] font-medium text-ink hover:border-line-2">
          {linkLabel(link)}<ExternalLink class="size-3 text-ink-3" />
        </a>
      {/each}
    </div>
  {/if}
  <div id="tool-{uid}" class="grid transition-[grid-template-rows] duration-150 {open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}">
    <div class="overflow-hidden">
      {#if open}
        <div class="mt-1 mb-2 ml-[38px] flex flex-col gap-2 rounded-2xl border border-line bg-surface-2 p-3 text-[12.5px]">
          {#if call.target}<p><span class="text-ink-3">{t("agent.consent.target")}：</span>{call.target.label}</p>{/if}
          {#if call.deny_reason}<p class="text-ink-2">{call.deny_reason}</p>{/if}
          {#if call.error}<p class="text-danger"><span class="font-medium">{t("agent.tool.error")}：</span>{call.error}</p>{/if}
          <div>
            <p class="mb-1 font-medium text-ink-2">{t("agent.tool.args")}</p>
            <pre class="max-h-48 overflow-auto rounded-xl bg-surface p-2.5 text-[12px] leading-relaxed whitespace-pre-wrap text-ink-2">{JSON.stringify(call.args, null, 2)}</pre>
          </div>
          {#if call.result?.data}
            <div>
              <p class="mb-1 font-medium text-ink-2">{t("agent.tool.result")}</p>
              <pre class="max-h-64 overflow-auto rounded-xl bg-surface p-2.5 text-[12px] leading-relaxed whitespace-pre-wrap text-ink-2">{JSON.stringify(call.result.data, null, 2).slice(0, 6000)}</pre>
            </div>
          {/if}
          <p class="text-ink-3">{relativeTime(call.created_at)}</p>
        </div>
      {/if}
    </div>
  </div>
</li>

<style>
  .row {
    animation: row-in 150ms ease-out;
  }
  @keyframes row-in {
    from {
      opacity: 0;
      transform: translateY(-2px);
    }
  }
  .badge {
    position: absolute;
    right: -3px;
    bottom: -3px;
    display: grid;
    place-items: center;
    width: 14px;
    height: 14px;
    border-radius: 999px;
    background: var(--surface);
  }
  .badge:empty {
    display: none;
  }
  .spin {
    width: 9px;
    height: 9px;
    border-radius: 999px;
    border: 1.5px solid var(--line-2);
    border-top-color: var(--ink);
    animation: spin 1s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .check {
    width: 10px;
    height: 10px;
    fill: none;
    stroke: var(--success);
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-dasharray: 12;
    stroke-dashoffset: 0;
    animation: draw 200ms ease-out;
  }
  @keyframes draw {
    from {
      stroke-dashoffset: 12;
    }
  }
  .running {
    background: linear-gradient(90deg, var(--ink-2) 0%, var(--ink-2) 35%, var(--ink) 50%, var(--ink-2) 65%, var(--ink-2) 100%);
    background-size: 220% 100%;
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    animation: sweep 1s linear infinite;
  }
  @keyframes sweep {
    from {
      background-position: 120% 0;
    }
    to {
      background-position: -100% 0;
    }
  }
  .shake {
    animation: shake 180ms ease-in-out 1;
  }
  @keyframes shake {
    25% {
      transform: translateX(-2px);
    }
    75% {
      transform: translateX(2px);
    }
  }
  .tag {
    flex-shrink: 0;
    border-radius: 999px;
    background: var(--pill-butter);
    color: var(--pill-butter-ink);
    padding: 1px 8px;
    font-size: 11.5px;
    font-weight: 500;
  }
  @media (prefers-reduced-motion: reduce) {
    .row,
    .check,
    .shake {
      animation: none;
    }
    .spin {
      animation: none;
      border-top-color: var(--line-2);
      background: var(--ink-3);
      width: 6px;
      height: 6px;
    }
    .running {
      animation: none;
      background: none;
      color: var(--ink);
    }
  }
</style>
