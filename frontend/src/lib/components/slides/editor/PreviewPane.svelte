<script lang="ts">
  import { untrack } from "svelte";
  import { CircleAlert, Expand, LoaderCircle, LocateFixed, NotebookText, Presentation, RefreshCw, Sparkles } from "@lucide/svelte";
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
   * A new render loads in a second iframe under the shown one, goes to the slide being viewed (Reveal's `slidechanged`
   * state), and only then replaces it: no blank flash, no jump back to the cover while the AI or a co-editor edits.
   * `activity`: an AI turn / workflow is reading or editing the deck right now (「AI 編輯中」).
   */
  let { preview, slide = 0, stale = false, canRefresh = false, notes: withNotes = false, activity = null, onRefresh, onAskAi }: {
    preview: PreviewInfo | null;
    slide?: number;
    /** The editor has changes newer than the shown render. */
    stale?: boolean;
    canRefresh?: boolean;
    /** Offer the speaker-notes panel. */
    notes?: boolean;
    activity?: "editing" | "reading" | null;
    onRefresh?: () => void;
    /** 「請 AI 找出問題」 under a failed render: the assistant reads the error and suggests a fix. */
    onAskAi?: () => void | Promise<void>;
  } = $props();
  let asking = $state(false);
  async function askAi() {
    asking = true;
    try {
      await onAskAi?.();
    } finally {
      asking = false;
    }
  }

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
  const latest = $derived(preview?.latest ?? null);
  const busy = $derived(latest?.status === "queued" || latest?.status === "rendering");
  const failed = $derived(latest?.status === "failed" ? latest : null);
  // The newest failure is only relevant while it is newer than the shown render.
  const showFailure = $derived(Boolean(failed && (!ready || failed.revision > ready.revision)));

  // ── frames: the shown render and, while it loads, the next one under it ──────────────────────────────
  type Frame = { id: string; url: string };
  let frames = $state<Frame[]>([]);
  let shownId = $state<string | null>(null);
  const els = new Map<string, HTMLIFrameElement>();
  const registerFrame = (el: HTMLIFrameElement, id: string) => {
    els.set(id, el);
    return { destroy: () => els.get(id) === el && els.delete(id) };
  };
  /** The slide being viewed (Reveal indices): kept across renders, moved by `slide` and by navigating in the deck. */
  let at = { h: untrack(() => slide), v: 0 };
  /** Pending frame: where it was sent, and the fallback timer that shows it anyway. */
  let swapTimer: ReturnType<typeof setTimeout> | undefined;
  let loadTimer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    const r = ready;
    untrack(() => {
      if (!r) {
        frames = [];
        shownId = null;
        return;
      }
      if (frames.some((f) => f.id === r.id)) return;
      const shown = frames.find((f) => f.id === shownId);
      if (!shown) {
        frames = [{ id: r.id, url: r.viewUrl }];
        shownId = r.id;
        return;
      }
      // A newer render replaces a pending one that has not been shown yet.
      frames = [shown, { id: r.id, url: r.viewUrl }];
      clearTimeout(swapTimer);
      clearTimeout(loadTimer);
      // A deck that never reports `ready` (broken script) is shown anyway.
      loadTimer = setTimeout(() => show(r.id), 15_000);
    });
  });
  $effect(() => () => (clearTimeout(swapTimer), clearTimeout(loadTimer)));

  function show(id: string) {
    if (!frames.some((f) => f.id === id) || shownId === id) return;
    clearTimeout(swapTimer);
    clearTimeout(loadTimer);
    shownId = id;
    frames = frames.filter((f) => f.id === id);
    slideNotes = undefined;
    if (withNotes) askNotes();
  }

  const post = (id: string | null, method: string, args: unknown[]) => els.get(id ?? "")?.contentWindow?.postMessage(JSON.stringify({ method, args }), "*");
  function go(index: number) {
    at = { h: index, v: 0 };
    post(shownId, "slide", [index, 0]);
  }
  const askNotes = () => post(shownId, "getSlideNotes", []);
  // Reveal posts its events as JSON strings; only messages from our iframes count (their origin is opaque).
  $effect(() => {
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string" || event.data.length > 250_000) return;
      const id = [...els].find(([, el]) => el.contentWindow === event.source)?.[0];
      if (!id) return;
      let data: { namespace?: string; eventName?: string; method?: string; result?: unknown; state?: { indexh?: unknown; indexv?: unknown } } | null = null;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      if (data?.namespace !== "reveal") return;
      const h = typeof data.state?.indexh === "number" ? data.state.indexh : null;
      const v = typeof data.state?.indexv === "number" ? data.state.indexv : 0;
      if (id !== shownId) {
        // The next render: go to the slide being viewed, show it once it is there.
        if (data.eventName === "ready") {
          if (at.h === (h ?? 0) && at.v === v) swapTimer = setTimeout(() => show(id), 60);
          else {
            post(id, "slide", [at.h, at.v]);
            swapTimer = setTimeout(() => show(id), 1500);
          }
        } else if (data.eventName === "slidechanged") {
          clearTimeout(swapTimer);
          swapTimer = setTimeout(() => show(id), 120);
        }
        return;
      }
      if (data.eventName === "ready") untrack(() => post(id, "slide", [at.h, at.v]));
      else if (data.eventName === "slidechanged" && h !== null) at = { h, v };
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
      els.get(shownId ?? "")?.focus();
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
      {:else if activity === "editing"}
        <Sparkles class="size-3.5 shrink-0 text-[var(--pill-lilac-ink)]" /><span class="truncate">{t("slides.editor.preview.aiEditingHint")}</span>
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
      {#each frames as f (f.id)}
        <iframe
          use:registerFrame={f.id}
          src={f.url}
          title={t("slides.editor.preview.title")}
          sandbox="allow-scripts allow-pointer-lock allow-presentation"
          allow="fullscreen"
          referrerpolicy="no-referrer"
          inert={f.id !== shownId}
          aria-hidden={f.id !== shownId}
          class="absolute inset-0 size-full border-0 bg-white {f.id === shownId ? 'z-10' : 'z-0'}"
        ></iframe>
      {/each}
      {#if activity}
        <div class="pointer-events-none absolute top-2.5 left-2.5 z-20 flex items-center gap-1.5 rounded-full border border-line bg-surface/95 px-2.5 py-1 text-[12px] font-medium text-ink-2 shadow-card">
          <Sparkles class="size-3.5 text-[var(--pill-lilac-ink)] {activity === 'editing' ? 'animate-pulse motion-reduce:animate-none' : ''}" />{activity === "editing" ? t("slides.editor.preview.aiEditing") : t("slides.editor.preview.aiReading")}
        </div>
      {/if}
      {#if busy}
        <div class="pointer-events-none absolute inset-x-0 top-0 z-20"><Progress value={latest?.progress || null} class="h-1 rounded-none" /></div>
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
      {#if onAskAi}
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" class="min-h-10" loading={asking} onclick={askAi}><Sparkles />{t("slides.editor.preview.askAi")}</Button>
          <span class="text-[12px] text-ink-3">{t("slides.editor.preview.askAiHint")}</span>
        </div>
      {/if}
    </div>
  {/if}
</div>
