<script lang="ts">
  import { i18n, t } from "#lib/i18n.svelte.ts";
  import type { TextStats } from "./markdown-text.ts";

  /** Status line under the editor: word / character counts (CJK-aware), selection counts, cursor position. */
  let { stats, selection, line, column }: { stats: TextStats; selection: TextStats | null; line: number; column: number } = $props();
  const nf = $derived(new Intl.NumberFormat(i18n.locale === "en" ? "en" : "zh-TW"));
</script>

<div class="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-line px-3 py-1.5 text-[11.5px] text-ink-3 tabular-nums" aria-live="off">
  <span>{t("mdx.stats.words", { n: nf.format(stats.words) })}</span>
  <span>{t("mdx.stats.chars", { n: nf.format(stats.charsNoSpaces) })}</span>
  {#if selection && selection.chars}<span class="text-ink-2">{t("mdx.stats.selection", { words: nf.format(selection.words), chars: nf.format(selection.charsNoSpaces) })}</span>{/if}
  <span class="ml-auto hidden sm:inline">{t("mdx.stats.position", { line: nf.format(line), col: nf.format(column) })}</span>
</div>
