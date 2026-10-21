<script lang="ts">
  import { Popover } from "bits-ui";
  import { Activity } from "@lucide/svelte";
  import { jobsStore } from "#lib/stores/jobs.svelte.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import JobsWidget from "./JobsWidget.svelte";

  /** Background jobs on the collapsed sidebar rail: an icon with a progress ring and a count; the full list opens beside it. */
  const running = $derived(jobsStore.running);
  const failed = $derived(jobsStore.jobs.some(j => j.status === "failed"));
  // Determinate only when every active job reports progress; otherwise the ring spins.
  const progress = $derived.by(() => {
    if (!running.length || running.some(j => j.status === "queued" || j.progress == null)) return null;
    return running.reduce((sum, j) => sum + (j.progress ?? 0), 0) / running.length;
  });
  const R = 18;
  const C = 2 * Math.PI * R;
  const label = $derived(running.length ? `${t("jobs.title")} (${t("jobs.running", { n: running.length })})` : t("jobs.title"));
</script>

<Popover.Root>
  <Popover.Trigger>
    {#snippet child({ props })}
      <button
        {...props}
        type="button"
        aria-label={label}
        class="relative grid size-10 place-items-center rounded-full text-ink-3 transition-colors hover:bg-surface/60 hover:text-ink-2 data-[state=open]:bg-surface data-[state=open]:text-ink data-[state=open]:shadow-card"
      >
        {#if running.length}
          <svg viewBox="0 0 40 40" class="pointer-events-none absolute inset-0 size-10 -rotate-90 {progress === null ? 'animate-spin [animation-duration:1.6s]' : ''}" aria-hidden="true">
            <circle cx="20" cy="20" r={R} fill="none" stroke="var(--line-2)" stroke-width="2" />
            <circle
              cx="20"
              cy="20"
              r={R}
              fill="none"
              stroke="var(--ink)"
              stroke-width="2"
              stroke-linecap="round"
              stroke-dasharray={C}
              stroke-dashoffset={progress === null ? C * 0.72 : C * (1 - Math.max(4, Math.min(100, progress)) / 100)}
              class="transition-[stroke-dashoffset] duration-500"
            />
          </svg>
        {/if}
        <Activity class="size-[18px] {running.length ? 'text-ink' : ''}" strokeWidth={1.9} />
        {#if running.length}
          <span class="absolute -top-0.5 -right-0.5 grid h-[18px] min-w-[18px] place-items-center rounded-full border-2 border-canvas bg-ink px-1 text-[10px] font-semibold text-primary-ink" aria-hidden="true">
            {running.length > 9 ? "9+" : running.length}
          </span>
        {:else if failed}
          <span class="absolute top-1 right-1 size-2 rounded-full border border-canvas bg-danger" aria-hidden="true"></span>
        {/if}
      </button>
    {/snippet}
  </Popover.Trigger>
  <Popover.Portal>
    <Popover.Content side="right" align="end" sideOffset={14} class="z-50 w-[280px] rounded-[18px] shadow-pop outline-none data-[state=open]:animate-[pop-in_140ms_ease-out]">
      <JobsWidget />
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>
