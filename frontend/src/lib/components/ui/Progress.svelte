<script lang="ts">
  let { value = null, class: cls = "" }: { value?: number | null; class?: string } = $props();
</script>

<div class="relative h-1.5 overflow-hidden rounded-full bg-surface-3 {cls}" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value ?? undefined}>
  {#if value === null}
    <div class="absolute inset-y-0 w-1/3 animate-[indeterminate_1.4s_ease-in-out_infinite] rounded-full bg-ink"></div>
  {:else}
    <div class="h-full rounded-full bg-ink transition-[width] duration-500" style="width:{Math.max(4, Math.min(100, value))}%"></div>
  {/if}
</div>

<style>
  @keyframes -global-indeterminate {
    from { left: -33%; }
    to { left: 100%; }
  }
</style>
