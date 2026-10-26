<script lang="ts">
  import { untrack } from "svelte";
  import { CircleAlert, Expand, LoaderCircle, LocateFixed, NotebookText, Presentation, RefreshCw } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Progress from "#lib/components/ui/Progress.svelte";
  import type { PreviewInfo } from "#lib/slides/types.ts";
  import { sanitizeNotes } from "#lib/slides/pages.ts";
  import { renderLog } from "#lib/slides/util.ts";

  /**
   * Live preview of the source tree: the newest ready quick render in the sandboxed deck iframe (opaque origin, path
   * capability URL), with the status of the render in progress. `slide` (the slide under the editor cursor) is shown
   * after every reload and, with 「跟隨游標」 on, whenever it changes. `notes`: a toggleable panel under the preview with
   * the speaker notes of the slide shown (asked from the deck with Reveal's `getSlideNotes`, sanitised like the player's).
   */
  let { preview, slide = 0, stale = false, canRefresh = false, notes: withNotes = false, onRefresh }: {
    preview: PreviewInfo | null;
    slide?: number;
    /** The editor has changes newer than the shown render. */
    stale?: boolean;
    canRefresh?: boolean;
    /** Offer the speaker-notes panel. */
    notes?: boolean;
    onRefresh?: () => void;
  } = $props();

  let frame = $state<HTMLIFrameElement | null>(null);
  let wrap = $state<HTMLElement | null>(null);
  let follow = $state(readFollow());
  let showLog = $state(false);
  let showNotes = $state(readFlag("hub-preview-notes", true));
  /** Notes of the slide shown: undefined until the deck answered. */
  let slideNotes = $state<string | null | undefined>(undefined);
  function readFlag(key: string, fallback: boolean) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : v !== "0";
    } catch {
      return fallback;
    }
  }
  function readFollow() {
    return readFlag("hub-quarto-follow", true);
  }
  $effect(() => {
    try {
      localStorage.setItem("hub-preview-notes", showNotes ? "1" : "0");
    } catch {}
  });
  $effect(() => {
    try {
      localStorage.setItem("hub-quarto-follow", follow ? "1" : "0");
    } catch {}
  });

  const ready = $derived(preview?.ready ?? null);
  $effect(() => {
    void ready?.id;
    slideNotes = undefined;
  });
  const latest = $derived(preview?.latest ?? null);
  const busy = $derived(latest?.status === "queued" || latest?.status === "rendering");
  const failed = $derived(latest?.status === "failed" ? latest : null);
  // The newest failure is only relevant while it is newer than the shown render.
  const showFailure = $derived(Boolean(failed && (!ready || failed.revision > ready.revision)));

  function go(index: number) {
    frame?.contentWindow?.postMessage(JSON.stringify({ method: "slide", args: [index, 0] }), "*");
  }
  const askNotes = () => frame?.contentWindow?.postMessage(JSON.stringify({ method: "getSlideNotes", args: [] }), "*");
  // Reveal posts its events as JSON strings; only messages from our iframe count (its origin is opaque).
  $effect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!frame || event.source !== frame.contentWindow || typeof event.data !== "string" || event.data.length > 250_000) return;
      let data: { namespace?: string; eventName?: string; method?: string; result?: unknown } | null = null;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      if (data?.namespace !== "reveal") return;
      if (data.eventName === "ready") untrack(() => go(slide));
      // The deck is user-authored: its notes are sanitised before they are shown.
      if (data.eventName === "callback" && data.method === "getSlideNotes") slideNotes = sanitizeNotes(data.result);
      else if (withNotes && (data.eventName === "ready" || data.eventName === "slidechanged")) askNotes();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  });
  $effect(() => {
    const index = slide;
    if (!untrack(() => follow)) return;
    const timer = setTimeout(() => go(index), 250);
    return () => clearTimeout(timer);
  });

  async function fullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await wrap?.requestFullscreen();
      frame?.focus();
    } catch {}
  }
</script>

<div class="flex min-h-0 flex-col gap-2.5">
  <div class="flex flex-wrap items-center gap-2">
    <div class="flex min-w-0 flex-1 items-center gap-2 text-[12.5px] text-ink-3" aria-live="polite">
      {#if busy}
        <LoaderCircle class="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
        <span class="truncate">{latest?.status === "rendering" ? t("slides.editor.preview.rendering", { pct: latest.progress }) : t("slides.editor.preview.queued")}</span>
      {:else if showFailure}
        <CircleAlert class="size-3.5 shrink-0 text-danger" /><span class="truncate text-danger">{t("slides.editor.preview.failed")}</span>
      {:else if stale}
        <span class="size-2 shrink-0 rounded-full bg-[var(--pill-butter-ink)]"></span><span class="truncate">{t("slides.editor.preview.stale")}</span>
      {:else if ready}
        <span class="size-2 shrink-0 rounded-full bg-success"></span><span class="truncate">{t("slides.editor.preview.upToDate")}</span>
      {/if}
    </div>
    {#if withNotes}
      <Button size="icon-sm" variant={showNotes ? "secondary" : "ghost"} aria-pressed={showNotes} title={t("slides.player.notes")} aria-label={t("slides.player.notes")} onclick={() => (showNotes = !showNotes)}><NotebookText /></Button>
    {/if}
    <Button size="icon-sm" variant={follow ? "secondary" : "ghost"} aria-pressed={follow} title={t("slides.editor.preview.follow")} aria-label={t("slides.editor.preview.follow")} onclick={() => ((follow = !follow), follow && go(slide))}><LocateFixed /></Button>
    {#if canRefresh}
      <Button size="icon-sm" variant="ghost" title={t("slides.editor.preview.refresh")} aria-label={t("slides.editor.preview.refresh")} disabled={busy} onclick={onRefresh}><RefreshCw /></Button>
    {/if}
    <Button size="icon-sm" variant="ghost" title={t("slides.fullscreen")} aria-label={t("slides.fullscreen")} disabled={!ready} onclick={fullscreen}><Expand /></Button>
  </div>

  <div bind:this={wrap} class="relative aspect-[16/10] w-full overflow-hidden rounded-2xl border border-line bg-surface-2 [&:fullscreen]:rounded-none [&:fullscreen]:border-0 [&:fullscreen]:bg-black">
    {#if ready}
      {#key ready.id}
        <iframe
          bind:this={frame}
          src={ready.viewUrl}
          title={t("slides.editor.preview.title")}
          sandbox="allow-scripts allow-pointer-lock allow-presentation"
          allow="fullscreen"
          referrerpolicy="no-referrer"
          class="size-full border-0 bg-white"
        ></iframe>
      {/key}
      {#if busy}
        <div class="pointer-events-none absolute inset-x-0 top-0"><Progress value={latest?.progress || null} class="h-1 rounded-none" /></div>
      {/if}
    {:else}
      <div class="grid size-full place-items-center p-6 text-center">
        <div class="flex max-w-xs flex-col items-center gap-3">
          {#if busy}
            <span class="grid size-11 place-items-center rounded-2xl" style="background:var(--pill-sky);color:var(--pill-sky-ink)"><LoaderCircle class="size-5 animate-spin motion-reduce:animate-none" /></span>
            <p class="text-sm font-medium">{t("slides.editor.preview.first")}</p>
            <div class="w-48"><Progress value={latest?.progress || null} /></div>
          {:else}
            <span class="grid size-11 place-items-center rounded-2xl bg-surface-3 text-ink-3"><Presentation class="size-5" /></span>
            <p class="text-[13px] text-ink-3">{showFailure ? t("slides.editor.preview.failedHint") : t("slides.editor.preview.none")}</p>
            {#if canRefresh && !showFailure}<Button size="sm" variant="secondary" onclick={onRefresh}><RefreshCw />{t("slides.editor.preview.render")}</Button>{/if}
          {/if}
        </div>
      </div>
    {/if}
  </div>

  {#if withNotes && showNotes && ready}
    <section class="max-h-[40dvh] overflow-y-auto rounded-2xl border border-line bg-surface px-4 py-3 text-[13.5px] leading-relaxed text-ink-2" aria-label={t("slides.player.notes")} aria-live="polite">
      <p class="mb-1.5 text-[12px] font-medium text-ink-3">{t("slides.player.notes")}</p>
      {#if slideNotes}
        <div class="speaker-notes">{@html slideNotes}</div>
      {:else if slideNotes === null}
        <p class="text-ink-3">{t("slides.player.noNotes")}</p>
      {:else}
        <LoaderCircle class="size-4 animate-spin text-ink-3 motion-reduce:animate-none" />
      {/if}
    </section>
  {/if}

  {#if showFailure && failed?.error}
    <div class="rounded-2xl border border-danger/30 bg-danger-soft/60 p-3">
      <button type="button" class="flex min-h-10 w-full items-center justify-between gap-2 text-left text-[13px] font-medium text-danger" aria-expanded={showLog} onclick={() => (showLog = !showLog)}>
        <span>{t("slides.editor.preview.log")}</span><span class="text-[12px] opacity-80">{showLog ? t("slides.editor.preview.hideLog") : t("slides.editor.preview.showLog")}</span>
      </button>
      {#if showLog}
        <pre class="mt-2 max-h-56 overflow-auto rounded-xl bg-surface p-3 text-[11.5px] leading-relaxed break-words whitespace-pre-wrap text-ink-2">{renderLog(failed.error)}</pre>
      {/if}
    </div>
  {/if}
</div>
