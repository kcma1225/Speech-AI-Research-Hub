<script lang="ts">
  import { untrack } from "svelte";
  import { ChevronLeft, ChevronRight, Minus, Pause, Play, Plus, Presentation, RotateCcw, Timer } from "@lucide/svelte";
  import { page as appPage } from "$app/state";
  import { api, ApiError } from "#lib/api.ts";
  import { i18n, t } from "#lib/i18n.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import EmptyState from "#lib/components/ui/EmptyState.svelte";
  import Spinner from "#lib/components/ui/Spinner.svelte";
  import Switch from "#lib/components/ui/Switch.svelte";
  import { loadManifest, notesHtml, preload } from "#lib/slides/pages.ts";
  import { deckChannel, type DeckChannel } from "#lib/slides/sync.ts";
  import type { PageManifest, SlideDetail, SlideVersion } from "#lib/slides/types.ts";

  // Speaker window (opened by the player with S). Same Hub origin as the player, so the two windows
  // follow each other through a BroadcastChannel. Loads the deck through the player routes, so it works
  // for share-link (`?key=`) and public viewers too.
  const slug = $derived(appPage.params.slug!);
  const key = $derived(appPage.url.searchParams.get("key"));
  const wanted = $derived(appPage.url.searchParams.get("v"));

  let detail = $state<SlideDetail | null>(null);
  let version = $state<SlideVersion | null>(null);
  let manifest = $state<PageManifest | null>(null);
  let error = $state<{ status: number; message: string } | null>(null);
  let current = $state(Math.max(1, Number(appPage.url.searchParams.get("p")) || 1));
  let peer = $state(false);

  $effect(() => {
    const path = `/slides/by-slug/${encodeURIComponent(slug)}${key ? `?key=${encodeURIComponent(key)}` : ""}`;
    untrack(() => {
      api.get<SlideDetail>(path).then(
        async d => {
          detail = d;
          version = d.versions.find(v => v.id === wanted && v.status === "published") ?? d.activeVersion;
          if (version?.pagesUrl) manifest = await loadManifest(version.pagesUrl).catch(() => null);
        },
        e => (error = { status: e instanceof ApiError ? e.status : 0, message: (e as Error).message }),
      );
    });
  });

  const pages = $derived(manifest?.pages ?? []);
  const total = $derived(manifest?.pageCount ?? 0);
  const now = $derived(pages.find(p => p.index === current) ?? null);
  const next = $derived(pages.find(p => p.index === current + 1) ?? null);
  const notes = $derived(notesHtml(now));
  const ratio = $derived(manifest ? `${manifest.width} / ${manifest.height}` : "16 / 9");

  // Quarto decks: the current slide is the live deck (crisp, all fragments shown), not driven by the
  // pointer or keys (pointer-events off, Reveal keyboard off) and moved through Reveal's postMessage API.
  // Same sandbox as the player: never add allow-same-origin.
  // `?receiver` (Reveal's own speaker-view convention) keeps the annotate plugin's toolbar out of it.
  const liveSrc = $derived(version?.sourceType === "quarto" && version.viewUrl ? `${version.viewUrl}${version.viewUrl.includes("?") ? "&" : "?"}receiver` : null);
  let frame = $state<HTMLIFrameElement | null>(null);
  let frameReady = $state(false);
  const reveal = (method: string, args: unknown[] = []) => frame?.contentWindow?.postMessage(JSON.stringify({ method, args }), "*");
  function showInFrame(n: number) {
    const target = pages.find(p => p.index === n);
    if (target?.h !== undefined) reveal("slide", [target.h, target.v ?? 0]);
    else if (!manifest) reveal("slide", [n - 1, 0]);
  }
  $effect(() => {
    const n = current;
    if (frameReady) untrack(() => showInFrame(n));
  });
  function onFrameMessage(event: MessageEvent) {
    if (!frame || event.source !== frame.contentWindow || typeof event.data !== "string" || event.data.length > 100_000) return;
    let data: { namespace?: unknown; eventName?: unknown };
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    if (data?.namespace !== "reveal" || data.eventName !== "ready") return;
    reveal("configure", [{ fragments: false, controls: false, progress: false, keyboard: false, touch: false, slideNumber: false, overview: false, help: false }]);
    frameReady = true;
    showInFrame(current);
  }
  $effect(() => {
    preload(pages.find(p => p.index === current + 1)?.full);
    preload(pages.find(p => p.index === current + 2)?.thumb);
  });

  // ---- Sync with the player window ------------------------------------------------------------
  let channel: DeckChannel | null = null;
  $effect(() => {
    const id = version?.id;
    if (!id) return;
    const ch = deckChannel(slug, id, "speaker", m => {
      if (m.type === "bye") return void (peer = false);
      peer = true;
      if (m.type === "page") current = m.page;
    });
    channel = ch;
    ch?.hello();
    const bye = () => ch?.close();
    window.addEventListener("pagehide", bye);
    return () => {
      window.removeEventListener("pagehide", bye);
      ch?.close();
      channel = null;
    };
  });
  const clamp = (n: number) => Math.min(Math.max(1, n), total || n);
  function goto(n: number) {
    current = clamp(n);
    channel?.page(current);
  }
  /** With a player listening, it decides (quarto decks step through fragments); otherwise move here. */
  function step(dir: 1 | -1) {
    if (peer && channel) channel.step(dir);
    else goto(current + dir);
  }

  // ---- Timer (survives a reload of this window) ------------------------------------------------
  const timerKey = $derived(`hub-speaker-timer:${slug}`);
  let startedAt = $state<number | null>(null); // epoch ms while running
  let banked = $state(0); // ms accumulated before the current run
  let targetOn = $state(false);
  let targetMin = $state(20);
  let tickNow = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => (tickNow = Date.now()), 250);
    return () => clearInterval(timer);
  });
  $effect(() => {
    const k = timerKey;
    untrack(() => {
      try {
        const saved = JSON.parse(sessionStorage.getItem(k) ?? "null") as { startedAt: number | null; banked: number; targetOn: boolean; targetMin: number } | null;
        if (saved) ({ startedAt, banked, targetOn, targetMin } = saved);
      } catch {}
    });
  });
  $effect(() => {
    const state = JSON.stringify({ startedAt, banked, targetOn, targetMin });
    try {
      sessionStorage.setItem(timerKey, state);
    } catch {}
  });
  const elapsed = $derived(banked + (startedAt ? tickNow - startedAt : 0));
  const over = $derived(targetOn && elapsed > targetMin * 60_000);
  const nearEnd = $derived(targetOn && !over && elapsed > targetMin * 60_000 - 2 * 60_000);
  function toggleTimer() {
    if (startedAt) {
      banked += Date.now() - startedAt;
      startedAt = null;
    } else startedAt = Date.now();
  }
  function resetTimer() {
    banked = 0;
    startedAt = null;
  }
  const fmt = (ms: number) => {
    const s = Math.floor(Math.abs(ms) / 1000);
    const h = Math.floor(s / 3600);
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  };
  const clock = $derived(new Intl.DateTimeFormat(i18n.locale, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(tickNow));

  function onKey(e: KeyboardEvent) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    if (target?.closest("[role=switch],button") && (e.key === " " || e.key === "Enter")) return;
    const k = e.key;
    let handled = true;
    if (k === "ArrowRight" || k === "ArrowDown" || k === "PageDown" || (k === " " && !e.shiftKey)) step(1);
    else if (k === "ArrowLeft" || k === "ArrowUp" || k === "PageUp" || (k === " " && e.shiftKey)) step(-1);
    else if (k === "Home") goto(1);
    else if (k === "End" && total) goto(total);
    else if (k === "t" || k === "T") toggleTimer();
    else handled = false;
    if (handled) e.preventDefault();
  }

  const navBtn = "grid size-11 shrink-0 cursor-pointer place-items-center rounded-full border border-line bg-surface text-ink transition-colors hover:bg-surface-2 disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-5";
</script>

<svelte:window onkeydown={onKey} onmessage={onFrameMessage} />
<svelte:head><title>{t("slides.speaker.title")}{detail ? ` · ${detail.project.title}` : ""}</title></svelte:head>

<div class="flex h-dvh flex-col bg-canvas text-ink">
  <header class="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-3 sm:px-5">
    <span class="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-3 text-ink-2"><Presentation class="size-4" /></span>
    <div class="min-w-0 flex-1">
      <h1 class="truncate text-[14px] font-semibold">{detail?.project.title ?? t("slides.speaker.title")}</h1>
      <p class="flex items-center gap-1.5 text-[11.5px] text-ink-3">
        <span class="size-1.5 rounded-full {peer ? 'bg-success' : 'bg-line-2'}"></span>
        {peer ? t("slides.speaker.linked") : t("slides.speaker.unlinked")}
      </p>
    </div>
    <span class="text-[15px] font-medium text-ink-2 tabular-nums" aria-label={t("slides.speaker.clock")}>{clock}</span>
  </header>

  {#if error}
    <div class="grid flex-1 place-items-center p-6">
      <EmptyState title={error.status === 404 ? t("slides.notFound") : t("slides.loadError")} hint={error.status === 404 ? undefined : error.message}>{#snippet icon()}<Presentation />{/snippet}</EmptyState>
    </div>
  {:else if !detail}
    <div class="grid flex-1 place-items-center text-ink-3"><Spinner class="size-5" /></div>
  {:else if !version}
    <div class="grid flex-1 place-items-center p-6">
      <EmptyState title={t("slides.noDeck")}>{#snippet icon()}<Presentation />{/snippet}</EmptyState>
    </div>
  {:else}
    <main class="grid min-h-0 flex-1 gap-3 overflow-y-auto p-3 sm:gap-4 sm:p-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(320px,1fr)] lg:overflow-hidden">
      <!-- Current page -->
      <section class="flex min-h-0 flex-col gap-3">
        <div class="relative min-h-0 flex-1 overflow-hidden rounded-[22px] border border-line/70 bg-surface-2 shadow-card max-lg:aspect-[var(--r)] max-lg:flex-none" style="--r:{ratio}">
          {#if liveSrc}
            <iframe
              bind:this={frame}
              src={liveSrc}
              title={detail.project.title}
              sandbox="allow-scripts"
              referrerpolicy="no-referrer"
              tabindex="-1"
              class="pointer-events-none absolute inset-0 size-full border-0 transition-opacity {frameReady ? 'opacity-100' : 'opacity-0'}"
            ></iframe>
          {:else if now}
            {#key now.index}
              <img src={now.full ?? now.thumb} alt={now.title ?? t("slides.player.pageAlt", { n: now.index })} class="absolute inset-0 size-full object-contain" />
            {/key}
          {:else}
            <div class="absolute inset-0 grid place-items-center p-6 text-center">
              <div>
                <p class="font-display text-[56px] leading-none tabular-nums">{current}</p>
                <p class="mt-3 text-[13px] text-ink-3">{t("slides.speaker.noPreview")}</p>
              </div>
            </div>
          {/if}
        </div>
        <div class="flex items-center gap-3">
          <button type="button" class={navBtn} aria-label={t("slides.player.prev")} disabled={!peer && current <= 1} onclick={() => step(-1)}><ChevronLeft /></button>
          <div class="min-w-0 flex-1 text-center">
            <p class="text-[15px] font-semibold tabular-nums">{total ? t("slides.player.counter", { n: current, total }) : current}</p>
            {#if now?.title}<p class="truncate text-[12.5px] text-ink-3">{now.title}</p>{/if}
          </div>
          <button type="button" class={navBtn} aria-label={t("slides.player.next")} disabled={!peer && total > 0 && current >= total} onclick={() => step(1)}><ChevronRight /></button>
        </div>
      </section>

      <!-- Next page, timer, notes -->
      <aside class="flex min-h-0 flex-col gap-3 sm:gap-4">
        <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3 lg:grid-cols-1">
          <div class="rounded-[22px] border border-line/70 bg-surface p-3 shadow-card">
            <p class="mb-2 px-1 text-[12px] font-medium text-ink-3">{t("slides.speaker.next")}</p>
            <div class="relative max-h-[30dvh] overflow-hidden rounded-xl bg-surface-2" style="aspect-ratio:{ratio}">
              {#if next}
                <img src={next.thumb} alt={next.title ?? t("slides.player.pageAlt", { n: next.index })} class="absolute inset-0 size-full object-contain" />
              {:else}
                <p class="absolute inset-0 grid place-items-center text-[12.5px] text-ink-3">{total && current >= total ? t("slides.speaker.end") : "—"}</p>
              {/if}
            </div>
          </div>

          <div class="flex flex-col rounded-[22px] border p-4 shadow-card transition-colors {over ? 'border-danger bg-danger-soft' : 'border-line/70 bg-surface'}">
            <div class="flex items-center justify-between gap-2">
              <p class="inline-flex items-center gap-1.5 text-[12px] font-medium {over ? 'text-danger' : 'text-ink-3'}"><Timer class="size-3.5" />{over ? t("slides.speaker.over") : t("slides.speaker.elapsed")}</p>
              <span class="text-[11px] text-ink-3">T</span>
            </div>
            <p class="mt-1 font-display text-[44px] leading-none tabular-nums sm:text-[52px] {over ? 'text-danger' : nearEnd ? 'text-[var(--pill-butter-ink)]' : 'text-ink'}" role="timer" aria-live="off">{fmt(elapsed)}</p>
            {#if targetOn}
              <p class="mt-1.5 text-[12.5px] tabular-nums {over ? 'font-medium text-danger' : 'text-ink-3'}">
                {over ? t("slides.speaker.overBy", { time: fmt(elapsed - targetMin * 60_000) }) : t("slides.speaker.remaining", { time: fmt(targetMin * 60_000 - elapsed) })}
              </p>
            {/if}
            <div class="mt-3 flex flex-wrap items-center gap-2">
              <Button size="sm" variant="primary" onclick={toggleTimer}>{#if startedAt}<Pause />{t("slides.speaker.pause")}{:else}<Play />{elapsed ? t("slides.speaker.resume") : t("slides.speaker.start")}{/if}</Button>
              <Button size="sm" variant="ghost" disabled={!elapsed} onclick={resetTimer}><RotateCcw />{t("slides.speaker.reset")}</Button>
            </div>
            <div class="mt-3 flex items-center gap-2 border-t border-line pt-3 {over ? 'border-danger/30' : ''}">
              <Switch bind:checked={targetOn} label={t("slides.speaker.target")} />
              <span class="text-[12.5px] text-ink-2">{t("slides.speaker.target")}</span>
              <div class="ml-auto flex items-center gap-1 {targetOn ? '' : 'opacity-50'}">
                <button type="button" class="grid size-7 cursor-pointer place-items-center rounded-full text-ink-2 hover:bg-surface-3 disabled:opacity-40 [&_svg]:size-3.5" aria-label={t("slides.speaker.less")} disabled={!targetOn || targetMin <= 1} onclick={() => (targetMin = Math.max(1, targetMin - (targetMin > 10 ? 5 : 1)))}><Minus /></button>
                <span class="min-w-[4.5em] text-center text-[12.5px] font-medium tabular-nums">{t("slides.speaker.minutes", { n: targetMin })}</span>
                <button type="button" class="grid size-7 cursor-pointer place-items-center rounded-full text-ink-2 hover:bg-surface-3 disabled:opacity-40 [&_svg]:size-3.5" aria-label={t("slides.speaker.more")} disabled={!targetOn || targetMin >= 180} onclick={() => (targetMin = Math.min(180, targetMin + (targetMin >= 10 ? 5 : 1)))}><Plus /></button>
              </div>
            </div>
          </div>
        </div>

        <div class="flex min-h-[160px] flex-1 flex-col overflow-hidden rounded-[22px] border border-line/70 bg-surface shadow-card">
          <p class="border-b border-line px-4 py-2.5 text-[12px] font-medium text-ink-3">{t("slides.player.notes")}</p>
          <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-[17px] leading-relaxed text-ink-2">
            {#if notes}
              <div class="speaker-notes">{@html notes}</div>
            {:else if now?.notes}
              <p class="whitespace-pre-wrap">{now.notes.text}</p>
            {:else}
              <p class="text-[14px] text-ink-3">{t("slides.player.noNotes")}</p>
            {/if}
          </div>
        </div>
      </aside>
    </main>

    {#if pages.length}
      <div class="flex shrink-0 gap-2 overflow-x-auto border-t border-line bg-surface px-3 py-2 [scrollbar-width:thin] sm:px-4">
        {#each pages as p (p.index)}
          <button
            type="button"
            class="relative h-12 shrink-0 cursor-pointer overflow-hidden rounded-lg border-2 bg-surface-2 {p.index === current ? 'border-ink' : 'border-transparent opacity-70 hover:opacity-100'}"
            style="aspect-ratio:{ratio}"
            aria-label={t("slides.player.goto", { n: p.index })}
            aria-current={p.index === current ? "true" : undefined}
            onclick={() => goto(p.index)}
          >
            <img src={p.thumb} alt="" loading="lazy" class="size-full object-cover" />
            <span class="absolute bottom-0.5 left-0.5 rounded bg-black/55 px-1 text-[9.5px] leading-[14px] font-medium text-white tabular-nums">{p.index}</span>
          </button>
        {/each}
      </div>
    {/if}
  {/if}
</div>
