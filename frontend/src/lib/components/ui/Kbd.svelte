<script lang="ts">
  import type { Snippet } from "svelte";
  let { children, class: cls = "" }: { children: Snippet; class?: string } = $props();
</script>

<kbd class="inline-flex h-5 min-w-5 items-center justify-center rounded-md border border-line-2 bg-surface-2 px-1.5 font-sans text-[11px] font-medium text-ink-3 {cls}">{@render children()}</kbd>
