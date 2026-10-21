<script lang="ts">
  import { untrack } from "svelte";
  import { Download } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import MarkdownView from "#lib/components/markdown/MarkdownView.svelte";
  import Spinner from "#lib/components/ui/Spinner.svelte";
  import { viewer } from "#lib/agent/viewer.ts";
  import type { ViewerEntry } from "#lib/agent/viewer-state.svelte.ts";

  /**
   * A file uploaded into the conversation (owner only): images inline; documents as the Markdown the server extracted
   * (what the assistant read), with the original file as a download.
   */
  let { entry }: { entry: ViewerEntry } = $props();
  const id = untrack(() => entry.ref.id);
  type UploadText = { upload: { id: string; title: string; upload_kind: "document" | "image"; format: string; mime: string; bytes: number; chars: number; truncated: boolean; pages: number | null; warnings: string[]; url: string }; text_md: string };
  let data = $state<UploadText | null>(null);
  let error = $state<string | null>(null);

  $effect(() => {
    void viewer.revisionOf(entry.ref);
    untrack(async () => {
      try {
        data = await api.get<UploadText>(`/agent/uploads/${id}/text`);
        viewer.setTitle(entry.ref, data.upload.title);
        error = null;
      } catch (e) {
        error = (e as Error).message;
      }
    });
  });
  const fileUrl = `/api/agent/uploads/${id}`;
  const size = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
</script>

{#if error && !data}
  <div class="m-4 flex flex-col items-start gap-3 rounded-2xl bg-surface-2 p-4 text-[13px] text-ink-2" role="status">
    <p>{t("viewer.upload.unavailable")}</p>
    <a class="inline-flex min-h-10 items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 font-medium text-ink" href={fileUrl} target="_blank" rel="noopener"><Download class="size-4" />{t("viewer.upload.download")}</a>
  </div>
{:else if !data}
  <div class="grid h-full place-items-center"><Spinner class="size-5 text-ink-3" /></div>
{:else}
  <div class="flex h-full min-h-0 flex-col">
    <div class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-3 pb-2 text-[12px] text-ink-3">
      <span>{data.upload.format.toUpperCase()} · {size(data.upload.bytes)}{#if data.upload.pages} · {t("viewer.upload.pages", { n: data.upload.pages })}{/if}</span>
      <span class="min-w-0 flex-1"></span>
      <a class="inline-flex min-h-10 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-[12.5px] font-medium text-ink hover:border-line-2" href={fileUrl} target="_blank" rel="noopener"><Download class="size-3.5 text-ink-3" />{t("viewer.upload.download")}</a>
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto border-t border-line px-5 py-4">
      {#if data.upload.upload_kind === "image"}
        <img src={fileUrl} alt={data.upload.title} class="mx-auto max-h-full max-w-full rounded-xl border border-line object-contain" />
      {:else}
        {#if data.upload.truncated}<p class="mb-3 rounded-xl bg-surface-2 px-3 py-2 text-[12.5px] text-ink-3">{t("viewer.upload.truncated")}</p>{/if}
        <MarkdownView source={data.text_md} fontSize={14} />
      {/if}
    </div>
  </div>
{/if}
