<script lang="ts" module>
  export type Tone = "peach" | "mint" | "sky" | "lilac" | "butter" | "rose" | "stone";
  const tones: Tone[] = ["peach", "mint", "sky", "lilac", "butter", "rose"];
  /** Stable pastel tone for a label (tags get the same colour everywhere). */
  export function toneFor(key: string): Tone {
    let h = 0;
    for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return tones[h % tones.length]!;
  }
</script>

<script lang="ts">
  import type { Snippet } from "svelte";
  let { tone = "stone", size = "md", dot = false, class: cls = "", children }: { tone?: Tone; size?: "sm" | "md"; dot?: boolean; class?: string; children: Snippet } = $props();
</script>

<span
  class="inline-flex max-w-full items-center gap-1.5 truncate rounded-full font-medium {size === 'sm' ? 'h-5 px-2 text-[11px]' : 'h-6 px-2.5 text-xs'} {cls}"
  style="background: var(--pill-{tone}); color: var(--pill-{tone}-ink)"
>
  {#if dot}<span class="size-1.5 shrink-0 rounded-full bg-current"></span>{/if}
  {@render children()}
</span>
