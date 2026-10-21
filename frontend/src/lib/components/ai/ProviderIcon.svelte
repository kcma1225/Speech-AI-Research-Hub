<script lang="ts">
  import { Plug } from "@lucide/svelte";
  import { vendorMark } from "#lib/ai/provider-icons.ts";

  /**
   * Vendor tile: the brand mark (simple-icons, CC0) on its brand colour, or a pastel monogram for vendors
   * without one. Decorative — the vendor / account name must be shown as text next to it.
   */
  let { kind, label = "", size = "md", class: cls = "" }: { kind: string | null | undefined; label?: string; size?: "xs" | "sm" | "md" | "lg"; class?: string } = $props();

  const mark = $derived(vendorMark(kind, label));
  const box = $derived({ xs: "size-5 rounded-[6px] text-[9px]", sm: "size-7 rounded-[8px] text-[11px]", md: "size-9 rounded-xl text-[13px]", lg: "size-10 rounded-2xl text-[14px]" }[size]);
  const glyph = $derived({ xs: "size-3", sm: "size-4", md: "size-5", lg: "size-[22px]" }[size]);
</script>

{#if mark.kind === "brand"}
  <span class="grid shrink-0 place-items-center ring-1 ring-ink/10 ring-inset dark:ring-white/12 {box} {cls}" style="background: {mark.bg}; color: {mark.fg}" aria-hidden="true">
    <svg viewBox="0 0 24 24" class={glyph} fill="currentColor"><path d={mark.path} /></svg>
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
