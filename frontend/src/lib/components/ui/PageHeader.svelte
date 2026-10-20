<script lang="ts">
  import type { Snippet } from "svelte";
  let { title, subtitle, actions }: { title: string; subtitle?: string; actions?: Snippet } = $props();
</script>

<div class="mb-6 flex flex-col gap-4 sm:mb-7 sm:flex-row sm:items-end sm:justify-between">
  <div class="min-w-0">
    <h1 class="font-display text-[34px] leading-[1.05] text-ink sm:text-[44px]">{title}</h1>
    {#if subtitle}<p class="mt-2 text-[14px] text-ink-3">{subtitle}</p>{/if}
  </div>
  {#if actions}<div class="flex flex-wrap items-center gap-2">{@render actions()}</div>{/if}
</div>
