<script lang="ts">
  import { untrack } from "svelte";
  import { CircleAlert, CircleCheck, LoaderCircle, TriangleAlert } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import Progress from "#lib/components/ui/Progress.svelte";
  import { draftRunning, draftStageLabel } from "#lib/slides/draft.ts";
  import type { AiDraftJob } from "#lib/slides/types.ts";

  /**
   * Live status of the AI deck draft started by `create_deck` (job `ai_slides_generate`): polls the deck's latest draft
   * job while it runs (stage + progress), then shows the outcome (pages, partial warning, auto-published version).
   */
  let { deckId, jobId }: { deckId: string; jobId: string } = $props();
  let job = $state<AiDraftJob | null>(null);
  let gone = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function poll() {
    clearTimeout(timer);
    try {
      const latest = (await api.get<{ job: AiDraftJob | null }>(`/slides/${deckId}/ai/generate`)).job;
      // A newer draft replaced this one: show nothing rather than another job's state.
      if (latest && latest.id !== jobId) gone = true;
      else job = latest;
    } catch {
      // deck deleted / offline: retry slowly
    }
    if (!gone && (!job || draftRunning(job))) timer = setTimeout(poll, document.hidden ? 8000 : 2500);
  }
  $effect(() => {
    void jobId;
    untrack(() => void poll());
    return () => clearTimeout(timer);
  });

  const r = $derived(job?.status === "succeeded" ? job.result : null);
  const status = $derived(!job ? "queued" : job.status === "succeeded" && r?.partial ? "partial" : job.status);
</script>

{#if !gone}
  <div class="mt-0.5 mb-1 ml-[38px] max-w-md rounded-2xl border border-line bg-surface px-3 py-2 text-[12.5px]" aria-live="polite" data-job-status={status}>
    <div class="flex min-h-6 items-center gap-2">
      {#if status === "queued" || status === "running"}
        <LoaderCircle class="size-3.5 shrink-0 animate-spin text-ink-2 motion-reduce:animate-none" />
      {:else if status === "succeeded"}
        <CircleCheck class="size-3.5 shrink-0 text-success" />
      {:else if status === "partial"}
        <TriangleAlert class="size-3.5 shrink-0" style="color:var(--pill-butter-ink)" />
      {:else}
        <CircleAlert class="size-3.5 shrink-0 text-danger" />
      {/if}
      <span class="font-medium text-ink">{t("agent.job.draft")}</span>
      <span class="text-ink-3">· {t(`agent.job.${status}` as "agent.job.queued")}</span>
      {#if job && draftRunning(job)}
        <span class="min-w-0 flex-1 truncate text-right text-ink-3">{draftStageLabel(job.stage)} · <span class="tabular-nums">{job.progress}%</span></span>
      {:else if r}
        <span class="min-w-0 flex-1 truncate text-right text-ink-3">{t("agent.job.pages", { n: r.pages })}{#if r.publishedVersion} · {t("agent.job.publishedAs", { n: r.publishedVersion })}{/if}</span>
      {/if}
    </div>
    {#if !job || draftRunning(job)}
      <Progress value={job?.progress || null} class="mt-1.5 h-1" />
      <p class="mt-1 text-[11.5px] text-ink-3">{t("agent.job.notify")}</p>
    {:else if job.status === "failed" && job.error}
      <p class="mt-1 text-danger">{job.error}</p>
    {:else if r?.partial && r.warning}
      <p class="mt-1 text-ink-2">{r.warning}</p>
    {/if}
  </div>
{/if}
