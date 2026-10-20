<script lang="ts">
  import { X } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import type { TagRef } from "#lib/types.ts";
  import Pill, { toneFor } from "#lib/components/ui/Pill.svelte";
  import TagPicker from "#lib/components/ui/TagPicker.svelte";

  /** Selected note tags as removable pills plus the shared TagPicker (endpoint /tags). */
  let { selected = $bindable([]), known = [], editable = false, onChange }: { selected?: string[]; known?: TagRef[]; editable?: boolean; onChange?: (ids: string[]) => void } = $props();
  let names = $state<Record<string, string>>({});

  $effect(() => {
    for (const tag of known) names[tag.id] ??= tag.name;
  });
  async function refreshNames() {
    try {
      const { tags } = await api.get<{ tags: TagRef[] }>("/tags");
      for (const tag of tags) names[tag.id] = tag.name;
    } catch {}
  }
  $effect(() => {
    if (selected.some(id => !(id in names))) void refreshNames();
  });

  function set(ids: string[]) {
    selected = ids;
    onChange?.(ids);
  }
</script>

<div class="flex flex-wrap items-center gap-1.5">
  {#each selected as id (id)}
    {@const name = names[id] ?? "…"}
    {#if editable}
      <button type="button" class="group inline-flex" onclick={() => set(selected.filter(x => x !== id))} aria-label={t("notes.filter.remove", { name })}>
        <Pill tone={toneFor(name)}>{name}<X class="-mr-1 size-3 opacity-60 group-hover:opacity-100" /></Pill>
      </button>
    {:else}
      <Pill tone={toneFor(name)}>{name}</Pill>
    {/if}
  {/each}
  {#if editable}
    <TagPicker endpoint="/tags" bind:selected onChange={set} label={selected.length ? t("notes.tags.edit") : t("notes.tags.add")} />
  {/if}
</div>
