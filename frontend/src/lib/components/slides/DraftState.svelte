<script lang="ts">
  import { untrack } from "svelte";
  import { CircleAlert, FileCode2, FilePen, LoaderCircle, Send, Sparkles, TriangleAlert } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Pill from "#lib/components/ui/Pill.svelte";
  import Progress from "#lib/components/ui/Progress.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import PreviewPane from "#lib/components/slides/editor/PreviewPane.svelte";
  import { draftRunning, draftStageLabel } from "#lib/slides/draft.ts";
  import type { AiDraftJob, PreviewInfo } from "#lib/slides/types.ts";

  /**
   * Deck page for a deck with an in-app source but no version yet: instead of only 「還沒有發布的版本」 it shows the AI
   * draft job while it runs, then the draft's live preview (newest ready `slide_preview`), its page count and
   * 「編輯」/「發布為第 1 版」 with the speaker notes of the shown slide. Also the 「未發布的修改」 view of a deck that has a
   * published version (`banner` off: the page's own bar offers 發布新版本). Polls while the draft or the preview is in
   * progress; editors queue a preview when the source moved past the newest one (edits made in chat or elsewhere).
   */
  let { deckId, editUrl, canManage, hasVersions = false, revision = null, banner = true, onPublished }: {
    deckId: string;
    editUrl: string;
    canManage: boolean;
    /** Other versions exist (failed ones): the button then says 「發布新版本」. */
    hasVersions?: boolean;
    /** Current source revision: a preview older than it is shown as stale and re-rendered. */
    revision?: number | null;
    /** The status bar with 編輯／發布 (a failed or running AI draft is always shown). */
    banner?: boolean;
    onPublished?: () => void;
  } = $props();

  let job = $state<AiDraftJob | null>(null);
  let preview = $state<PreviewInfo | null>(null);
  let loaded = $state(false);
  let publishing = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function poll() {
    clearTimeout(timer);
    try {
      const [j, p] = await Promise.all([
        api.get<{ job: AiDraftJob | null }>(`/slides/${deckId}/ai/generate`),
        api.get<{ preview: PreviewInfo }>(`/slides/${deckId}/source/preview`),
      ]);
      const wasRunning = draftRunning(job);
      job = j.job;
      preview = p.preview;
      // The job may have published v1 itself: let the page reload into the player.
      if (wasRunning && !draftRunning(job) && job?.result?.publishedVersion) onPublished?.();
    } catch {
      // keep the last state; the next tick retries
    }
    loaded = true;
    await ensurePreview();
    const busy = draftRunning(job) || preview?.latest?.status === "queued" || preview?.latest?.status === "rendering";
    if (busy) timer = setTimeout(poll, document.hidden ? 6000 : 2000);
  }
  // A new source revision (an edit saved anywhere) re-reads the preview and queues a fresh one.
  $effect(() => {
    void deckId;
    void revision;
    untrack(() => void poll());
    return () => clearTimeout(timer);
  });

  // The source moved past the newest preview: editors queue one (the editor and the chat viewer do the same).
  let requested = 0;
  async function ensurePreview() {
    const rev = revision;
    if (!canManage || !rev || draftRunning(job) || requested >= rev) return;
    const latest = preview?.latest;
    if (latest && (latest.revision >= rev || latest.status === "queued" || latest.status === "rendering")) return;
    requested = rev;
    try {
      preview = (await api.post<{ preview: PreviewInfo }>(`/slides/${deckId}/source/preview`)).preview;
    } catch {
      // the editor offers a manual refresh; nothing to do here
    }
  }
  const stale = $derived(!!revision && !!preview?.ready && preview.ready.revision < revision);
  const running = $derived(draftRunning(job));
  const aiDone = $derived(job?.status === "succeeded" ? job.result : null);
  const failed = $derived(job?.status === "failed" ? job : null);
  const pages = $derived(aiDone?.pages ?? null);

  async function publish() {
    publishing = true;
    try {
      const r = await api.post<{ version: number }>(`/slides/${deckId}/source/publish`);
      toasts.show(t("slides.draft.published", { n: r.version }), "success");
      onPublished?.();
    } catch (e) {
      toasts.show((e as Error).message, "error");
    } finally {
      publishing = false;
    }
  }
</script>

<div class="flex flex-col gap-3">
  {#if running && job}
    <div class="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4 sm:flex-row sm:items-center">
      <span class="grid size-10 shrink-0 place-items-center rounded-xl" style="background:var(--pill-sky);color:var(--pill-sky-ink)"><LoaderCircle class="size-5 animate-spin motion-reduce:animate-none" /></span>
      <div class="min-w-0 flex-1">
        <p class="text-sm font-semibold text-ink">{t("slides.draft.running")}</p>
        <p class="mt-0.5 text-[12.5px] text-ink-3">{t("slides.draft.runningHint")}</p>
        <div class="mt-2">
          <div class="mb-1 flex justify-between text-[12px] text-ink-3"><span>{draftStageLabel(job.stage)}</span><span class="tabular-nums">{job.progress}%</span></div>
          <Progress value={job.progress || null} />
        </div>
      </div>
    </div>
  {:else if loaded && (banner || failed)}
    <div class="flex flex-col gap-3 rounded-2xl border p-4 sm:flex-row sm:items-center" style="border-color:var(--pill-butter-ink);background:var(--pill-butter)">
      <span class="hidden size-10 shrink-0 place-items-center rounded-xl bg-surface/70 sm:grid" style="color:var(--pill-butter-ink)">
        {#if failed}<CircleAlert class="size-5" />{:else if aiDone}<Sparkles class="size-5" />{:else}<FilePen class="size-5" />{/if}
      </span>
      <div class="min-w-0 flex-1" style="color:var(--pill-butter-ink)">
        <p class="flex flex-wrap items-center gap-2 text-sm font-semibold">
          {failed ? t("slides.draft.failed") : aiDone ? t("slides.draft.done") : t("slides.draft.unpublished")}
          {#if pages !== null}
            <Pill size="sm">{aiDone?.partial && aiDone.expectedPages ? t("slides.draft.pagesOf", { n: pages, total: aiDone.expectedPages }) : t("slides.draft.pages", { n: pages })}</Pill>
          {/if}
        </p>
        <p class="mt-0.5 text-[12.5px] leading-relaxed opacity-90">
          {#if failed}{failed.error}{:else if !canManage}{t("slides.edit.notPublishedViewer")}{:else if aiDone}{t("slides.draft.doneHint")}{:else}{t("slides.draft.unpublishedHint")}{/if}
        </p>
        {#if aiDone?.partial && aiDone.warning}
          <p class="mt-1.5 flex items-start gap-1.5 text-[12.5px] font-medium"><TriangleAlert class="mt-0.5 size-3.5 shrink-0" />{aiDone.warning}</p>
        {/if}
      </div>
      {#if canManage}
        <div class="flex shrink-0 flex-wrap gap-2">
          <Button size="sm" variant="secondary" href={editUrl}><FileCode2 />{t("slides.draft.edit")}</Button>
          <Button size="sm" variant="primary" loading={publishing} disabled={!preview?.ready} onclick={publish}><Send />{hasVersions ? t("slides.draft.publishNext") : t("slides.draft.publishFirst")}</Button>
        </div>
      {:else}
        <Button size="sm" variant="secondary" href={editUrl}><FileCode2 />{t("slides.edit.view")}</Button>
      {/if}
    </div>
  {/if}
  {#if loaded && (preview?.ready || preview?.latest)}
    <div class="rounded-[22px] border border-line/70 bg-surface p-3 shadow-card">
      <PreviewPane {preview} {stale} notes />
    </div>
  {:else if loaded && !running}
    <p class="px-1 text-[12.5px] text-ink-3">{t("slides.draft.noPreview")}</p>
  {/if}
</div>
