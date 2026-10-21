<script lang="ts">
  import { t } from "#lib/i18n.svelte.ts";
  import type { Heading } from "./markdown-text.ts";

  /** Table of contents from the document's headings; selecting one jumps the editor (and preview) there. */
  let { headings, current = 0, onJump }: { headings: Heading[]; current?: number; onJump: (h: Heading) => void } = $props();
  const minLevel = $derived(Math.min(6, ...headings.map(h => h.level)));
  // The heading the cursor is in: the last one at or before the cursor line.
  const active = $derived(headings.findLastIndex(h => h.line <= current));
</script>

<nav aria-label={t("mdx.outline")} class="flex min-h-0 flex-col">
  <h2 class="px-3 pt-3 pb-1.5 text-[12px] font-semibold tracking-wide text-ink-3 uppercase">{t("mdx.outline")}</h2>
  {#if headings.length}
    <ol class="flex min-h-0 flex-col overflow-y-auto px-1.5 pb-3">
      {#each headings as h, i (h.line + ":" + h.text)}
        <li>
          <button
            type="button"
            class="flex min-h-10 w-full items-center rounded-lg py-1 pr-2 text-left text-[13px] leading-snug transition-colors hover:bg-surface-3 lg:min-h-8 {i === active ? 'bg-surface-3 font-semibold text-ink' : 'text-ink-2'}"
            style="padding-left:{8 + (h.level - minLevel) * 14}px"
            aria-current={i === active ? "location" : undefined}
            onclick={() => onJump(h)}><span class="line-clamp-2">{h.text}</span></button
          >
        </li>
      {/each}
    </ol>
  {:else}
    <p class="px-3 pb-3 text-[12.5px] text-ink-3">{t("mdx.outlineEmpty")}</p>
  {/if}
</nav>
