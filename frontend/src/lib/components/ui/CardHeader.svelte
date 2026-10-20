<script lang="ts">
  import type { Snippet } from "svelte";
  let { title, subtitle, actions }: { title: string; subtitle?: string; actions?: Snippet } = $props();
</script>

<header class="mb-4 flex items-start justify-between gap-3">
  <div class="min-w-0">
    <h2 class="text-[15px] font-semibold tracking-[-0.01em] text-ink">{title}</h2>
    {#if subtitle}<p class="mt-0.5 text-[13px] text-ink-3">{subtitle}</p>{/if}
  </div>
  {#if actions}<div class="flex shrink-0 items-center gap-1">{@render actions()}</div>{/if}
</header>
