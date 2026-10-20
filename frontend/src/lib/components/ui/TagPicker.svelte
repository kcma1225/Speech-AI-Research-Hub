<script lang="ts">
  import { Popover } from "bits-ui";
  import { Check, Plus, Tag } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import Pill, { toneFor } from "./Pill.svelte";
  import { toasts } from "./toast.svelte.ts";

  /**
   * Multi-select tag popover with inline create. `endpoint` is "/tags" (notes) or "/slide-tags" (slides);
   * both return `{ tags: [{id,name,count}] }`; POST `{name}` → `{ tag }`.
   */
  let { endpoint, selected = $bindable([]), onChange, canCreate = true, label }: {
    endpoint: "/tags" | "/slide-tags";
    selected?: string[];
    onChange?: (ids: string[]) => void;
    canCreate?: boolean;
    label: string;
  } = $props();
  let open = $state(false);
  let tags = $state<{ id: string; name: string }[]>([]);
  let query = $state("");
  $effect(() => {
    if (open) api.get<{ tags: { id: string; name: string }[] }>(endpoint).then(r => (tags = r.tags));
  });
  const filtered = $derived(tags.filter(tag => tag.name.toLowerCase().includes(query.trim().toLowerCase())));
  const exact = $derived(tags.some(tag => tag.name.toLowerCase() === query.trim().toLowerCase()));

  function toggle(id: string) {
    selected = selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id];
    onChange?.(selected);
  }
  async function create() {
    try {
      const { tag } = await api.post<{ tag: { id: string; name: string } }>(endpoint, { name: query.trim() });
      tags = [...tags, tag];
      query = "";
      toggle(tag.id);
    } catch (e) {
      toasts.show((e as Error).message, "error");
    }
  }
</script>

<Popover.Root bind:open>
  <Popover.Trigger
    class="inline-flex h-8 items-center gap-1.5 rounded-full border border-dashed border-line-2 px-3 text-[13px] font-medium text-ink-2 hover:border-ink-3 hover:text-ink"
  >
    <Tag class="size-3.5" />{label}
  </Popover.Trigger>
  <Popover.Portal>
    <Popover.Content align="start" sideOffset={6} class="z-50 w-64 rounded-2xl border border-line bg-surface p-1.5 shadow-pop outline-none data-[state=open]:animate-[pop-in_120ms_ease-out]">
      <input
        bind:value={query}
        placeholder={t("tags.search")}
        class="mb-1 h-9 w-full rounded-xl bg-surface-2 px-3 text-sm outline-none placeholder:text-ink-3"
        onkeydown={e => e.key === "Enter" && canCreate && query.trim() && !exact && create()}
      />
      <div class="max-h-60 overflow-y-auto">
        {#each filtered as tag (tag.id)}
          <button type="button" onclick={() => toggle(tag.id)} class="flex h-9 w-full items-center gap-2 rounded-xl px-2 text-left text-sm hover:bg-surface-2">
            <Pill tone={toneFor(tag.name)} size="sm">{tag.name}</Pill>
            <span class="flex-1"></span>
            {#if selected.includes(tag.id)}<Check class="size-4" />{/if}
          </button>
        {/each}
        {#if canCreate && query.trim() && !exact}
          <button type="button" onclick={create} class="flex h-9 w-full items-center gap-2 rounded-xl px-2 text-left text-sm text-ink-2 hover:bg-surface-2">
            <Plus class="size-4" />{t("tags.create", { name: query.trim() })}
          </button>
        {/if}
      </div>
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>
