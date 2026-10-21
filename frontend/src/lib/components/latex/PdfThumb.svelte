<script lang="ts">
  import { onMount } from "svelte";
  import { FileText } from "@lucide/svelte";
  import { openPdf } from "#lib/latex/pdf.ts";

  /** First page of a compiled PDF, rendered when the card scrolls into view (pdf.js loads lazily). */
  let { url }: { url: string | null } = $props();
  let host: HTMLDivElement;
  let canvas = $state<HTMLCanvasElement | null>(null);
  let ready = $state(false);

  onMount(() => {
    if (!url) return;
    let cancelled = false;
    const render = async () => {
      try {
        const doc = await openPdf(url);
        const page = await doc.getPage(1);
        if (cancelled || !canvas) return;
        const width = host.clientWidth || 320;
        const base = page.getViewport({ scale: 1 });
        const scale = (width / base.width) * Math.min(window.devicePixelRatio || 1, 2);
        const viewport = page.getViewport({ scale });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        await page.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport }).promise;
        ready = true;
        void doc.close();
      } catch {
        ready = false;
      }
    };
    const observer = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) {
        observer.disconnect();
        void render();
      }
    });
    observer.observe(host);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  });
</script>

<div bind:this={host} class="relative size-full overflow-hidden bg-surface-2">
  {#if url}
    <canvas bind:this={canvas} class="block w-full bg-white transition-opacity duration-300 motion-reduce:transition-none {ready ? 'opacity-100' : 'opacity-0'}"></canvas>
  {/if}
  {#if !ready}
    <div class="absolute inset-0 grid place-items-center hero-gradient opacity-70"><FileText class="size-9 text-hero-ink opacity-45" /></div>
  {/if}
</div>
