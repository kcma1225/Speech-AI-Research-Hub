<script lang="ts">
  import { fromSlide, type Box } from "#lib/slides/laser.ts";

  /**
   * Laser pointer drawn above a slide (the deck iframe or a page image), outside the deck: it works for
   * every rendered deck without touching its HTML and never takes pointer events, so the deck's own
   * annotate tools keep working underneath. Same look as the annotate plugin's laser (dot, fading trail
   * with glow; no trail with reduced motion). Points are slide fractions (see `laser.ts`).
   */
  let { box, class: cls = "" }: { box: () => Box | null; class?: string } = $props();

  const TRAIL_MS = 450; // as in the annotate plugin
  let root = $state<HTMLDivElement | null>(null);
  let canvas = $state<HTMLCanvasElement | null>(null);
  let dot = $state<HTMLSpanElement | null>(null);
  let on = $state(false);
  let down = $state(false);
  let last: { x: number; y: number } | null = null;
  let trail: { x: number; y: number; t: number; gap: boolean }[] = [];
  let frame = 0;
  const reduced = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;

  /** Slide box relative to the overlay. */
  function local(): Box | null {
    const b = box();
    const r = root?.getBoundingClientRect();
    if (!b || !r || b.width <= 0 || b.height <= 0) return null;
    return { left: b.left - r.left, top: b.top - r.top, width: b.width, height: b.height };
  }

  function placeDot() {
    const b = last && local();
    if (!dot || !b || !last) return;
    const p = fromSlide(b, last.x, last.y);
    dot.style.transform = `translate(${p.x}px,${p.y}px)`;
  }

  function draw() {
    frame = 0;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const now = performance.now();
    trail = trail.filter(p => now - p.t < TRAIL_MS);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const b = local();
    if (!b) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (let i = 1; i < trail.length; i++) {
      const a = trail[i - 1]!;
      const c = trail[i]!;
      if (c.gap) continue;
      const life = 1 - (now - c.t) / TRAIL_MS;
      const p = fromSlide(b, a.x, a.y);
      const q = fromSlide(b, c.x, c.y);
      ctx.strokeStyle = `rgba(255,40,40,${(life * 0.85).toFixed(3)})`;
      ctx.lineWidth = 2 + life * 5;
      ctx.shadowColor = "rgba(255,30,30,.9)";
      ctx.shadowBlur = 10 * life;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(q.x, q.y);
      ctx.stroke();
    }
    if (trail.length) frame = requestAnimationFrame(draw);
  }

  /** Show the laser at slide fraction (x, y). A new trail segment starts after a hide or a press. */
  export function point(x: number, y: number, pressed: boolean) {
    if (!local()) return hide(); // nothing to point at (no slide box yet)
    const gap = !on || (pressed && !down);
    on = true;
    down = pressed;
    last = { x, y };
    placeDot();
    if (reduced?.matches) return;
    trail.push({ x, y, t: performance.now(), gap });
    cancelAnimationFrame(frame);
    draw();
  }

  export function hide() {
    on = false;
    down = false;
    last = null;
    trail = [];
    cancelAnimationFrame(frame);
    frame = 0;
    const ctx = canvas?.getContext("2d");
    if (canvas && ctx) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  /** Re-place after the slide box moved without the overlay resizing (e.g. the deck reported a new scale). */
  export function refresh() {
    placeDot();
    if (trail.length && !frame) draw();
  }

  $effect(() => {
    const el = root;
    const c = canvas;
    if (!el || !c) return;
    const fit = () => {
      const dpr = window.devicePixelRatio || 1;
      c.width = Math.max(1, Math.round(el.clientWidth * dpr));
      c.height = Math.max(1, Math.round(el.clientHeight * dpr));
      placeDot();
      draw();
    };
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    fit();
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  });
</script>

<div bind:this={root} class="pointer-events-none absolute inset-0 overflow-hidden {cls}" aria-hidden="true">
  <canvas bind:this={canvas} class="absolute inset-0 size-full"></canvas>
  <span bind:this={dot} class="laser-dot" class:is-on={on} class:is-down={down}></span>
</div>

<style>
  /* Copied from the annotate plugin's .annotate-laser-dot so both lasers look the same. */
  .laser-dot {
    position: absolute;
    top: 0;
    left: 0;
    width: 14px;
    height: 14px;
    margin: -7px 0 0 -7px;
    border-radius: 50%;
    opacity: 0;
    background: radial-gradient(circle, #fff 0 18%, #ff3030 38%, rgba(255, 40, 40, 0.55) 62%, rgba(255, 40, 40, 0) 72%);
    box-shadow: 0 0 10px 3px rgba(255, 40, 40, 0.75), 0 0 22px 8px rgba(255, 40, 40, 0.3);
    transition: width 0.08s, height 0.08s, margin 0.08s;
  }
  .laser-dot.is-on { opacity: 1; }
  .laser-dot.is-down {
    width: 20px;
    height: 20px;
    margin: -10px 0 0 -10px;
    box-shadow: 0 0 14px 5px rgba(255, 40, 40, 0.85), 0 0 30px 12px rgba(255, 40, 40, 0.35);
  }
  @media (prefers-reduced-motion: reduce) {
    .laser-dot { transition: none; }
  }
</style>
