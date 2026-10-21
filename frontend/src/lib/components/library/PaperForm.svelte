<script lang="ts" module>
  import type { PaperRecord } from "#lib/library/types.ts";
  /** Editable string view of a record (the form works on text; `toRecord` converts back). */
  export type PaperDraft = {
    type: PaperRecord["type"]; title: string; authors: string; year: string; containerTitle: string; venue: string;
    volume: string; issue: string; pages: string; publisher: string; doi: string; arxivId: string; url: string; abstract: string;
  };
</script>

<script lang="ts">
  import { t } from "#lib/i18n.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import { PAPER_TYPES } from "#lib/library/types.ts";
  import Select from "#lib/components/ui/Select.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";
  import Textarea from "#lib/components/ui/Textarea.svelte";

  let { draft = $bindable(), errors = {} }: { draft: PaperDraft; errors?: Partial<Record<keyof PaperDraft, string>> } = $props();
  const typeOptions = PAPER_TYPES.map(value => ({ value, label: t(`library.type.${value}` as MessageKey) }));
</script>

<div class="flex flex-col gap-3.5">
  <div class="flex flex-col gap-1.5">
    <span class="text-[13px] font-medium text-ink-2">{t("library.form.type")}</span>
    <Select bind:value={draft.type} label={t("library.form.type")} options={typeOptions} class="w-full" />
  </div>
  <Textarea bind:value={draft.title} label={t("library.form.title")} rows={2} error={errors.title} />
  <Textarea bind:value={draft.authors} label={t("library.form.authors")} hint={t("library.form.authorsHint")} rows={3} />
  <div class="grid grid-cols-2 gap-3">
    <TextField bind:value={draft.year} label={t("library.form.year")} inputmode="numeric" maxlength={4} error={errors.year} />
    <TextField bind:value={draft.venue} label={t("library.form.venue")} placeholder={t("library.form.venueHint")} />
  </div>
  <TextField bind:value={draft.containerTitle} label={t("library.form.container")} />
  <div class="grid grid-cols-3 gap-3">
    <TextField bind:value={draft.volume} label={t("library.form.volume")} />
    <TextField bind:value={draft.issue} label={t("library.form.issue")} />
    <TextField bind:value={draft.pages} label={t("library.form.pages")} />
  </div>
  <TextField bind:value={draft.publisher} label={t("library.form.publisher")} />
  <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
    <TextField bind:value={draft.doi} label={t("library.form.doi")} placeholder="10.xxxx/…" />
    <TextField bind:value={draft.arxivId} label={t("library.form.arxiv")} placeholder="2005.08100" />
  </div>
  <TextField bind:value={draft.url} label={t("library.form.url")} type="url" placeholder="https://" error={errors.url} />
  <Textarea bind:value={draft.abstract} label={t("library.form.abstract")} rows={5} />
</div>
