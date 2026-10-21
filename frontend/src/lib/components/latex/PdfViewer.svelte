<script lang="ts">
  import { untrack } from "svelte";
  import { ChevronDown, ChevronUp, FileText, LoaderCircle, Maximize2, ZoomIn, ZoomOut } from "@lucide/svelte";
  import type { RenderTask } from "pdfjs-dist";
  import { t } from "#lib/i18n.svelte.ts";
  import { openPdf, pdfjs, type OpenPdf } from "#lib/latex/pdf.ts";
  import type { Rect } from "#lib/latex/synctex.ts";

  /**
   * PDF preview (pdf.js): pages render lazily as they scroll into view, each with a text layer (select/copy/search),
   * zoom (fit width or steps), page navigation, SyncTeX highlights (forward search) and double-click → `onInverse`
   * with the point in PDF points from the page's top-left. The scroll position survives a new PDF of the same project.
   */
  let { url, onInverse, class: cls = "" }: { url: string | null; onInverse?: (page: number, x: number, y: number) => void; class?: string } = $props();

  type PageSize = { w: number; h: number };
  let scroller = $state<HTMLDivElement | null>(null);
  let doc: OpenPdf | null = null;
  let sizes = $state<PageSize[]>([]);
  let loading = $state(false);
  let failed = $state<string | null>(null);
  let zoom = $state<"fit" | number>("fit");
  let width = $state(600);
  let current = $state(1);
  let highlights = $state<Rect[]>([]);
  let highlightKey = $state(0);
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  const pageEls: HTMLDivElement[] = [];
  const rendered = new Map<number, { scale: number; task: RenderTask | null }>();
  let observer: IntersectionObserver | null = null;
  const visible = new Set<number>();

  const maxWidth = $derived(sizes.reduce((m, s) => Math.max(m, s.w), 0) || 595);
  const scale = $derived(zoom === "fit" ? Math.max(0.3, (width - 32) / maxWidth) : zoom);

  // Container width (fit mode).
  $effect(() => {
    if (!scroller) return;
    const ro = new ResizeObserver(() => (width = scroller!.clientWidth));
    ro.observe(scroller);
    return () => ro.disconnect();
  });

  // Load a new document; keep the relative scroll position.
  let loadSeq = 0;
  $effect(() => {
    const next = url;
    untrack(() => void load(next));
  });
  async function load(next: string | null) {
    const seq = ++loadSeq;
    const fraction = scroller && scroller.scrollHeight > scroller.clientHeight ? scroller.scrollTop / (scroller.scrollHeight - scroller.clientHeight) : 0;
    if (!next) {
      void doc?.close();
      doc = null;
      sizes = [];
      return;
    }
    loading = true;
    failed = null;
    try {
      const d = await openPdf(next);
      if (seq !== loadSeq) return void d.close();
      const list: PageSize[] = [];
      for (let i = 1; i <= d.numPages; i++) {
        const v = (await d.getPage(i)).getViewport({ scale: 1 });
        list.push({ w: v.width, h: v.height });
      }
      if (seq !== loadSeq) return void d.close();
      for (const r of rendered.values()) r.task?.cancel();
      rendered.clear();
      const old = doc;
      doc = d;
      sizes = list;
      void old?.close();
      requestAnimationFrame(() => {
        if (scroller) scroller.scrollTop = fraction * (scroller.scrollHeight - scroller.clientHeight);
        observe();
        renderVisible();
      });
    } catch (e) {
      if (seq === loadSeq) failed = (e as Error).message;
    } finally {
      if (seq === loadSeq) loading = false;
    }
  }

  function observe() {
    observer?.disconnect();
    visible.clear();
    observer = new IntersectionObserver(
      entries => {
        for (const e of entries) {
          const n = Number((e.target as HTMLElement).dataset.page);
          if (e.isIntersecting) visible.add(n);
          else visible.delete(n);
        }
        if (visible.size) current = Math.min(...visible);
        renderVisible();
      },
      { root: scroller, rootMargin: "400px 0px" },
    );
    pageEls.forEach(el => el && observer!.observe(el));
  }
  $effect(() => () => {
    observer?.disconnect();
    void doc?.close();
  });

  // Re-render visible pages when the scale changes (debounced).
  let zoomTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    void scale;
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => untrack(renderVisible), 120);
  });

  function renderVisible() {
    for (const n of visible) void renderPage(n);
  }

  async function renderPage(n: number) {
    const el = pageEls[n - 1];
    if (!doc || !el) return;
    const s = scale;
    const prev = rendered.get(n);
    if (prev && Math.abs(prev.scale - s) < 0.001) return;
    prev?.task?.cancel();
    const entry = { scale: s, task: null as RenderTask | null };
    rendered.set(n, entry);
    try {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: s });
      const ratio = Math.min(window.devicePixelRatio || 1, 2.5);
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.className = "pdf-canvas";
      entry.task = page.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined });
      await entry.task.promise;
      if (rendered.get(n) !== entry) return;
      const text = document.createElement("div");
      text.className = "textLayer";
      el.style.setProperty("--total-scale-factor", String(s));
      const lib = await pdfjs();
      const layer = new lib.TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport });
      await layer.render();
      if (rendered.get(n) !== entry) return;
      el.querySelector(".pdf-canvas")?.remove();
      el.querySelector(".textLayer")?.remove();
      el.prepend(canvas);
      el.append(text);
    } catch (e) {
      if ((e as Error)?.name !== "RenderingCancelledException") rendered.delete(n);
    }
  }

  function goTo(n: number, offsetPt = 0) {
    const el = pageEls[n - 1];
    if (!el || !scroller) return;
    scroller.scrollTo({ top: el.offsetTop - 12 + offsetPt * scale, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }

  /** Forward search result: scroll to the first rectangle and flash every rectangle. */
  /** First visible page (AI layout review picks pages around it). */
  export function currentPage() {
    return current;
  }
  export function reveal(rects: Rect[]) {
    if (!rects.length) return;
    highlights = rects;
    highlightKey++;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => (highlights = []), 3000);
    goTo(rects[0]!.page, Math.max(0, rects[0]!.y - 80));
  }

  function dblclick(e: MouseEvent, n: number) {
    const el = pageEls[n - 1];
    if (!el || !onInverse) return;
    const box = el.getBoundingClientRect();
    onInverse(n, (e.clientX - box.left) / scale, (e.clientY - box.top) / scale);
  }

  function setZoom(next: "fit" | number) {
    zoom = next === "fit" ? "fit" : Math.min(4, Math.max(0.4, Math.round(next * 10) / 10));
  }
</script>

<div class="flex min-h-0 flex-col {cls}">
  <div class="flex h-11 shrink-0 items-center gap-1 border-b border-line bg-surface-2/70 px-1.5">
    <button type="button" class="tool" aria-label={t("latex.pdf.prev")} title={t("latex.pdf.prev")} disabled={current <= 1} onclick={() => goTo(current - 1)}><ChevronUp class="size-4" /></button>
    <button type="button" class="tool" aria-label={t("latex.pdf.next")} title={t("latex.pdf.next")} disabled={current >= sizes.length} onclick={() => goTo(current + 1)}><ChevronDown class="size-4" /></button>
    <span class="px-1 text-[12.5px] text-ink-2 tabular-nums" aria-live="polite">{sizes.length ? t("latex.pdf.page", { n: current, total: sizes.length }) : ""}</span>
    <div class="ml-auto flex items-center gap-1">
      {#if loading}<LoaderCircle class="size-4 animate-spin text-ink-3 motion-reduce:animate-none" />{/if}
      <button type="button" class="tool" aria-label={t("latex.pdf.zoomOut")} title={t("latex.pdf.zoomOut")} onclick={() => setZoom(scale - 0.15)}><ZoomOut class="size-4" /></button>
      <span class="w-11 text-center text-[12px] text-ink-3 tabular-nums">{Math.round(scale * 100)}%</span>
      <button type="button" class="tool" aria-label={t("latex.pdf.zoomIn")} title={t("latex.pdf.zoomIn")} onclick={() => setZoom(scale + 0.15)}><ZoomIn class="size-4" /></button>
      <button type="button" class="tool {zoom === 'fit' ? 'bg-surface-3 text-ink' : ''}" aria-pressed={zoom === "fit"} aria-label={t("latex.pdf.fit")} title={t("latex.pdf.fit")} onclick={() => setZoom("fit")}><Maximize2 class="size-4" /></button>
    </div>
  </div>
  <div bind:this={scroller} class="pdf-scroller relative min-h-0 flex-1 overflow-auto bg-surface-3/60 px-4 py-3" role="region" aria-label={t("latex.pdf")}>
    {#if failed}
      <p class="m-6 text-center text-[13px] text-danger">{failed}</p>
    {:else if !url}
      <div class="grid h-full place-items-center text-center text-ink-3">
        <div class="flex flex-col items-center gap-2 px-6 py-10"><FileText class="size-8 opacity-50" /><p class="text-[14px] font-medium text-ink-2">{t("latex.pdf.empty")}</p><p class="text-[12.5px]">{t("latex.pdf.emptyHint")}</p></div>
      </div>
    {/if}
    {#each sizes as size, i (i)}
      <div
        bind:this={pageEls[i]}
        data-page={i + 1}
        class="pdf-page relative mx-auto mb-3 bg-white shadow-card"
        style="width:{size.w * scale}px;height:{size.h * scale}px"
        ondblclick={e => dblclick(e, i + 1)}
        role="presentation"
      >
        {#key highlightKey}
          {#each highlights.filter(h => h.page === i + 1) as h, j (j)}
            <span class="sync-flash pointer-events-none absolute z-10 rounded-[3px]" style="left:{h.x * scale - 2}px;top:{h.y * scale - 2}px;width:{h.width * scale + 4}px;height:{h.height * scale + 4}px"></span>
          {/each}
        {/key}
      </div>
    {/each}
  </div>
</div>

<style>
  .tool {
    display: grid;
    width: 2.5rem;
    height: 2.5rem;
    place-items: center;
    border-radius: 9999px;
    color: var(--ink-2);
  }
  @media (min-width: 1024px) {
    .tool {
      width: 2rem;
      height: 2rem;
    }
  }
  .tool:hover:not(:disabled) {
    background: var(--surface-3);
    color: var(--ink);
  }
  .tool:disabled {
    opacity: 0.35;
  }
  .pdf-page :global(.pdf-canvas) {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
  .pdf-page :global(.textLayer) {
    position: absolute;
    inset: 0;
    overflow: clip;
    opacity: 1;
    line-height: 1;
    text-align: initial;
    transform-origin: 0 0;
    z-index: 2;
    --scale-round-x: 1px;
    --scale-round-y: 1px;
    --min-font-size: 1;
    --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
    --min-font-size-inv: calc(1 / var(--min-font-size));
  }
  .pdf-page :global(.textLayer :is(span, br)) {
    color: transparent;
    position: absolute;
    white-space: pre;
    cursor: text;
    transform-origin: 0% 0%;
  }
  .pdf-page :global(.textLayer > :not(.markedContent)),
  .pdf-page :global(.textLayer .markedContent span:not(.markedContent)) {
    z-index: 1;
    --font-height: 0;
    font-size: calc(var(--text-scale-factor) * var(--font-height));
    --scale-x: 1;
    --rotate: 0deg;
    transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));
  }
  .pdf-page :global(.textLayer .markedContent) {
    display: contents;
  }
  .pdf-page :global(.textLayer ::selection) {
    background: color-mix(in srgb, var(--pill-sky-ink) 30%, transparent);
    color: transparent;
  }
  .pdf-page :global(.textLayer .endOfContent) {
    display: block;
    position: absolute;
    inset: 100% 0 0;
    z-index: 0;
    cursor: default;
    user-select: none;
  }
  .sync-flash {
    background: color-mix(in srgb, var(--pill-butter-ink) 28%, transparent);
    outline: 2px solid color-mix(in srgb, var(--pill-butter-ink) 70%, transparent);
    animation: flash 2.6s ease-out forwards;
  }
  @keyframes flash {
    0%,
    60% {
      opacity: 1;
    }
    100% {
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .sync-flash {
      animation: none;
      opacity: 0.9;
    }
  }
</style>
