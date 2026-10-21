<script lang="ts">
  import { Link } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";

  /**
   * 「從網址下載」: a PDF link or a landing page (arXiv abs, ACL Anthology, OpenReview, DOI). `onDownload` calls the API
   * and resolves to an error message (shown under the field) or null on success.
   */
  let { onDownload, disabled = false, autofocus = false }: { onDownload: (url: string) => Promise<string | null>; disabled?: boolean; autofocus?: boolean } = $props();
  let url = $state("");
  let busy = $state(false);
  let error = $state<string | null>(null);
  let ref = $state<HTMLInputElement | null>(null);
  $effect(() => {
    if (autofocus) ref?.focus();
  });

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    const value = url.trim();
    if (!/^https?:\/\/\S+$/i.test(value)) {
      error = t("library.pdfUrl.invalid");
      return;
    }
    busy = true;
    error = null;
    try {
      error = await onDownload(value);
      if (!error) url = "";
    } finally {
      busy = false;
    }
  }
</script>

<form class="flex flex-col gap-2 sm:flex-row sm:items-start" onsubmit={submit} novalidate>
  <TextField
    bind:value={url}
    bind:ref
    type="url"
    inputmode="url"
    label={t("library.pdfUrl.label")}
    placeholder="https://arxiv.org/abs/2301.00001"
    hint={busy ? t("library.pdfUrl.downloading") : t("library.pdfUrl.hint")}
    {error}
    autocomplete="off"
    spellcheck={false}
    disabled={busy || disabled}
    class="min-w-0 flex-1"
  />
  <Button type="submit" loading={busy} disabled={disabled || !url.trim()} class="sm:mt-[26px]"><Link />{t("library.pdfUrl.submit")}</Button>
</form>
