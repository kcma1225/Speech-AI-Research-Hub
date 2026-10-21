<script lang="ts">
  import { goto } from "$app/navigation";
  import { Check, FilePlus2, Trash2 } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { todayTaipei } from "#lib/dates.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import ConfirmDialog from "#lib/components/ui/ConfirmDialog.svelte";
  import DatePicker from "#lib/components/ui/DatePicker.svelte";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import { kindIcon, templateDescription, templateName, type Note, type NoteTemplate } from "./types.ts";

  /** Template picker + title/date, then opens the new note. */
  let { open = $bindable(false), studySlug, templates, onTemplatesChanged }: { open?: boolean; studySlug: string; templates: NoteTemplate[]; onTemplatesChanged?: () => void } = $props();

  let templateId = $state<string | null>(null);
  let title = $state("");
  let date = $state(todayTaipei());
  let saving = $state(false);
  const chosen = $derived(templates.find(x => x.id === templateId) ?? null);
  const system = $derived(templates.filter(x => x.scope === "system"));
  const mine = $derived(templates.filter(x => x.scope === "user"));

  $effect(() => {
    if (open) {
      templateId = system[0]?.id ?? null;
      title = "";
      date = todayTaipei();
    }
  });

  let removing = $state<NoteTemplate | null>(null);
  let confirmRemove = $state(false);
  async function removeTemplate() {
    const tpl = removing;
    if (!tpl) return;
    try {
      await api.del(`/note-templates/${tpl.id}`);
      if (templateId === tpl.id) templateId = system[0]?.id ?? null;
      toasts.show(t("notes.template.deleted"), "success");
      onTemplatesChanged?.();
    } catch (e) {
      toasts.show((e as Error).message, "error");
    }
  }

  async function create() {
    saving = true;
    try {
      const r = await api.post<{ note: Note; url: string }>(`/studies/${encodeURIComponent(studySlug)}/notes`, {
        template_id: templateId,
        event_date: date || null,
        ...(title.trim() ? { title: title.trim() } : {}),
      });
      open = false;
      await goto(r.url);
    } catch (e) {
      toasts.show((e as Error).message, "error");
    } finally {
      saving = false;
    }
  }
</script>

{#snippet option(tpl: NoteTemplate | null)}
  {@const Icon = tpl ? kindIcon[tpl.kind] : FilePlus2}
  {@const active = (tpl?.id ?? null) === templateId}
  <div class="relative">
  <button
    type="button"
    role="radio"
    aria-checked={active}
    class="relative flex h-full min-h-[72px] w-full items-start gap-3 rounded-2xl border p-3 text-left transition-[border-color,background-color] {active ? 'border-ink bg-surface-2' : 'border-line hover:border-line-2 hover:bg-surface-2/60'}"
    onclick={() => (templateId = tpl?.id ?? null)}
  >
    <span class="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-3 text-ink-2"><Icon class="size-4.5" /></span>
    <span class="min-w-0 flex-1">
      <span class="block text-[14px] font-semibold text-ink">{tpl ? templateName(tpl.name, tpl.scope) : t("notes.blank")}</span>
      <span class="mt-0.5 block text-[12.5px] leading-snug text-ink-3">{tpl ? templateDescription(tpl) || t("notes.customTemplate") : t("notes.blankHint")}</span>
    </span>
    {#if active}<Check class="absolute top-3 right-3 size-4 text-ink" />{/if}
  </button>
  {#if tpl?.scope === "user"}
    <button
      type="button"
      class="absolute right-1.5 bottom-1.5 grid size-10 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-danger"
      aria-label={t("notes.template.delete", { name: tpl.name })}
      onclick={() => ((removing = tpl), (confirmRemove = true))}><Trash2 class="size-4" /></button
    >
  {/if}
  </div>
{/snippet}

<Sheet bind:open title={t("notes.new")} description={t("notes.newHint")} side="center">
  <div class="flex flex-col gap-4 pt-1">
    <div role="radiogroup" aria-label={t("notes.template")} class="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {#each system as tpl (tpl.id)}{@render option(tpl)}{/each}
      {#each mine as tpl (tpl.id)}{@render option(tpl)}{/each}
      {@render option(null)}
    </div>
    <TextField label={t("notes.titleLabel")} bind:value={title} placeholder={`${chosen?.name ?? t("notes.note")} ${date || todayTaipei()}`} maxlength={200} />
    <div class="flex flex-col gap-1.5">
      <span class="text-[13px] font-medium text-ink-2">{t("notes.date")}</span>
      <DatePicker label={t("notes.date")} bind:value={date} clearable />
    </div>
  </div>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>{t("notes.cancel")}</Button>
    <Button variant="primary" loading={saving} onclick={create}>{t("notes.create")}</Button>
  {/snippet}
</Sheet>

<ConfirmDialog bind:open={confirmRemove} title={t("notes.template.deleteTitle", { name: removing?.name ?? "" })} description={t("notes.template.deleteBody")} confirmLabel={t("notes.template.deleteAction")} onConfirm={removeTemplate} />
