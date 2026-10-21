<script lang="ts">
  import { EyeOff, ScanEye } from "@lucide/svelte";
  import { aiApi, toErrorBody, type AiErrorBody } from "#lib/ai/admin.ts";
  import { aiStatus } from "#lib/ai/status.svelte.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import { openPdf, type OpenPdf } from "#lib/latex/pdf.ts";
  import type { SyncClient } from "#lib/latex/sync-client.ts";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import Spinner from "#lib/components/ui/Spinner.svelte";
  import AiErrorPanel from "#lib/components/ai/AiErrorPanel.svelte";
  import ReviewResults, { type LayoutReview, type ReviewIssue } from "./ReviewResults.svelte";

  /**
   * 「AI 檢查排版」 of the LaTeX editor (role `writing` with vision): renders up to 6 pages of the PDF on screen with
   * pdf.js (≈1600 px JPEG), maps each page to source lines with SyncTeX and asks the AI to review them. Fixes become
   * `latex_file` suggestions (open editors pick them up through the collab "suggestions" message).
   */
  let {
    projectId,
    compile,
    sync,
    currentPage = () => 1,
    onReveal,
    compact = false,
  }: {
    projectId: string;
    compile: { id: string; pdf_url: string | null; synctex_url: string | null } | null;
    sync: SyncClient;
    currentPage?: () => number;
    onReveal?: (path: string, line: number) => void;
    compact?: boolean;
  } = $props();

  const MAX = 6;
  const WIDTH = 1600;
  $effect(() => aiStatus.watch());
  const vision = $derived(aiStatus.vision("writing"));

  let open = $state(false);
  let doc: OpenPdf | null = null;
  let docKey: string | null = null;
  let pageCount = $state(0);
  let selected = $state<number[]>([]);
  let review = $state<LayoutReview | null>(null);
  let images = $state<Record<number, string>>({});
  let error = $state<AiErrorBody | null>(null);
  let phase = $state<"idle" | "loading" | "rendering" | "reviewing">("idle");

  async function show() {
    open = true;
    error = null;
    if (!compile?.pdf_url) return;
    if (docKey !== compile.id) {
      phase = "loading";
      try {
        void doc?.close();
        doc = await openPdf(compile.pdf_url);
        docKey = compile.id;
        pageCount = doc.numPages;
        review = null;
        images = {};
      } catch {
        error = { error: t("common.error") };
        return;
      } finally {
        phase = "idle";
      }
    }
    const cur = Math.min(Math.max(currentPage(), 1), pageCount);
    if (!selected.length || selected.some(n => n > pageCount)) selected = Array.from({ length: Math.min(3, pageCount - cur + 1) }, (_, i) => cur + i);
  }
  $effect(() => () => void doc?.close());

  function toggle(n: number) {
    if (selected.includes(n)) selected = selected.filter(x => x !== n);
    else if (selected.length < MAX) selected = [...selected, n].sort((a, b) => a - b);
    else toasts.show(t("vision.pagesHint", { max: MAX }));
  }

  async function renderPage(n: number): Promise<string> {
    const page = await doc!.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(4, WIDTH / base.width) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, canvas }).promise;
    const url = canvas.toDataURL("image/jpeg", 0.85);
    page.cleanup();
    return url;
  }

  async function run() {
    if (!doc || !compile || !selected.length) return;
    error = null;
    phase = "rendering";
    try {
      const pages = [];
      const rendered: Record<number, string> = {};
      for (const n of selected) {
        rendered[n] = await renderPage(n);
        const sources = compile.synctex_url ? await sync.pageSources(n).catch(() => []) : [];
        pages.push({ page: n, image: rendered[n], sources });
      }
      images = rendered;
      phase = "reviewing";
      review = (await aiApi.post<{ review: LayoutReview }>(`/latex/${projectId}/ai/layout-review`, { compile_id: compile.id, pages })).review;
    } catch (e) {
      error = toErrorBody(e);
    } finally {
      phase = "idle";
    }
  }

  async function suggest(issue: ReviewIssue) {
    if (!issue.fix) return;
    try {
      await aiApi.post(`/latex/${projectId}/ai/layout-review/suggest`, { file_id: issue.fix.file_id, find: issue.fix.find, replace: issue.fix.replace, title: issue.title });
      toasts.show(t("vision.suggested"), "success");
    } catch (e) {
      toasts.show(toErrorBody(e).error, "error");
      throw e;
    }
  }
  const goto = (issue: ReviewIssue) => {
    if (!issue.path) return;
    open = false;
    onReveal?.(issue.path, issue.line ?? 1);
  };
</script>

{#if vision}
  <Button variant="secondary" size={compact ? "icon" : "sm"} class={compact ? "" : "h-10 lg:h-8"} aria-label={t("vision.latex.button")} title={t("vision.latex.button")} onclick={show}>
    <ScanEye />{#if !compact}{t("vision.latex.button")}{/if}
  </Button>
{:else if aiStatus.available("writing")}
  <span class="hidden h-8 items-center gap-1.5 rounded-full border border-dashed border-line-2 px-3 text-[12px] text-ink-3 xl:inline-flex" title={t("vision.unsupported")}>
    <EyeOff class="size-3.5" aria-hidden="true" />{t("vision.unsupported")}
  </span>
{/if}

<Sheet bind:open guard={false} title={t("vision.latex.title")} description={t("vision.latex.desc")} side="right">
  <div class="flex flex-col gap-4">
    {#if !compile?.pdf_url}
      <p class="rounded-2xl border border-dashed border-line-2 p-4 text-center text-[13px] text-ink-3">{t("vision.noPdf")}</p>
    {:else if phase === "loading"}
      <p class="flex items-center gap-2 text-[13px] text-ink-3"><Spinner class="size-4" />{t("common.loading")}</p>
    {:else}
      <fieldset class="flex flex-col gap-2">
        <legend class="mb-1 flex w-full items-baseline justify-between gap-2 text-[13px] font-medium text-ink-2">
          {t("vision.pages")}<span class="text-[12px] font-normal text-ink-3">{t("vision.selectedN", { n: selected.length })}</span>
        </legend>
        <p class="text-[12px] text-ink-3">{t("vision.pagesHint", { max: MAX })}</p>
        <div class="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
          {#each Array.from({ length: pageCount }, (_, i) => i + 1) as n (n)}
            <button
              type="button"
              class="h-10 min-w-10 rounded-xl border px-2 text-[13px] font-medium tabular-nums transition-colors {selected.includes(n) ? 'border-ink bg-ink text-surface' : 'border-line text-ink-2 hover:bg-surface-3'}"
              aria-pressed={selected.includes(n)}
              aria-label={t("vision.pageN", { n })}
              onclick={() => toggle(n)}>{n}</button
            >
          {/each}
        </div>
      </fieldset>
      {#if error}<AiErrorPanel {error} compact />{/if}
      <Button variant="primary" size="lg" class="w-full" loading={phase !== "idle"} disabled={!selected.length} onclick={run}>
        <ScanEye />{review ? t("vision.rerun") : t("vision.run")}
      </Button>
      {#if phase === "rendering"}<p class="text-center text-[12.5px] text-ink-3" aria-live="polite">{t("vision.rendering")}</p>{/if}
      {#if phase === "reviewing"}<p class="text-center text-[12.5px] text-ink-3" aria-live="polite">{t("vision.running", { n: selected.length })}</p>{/if}
      {#if review && phase === "idle"}
        <ReviewResults {review} onSuggest={suggest} onGoto={onReveal ? goto : undefined} thumb={n => images[n] ?? null} />
      {/if}
    {/if}
  </div>
</Sheet>
