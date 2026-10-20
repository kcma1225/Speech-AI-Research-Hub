<script lang="ts">
  import { CircleCheck, CircleX, LoaderCircle, Presentation, AudioLines } from "@lucide/svelte";
  import { jobsStore } from "#lib/stores/jobs.svelte.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import Progress from "#lib/components/ui/Progress.svelte";

  let { compact = false }: { compact?: boolean } = $props();
  const jobs = $derived(jobsStore.jobs.slice(0, compact ? 3 : 4));
  const running = $derived(jobsStore.running.length);
</script>

<div class="rounded-[18px] border border-line/70 bg-surface p-3.5 shadow-card">
  <div class="mb-2.5 flex items-center justify-between">
    <p class="text-[12px] font-semibold text-ink">{t("jobs.title")}</p>
    {#if running}
      <span class="inline-flex items-center gap-1 text-[11px] font-medium text-ink-3"><LoaderCircle class="size-3 animate-spin" />{t("jobs.running", { n: running })}</span>
    {/if}
  </div>
  {#if jobs.length === 0}
    <p class="text-[12px] text-ink-3">{t("jobs.none")}</p>
  {:else}
    <ul class="flex flex-col gap-3">
      {#each jobs as job (job.id)}
        {@const active = job.status === "queued" || job.status === "running"}
        <li>
          <a href={job.url} class="group block">
            <div class="flex items-center gap-2">
              <span class="grid size-6 shrink-0 place-items-center rounded-lg bg-surface-2 text-ink-2 [&_svg]:size-3.5">
                {#if job.kind === "slide_render"}<Presentation />{:else}<AudioLines />{/if}
              </span>
              <span class="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink group-hover:underline">{job.label}</span>
              {#if job.status === "succeeded"}<CircleCheck class="size-3.5 shrink-0 text-success" />
              {:else if job.status === "failed" || job.status === "cancelled"}<CircleX class="size-3.5 shrink-0 text-danger" />{/if}
            </div>
            {#if active}
              <div class="mt-1.5 flex items-center gap-2 pl-8">
                <Progress value={job.status === "queued" ? null : job.progress} class="flex-1" />
                <span class="w-14 truncate text-right text-[11px] text-ink-3">{job.status === "queued" ? t("jobs.queued") : (job.stage ?? "")}</span>
              </div>
            {:else}
              <p class="mt-0.5 pl-8 text-[11px] text-ink-3">{job.status === "succeeded" ? t("jobs.done") : job.status === "failed" ? t("jobs.failed") : t("jobs.cancelled")}</p>
            {/if}
          </a>
        </li>
      {/each}
    </ul>
  {/if}
</div>
