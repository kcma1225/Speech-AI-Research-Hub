<script lang="ts">
  import type { Snippet } from "svelte";
  let { title, hint, icon, action, class: cls = "" }: { title: string; hint?: string; icon?: Snippet; action?: Snippet; class?: string } = $props();
</script>

<div class="flex flex-col items-center justify-center px-6 py-10 text-center {cls}">
  {#if icon}<div class="mb-3 grid size-11 place-items-center rounded-2xl bg-surface-2 text-ink-3 [&_svg]:size-5">{@render icon()}</div>{/if}
  <p class="text-sm font-medium text-ink">{title}</p>
  {#if hint}<p class="mt-1 max-w-xs text-[13px] text-ink-3">{hint}</p>{/if}
  {#if action}<div class="mt-4">{@render action()}</div>{/if}
</div>
