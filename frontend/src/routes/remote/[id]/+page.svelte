<script lang="ts">
  import { untrack } from "svelte";
  import { page as route } from "$app/state";
  import { ArrowLeft, ChevronLeft, ChevronRight, Image, ImageMinus, ImageOff, LayoutGrid, Minus, MonitorX, MousePointer2, Pause, Play, Plus, Rotate3d, RotateCcw, X } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import AskDock from "#lib/components/slides/AskDock.svelte";
  import EmptyState from "#lib/components/ui/EmptyState.svelte";
  import { loadManifest, notesHtml } from "#lib/slides/pages.ts";
  import { containBox, toSlide } from "#lib/slides/laser.ts";
  import { controlEvent, liveSocket, socketUrl, type LinkState } from "#lib/slides/remote.ts";
  import { AskSession } from "#lib/slides/ask-session.svelte.ts";
  import { startTilt, tiltNeedsAsk, tiltPermission, tiltSupported } from "#lib/slides/tilt.ts";
  import { iosOtherBrowser } from "#lib/slides/device.ts";
  import type { PageManifest, SlideDetail } from "#lib/slides/types.ts";

  /**
   * Phone controller of one presentation (`/remote/<session>`), all on one screen: big 上一頁／下一頁, the current slide
   * (large, small or hidden, per phone) with its speaker notes and the next slide, jump to any page, a laser pointer
   * (hold a finger on the slide, or tap 轉動指向 and turn the phone), a talk timer, the screen kept awake, and
   * 「提問助手」 under the notes (the professor asks in the middle of the talk). The computer's player does the moving
   * (lib/slides/remote.ts); this page follows its `state`.
   */
  const id = $derived(route.params.id!);
  let link = $state<LinkState>("connecting");
  let ended = $state(false);
  let current = $state(1);
  let total = $state(0);
  let deck = $state<{ deckId: string; versionId: string; title: string } | null>(null);
  let manifest = $state<PageManifest | null>(null);

  let sock: ReturnType<typeof liveSocket> | null = null;
  async function stillLive(sid: string, s: { close(): void }) {
    try {
      const { sessions } = await api.get<{ sessions: { id: string }[] }>("/slides/remote/sessions");
      if (!sessions.some((x) => x.id === sid)) {
        ended = true;
        s.close();
      }
    } catch {
      // offline: keep retrying
    }
  }
  $effect(() => {
    const sid = id;
    ended = false;
    const s = liveSocket(socketUrl(`/slides/remote/control/${encodeURIComponent(sid)}`), {
      onState: (v) => (link = v),
      onMessage: (data) => {
        const m = controlEvent(data);
        if (!m) return;
        if (m.type === "ended") {
          ended = true;
          return;
        }
        current = m.page;
        if (m.total) total = m.total;
        if (deck?.versionId !== m.versionId) deck = { deckId: m.deckId, versionId: m.versionId, title: m.title };
      },
      // A refused or dropped socket: the session may be gone (ended on the computer, or the server restarted and the
      // player now hosts a new session) — the list says; otherwise keep retrying.
      onClose: (code) => {
        if (code === 1008 || code === 1013) ended = true;
        else void stillLive(sid, s);
        return !ended;
      },
    });
    sock = s;
    return () => {
      s.close();
      sock = null;
    };
  });

  // Page images and notes of the presented version.
  $effect(() => {
    const d = deck;
    if (!d) return;
    untrack(() => {
      api.get<SlideDetail>(`/slides/${d.deckId}`).then(
        (detail) => {
          const v = detail.versions.find((x) => x.id === d.versionId) ?? (detail.activeVersion?.id === d.versionId ? detail.activeVersion : null);
          if (v?.pagesUrl) loadManifest(v.pagesUrl).then((m) => deck?.versionId === d.versionId && (manifest = m), () => {});
        },
        () => {},
      );
    });
  });
  const pages = $derived(manifest?.pages ?? []);
  const count = $derived(total || manifest?.pageCount || 0);
  const shown = $derived(pages.find((p) => p.index === current) ?? null);
  const next = $derived(pages.find((p) => p.index === current + 1) ?? null);
  const notes = $derived(notesHtml(shown));
  const ratio = $derived(manifest ? manifest.width / manifest.height : 16 / 10);

  // ---- Commands ---------------------------------------------------------------------------
  const buzz = () => {
    try {
      navigator.vibrate?.(8);
    } catch {}
  };
  function step(dir: 1 | -1) {
    sock?.send({ type: "step", dir });
    buzz();
  }
  function jump(n: number) {
    sock?.send({ type: "goto", page: n });
    showPages = false;
    buzz();
  }
  const canPrev = $derived(link === "open" && current > 1);
  const canNext = $derived(link === "open" && (!count || current < count));

  // ---- Laser: hold a finger on the slide ----------------------------------------------------
  let laserOn = $state(false);
  let pad = $state<HTMLElement | null>(null);
  let pointer = $state<{ x: number; y: number } | null>(null);
  let lastSent = 0;
  function slideBox() {
    const r = pad?.getBoundingClientRect();
    return r ? containBox(r, ratio, 1) : null;
  }
  function sendLaser(p: { x: number; y: number }, down: boolean) {
    pointer = p;
    const now = performance.now();
    // ~50 frames per second is smooth on the projector and under the server's limit.
    if (now - lastSent < 20 && down) return;
    lastSent = now;
    sock?.send({ type: "laser", page: current, x: p.x, y: p.y, down });
  }
  function laserAt(e: PointerEvent, down: boolean) {
    const b = slideBox();
    const p = b ? toSlide(b, e.clientX, e.clientY) : null;
    if (!p) return laserOff();
    sendLaser(p, down);
  }
  function laserOff() {
    if (!pointer) return;
    pointer = null;
    sock?.send({ type: "laserOff" });
  }
  // Without the laser, a horizontal swipe on the slide steps.
  let swipe: { x: number; y: number } | null = null;
  function padDown(e: PointerEvent) {
    if (tilting) return;
    if (laserOn) {
      pad?.setPointerCapture(e.pointerId);
      laserAt(e, true);
    } else swipe = { x: e.clientX, y: e.clientY };
  }
  function padMove(e: PointerEvent) {
    if (laserOn && pad?.hasPointerCapture(e.pointerId)) laserAt(e, true);
  }
  function padUp(e: PointerEvent) {
    if (laserOn) return laserOff();
    if (!swipe) return;
    const dx = e.clientX - swipe.x;
    const dy = e.clientY - swipe.y;
    swipe = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
  }
  $effect(() => {
    if (!laserOn) untrack(laserOff);
  });

  // ---- Laser by turning the phone: tap 轉動指向 on / off, the dot starts at the centre (lib/slides/tilt.ts) -------------------
  const canTilt = tiltSupported();
  // iOS gives motion readings only after a tap on 轉動指向 allowed them (requestPermission must run in a click, a
  // press-down is refused as "no user gesture"); readings arriving means access was given earlier in this tab.
  let tiltAllowed = $state(!canTilt || !tiltNeedsAsk());
  let tilting = $state(false);
  let tiltNote = $state<string | null>(null);
  let stopTilt: (() => void) | null = null;
  // A per-phone fix when the dot moves the wrong way (shown once 轉動指向 has been used).
  const readFlip = () => {
    try {
      const v = JSON.parse(localStorage.getItem("hub-remote-tilt-flip") ?? "{}") as { x?: number; y?: number };
      return { x: v.x === -1 ? -1 : 1, y: v.y === -1 ? -1 : 1 } as { x: 1 | -1; y: 1 | -1 };
    } catch {
      return { x: 1, y: 1 } as { x: 1 | -1; y: 1 | -1 };
    }
  };
  let flip = $state(readFlip());
  let tiltUsed = $state(false);
  function toggleFlip(axis: "x" | "y") {
    flip = { ...flip, [axis]: flip[axis] === 1 ? -1 : 1 };
    try {
      localStorage.setItem("hub-remote-tilt-flip", JSON.stringify(flip));
    } catch {}
  }
  $effect(() => {
    if (tiltAllowed) return;
    // Browsers without a gyroscope send one empty event: only a reading counts.
    const on = (e: DeviceMotionEvent) => {
      const r = e.rotationRate;
      if (r && (r.alpha != null || r.beta != null || r.gamma != null)) tiltAllowed = true;
    };
    window.addEventListener("devicemotion", on);
    return () => window.removeEventListener("devicemotion", on);
  });
  /** Tap: on (the dot starts at the centre) / off. The first tap on iOS asks for motion access, then turns it on. */
  async function tiltClick() {
    if (tilting) return tiltOff();
    if (!tiltAllowed) {
      if (!(await tiltPermission())) return void (tiltNote = iosOtherBrowser() ? t("remote.tiltIosBrowser", { name: iosOtherBrowser()! }) : t("remote.tiltDenied"));
      tiltAllowed = true;
    }
    tiltNote = null;
    laserOn = false;
    tilting = true;
    tiltUsed = true;
    buzz();
    stopTilt = startTilt(
      (p) => sendLaser(p, true),
      () => {
        tiltNote = t("remote.tiltSilent");
        tiltOff();
      },
      () => flip,
    );
  }
  function tiltOff() {
    if (!tilting) return;
    tilting = false;
    stopTilt?.();
    stopTilt = null;
    laserOff();
  }
  // Stops when the phone locks or the page is left.
  $effect(() => {
    const hide = () => document.visibilityState === "hidden" && tiltOff();
    document.addEventListener("visibilitychange", hide);
    return () => (document.removeEventListener("visibilitychange", hide), stopTilt?.());
  });

  // ---- Timer ---------------------------------------------------------------------------------
  let elapsed = $state(0);
  let running = $state(true);
  let startedAt = Date.now();
  let base = 0;
  $effect(() => {
    if (!running) return;
    startedAt = Date.now();
    const timer = setInterval(() => (elapsed = base + Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => {
      clearInterval(timer);
      base = elapsed;
    };
  });
  function resetTimer() {
    base = 0;
    elapsed = 0;
    startedAt = Date.now();
  }
  const clock = $derived(`${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`);

  // ---- Screen stays on while controlling -------------------------------------------------------
  $effect(() => {
    type Lock = { release(): Promise<void> };
    const wl = (navigator as { wakeLock?: { request(type: "screen"): Promise<Lock> } }).wakeLock;
    if (!wl) return;
    let lock: Lock | null = null;
    let gone = false;
    const take = () => {
      if (gone || document.visibilityState !== "visible") return;
      wl.request("screen").then((l) => (gone ? void l.release() : (lock = l)), () => {});
    };
    take();
    document.addEventListener("visibilitychange", take);
    return () => {
      gone = true;
      document.removeEventListener("visibilitychange", take);
      void lock?.release().catch(() => {});
    };
  });

  // ---- Notes size (per phone) -------------------------------------------------------------------
  const readSize = () => {
    try {
      const n = Number(localStorage.getItem("hub-remote-notes-size"));
      return n >= 13 && n <= 28 ? n : 17;
    } catch {
      return 17;
    }
  };
  let notesSize = $state(readSize());
  $effect(() => {
    try {
      localStorage.setItem("hub-remote-notes-size", String(notesSize));
    } catch {}
  });

  // ---- Slide size (per phone): large, small beside the page info, or hidden for more notes / answers ---------------
  type SlideView = "large" | "small" | "off";
  const VIEWS: SlideView[] = ["large", "small", "off"];
  const readView = (): SlideView => {
    try {
      const v = localStorage.getItem("hub-remote-slide") as SlideView | null;
      return v && VIEWS.includes(v) ? v : "large";
    } catch {
      return "large";
    }
  };
  let view = $state<SlideView>(readView());
  $effect(() => {
    try {
      localStorage.setItem("hub-remote-slide", view);
    } catch {}
  });
  const cycleView = () => (view = VIEWS[(VIEWS.indexOf(view) + 1) % VIEWS.length]!);

  // Wide screens (tablets, phones in landscape): 提問助手 is a column beside the notes.
  // Short screens (phones in landscape) show a large slide small: it would leave no room for the notes.
  let wide = $state(false);
  let short = $state(false);
  $effect(() => {
    const mq = matchMedia("(min-width: 768px), (orientation: landscape)");
    const low = matchMedia("(max-height: 560px)");
    const set = () => ((wide = mq.matches), (short = low.matches));
    set();
    mq.addEventListener("change", set);
    low.addEventListener("change", set);
    return () => (mq.removeEventListener("change", set), low.removeEventListener("change", set));
  });

  // 提問助手: opens over part of the notes when an answer arrives; a large slide then shrinks to make room.
  let askOpen = $state(false);
  const ask = new AskSession(
    () => ({ deckId: deck?.deckId ?? null, page: current }),
    () => (askOpen = true),
  );
  $effect(() => () => ask.stop());
  const shownView = $derived<SlideView>(view === "large" && (short || (!wide && askOpen)) ? "small" : view);
  $effect(() => {
    if (shownView === "off") untrack(() => (laserOn = false));
  });

  let showPages = $state(false);
  // Hardware keyboards / presenter clickers paired with the phone.
  function onKey(e: KeyboardEvent) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (["ArrowRight", "PageDown", " "].includes(e.key)) step(1);
    else if (["ArrowLeft", "PageUp"].includes(e.key)) step(-1);
    else return;
    e.preventDefault();
  }
</script>

<svelte:head><title>{deck ? `${deck.title} · ` : ""}{t("remote.appName")}</title></svelte:head>
<svelte:window onkeydown={onKey} />

{#snippet slidePad(cls: string)}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    bind:this={pad}
    class="relative overflow-hidden rounded-2xl border-2 bg-black select-none {cls} {laserOn || tilting ? 'border-danger' : 'border-line'} {laserOn ? 'touch-none' : 'touch-pan-y'}"
    style="aspect-ratio:{ratio}"
    onpointerdown={padDown}
    onpointermove={padMove}
    onpointerup={padUp}
    onpointercancel={() => (laserOn ? laserOff() : (swipe = null))}
    oncontextmenu={(e) => e.preventDefault()}
  >
    {#if shown}
      <img src={shown.full ?? shown.thumb} alt={shown.title ?? t("slides.player.pageAlt", { n: current })} class="size-full object-contain" draggable="false" />
    {:else}
      <div class="grid size-full place-items-center text-[44px] font-semibold text-white/80 tabular-nums">{current}</div>
    {/if}
    {#if pointer && (laserOn || tilting)}
      <span class="pointer-events-none absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#ff2828] shadow-[0_0_12px_4px_rgba(255,40,40,.7)]" style="left:{pointer.x * 100}%;top:{pointer.y * 100}%"></span>
    {/if}
    {#if laserOn}<span class="pointer-events-none absolute top-2 right-2 rounded-full bg-danger px-2 py-0.5 text-[12px] font-medium text-white">{t("remote.laserHold")}</span>{/if}
  </div>
{/snippet}

<!-- Tap to point by turning the phone, tap again to stop (works with the slide hidden too). -->
{#snippet tiltButton(compact: boolean)}
  <button
    type="button"
    class="inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-xl border text-[14px] font-medium select-none {compact ? 'size-10' : 'min-h-11 flex-1 px-3'} {tilting ? 'border-danger bg-danger text-white' : 'border-line bg-surface-2 text-ink'}"
    aria-label={tiltAllowed ? t("remote.tilt") : t("remote.tiltEnable")}
    aria-pressed={tilting}
    onclick={tiltClick}
  >
    <Rotate3d class="size-4.5" />{#if !compact}{tilting ? t("remote.tiltOn") : tiltAllowed ? t("remote.tilt") : t("remote.tiltEnable")}{/if}
  </button>
{/snippet}

{#if ended}
  <div class="grid min-h-dvh place-items-center bg-canvas px-6">
    <EmptyState title={t("remote.endedTitle")} hint={t("remote.endedHint")}>
      {#snippet icon()}<MonitorX />{/snippet}
      {#snippet action()}<Button variant="primary" href="/remote">{t("remote.backToList")}</Button>{/snippet}
    </EmptyState>
  </div>
{:else}
  <div class="flex h-dvh flex-col bg-canvas">
    <header class="shrink-0 border-b border-line bg-surface pt-[env(safe-area-inset-top)]">
      <div class="mx-auto flex h-14 max-w-5xl items-center gap-1.5 px-2 sm:px-4">
        <Button size="icon" variant="ghost" href="/remote" aria-label={t("remote.backToList")}><ArrowLeft /></Button>
        <div class="min-w-0 flex-1">
          <p class="truncate text-[14px] font-semibold">{deck?.title ?? t("remote.connecting")}</p>
          <p class="flex items-center gap-1.5 text-[12px] text-ink-3" aria-live="polite">
            <span class="size-2 shrink-0 rounded-full {link === 'open' ? 'bg-success' : link === 'connecting' ? 'bg-[var(--pill-butter-ink)]' : 'bg-danger'}"></span>
            {link === "open" ? t("remote.linked") : link === "connecting" ? t("remote.connecting") : t("remote.reconnecting")}
          </p>
        </div>
        <button type="button" class="grid size-10 shrink-0 cursor-pointer place-items-center rounded-full text-ink-2 hover:bg-surface-3" aria-label={t(`remote.view.${view}`)} title={t(`remote.view.${view}`)} onclick={cycleView}>
          {#if view === "large"}<Image class="size-5" />{:else if view === "small"}<ImageMinus class="size-5" />{:else}<ImageOff class="size-5" />{/if}
        </button>
        <div class="flex items-center rounded-full bg-surface-2 p-0.5">
          <span class="px-2 text-[14px] font-semibold tabular-nums" aria-label={t("remote.timer")}>{clock}</span>
          <button type="button" class="grid size-9 cursor-pointer place-items-center rounded-full text-ink-2 hover:bg-surface-3" aria-label={running ? t("remote.pause") : t("remote.resume")} onclick={() => (running = !running)}>
            {#if running}<Pause class="size-4" />{:else}<Play class="size-4" />{/if}
          </button>
          <button type="button" class="grid size-9 cursor-pointer place-items-center rounded-full text-ink-2 hover:bg-surface-3" aria-label={t("remote.resetTimer")} onclick={resetTimer}><RotateCcw class="size-4" /></button>
        </div>
      </div>
    </header>

    <!-- One screen: slide (large / small / hidden) and notes, 提問助手 under them (phones) or beside them (wide). -->
    <main class="mx-auto flex min-h-0 w-full max-w-6xl flex-1 gap-2.5 overflow-hidden p-2.5 md:gap-4 md:p-4 {wide ? 'flex-row' : 'flex-col'}">
      <div class="flex min-h-0 min-w-0 flex-col gap-2 {wide ? 'flex-[1.25]' : 'flex-1'}">
        {#if shownView === "large"}
          <section class="flex shrink-0 flex-col gap-2">
            {@render slidePad("w-full")}
            <p class="flex min-w-0 items-baseline gap-2 px-0.5" aria-live="polite">
              <span class="shrink-0 text-[15px] font-semibold tabular-nums">{count ? `${current} / ${count}` : current}</span>
              {#if next}<span class="min-w-0 truncate text-[12.5px] text-ink-3">{t("remote.next")}：{next.title ?? t("remote.page", { n: next.index })}</span>{/if}
            </p>
            <div class="flex items-center gap-2">
              <Button variant={laserOn ? "primary" : "secondary"} class="min-h-11 flex-1" aria-pressed={laserOn} onclick={() => (tiltOff(), (laserOn = !laserOn))}><MousePointer2 />{t("remote.laser")}</Button>
              {#if canTilt}{@render tiltButton(false)}{/if}
              <Button variant="secondary" size="icon" class="size-11" aria-label={t("remote.pages")} disabled={!pages.length} onclick={() => (showPages = true)}><LayoutGrid /></Button>
            </div>
          </section>
        {:else if shownView === "small"}
          <section class="grid shrink-0 grid-cols-[minmax(0,42%)_minmax(0,1fr)] gap-2.5">
            {@render slidePad("w-full self-start")}
            <div class="flex min-w-0 flex-col gap-1.5">
              <p class="text-[15px] font-semibold tabular-nums" aria-live="polite">{count ? `${current} / ${count}` : current}</p>
              {#if next}<p class="line-clamp-2 text-[12px] text-ink-3">{t("remote.next")}：{next.title ?? t("remote.page", { n: next.index })}</p>{/if}
              <div class="mt-auto flex items-center gap-1.5">
                <Button variant={laserOn ? "primary" : "secondary"} size="icon" class="size-10" aria-label={t("remote.laser")} aria-pressed={laserOn} onclick={() => (tiltOff(), (laserOn = !laserOn))}><MousePointer2 /></Button>
                {#if canTilt}{@render tiltButton(true)}{/if}
                <Button variant="secondary" size="icon" class="size-10" aria-label={t("remote.pages")} disabled={!pages.length} onclick={() => (showPages = true)}><LayoutGrid /></Button>
              </div>
            </div>
          </section>
        {:else}
          <section class="flex shrink-0 items-center gap-2 px-0.5">
            <p class="min-w-0 flex-1 truncate text-[13px] text-ink-3" aria-live="polite">
              <span class="mr-1.5 text-[15px] font-semibold text-ink tabular-nums">{count ? `${current} / ${count}` : current}</span>{#if next}{t("remote.next")}：{next.title ?? t("remote.page", { n: next.index })}{/if}
            </p>
            {#if canTilt}{@render tiltButton(true)}{/if}
            <Button variant="secondary" size="icon" class="size-10" aria-label={t("remote.pages")} disabled={!pages.length} onclick={() => (showPages = true)}><LayoutGrid /></Button>
          </section>
        {/if}
        {#if tiltNote}<p class="shrink-0 px-0.5 text-[12.5px] text-ink-3" role="status">{tiltNote}</p>{/if}
        {#if tiltUsed}
          <div class="flex shrink-0 flex-wrap items-center gap-1.5 px-0.5 text-[12.5px] text-ink-3">
            {t("remote.tiltWrongWay")}
            {#each [["x", t("remote.tiltFlipX")], ["y", t("remote.tiltFlipY")]] as [axis, label] (axis)}
              <button type="button" class="min-h-8 cursor-pointer rounded-full border px-2.5 {flip[axis as 'x' | 'y'] === -1 ? 'border-ink bg-ink text-canvas' : 'border-line bg-surface-2 text-ink-2'}" aria-pressed={flip[axis as "x" | "y"] === -1} onclick={() => toggleFlip(axis as "x" | "y")}>{label}</button>
            {/each}
          </div>
        {/if}

        <section class="flex min-h-24 flex-1 flex-col rounded-2xl border border-line bg-surface" aria-label={t("slides.player.notes")}>
          <div class="flex shrink-0 items-center gap-1 border-b border-line px-3 py-1">
            <p class="min-w-0 flex-1 truncate text-[13px] font-medium text-ink-2">{shown?.title ?? t("slides.player.notes")}</p>
            <button type="button" class="grid size-9 cursor-pointer place-items-center rounded-full text-ink-2 hover:bg-surface-3 disabled:opacity-40" aria-label={t("remote.smaller")} disabled={notesSize <= 13} onclick={() => (notesSize -= 1)}><Minus class="size-4" /></button>
            <button type="button" class="grid size-9 cursor-pointer place-items-center rounded-full text-ink-2 hover:bg-surface-3 disabled:opacity-40" aria-label={t("remote.larger")} disabled={notesSize >= 28} onclick={() => (notesSize += 1)}><Plus class="size-4" /></button>
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3 leading-relaxed [overflow-wrap:anywhere] text-ink" style="font-size:{notesSize}px">
            {#if notes}
              <div class="speaker-notes">{@html notes}</div>
            {:else if shown?.notes}
              <p class="whitespace-pre-wrap">{shown.notes.text}</p>
            {:else}
              <p class="text-[14px] text-ink-3">{manifest ? t("slides.player.noNotes") : t("remote.noPages")}</p>
            {/if}
          </div>
        </section>
      </div>

      <div class="flex min-h-0 min-w-0 flex-col {wide ? 'flex-1' : askOpen ? 'h-[55%] shrink-0' : 'shrink-0'}">
        <AskDock session={ask} {wide} bind:open={askOpen} disabled={!deck} />
      </div>
    </main>

    <nav class="shrink-0 border-t border-line bg-surface px-3 pt-2.5 pb-[calc(10px+env(safe-area-inset-bottom))]" aria-label={t("remote.controls")}>
      <div class="mx-auto grid max-w-5xl grid-cols-[1fr_1.6fr] gap-2.5">
        <button type="button" class="flex min-h-16 cursor-pointer items-center justify-center gap-1.5 rounded-2xl border [@media(max-height:560px)]:min-h-12 border-line bg-surface-2 text-[16px] font-semibold text-ink active:bg-surface-3 disabled:opacity-40" disabled={!canPrev} onclick={() => step(-1)}><ChevronLeft class="size-6" />{t("remote.prev")}</button>
        <button type="button" class="flex min-h-16 cursor-pointer items-center justify-center gap-1.5 rounded-2xl bg-ink [@media(max-height:560px)]:min-h-12 text-[17px] font-semibold text-canvas active:opacity-85 disabled:opacity-40" disabled={!canNext} onclick={() => step(1)}>{t("remote.nextBtn")}<ChevronRight class="size-6" /></button>
      </div>
    </nav>
  </div>

  {#if showPages}
    <div class="fixed inset-0 z-50 flex flex-col bg-canvas" role="dialog" aria-modal="true" aria-label={t("remote.pages")}>
      <div class="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface px-3 pt-[env(safe-area-inset-top)]">
        <p class="flex-1 text-[15px] font-semibold">{t("remote.pages")}</p>
        <Button size="icon" variant="ghost" aria-label={t("common.close")} onclick={() => (showPages = false)}><X /></Button>
      </div>
      <div class="grid flex-1 grid-cols-2 content-start gap-3 overflow-y-auto p-3 pb-[calc(12px+env(safe-area-inset-bottom))] sm:grid-cols-3 md:grid-cols-4">
        {#each pages as p (p.index)}
          <button type="button" class="relative cursor-pointer overflow-hidden rounded-xl border-2 bg-surface-2 text-left {p.index === current ? 'border-ink' : 'border-transparent'}" aria-current={p.index === current ? "true" : undefined} onclick={() => jump(p.index)}>
            <img src={p.thumb} alt="" loading="lazy" class="w-full object-cover" style="aspect-ratio:{ratio}" draggable="false" />
            <span class="absolute top-1 left-1 rounded-md bg-black/60 px-1.5 text-[11px] leading-5 font-medium text-white tabular-nums">{p.index}</span>
            {#if p.title}<span class="block truncate px-2 py-1 text-[12px] text-ink-2">{p.title}</span>{/if}
          </button>
        {/each}
      </div>
    </div>
  {/if}
{/if}
