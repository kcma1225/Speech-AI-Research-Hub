<script lang="ts">
  import { FileText, Plus } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import { session } from "#lib/stores/session.svelte.ts";
  import { notesList } from "#lib/notes/list.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
</script>

<svelte:head><title>{t("nav.notes")}</title></svelte:head>

<!-- Desktop-only hint pane (phones show just the list at /notes). -->
<section class="flex flex-1 flex-col items-center justify-center rounded-[var(--radius-card)] border border-dashed border-line-2 px-8 text-center">
  <div class="mb-4 grid size-14 place-items-center rounded-[18px]" style="background:var(--pill-sky);color:var(--pill-sky-ink)"><FileText class="size-6" /></div>
  <p class="font-display text-[28px] leading-tight text-ink">{t("notes.pick.title")}</p>
  <p class="mt-2 max-w-sm text-[13.5px] text-ink-3">
    {notesList.items.length ? t("notes.pick.hint", { n: notesList.items.length + (notesList.nextCursor ? "+" : "") }) : t("notes.pick.hintEmpty")}
  </p>
  {#if session.canEdit}
    <Button variant="secondary" class="mt-5" href="/notes?new=1"><Plus />{t("notes.new")}</Button>
  {/if}
</section>
