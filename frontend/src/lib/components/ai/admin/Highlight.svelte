<script lang="ts">
  /** `text` with every case-insensitive occurrence of `query` marked. */
  let { text, query = "" }: { text: string; query?: string } = $props();
  const parts = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [{ s: text, hit: false }];
    const out: Array<{ s: string; hit: boolean }> = [];
    const low = text.toLowerCase();
    let i = 0;
    for (let j = low.indexOf(q); j !== -1; j = low.indexOf(q, i)) {
      if (j > i) out.push({ s: text.slice(i, j), hit: false });
      out.push({ s: text.slice(j, j + q.length), hit: true });
      i = j + q.length;
    }
    if (i < text.length) out.push({ s: text.slice(i), hit: false });
    return out;
  });
</script>

{#each parts as p, i (i)}{#if p.hit}<mark class="rounded-[3px] bg-[var(--pill-butter)] px-px text-[var(--pill-butter-ink)]">{p.s}</mark>{:else}{p.s}{/if}{/each}
