<script lang="ts">
  import { goto } from "$app/navigation";
  import { api } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import { notesList } from "#lib/notes/list.svelte.ts";
  import { todayTaipei } from "#lib/notes/types.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import DatePicker from "./DatePicker.svelte";
  import NoteTags from "./NoteTags.svelte";

  let { open = $bindable(false) }: { open?: boolean } = $props();
  let title = $state("");
  let eventDate = $state(todayTaipei());
  let tagIds = $state<string[]>([]);
  let busy = $state(false);
  let error = $state<string | null>(null);

  $effect(() => {
    if (open) {
      title = "";
      eventDate = todayTaipei();
      tagIds = [];
      error = null;
    }
  });

  async function create(event?: SubmitEvent) {
    event?.preventDefault();
    if (!title.trim()) {
      error = t("notes.titleRequired");
      return;
    }
    busy = true;
    try {
      const { id } = await api.post<{ id: string }>("/items", { title: title.trim(), event_date: eventDate, tagIds });
      open = false;
      void notesList.reload();
      await goto(`/notes/${id}?edit=1`);
    } catch (e) {
      toasts.show((e as Error).message, "error");
    } finally {
      busy = false;
    }
  }
</script>

<Sheet bind:open title={t("notes.new")} description={t("notes.new.hint")} side="center">
  <form id="new-note" class="flex flex-col gap-4 pt-2" onsubmit={create}>
    <TextField label={t("notes.field.title")} bind:value={title} error={error} maxlength={200} placeholder={t("notes.field.titlePlaceholder")} autofocus oninput={() => (error = null)} />
    <div class="flex flex-col gap-1.5">
      <span class="text-[13px] font-medium text-ink-2">{t("notes.field.date")}</span>
      <DatePicker bind:value={eventDate} label={t("notes.field.date")} class="w-fit" />
    </div>
    <div class="flex flex-col gap-1.5">
      <span class="text-[13px] font-medium text-ink-2">{t("notes.field.tags")}</span>
      <NoteTags bind:selected={tagIds} editable />
    </div>
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>{t("action.cancel")}</Button>
    <Button variant="primary" type="submit" form="new-note" loading={busy}>{t("notes.create")}</Button>
  {/snippet}
</Sheet>
