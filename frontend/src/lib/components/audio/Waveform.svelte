<script lang="ts">
  import { formatClock } from "#lib/audio/time.ts";

  /**
   * Seekable waveform (an ARIA slider). Bars come from `peaks` (values in [0,1]); without peaks it draws flat bars.
   * Played bars use `--ink`, unplayed `--line-2`, the hover preview `--ink-3`.
   */
  let {
    peaks = null,
    duration,
    currentTime,
    onSeek,
    label,
    valueText,
    height = 72,
    barWidth = 2.5,
    gap = 1.5,
    class: cls = "",
  }: {
    peaks?: number[] | null;
    duration: number;
    currentTime: number;
    onSeek: (time: number) => void;
    label: string;
    valueText?: string;
    height?: number;
    barWidth?: number;
    gap?: number;
    class?: string;
  } = $props();

  const uid = $props.id();
  let width = $state(0);
  let hoverX = $state<number | null>(null);
  let dragging = $state(false);
  let el = $state<HTMLDivElement | null>(null);

  const count = $derived(Math.max(8, Math.floor((width + gap) / (barWidth + gap))));
  /** Bar heights in [0,1]: max of each bucket of the source peaks, lightly normalised so quiet files stay visible. */
  const bars = $derived.by(() => {
    if (!peaks?.length) return Array.from({ length: count }, () => 0.18);
    const out: number[] = [];
    const step = peaks.length / count;
    for (let i = 0; i < count; i++) {
      let m = 0;
      const from = Math.floor(i * step);
      const to = Math.max(from + 1, Math.floor((i + 1) * step));
      for (let j = from; j < to && j < peaks.length; j++) m = Math.max(m, peaks[j] ?? 0);
      out.push(m);
    }
    const top = Math.max(...out, 0.001);
    return out.map(v => Math.max(0.06, Math.min(1, v / top)));
  });
  const path = $derived.by(() => {
    const mid = height / 2;
    const usable = height - barWidth - 2;
    let d = "";
    bars.forEach((v, i) => {
      const x = i * (barWidth + gap) + barWidth / 2;
      const h = Math.max(0.5, (v * usable) / 2);
      d += `M${x.toFixed(2)} ${(mid - h).toFixed(2)}V${(mid + h).toFixed(2)}`;
    });
    return d;
  });

  const progress = $derived(duration > 0 ? Math.min(1, Math.max(0, currentTime / duration)) : 0);
  const playedX = $derived(progress * width);
  const hoverTime = $derived(hoverX === null || !width ? null : (hoverX / width) * duration);

  function timeAt(clientX: number) {
    const rect = el!.getBoundingClientRect();
    const x = Math.min(rect.width, Math.max(0, clientX - rect.left));
    return { x, time: rect.width ? (x / rect.width) * duration : 0 };
  }
  function pointerdown(e: PointerEvent) {
    if (!duration || e.button !== 0) return;
    el?.setPointerCapture(e.pointerId);
    dragging = true;
    const p = timeAt(e.clientX);
    hoverX = p.x;
    onSeek(p.time);
  }
  function pointermove(e: PointerEvent) {
    if (!duration) return;
    const p = timeAt(e.clientX);
    if (e.pointerType === "mouse" || dragging) hoverX = p.x;
    if (dragging) onSeek(p.time);
  }
  function pointerup(e: PointerEvent) {
    dragging = false;
    if (e.pointerType !== "mouse") hoverX = null;
  }
  function keydown(e: KeyboardEvent) {
    if (!duration) return;
    const small = 5;
    const big = Math.max(30, duration / 10);
    const map: Record<string, number> = {
      ArrowLeft: currentTime - small,
      ArrowDown: currentTime - small,
      ArrowRight: currentTime + small,
      ArrowUp: currentTime + small,
      PageDown: currentTime - big,
      PageUp: currentTime + big,
      Home: 0,
      End: duration,
    };
    if (!(e.key in map) || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    e.stopPropagation();
    onSeek(Math.min(duration, Math.max(0, map[e.key]!)));
  }
</script>

<div
  bind:this={el}
  bind:clientWidth={width}
  role="slider"
  tabindex="0"
  aria-label={label}
  aria-valuemin={0}
  aria-valuemax={Math.round(duration)}
  aria-valuenow={Math.round(currentTime)}
  aria-valuetext={valueText ?? `${formatClock(currentTime)} / ${formatClock(duration)}`}
  class="group relative w-full cursor-pointer touch-none rounded-lg select-none focus-visible:outline-offset-4 {cls}"
  style="height:{height}px"
  onpointerdown={pointerdown}
  onpointermove={pointermove}
  onpointerup={pointerup}
  onpointercancel={pointerup}
  onpointerleave={e => e.pointerType === "mouse" && !dragging && (hoverX = null)}
  onkeydown={keydown}
>
  {#if width}
    <svg {width} {height} viewBox="0 0 {width} {height}" class="block" aria-hidden="true">
      <defs>
        <clipPath id="wf-played-{uid}"><rect x="0" y="0" width={playedX} {height} /></clipPath>
        <clipPath id="wf-hover-{uid}">
          {#if hoverX !== null && hoverX > playedX}<rect x={playedX} y="0" width={hoverX - playedX} {height} />{/if}
        </clipPath>
      </defs>
      <path d={path} stroke="var(--line-2)" stroke-width={barWidth} stroke-linecap="round" fill="none" />
      <path d={path} stroke="var(--ink-3)" stroke-width={barWidth} stroke-linecap="round" fill="none" clip-path="url(#wf-hover-{uid})" />
      <path d={path} stroke="var(--ink)" stroke-width={barWidth} stroke-linecap="round" fill="none" clip-path="url(#wf-played-{uid})" />
    </svg>
    <!-- Playhead -->
    <span class="pointer-events-none absolute inset-y-0 w-px bg-ink/70" style="left:{playedX}px" aria-hidden="true"></span>
  {/if}
  {#if hoverTime !== null}
    <span
      class="pointer-events-none absolute -top-8 z-10 -translate-x-1/2 rounded-lg bg-primary px-2 py-1 text-[11.5px] font-medium text-primary-ink tabular-nums shadow-pop"
      style="left:{Math.min(width - 24, Math.max(24, hoverX ?? 0))}px"
      aria-hidden="true">{formatClock(hoverTime)}</span
    >
  {/if}
</div>
