<script lang="ts">
  import { X } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import Pill, { toneFor } from "#lib/components/ui/Pill.svelte";

  /** Free-form tag chips (max 30, 40 chars, case-insensitive unique). `onChange` gets the new list. */
  let { tags, onChange, disabled = false, suggestions = [] }: { tags: string[]; onChange: (tags: string[]) => void; disabled?: boolean; suggestions?: string[] } = $props();
  let draft = $state("");
  const uid = $props.id();

  function add(raw: string) {
    const tag = raw.trim().slice(0, 40);
    draft = "";
    if (!tag || tags.length >= 30 || tags.some(x => x.toLowerCase() === tag.toLowerCase())) return;
    onChange([...tags, tag]);
  }
  const remaining = $derived(suggestions.filter(s => !tags.some(x => x.toLowerCase() === s.toLowerCase())).slice(0, 8));
</script>

<div class="flex flex-col gap-2">
  <div class="flex min-h-11 flex-wrap items-center gap-1.5 rounded-xl border border-line-2 bg-surface px-2 py-1.5 focus-within:border-ink">
    {#each tags as tag (tag)}
      <span class="inline-flex items-center">
        <Pill tone={toneFor(tag.toLowerCase())}>
          {tag}
          {#if !disabled}
            <button type="button" class="-mr-1.5 grid size-6 place-items-center rounded-full hover:bg-black/10" aria-label={t("library.tags.remove", { tag })} onclick={() => onChange(tags.filter(x => x !== tag))}><X class="size-3" /></button>
          {/if}
        </Pill>
      </span>
    {/each}
    {#if !disabled}
      <label for="tag-{uid}" class="sr-only">{t("library.tags.add")}</label>
      <input
        id="tag-{uid}"
        bind:value={draft}
        placeholder={tags.length ? "" : t("library.tags.placeholder")}
        maxlength={40}
        class="h-8 min-w-24 flex-1 bg-transparent px-1 text-[15px] text-ink outline-none placeholder:text-ink-3 sm:text-sm"
        onkeydown={e => {
          if ((e.key === "Enter" || e.key === ",") && !e.isComposing) {
            e.preventDefault();
            add(draft);
          } else if (e.key === "Backspace" && !draft && tags.length) onChange(tags.slice(0, -1));
        }}
        onblur={() => draft.trim() && add(draft)}
      />
    {/if}
  </div>
  {#if !disabled && remaining.length}
    <div class="flex flex-wrap gap-1.5">
      {#each remaining as s (s)}
        <button type="button" class="h-8 rounded-full border border-dashed border-line-2 px-3 text-[12.5px] text-ink-2 hover:border-ink-3 hover:text-ink" onclick={() => add(s)}>+ {s}</button>
      {/each}
    </div>
  {/if}
</div>
