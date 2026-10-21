<script lang="ts">
  import { untrack } from "svelte";
  import { page } from "$app/state";
  import { ExternalLink } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import CompileBadge from "#lib/components/latex/CompileBadge.svelte";
  import PdfViewer from "#lib/components/latex/PdfViewer.svelte";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import Select from "#lib/components/ui/Select.svelte";
  import Spinner from "#lib/components/ui/Spinner.svelte";
  import { latexLanguage } from "#lib/latex/language.ts";
  import { isRunning, type ProjectDetail } from "#lib/latex/types.ts";
  import { viewer } from "#lib/agent/viewer.ts";
  import type { ViewerEntry } from "#lib/agent/viewer-state.svelte.ts";
  import LiveText from "./LiveText.svelte";
  import ViewerLink from "./ViewerLink.svelte";
  import { poll, whenPdfPage } from "./util.ts";

  /**
   * A LaTeX project: the newest compiled PDF (refreshes when a compile finishes — collab `latex_compiled`, or polling
   * while one runs) and a section file's live text with its pending suggestions.
   */
  let { entry }: { entry: ViewerEntry } = $props();
  const id = untrack(() => entry.ref.id);
  let detail = $state<ProjectDetail | null>(null);
  let error = $state<string | null>(null);
  let tab = $state<"pdf" | "source">(untrack(() => (entry.focus.fileId || entry.focus.suggestionId ? "source" : "pdf")));
  let fileId = $state<string | null>(untrack(() => entry.focus.fileId ?? null));
  let pdfHost = $state<HTMLElement | null>(null);
  let pdf = $state<PdfViewer | null>(null);

  async function load() {
    try {
      const next = await api.get<ProjectDetail>(`/latex/${id}`);
      const before = detail?.pdf_compile?.id;
      detail = next;
      viewer.setTitle(entry.ref, next.project.title);
      if (before && next.pdf_compile && next.pdf_compile.id !== before) viewer.markUpdated(entry.ref);
      fileId ??= next.root_file_id;
      error = null;
    } catch (e) {
      error = (e as Error).message;
    }
  }
  $effect(() => {
    void viewer.revisionOf(entry.ref);
    untrack(() => void load());
  });
  $effect(() => poll(async () => {
    await load();
    return isRunning(detail?.latest_compile?.status) ? 4000 : 30_000;
  }, 6000));

  // Text files in the editor's tab order: the root, the sections in \input order, then the rest.
  const files = $derived.by(() => {
    if (!detail) return [];
    const text = detail.files.filter((f) => f.kind === "text");
    const order = new Map<string, number>();
    if (detail.root_file_id) order.set(detail.root_file_id, -1);
    detail.sections.forEach((s, i) => s.file_id && order.set(s.file_id, i));
    return [...text].sort((a, b) => (order.get(a.id) ?? 1e6) - (order.get(b.id) ?? 1e6) || a.path.localeCompare(b.path));
  });
  const options = $derived(files.map((f) => ({ value: f.id, label: f.title ? `${f.title}` : f.path, hint: f.title ? f.path : undefined })));
  const file = $derived(files.find((f) => f.id === fileId) ?? null);
  const onPage = $derived(page.url.pathname.includes(`/latex/${id}`));
  const editorUrl = $derived(detail ? `/studies/${encodeURIComponent(detail.study.slug)}/latex/${id}${fileId ? `?file=${fileId}` : ""}` : null);

  // Focus: a file / suggestion → source tab; a page → the PDF at that page.
  let lastNonce = -1;
  $effect(() => {
    const e = entry;
    untrack(() => {
      if (e.nonce === lastNonce) return;
      lastNonce = e.nonce;
      if (e.focus.fileId) fileId = e.focus.fileId;
      if (e.focus.fileId || e.focus.suggestionId) tab = "source";
      if (e.focus.page) {
        tab = "pdf";
        const n = e.focus.page;
        void whenPdfPage(pdfHost, n).then((ok) => ok && pdf?.reveal([{ page: n, x: 0, y: 0, width: 0, height: 0 }]));
      }
    });
  });
</script>

{#if error && !detail}
  <p class="m-4 rounded-2xl bg-danger-soft p-4 text-[13px] text-danger" role="alert">{error}</p>
{:else if !detail}
  <div class="grid h-full place-items-center"><Spinner class="size-5 text-ink-3" /></div>
{:else}
  <div class="flex h-full min-h-0 flex-col">
    <div class="flex shrink-0 flex-wrap items-center gap-2 px-3 pt-3 pb-2">
      <Segmented guardIgnore bind:value={tab} label={t("viewer.latex.view")} options={[{ value: "pdf", label: "PDF" }, { value: "source", label: t("viewer.latex.source") }]} />
      <CompileBadge status={detail.latest_compile?.status ?? null} />
      <span class="min-w-0 flex-1"></span>
      {#if editorUrl}<ViewerLink href={editorUrl} icon={ExternalLink} label={t("viewer.latex.open")} />{/if}
    </div>
    {#if tab === "source" && options.length > 1}
      <div class="shrink-0 px-3 pb-2"><Select bind:value={fileId as string} {options} label={t("viewer.latex.file")} /></div>
    {/if}
    <div class="relative min-h-0 flex-1 border-t border-line">
      <div bind:this={pdfHost} class="h-full {tab === 'pdf' ? 'flex flex-col' : 'hidden'}">
        <PdfViewer bind:this={pdf} url={detail.pdf_compile?.pdf_url ?? null} class="min-h-0 flex-1" />
      </div>
      {#if onPage}
        {#if tab === "source"}<p class="m-4 rounded-xl bg-surface-2 px-3 py-2 text-[12.5px] text-ink-3">{t("viewer.onPage")}</p>{/if}
      {:else if file}
        <div class="h-full {tab === 'source' ? '' : 'hidden'}">
          {#key file.id}
            <LiveText
              docName={`latex:${id}:${file.id}`}
              targetType="latex_file"
              targetId={file.id}
              {entry}
              artifact={entry.ref}
              language={latexLanguage}
              label={file.path}
              onMessage={(m) => (m.type === "latex_compiled" || m.type === "latex_meta") && void load()}
            />
          {/key}
        </div>
      {/if}
    </div>
  </div>
{/if}
