<script lang="ts">
  import { Popover } from "bits-ui";
  import { Check, ListFilter } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import Pill, { toneFor } from "#lib/components/ui/Pill.svelte";

  /** Multi-select filter over slide tags; `none` stands for untagged decks (backend `tags=none`). */
  let { selected = $bindable([]), tags = $bindable([]) }: { selected?: string[]; tags?: { id: string; name: string; count?: number }[] } = $props();
  let open = $state(false);
  let loaded = $state(false);
  $effect(() => {
    if (loaded) return;
    loaded = true;
    api.get<{ tags: { id: string; name: string; count?: number }[] }>("/slide-tags").then(r => (tags = r.tags)).catch(() => (loaded = false));
  });
  function toggle(id: string) {
    selected = selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id];
  }
  const row = "flex h-9 w-full cursor-pointer items-center gap-2 rounded-xl px-2 text-left text-sm hover:bg-surface-2";
</script>

<Popover.Root bind:open>
  <Popover.Trigger
    class="inline-flex h-11 shrink-0 cursor-pointer items-center gap-2 rounded-full border px-4 text-sm font-medium transition-colors sm:h-10 {selected.length ? 'border-ink bg-surface text-ink' : 'border-line-2 bg-surface text-ink-2 hover:border-ink-3 hover:text-ink'}"
  >
    <ListFilter class="size-4" />{t("slides.filter.tags")}
    {#if selected.length}<span class="grid h-5 min-w-5 place-items-center rounded-full bg-ink px-1.5 text-[11px] text-canvas">{selected.length}</span>{/if}
  </Popover.Trigger>
  <Popover.Portal>
    <Popover.Content align="end" sideOffset={6} class="z-50 w-64 rounded-2xl border border-line bg-surface p-1.5 shadow-pop outline-none data-[state=open]:animate-[pop-in_120ms_ease-out]">
      <div class="max-h-72 overflow-y-auto">
        {#each tags as tag (tag.id)}
          <button type="button" class={row} aria-pressed={selected.includes(tag.id)} onclick={() => toggle(tag.id)}>
            <Pill tone={toneFor(tag.name)} size="sm">{tag.name}</Pill>
            {#if tag.count !== undefined}<span class="text-[12px] text-ink-3">{tag.count}</span>{/if}
            <span class="flex-1"></span>
            {#if selected.includes(tag.id)}<Check class="size-4" />{/if}
          </button>
        {:else}
          <p class="px-2 py-2 text-[13px] text-ink-3">{t("slides.filter.none")}</p>
        {/each}
        <div class="my-1 h-px bg-line"></div>
        <button type="button" class={row} aria-pressed={selected.includes("none")} onclick={() => toggle("none")}>
          <Pill size="sm">{t("slides.filter.untagged")}</Pill>
          <span class="flex-1"></span>
          {#if selected.includes("none")}<Check class="size-4" />{/if}
        </button>
      </div>
      {#if selected.length}
        <div class="mt-1 border-t border-line pt-1">
          <button type="button" class="{row} justify-center text-ink-2" onclick={() => ((selected = []), (open = false))}>{t("slides.filter.clear")}</button>
        </div>
      {/if}
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>
