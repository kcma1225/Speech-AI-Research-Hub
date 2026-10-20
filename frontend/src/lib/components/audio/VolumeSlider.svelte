<script lang="ts">
  /** Horizontal 0–1 slider (custom, no native range input). */
  let { value, onChange, label, class: cls = "" }: { value: number; onChange: (v: number) => void; label: string; class?: string } = $props();
  let el = $state<HTMLDivElement | null>(null);
  let dragging = false;

  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  function at(clientX: number) {
    const r = el!.getBoundingClientRect();
    return clamp((clientX - r.left) / (r.width || 1));
  }
</script>

<div
  bind:this={el}
  role="slider"
  tabindex="0"
  aria-label={label}
  aria-valuemin={0}
  aria-valuemax={100}
  aria-valuenow={Math.round(value * 100)}
  aria-valuetext="{Math.round(value * 100)}%"
  class="group relative flex h-8 cursor-pointer touch-none items-center rounded-full select-none {cls}"
  onpointerdown={e => {
    if (e.button !== 0) return;
    el?.setPointerCapture(e.pointerId);
    dragging = true;
    onChange(at(e.clientX));
  }}
  onpointermove={e => dragging && onChange(at(e.clientX))}
  onpointerup={() => (dragging = false)}
  onpointercancel={() => (dragging = false)}
  onkeydown={e => {
    const step = e.shiftKey ? 0.2 : 0.05;
    const next = { ArrowLeft: value - step, ArrowDown: value - step, ArrowRight: value + step, ArrowUp: value + step, Home: 0, End: 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    onChange(clamp(next));
  }}
>
  <span class="relative h-1 w-full overflow-hidden rounded-full bg-line-2">
    <span class="absolute inset-y-0 left-0 rounded-full bg-ink" style="width:{value * 100}%"></span>
  </span>
  <span
    class="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink shadow-card transition-transform group-hover:scale-110"
    style="left:{value * 100}%"
  ></span>
</div>
