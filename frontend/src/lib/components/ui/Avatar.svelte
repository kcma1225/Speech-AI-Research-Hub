<script lang="ts">
  import { toneFor } from "./Pill.svelte";
  import { displayInitials } from "#lib/people.svelte.ts";
  /** `name` is the person's (Chinese) name from the API; `id` helps resolve the English name in the English UI. */
  let { name, id, size = 32, class: cls = "" }: { name: string; id?: string | null; size?: number; class?: string } = $props();

  // Initials of the locale-appropriate name: the CJK given name (two characters), or two Latin initials.
  const initials = $derived(displayInitials(id ? { id, name } : name));
  const tone = $derived(toneFor(name));
</script>

<span
  class="inline-grid shrink-0 place-items-center rounded-full font-semibold select-none ring-2 ring-surface {cls}"
  style="width:{size}px;height:{size}px;font-size:{Math.round(size * (initials.length > 1 && /[㐀-鿿]/.test(initials) ? 0.36 : 0.38))}px;background:var(--pill-{tone});color:var(--pill-{tone}-ink)"
  aria-hidden="true">{initials}</span
>
