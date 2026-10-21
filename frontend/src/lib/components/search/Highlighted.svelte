<script lang="ts">
  import { highlightParts } from "#lib/search/meta.ts";

  /** Text with server-given highlight ranges rendered as <mark> (never HTML from the server). */
  let { text, ranges = [], class: cls = "" }: { text: string; ranges?: [number, number][]; class?: string } = $props();
  const parts = $derived(highlightParts(text, ranges));
</script>

<span class={cls}>{#each parts as p, i (i)}{#if p.mark}<mark class="rounded-[4px] bg-[var(--pill-butter)] px-[1px] text-[var(--pill-butter-ink)]">{p.text}</mark>{:else}{p.text}{/if}{/each}</span>
