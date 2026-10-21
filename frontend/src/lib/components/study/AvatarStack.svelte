<script lang="ts">
  import Avatar from "#lib/components/ui/Avatar.svelte";

  /** Overlapping member avatars with a +N overflow chip; names are exposed as a tooltip and to screen readers. */
  let { people, max = 4, size = 28 }: { people: { id: string; name: string }[]; max?: number; size?: number } = $props();
  const shown = $derived(people.slice(0, max));
  const extra = $derived(people.length - shown.length);
  const names = $derived(people.map(p => p.name).join("、"));
</script>

<span class="inline-flex items-center" title={names}>
  <span class="sr-only">{names}</span>
  {#each shown as person, i (person.id)}
    <span class="-ml-1 first:ml-0" style="z-index:{shown.length - i}"><Avatar name={person.name} {size} /></span>
  {/each}
  {#if extra > 0}
    <span
      class="-ml-1 inline-grid shrink-0 place-items-center rounded-full bg-surface-3 font-semibold text-ink-2 ring-2 ring-surface"
      style="width:{size}px;height:{size}px;font-size:{Math.round(size * 0.36)}px"
      aria-hidden="true">+{extra}</span
    >
  {/if}
</span>
