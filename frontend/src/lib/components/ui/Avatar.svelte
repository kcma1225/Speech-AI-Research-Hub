<script lang="ts">
  import { toneFor } from "./Pill.svelte";
  let { name, size = 32, class: cls = "" }: { name: string; size?: number; class?: string } = $props();

  // Two Latin initials, or the last CJK character pair (given name) for Chinese names.
  const initials = $derived.by(() => {
    const trimmed = name.trim();
    if (/[㐀-鿿]/.test(trimmed)) return trimmed.replace(/\s/g, "").slice(-2);
    const parts = trimmed.split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts.at(-1)![0] : (parts[0]?.[1] ?? ""))).toUpperCase();
  });
  const tone = $derived(toneFor(name));
</script>

<span
  class="inline-grid shrink-0 place-items-center rounded-full font-semibold select-none ring-2 ring-surface {cls}"
  style="width:{size}px;height:{size}px;font-size:{Math.round(size * (initials.length > 1 && /[㐀-鿿]/.test(initials) ? 0.36 : 0.38))}px;background:var(--pill-{tone});color:var(--pill-{tone}-ink)"
  aria-hidden="true">{initials}</span
>
