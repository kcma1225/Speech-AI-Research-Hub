<script lang="ts" module>
  import { diffWords, type ChangeObject } from "diff";

  const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter("zh-Hant", { granularity: "word" }) : undefined;

  /** Word diff (CJK words via Intl.Segmenter; character diffs are noisy on Chinese). */
  export function wordDiff(before: string, after: string): ChangeObject<string>[] {
    if (before.length + after.length > 20_000) return [...(before ? [{ value: before, removed: true, added: false, count: 1 }] : []), ...(after ? [{ value: after, added: true, removed: false, count: 1 }] : [])];
    return diffWords(before, after, segmenter ? { intlSegmenter: segmenter } : undefined);
  }
</script>

<script lang="ts">
  /** Inline word diff of one hunk: removed words struck in red, added words in green. */
  let { before, after, class: cls = "" }: { before: string; after: string; class?: string } = $props();
  const parts = $derived(wordDiff(before, after));
</script>

<p class="text-[13px] leading-[1.7] break-words whitespace-pre-wrap text-ink-2 {cls}">
  {#each parts as part, i (i)}
    {#if part.removed}<del class="rounded-[3px] bg-[color-mix(in_srgb,var(--danger)_13%,transparent)] text-danger decoration-[color-mix(in_srgb,var(--danger)_60%,transparent)]">{part.value}</del
      >{:else if part.added}<ins class="rounded-[3px] bg-[color-mix(in_srgb,var(--success)_15%,transparent)] text-[color-mix(in_srgb,var(--success)_75%,var(--ink))] no-underline">{part.value}</ins
      >{:else}<span>{part.value}</span>{/if}
  {/each}
</p>
