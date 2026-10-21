<script lang="ts">
  import { Copy, FileInput, PenLine, Eye } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import { copyText } from "#lib/library/api.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import Textarea from "#lib/components/ui/Textarea.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import MarkdownView from "#lib/components/markdown/MarkdownView.svelte";

  /** Preview of AI-written Markdown; the user may edit it, then insert it into their notes (or copy it). */
  let { open = $bindable(false), markdown = $bindable(""), note, onInsert }: { open?: boolean; markdown?: string; note?: string; onInsert?: (md: string) => void } = $props();
  let editing = $state(false);
</script>

<Sheet bind:open title={t("library.ai.previewTitle")} description={t("library.ai.previewHint")} side="center">
  {#snippet children()}
    {#if note}<p class="mb-2 text-[12.5px] text-ink-3">{note}</p>{/if}
    <div class="mb-2 flex justify-end">
      <Button size="sm" variant="ghost" onclick={() => (editing = !editing)}>{#if editing}<Eye />{t("md.preview")}{:else}<PenLine />{t("md.edit")}{/if}</Button>
    </div>
    {#if editing}
      <Textarea bind:value={markdown} rows={12} label={t("library.ai.previewTitle")} class="[&_label]:sr-only" />
    {:else}
      <div class="rounded-2xl border border-line bg-surface-2/60 p-4"><MarkdownView source={markdown} fontSize={14} /></div>
    {/if}
  {/snippet}
  {#snippet footer()}
    <Button
      variant="ghost"
      onclick={async () => {
        if (await copyText(markdown)) toasts.show(t("library.detail.copied"), "success");
        else toasts.show(t("library.detail.copyFailed"), "error");
      }}><Copy />{t("library.ai.copy")}</Button
    >
    {#if onInsert}
      <Button
        variant="primary"
        onclick={() => {
          onInsert(markdown);
          open = false;
        }}><FileInput />{t("library.ai.insert")}</Button
      >
    {/if}
  {/snippet}
</Sheet>
