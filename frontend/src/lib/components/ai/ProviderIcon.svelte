<script lang="ts">
  import { Plug } from "@lucide/svelte";
  import { scopeSvgIds, vendorMark } from "#lib/ai/provider-icons.ts";

  /**
   * Vendor tile: the brand mark (LobeHub Icons, MIT — see lib/ai/provider-svgs/NOTICE.md) on its brand tile, or a
   * pastel monogram for vendors without one. Decorative — the vendor / account name must be shown as text next to it.
   */
  let { kind, label = "", size = "md", class: cls = "" }: { kind: string | null | undefined; label?: string; size?: "xs" | "sm" | "md" | "lg"; class?: string } = $props();

  const mark = $derived(vendorMark(kind, label));
  const markup = $derived(mark.kind === "brand" ? scopeSvgIds(mark.svg) : "");
  const box = $derived({ xs: "size-5 rounded-[6px] text-[9px]", sm: "size-7 rounded-[8px] text-[11px]", md: "size-9 rounded-xl text-[13px]", lg: "size-10 rounded-2xl text-[14px]" }[size]);
  const glyph = $derived({ xs: "size-3.5", sm: "size-[18px]", md: "size-[22px]", lg: "size-6" }[size]);
</script>

{#if mark.kind === "brand"}
  <span
    class="grid shrink-0 place-items-center bg-[var(--pi-bg)] text-[var(--pi-fg)] ring-1 ring-ink/10 ring-inset dark:bg-[var(--pi-dbg)] dark:text-[var(--pi-dfg)] dark:ring-white/12 {box} {cls}"
    style="--pi-bg: {mark.bg}; --pi-fg: {mark.fg}; --pi-dbg: {mark.darkBg}; --pi-dfg: {mark.darkFg}"
    aria-hidden="true"
  >
    <span class="block {glyph} [&>svg]:size-full">{@html markup}</span>
  </span>
{:else if mark.kind === "mono"}
  <span
    class="grid shrink-0 place-items-center leading-none font-bold tracking-[-0.02em] {box} {cls}"
    style="background: var(--pill-{mark.tone}); color: var(--pill-{mark.tone}-ink)"
    aria-hidden="true">{mark.text}</span
  >
{:else}
  <span class="grid shrink-0 place-items-center bg-surface-3 text-ink-2 {box} {cls}" aria-hidden="true"><Plug class={glyph} /></span>
{/if}
