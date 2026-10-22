<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { ChevronRight, Layers } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import Pill from "#lib/components/ui/Pill.svelte";
  import { workflowsApi } from "#lib/workflows/api.ts";
  import { ACTIVE, NEEDS_YOU, WORKING, type Workflow } from "#lib/workflows/types.ts";
  import { STATUS_TONE } from "./meta.ts";
  import WorkflowCard from "./WorkflowCard.svelte";

  /**
   * A batch of workflow runs started by one request (「每一篇文獻都做成簡報」: one run per paper): one row per run with
   * its status (排隊中 / 規劃中 / 需要 PDF / 已完成…), expandable into that run's live WorkflowCard. Polls while any run
   * is active (the cards themselves stream over SSE once expanded).
   */
  let { batchId, compact = false, focusKey = null }: {
    batchId: string;
    compact?: boolean;
    /** Deep-linked card (`workflow:<runId>`, lib/agent/focus.ts): that run's row opens so the chat can scroll to its card. */
    focusKey?: string | null;
  } = $props();

  let runs = $state<Workflow[]>([]);
  let error = $state<string | null>(null);
  let loaded = $state(false);
  let open = $state<Record<string, boolean>>({});
  let timer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;

  async function load() {
    try {
      runs = (await workflowsApi.list({ batch: untrack(() => batchId), limit: 20 })).workflows;
      error = null;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loaded = true;
    }
    if (destroyed) return;
    const busy = runs.some((r) => ACTIVE.includes(r.status));
    timer = setTimeout(() => void load(), busy ? (document.hidden ? 15_000 : 4_000) : 30_000);
  }
  void load();
  onDestroy(() => {
    destroyed = true;
    if (timer) clearTimeout(timer);
  });

  $effect(() => {
    const id = focusKey?.startsWith("workflow:") ? focusKey.slice(9) : null;
    if (id && runs.some((r) => r.id === id) && !untrack(() => open[id])) open = { ...untrack(() => open), [id]: true };
  });

  const counts = $derived({
    done: runs.filter((r) => r.status === "done" || r.status === "partial").length,
    working: runs.filter((r) => WORKING.includes(r.status)).length,
    queued: runs.filter((r) => r.status === "queued").length,
    needs: runs.filter((r) => NEEDS_YOU.includes(r.status)).length,
  });
</script>

<article data-workflow-batch class="mt-2 rounded-[20px] border border-line bg-surface shadow-card {compact ? 'p-3' : 'p-3 sm:p-4'}" aria-label={t("wf.batch.title")}>
  <header class="flex flex-wrap items-center gap-x-2 gap-y-1">
    <span class="grid size-8 shrink-0 place-items-center rounded-full bg-surface-3 text-ink-2"><Layers class="size-4" aria-hidden="true" /></span>
    <div class="min-w-0 flex-1">
      <p class="text-[11.5px] tracking-wide text-ink-3 uppercase">{t("wf.batch.title")}{#if runs.length} · {t("wf.batch.count", { n: runs.length })}{/if}</p>
      {#if runs.length}<p class="text-[12.5px] text-ink-2 tabular-nums">{t("wf.batch.summary", counts)}</p>{/if}
    </div>
  </header>
  {#if error && !runs.length}
    <p class="mt-2 text-[13px] text-danger">{t("wf.batch.loadFailed")}：{error}</p>
  {:else if !loaded}
    <p class="mt-2 text-[13px] text-ink-3">{t("wf.title")}…</p>
  {/if}
  <ol class="mt-2 flex flex-col gap-1.5">
    {#each runs as r, i (r.id)}
      <li class="min-w-0 rounded-2xl border border-line bg-surface-2">
        <button type="button" class="flex min-h-11 w-full min-w-0 items-center gap-2 rounded-2xl px-3 py-2 text-left hover:bg-surface-3" aria-expanded={!!open[r.id]} onclick={() => (open = { ...open, [r.id]: !open[r.id] })}>
          <ChevronRight class="size-3.5 shrink-0 text-ink-3 transition-transform duration-150 motion-reduce:transition-none {open[r.id] ? 'rotate-90' : ''}" aria-hidden="true" />
          <span class="shrink-0 text-[12px] text-ink-3 tabular-nums">{i + 1}.</span>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-[13.5px] text-ink">{r.title}</span>
            {#if r.status === "needs_pdf" || r.status === "awaiting_input"}{#if r.question}<span class="block truncate text-[12px] text-ink-3">{r.question}</span>{/if}{/if}
          </span>
          <Pill size="sm" tone={STATUS_TONE[r.status] ?? "stone"} dot={WORKING.includes(r.status)}>{t(`wf.status.${r.status}` as MessageKey)}</Pill>
          <span class="sr-only">{open[r.id] ? t("wf.batch.collapse") : t("wf.batch.expand")}</span>
        </button>
        {#if open[r.id]}
          <div class="px-2 pb-2">{#key r.id}<WorkflowCard id={r.id} compact collapsible />{/key}</div>
        {/if}
      </li>
    {/each}
  </ol>
</article>
