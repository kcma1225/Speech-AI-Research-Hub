<script lang="ts">
  import { untrack, type Snippet } from "svelte";
  import { ChevronLeft, ChevronRight, Expand, GalleryHorizontal, Minimize, NotebookText, Presentation, ScreenShare } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import Spinner from "#lib/components/ui/Spinner.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import { loadManifest, notesHtml, openSpeaker, pageAt, preload, readPosition, writePosition } from "#lib/slides/pages.ts";
  import { deckChannel, type DeckChannel } from "#lib/slides/sync.ts";
  import type { PageManifest, SlideVersion } from "#lib/slides/types.ts";

  /**
   * Deck player. pdf/pptx versions (and quarto versions shown without their HTML) are drawn from the
   * page images of the manifest; quarto decks run in the sandboxed iframe (never add allow-same-origin:
   * the deck runs untrusted scripts and must keep an opaque origin) and are driven through Reveal's
   * postMessage API. Same chrome for both: counter, thumbnails, keyboard, swipe, fullscreen, speaker window.
   */
  let {
    version,
    deck,
    title,
    page = $bindable(1),
    manifest = $bindable(null),
    startPage = null,
    variant = "embedded",
    globalKeys = false,
    counts = {},
    shareKey = null,
    speaker = true,
    class: cls = "",
    empty,
  }: {
    version: SlideVersion | null;
    /** Deck slug: scopes the remembered position and the speaker channel. */
    deck: string;
    title: string;
    page?: number;
    manifest?: PageManifest | null;
    /** Page to open when the version changes (instead of the remembered one). */
    startPage?: number | null;
    variant?: "embedded" | "stage";
    /** Arrow keys etc. work anywhere on the page (the standalone player), not only while the player has focus. */
    globalKeys?: boolean;
    /** Review count per page, shown on the thumbnails. */
    counts?: Record<number, number>;
    shareKey?: string | null;
    /** Offer the speaker window (published versions only: it loads the deck through the player routes). */
    speaker?: boolean;
    class?: string;
    empty?: Snippet;
  } = $props();

  let root = $state<HTMLDivElement | null>(null);
  let frame = $state<HTMLIFrameElement | null>(null);
  let strip = $state<HTMLDivElement | null>(null);
  let manifestState = $state<"idle" | "loading" | "ready" | "missing">("idle");
  let showThumbs = $state(true);
  let showNotes = $state(false);

  // Quarto decks are shown live; everything else from page images.
  const live = $derived(Boolean(version?.sourceType === "quarto" && version.viewUrl));
  const pages = $derived(manifest?.pages ?? []);
  let revealTotal = $state<number | null>(null);
  const total = $derived(manifest?.pageCount ?? revealTotal ?? 0);
  const current = $derived(pages.find(p => p.index === page) ?? null);
  const ratio = $derived(manifest ? `${manifest.width} / ${manifest.height}` : "16 / 10");
  const notes = $derived(notesHtml(current));
  const canSpeak = $derived(Boolean(speaker && version?.status === "published" && (manifest || live)));

  // ---- Version changes: iframe URL, manifest, starting page -------------------------------------
  // The view URL carries a fresh token on every detail load; keep the iframe on the same URL while the
  // version is unchanged so reloading the detail (after a review, a save…) doesn't restart the deck.
  let frameSrc = $state<string | null>(null);
  let versionId: string | null = null;
  let ready = $state(false);
  let revealPage = 0;
  $effect(() => {
    const v = version;
    const id = v?.id ?? null;
    const pagesUrl = v?.pagesUrl ?? null;
    untrack(() => {
      if (id === versionId && (frameSrc || !v?.viewUrl)) {
        if (id && pagesUrl && !manifest && manifestState !== "loading") fetchManifest(pagesUrl, id);
        return;
      }
      versionId = id;
      frameSrc = v && v.sourceType === "quarto" ? v.viewUrl : null;
      ready = false;
      revealTotal = null;
      revealPage = 0;
      manifest = null;
      page = Math.max(1, startPage ?? (id ? readPosition(deck, id) : null) ?? 1);
      if (pagesUrl && id) fetchManifest(pagesUrl, id);
      else manifestState = id ? "missing" : "idle";
    });
  });
  function fetchManifest(url: string, id: string) {
    manifestState = "loading";
    loadManifest(url).then(
      m => {
        if (versionId !== id) return;
        manifest = m;
        manifestState = "ready";
        if (page > m.pageCount) page = m.pageCount;
      },
      () => versionId === id && (manifestState = "missing"),
    );
  }

  // ---- Navigation -----------------------------------------------------------------------------
  const clamp = (n: number) => Math.min(Math.max(1, n), Math.max(1, total || n));
  export function goto(n: number) {
    page = clamp(n);
  }
  function step(dir: 1 | -1) {
    if (live) return void reveal(dir > 0 ? "next" : "prev");
    goto(page + dir);
  }

  // Remember where we were, and warm up the neighbours.
  $effect(() => {
    if (versionId && page >= 1) writePosition(deck, versionId, page);
  });
  $effect(() => {
    if (live) return;
    for (const n of [page + 1, page - 1, page + 2]) {
      const p = pages.find(x => x.index === n);
      preload(p?.full ?? p?.thumb);
    }
  });

  // ---- Reveal (quarto) ------------------------------------------------------------------------
  function reveal(method: string, args: unknown[] = []) {
    frame?.contentWindow?.postMessage(JSON.stringify({ method, args }), "*");
  }
  // Parent → deck: when `page` changes for any reason other than the deck reporting it, move the deck.
  $effect(() => {
    const n = page;
    if (!live || !ready) return;
    untrack(() => {
      if (n === revealPage) return;
      const target = pages.find(p => p.index === n);
      if (target && target.h !== undefined) reveal("slide", [target.h, target.v ?? 0]);
      else if (!manifest) reveal("slide", [n - 1, 0]);
    });
  });
  function onDeckMessage(event: MessageEvent) {
    if (!frame || event.source !== frame.contentWindow) return;
    // The deck is user-authored: treat every message as untrusted input.
    let data: unknown = event.data;
    if (typeof data === "string") {
      if (data.length > 100_000) return;
      try {
        data = JSON.parse(data);
      } catch {
        return;
      }
    }
    if (!data || typeof data !== "object") return;
    const msg = data as { namespace?: unknown; type?: unknown; eventName?: unknown; state?: unknown; method?: unknown; result?: unknown };
    if (msg.namespace === "hub") {
      if (msg.type === "speaker") speak();
      else if (msg.type === "fullscreen") fullscreen();
      return;
    }
    if (msg.namespace !== "reveal") return;
    if (msg.eventName === "callback") {
      if (msg.method === "getTotalSlides" && Number.isInteger(msg.result)) revealTotal = msg.result as number;
      else if (msg.method === "getSlidePastCount" && Number.isInteger(msg.result) && !manifest) {
        revealPage = (msg.result as number) + 1;
        page = revealPage;
      }
      return;
    }
    const state = msg.state as { indexh?: unknown; indexv?: unknown } | undefined;
    if (msg.eventName === "ready") {
      ready = true;
      reveal("getTotalSlides");
      // Restore the remembered / requested page once the deck can be driven.
      const target = pages.find(p => p.index === page);
      revealPage = 0;
      if (page > 1 && target?.h !== undefined) reveal("slide", [target.h, target.v ?? 0]);
      else if (page > 1 && !manifest) reveal("slide", [page - 1, 0]);
      else revealPage = page;
    }
    if (state && Number.isInteger(state.indexh)) {
      const h = state.indexh as number;
      const v = Number.isInteger(state.indexv) ? (state.indexv as number) : 0;
      const found = pageAt(manifest, h, v);
      if (found) {
        revealPage = found.index;
        page = found.index;
      } else if (!manifest && msg.eventName === "slidechanged") reveal("getSlidePastCount");
    }
  }

  // ---- Fullscreen -----------------------------------------------------------------------------
  let native = $state(false);
  // iPhone Safari has no element fullscreen: fall back to a fixed overlay.
  let pseudo = $state(false);
  const isFullscreen = $derived(native || pseudo);
  export function fullscreen() {
    if (!root) return;
    if (document.fullscreenElement) return void document.exitFullscreen();
    if (pseudo) return void (pseudo = false);
    if (root.requestFullscreen) void root.requestFullscreen().then(() => (live ? frame : root)?.focus(), () => (pseudo = true));
    else pseudo = true;
  }

  // ---- Speaker window -------------------------------------------------------------------------
  let channel: DeckChannel | null = null;
  let remotePage = 0;
  function speak() {
    if (!canSpeak || !version) return;
    if (!openSpeaker(deck, version.id, page, shareKey)) toasts.show(t("slides.player.popupBlocked"), "error");
  }
  $effect(() => {
    const id = version?.status === "published" ? version.id : null;
    if (!id || !speaker) return;
    const ch = deckChannel(deck, id, "player", m => {
      if (m.type === "hello") ch?.page(page);
      else if (m.type === "page" && m.page !== page) {
        remotePage = m.page;
        goto(m.page);
      } else if (m.type === "step") step(m.dir);
    });
    channel = ch;
    const bye = () => ch?.close();
    window.addEventListener("pagehide", bye);
    return () => {
      window.removeEventListener("pagehide", bye);
      ch?.close();
      channel = null;
    };
  });
  // Announce our own moves (not the ones the speaker window asked for: that would echo back).
  $effect(() => {
    const n = page;
    untrack(() => {
      if (n === remotePage) return void (remotePage = 0);
      channel?.page(n);
    });
  });

  // ---- Keyboard & touch -----------------------------------------------------------------------
  function onKey(e: KeyboardEvent) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing || !version) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    if (!(globalKeys || isFullscreen || root?.contains(document.activeElement))) return;
    // Keys inside menus/dialogs belong to them.
    if (target?.closest("[role=dialog],[role=menu],[role=listbox]")) return;
    const key = e.key;
    let handled = true;
    if (key === "ArrowRight" || key === "ArrowDown" || key === "PageDown" || (key === " " && !e.shiftKey)) step(1);
    else if (key === "ArrowLeft" || key === "ArrowUp" || key === "PageUp" || (key === " " && e.shiftKey)) step(-1);
    else if (key === "Home") goto(1);
    else if (key === "End") goto(total || page);
    else if (key === "f" || key === "F") fullscreen();
    else if (key === "s" || key === "S") speak();
    else handled = false;
    if (handled) e.preventDefault();
  }
  let touch: { x: number; y: number } | null = null;
  function touchStart(e: TouchEvent) {
    const t0 = e.touches[0];
    touch = e.touches.length === 1 && t0 ? { x: t0.clientX, y: t0.clientY } : null;
  }
  function touchEnd(e: TouchEvent) {
    const t1 = e.changedTouches[0];
    if (!touch || !t1) return;
    const dx = t1.clientX - touch.x;
    const dy = t1.clientY - touch.y;
    touch = null;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.3) step(dx < 0 ? 1 : -1);
  }

  $effect(() => {
    const sync = () => (native = document.fullscreenElement === root);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && pseudo && (pseudo = false);
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("keydown", esc);
    window.addEventListener("keydown", onKey);
    window.addEventListener("message", onDeckMessage);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("keydown", esc);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("message", onDeckMessage);
    };
  });

  // Keep the active thumbnail in view (horizontally only: never scroll the page).
  $effect(() => {
    const n = page;
    if (!strip || !showThumbs) return;
    const el = strip.querySelector<HTMLElement>(`[data-page="${n}"]`);
    if (!el) return;
    const left = el.offsetLeft - strip.clientWidth / 2 + el.clientWidth / 2;
    strip.scrollTo({ left, behavior: "smooth" });
  });

  // In fullscreen the image controls fade out while the pointer rests.
  let idle = $state(false);
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  function wake() {
    idle = false;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => (idle = true), 2500);
  }
  $effect(() => () => clearTimeout(idleTimer));

  const btn =
    "grid size-9 shrink-0 cursor-pointer place-items-center rounded-full text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4";
  const toggleOn = "bg-surface-3 text-ink";
  const fsBtn = "grid size-10 shrink-0 cursor-pointer place-items-center rounded-full text-white/85 hover:bg-white/15 hover:text-white disabled:opacity-40 [&_svg]:size-[18px]";
</script>

{#snippet counter(dark = false)}
  <span class="min-w-[4.5rem] px-1 text-center text-[13px] font-medium tabular-nums {dark ? 'text-white/85' : 'text-ink-2'}" aria-live="polite">
    {#if total}{t("slides.player.counter", { n: page, total })}{:else if live}{page}{:else}–{/if}
  </span>
{/snippet}

<div
  bind:this={root}
  role="region"
  aria-label={title}
  tabindex="-1"
  class="group/player flex min-w-0 flex-col outline-none {isFullscreen ? (pseudo ? 'fixed inset-0 z-[70] bg-black pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]' : 'bg-black') : cls}"
  onpointermove={isFullscreen ? wake : undefined}
>
  <!-- Stage -->
  <div
    class="relative min-h-0 overflow-hidden {isFullscreen ? 'flex-1 bg-black' : variant === 'stage' ? 'flex-1 bg-canvas-2' : 'max-h-[min(70dvh,860px)] rounded-[22px] border border-line/70 bg-surface-2 shadow-card'}"
    style={!isFullscreen && variant === "embedded" ? `aspect-ratio:${ratio}` : undefined}
  >
    {#if !version}
      <div class="absolute inset-0 grid place-items-center p-6 text-center">{@render empty?.()}</div>
    {:else if live && frameSrc}
      {#key frameSrc}
        <iframe
          bind:this={frame}
          src={frameSrc}
          {title}
          sandbox="allow-scripts allow-pointer-lock allow-presentation"
          allow="fullscreen"
          referrerpolicy="no-referrer"
          class="absolute inset-0 size-full border-0"
        ></iframe>
      {/key}
    {:else if current}
      <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
      <div class="absolute inset-0 select-none" ontouchstart={touchStart} ontouchend={touchEnd} onclick={() => root?.focus()}>
        <img src={current.thumb} alt="" aria-hidden="true" class="absolute inset-0 size-full scale-105 object-contain opacity-60 blur-sm" draggable="false" />
        {#key current.index}
          <img src={current.full ?? current.thumb} alt={current.title ?? t("slides.player.pageAlt", { n: current.index })} class="absolute inset-0 size-full object-contain" draggable="false" />
        {/key}
        {#if !isFullscreen}
          <!-- Large tap targets on the image edges (desktop hover shows them). -->
          <button type="button" class="absolute inset-y-0 left-0 hidden w-[18%] cursor-pointer items-center justify-start pl-3 opacity-0 transition-opacity group-hover/player:opacity-100 sm:flex" aria-label={t("slides.player.prev")} disabled={page <= 1} onclick={() => step(-1)}>
            <span class="grid size-10 place-items-center rounded-full bg-black/45 text-white backdrop-blur"><ChevronLeft class="size-5" /></span>
          </button>
          <button type="button" class="absolute inset-y-0 right-0 hidden w-[18%] cursor-pointer items-center justify-end pr-3 opacity-0 transition-opacity group-hover/player:opacity-100 sm:flex" aria-label={t("slides.player.next")} disabled={page >= total} onclick={() => step(1)}>
            <span class="grid size-10 place-items-center rounded-full bg-black/45 text-white backdrop-blur"><ChevronRight class="size-5" /></span>
          </button>
        {/if}
      </div>
    {:else if manifestState === "loading"}
      <div class="absolute inset-0 grid place-items-center text-ink-3"><Spinner class="size-5" /></div>
    {:else}
      <div class="absolute inset-0 grid place-items-center p-6 text-center">
        <div class="flex max-w-sm flex-col items-center gap-3">
          <span class="grid size-11 place-items-center rounded-2xl bg-surface-3 text-ink-2"><Presentation class="size-5" /></span>
          <p class="text-sm font-medium">{t("slides.player.noPages")}</p>
          <p class="text-[13px] text-ink-3">{t("slides.player.noPagesHint")}</p>
        </div>
      </div>
    {/if}

    {#if isFullscreen}
      <div class="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-3 transition-opacity duration-300 {idle && !live ? 'opacity-0' : 'opacity-100'}">
        <div class="pointer-events-auto flex items-center gap-1 rounded-full bg-black/60 p-1 backdrop-blur {live ? 'opacity-50 hover:opacity-100' : ''}">
          <button type="button" class={fsBtn} aria-label={t("slides.player.prev")} disabled={!live && page <= 1} onclick={() => step(-1)}><ChevronLeft /></button>
          {@render counter(true)}
          <button type="button" class={fsBtn} aria-label={t("slides.player.next")} disabled={!live && page >= total} onclick={() => step(1)}><ChevronRight /></button>
          {#if canSpeak}<button type="button" class={fsBtn} aria-label={t("slides.player.speaker")} onclick={speak}><ScreenShare /></button>{/if}
          <button type="button" class={fsBtn} aria-label={t("slides.player.exitFullscreen")} onclick={fullscreen}><Minimize /></button>
        </div>
      </div>
    {/if}
  </div>

  {#if version && !isFullscreen}
    <!-- Toolbar -->
    <div class="flex min-w-0 items-center gap-1 {variant === 'stage' ? 'border-t border-line bg-surface px-2 py-1.5 sm:px-3' : 'mt-2 px-0.5'}">
      <button type="button" class={btn} aria-label={t("slides.player.prev")} title="←" disabled={!live && page <= 1} onclick={() => step(-1)}><ChevronLeft /></button>
      {@render counter()}
      <button type="button" class={btn} aria-label={t("slides.player.next")} title="→" disabled={!live && page >= total} onclick={() => step(1)}><ChevronRight /></button>
      <p class="mx-1 hidden min-w-0 flex-1 truncate text-[13px] text-ink-3 sm:block">{current?.title ?? ""}</p>
      <span class="flex-1 sm:hidden"></span>
      {#if pages.some(p => p.notes)}
        <button type="button" class="{btn} {showNotes ? toggleOn : ''}" aria-pressed={showNotes} aria-label={t("slides.player.notes")} title={t("slides.player.notes")} onclick={() => (showNotes = !showNotes)}><NotebookText /></button>
      {/if}
      {#if pages.length}
        <button type="button" class="{btn} {showThumbs ? toggleOn : ''}" aria-pressed={showThumbs} aria-label={t("slides.player.thumbs")} title={t("slides.player.thumbs")} onclick={() => (showThumbs = !showThumbs)}><GalleryHorizontal /></button>
      {/if}
      {#if canSpeak}
        <button type="button" class={btn} aria-label={t("slides.player.speaker")} title="{t('slides.player.speaker')} (S)" onclick={speak}><ScreenShare /></button>
      {/if}
      <button type="button" class={btn} aria-label={t("slides.fullscreen")} title="{t('slides.fullscreen')} (F)" onclick={fullscreen}><Expand /></button>
    </div>

    {#if showNotes && pages.some(p => p.notes)}
      <div class="mt-1 max-h-48 overflow-y-auto rounded-2xl border border-line bg-surface px-4 py-3 text-[13.5px] leading-relaxed text-ink-2 {variant === 'stage' ? 'mx-2 mb-1.5 sm:mx-3' : ''}">
        {#if notes}
          <div class="speaker-notes">{@html notes}</div>
        {:else if current?.notes}
          <p class="whitespace-pre-wrap">{current.notes.text}</p>
        {:else}
          <p class="text-ink-3">{t("slides.player.noNotes")}</p>
        {/if}
      </div>
    {/if}

    {#if showThumbs && pages.length}
      <div bind:this={strip} class="flex gap-2 overflow-x-auto overscroll-x-contain scroll-smooth py-2 [scrollbar-width:thin] {variant === 'stage' ? 'bg-surface px-2 sm:px-3' : 'px-0.5'}">
        {#each pages as p (p.index)}
          {@const n = counts[p.index] ?? 0}
          <button
            type="button"
            data-page={p.index}
            class="relative shrink-0 cursor-pointer overflow-hidden rounded-xl border-2 bg-surface-2 transition-[border-color,opacity] {p.index === page ? 'border-ink' : 'border-transparent opacity-75 hover:opacity-100'}"
            style="aspect-ratio:{ratio};height:{variant === 'stage' ? 64 : 56}px"
            aria-label={t("slides.player.goto", { n: p.index })}
            aria-current={p.index === page ? "true" : undefined}
            title={p.title}
            onclick={() => goto(p.index)}
          >
            <img src={p.thumb} alt="" loading="lazy" class="size-full object-cover" draggable="false" />
            <span class="absolute bottom-0.5 left-0.5 rounded-md bg-black/55 px-1 text-[10px] leading-4 font-medium text-white tabular-nums">{p.index}</span>
            {#if n}
              <span class="absolute top-0.5 right-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums" style="background:var(--pill-lilac);color:var(--pill-lilac-ink)" title={t("slides.reviews", { n })}>{n}</span>
            {/if}
          </button>
        {/each}
      </div>
    {/if}
  {/if}
</div>
