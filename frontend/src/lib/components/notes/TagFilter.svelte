<script lang="ts">
  import { Popover } from "bits-ui";
  import { Check, ListFilter, Tag as TagIcon } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import Pill, { tagTone, toneFor } from "#lib/components/ui/Pill.svelte";

  /** Multi-select filter over note tags plus 未分類 (`none`). */
  let { tags, selected, onChange }: { tags: { id: string; name: string; count: number }[]; selected: string[]; onChange: (ids: string[]) => void } = $props();
  let open = $state(false);
  let query = $state("");
  const filtered = $derived(tags.filter(tag => tag.name.toLowerCase().includes(query.trim().toLowerCase())));

  function toggle(id: string) {
    onChange(selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id]);
  }
</script>

{#snippet check(on: boolean)}
  <span class="grid size-4.5 shrink-0 place-items-center rounded-[6px] border transition-colors {on ? 'border-ink bg-ink text-surface' : 'border-line-2'}">
    {#if on}<Check class="size-3" strokeWidth={3} />{/if}
  </span>
{/snippet}

<Popover.Root bind:open>
  <Popover.Trigger
    aria-label={t("notes.filter.tags")}
    class="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-medium transition-colors {selected.length
      ? 'border-ink bg-ink text-surface'
      : 'border-line bg-surface text-ink-2 hover:border-line-2 hover:text-ink'}"
  >
    <ListFilter class="size-4" />
    <span class="hidden sm:inline">{t("notes.filter.tags")}</span>
    {#if selected.length}<span class="grid h-5 min-w-5 place-items-center rounded-full bg-surface px-1 text-[11px] text-ink tabular-nums">{selected.length}</span>{/if}
  </Popover.Trigger>
  <Popover.Portal>
    <Popover.Content align="end" sideOffset={6} class="z-50 w-64 rounded-2xl border border-line bg-surface p-1.5 shadow-pop outline-none data-[state=open]:animate-[pop-in_120ms_ease-out]">
      {#if tags.length > 6}
        <input bind:value={query} placeholder={t("notes.filter.search")} class="mb-1 h-9 w-full rounded-xl bg-surface-2 px-3 text-sm outline-none placeholder:text-ink-3" />
      {/if}
      <div class="max-h-72 overflow-y-auto">
        {#each filtered as tag (tag.id)}
          <button type="button" role="checkbox" aria-checked={selected.includes(tag.id)} onclick={() => toggle(tag.id)} class="flex h-9 w-full items-center gap-2.5 rounded-xl px-2 text-left text-sm hover:bg-surface-2">
            {@render check(selected.includes(tag.id))}
            <Pill tone={tagTone(tag)} size="sm">{tag.name}</Pill>
            <span class="ml-auto text-[12px] text-ink-3 tabular-nums">{tag.count}</span>
          </button>
        {:else}
          {#if query}<p class="px-2 py-2 text-[13px] text-ink-3">{t("notes.filter.noMatch")}</p>{/if}
        {/each}
        <div class="my-1 h-px bg-line"></div>
        <button type="button" role="checkbox" aria-checked={selected.includes("none")} onclick={() => toggle("none")} class="flex h-9 w-full items-center gap-2.5 rounded-xl px-2 text-left text-sm hover:bg-surface-2">
          {@render check(selected.includes("none"))}
          <TagIcon class="size-3.5 text-ink-3" /><span class="text-ink-2">{t("notes.filter.untagged")}</span>
        </button>
        {#if selected.length}
          <button type="button" onclick={() => onChange([])} class="mt-1 flex h-9 w-full items-center justify-center rounded-xl text-[13px] font-medium text-ink-2 hover:bg-surface-2 hover:text-ink">{t("notes.filter.clear")}</button>
        {/if}
      </div>
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>
