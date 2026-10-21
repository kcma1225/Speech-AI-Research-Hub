<script lang="ts">
  import { untrack } from "svelte";
  import { ExternalLink } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import PdfViewer from "#lib/components/latex/PdfViewer.svelte";
  import MarkdownView from "#lib/components/markdown/MarkdownView.svelte";
  import Spinner from "#lib/components/ui/Spinner.svelte";
  import type { PaperDetail } from "#lib/library/types.ts";
  import { viewer } from "#lib/agent/viewer.ts";
  import type { ViewerEntry } from "#lib/agent/viewer-state.svelte.ts";
  import ViewerLink from "./ViewerLink.svelte";
  import { whenPdfPage } from "./util.ts";

  /**
   * A library paper: its newest PDF through the Range route (pdf.js, lazy pages), opened at the page the assistant
   * cited (`[p. 5]` chips → focus.page). Without a PDF: the abstract.
   */
  let { entry }: { entry: ViewerEntry } = $props();
  const id = untrack(() => entry.ref.id);
  let paper = $state<PaperDetail | null>(null);
  let error = $state<string | null>(null);
  let host = $state<HTMLElement | null>(null);
  let pdf = $state<PdfViewer | null>(null);

  async function load() {
    try {
      paper = (await api.get<{ paper: PaperDetail }>(`/library/papers/${id}`)).paper;
      viewer.setTitle(entry.ref, paper.title);
      error = null;
    } catch (e) {
      error = (e as Error).message;
    }
  }
  $effect(() => {
    void viewer.revisionOf(entry.ref);
    untrack(() => void load());
  });

  let lastNonce = -1;
  $effect(() => {
    const e = entry;
    const ready = !!paper?.has_pdf && !!pdf;
    untrack(() => {
      if (!ready || e.nonce === lastNonce) return;
      lastNonce = e.nonce;
      const n = e.focus.page;
      if (n) void whenPdfPage(host, n).then((ok) => ok && pdf?.reveal([{ page: n, x: 0, y: 0, width: 0, height: 0 }]));
    });
  });
  const authors = $derived((paper?.authors ?? []).map((a) => a.literal ?? a.family ?? "").filter(Boolean).slice(0, 4).join(", "));
</script>

{#if error && !paper}
  <p class="m-4 rounded-2xl bg-danger-soft p-4 text-[13px] text-danger" role="alert">{error}</p>
{:else if !paper}
  <div class="grid h-full place-items-center"><Spinner class="size-5 text-ink-3" /></div>
{:else}
  <div class="flex h-full min-h-0 flex-col">
    <div class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-3 pb-2 text-[12px] text-ink-3">
      <span class="min-w-0 truncate">{[authors, paper.year, paper.venue].filter(Boolean).join(" · ")}</span>
      <span class="min-w-0 flex-1"></span>
      <ViewerLink href={`/library?paper=${id}`} icon={ExternalLink} label={t("viewer.paper.open")} />
    </div>
    <div bind:this={host} class="flex min-h-0 flex-1 flex-col border-t border-line">
      {#if paper.has_pdf}
        <PdfViewer bind:this={pdf} url={`/api/library/papers/${id}/pdf`} class="min-h-0 flex-1" />
      {:else}
        <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <p class="mb-3 rounded-xl bg-surface-2 px-3 py-2 text-[12.5px] text-ink-3">{t("viewer.paper.noPdf")}</p>
          {#if paper.abstract}<MarkdownView source={paper.abstract} fontSize={14} />{/if}
        </div>
      {/if}
    </div>
  </div>
{/if}
