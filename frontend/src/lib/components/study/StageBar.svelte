<script lang="ts">
  import { t } from "#lib/i18n.svelte.ts";

  /**
   * Segmented stage progress: one segment per stage, filled when completed (or before the current one),
   * the current stage drawn as a half-filled, pulsing segment.
   */
  let { count, done, current, label }: { count: number; done: number; current: number | null; label?: string } = $props();
  const segments = $derived(Array.from({ length: Math.max(count, 1) }, (_, i) => (i < Math.max(done, current ?? 0) ? "done" : i === current ? "current" : "todo")));
  const text = $derived(label ?? (current !== null ? t("studies.stageOf", { n: current + 1, total: count }) : t("studies.noStage")));
</script>

<div class="flex w-full gap-1" role="img" aria-label={text}>
  {#each segments as state, i (i)}
    <span class="relative h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
      {#if state === "done"}
        <span class="absolute inset-0 rounded-full bg-ink"></span>
      {:else if state === "current"}
        <span class="stage-current absolute inset-y-0 left-0 w-1/2 rounded-full bg-ink"></span>
      {/if}
    </span>
  {/each}
</div>

<style>
  .stage-current {
    animation: stage-pulse 2.4s ease-in-out infinite;
  }
  @keyframes stage-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.55; }
  }
  @media (prefers-reduced-motion: reduce) {
    .stage-current { animation: none; }
  }
</style>
