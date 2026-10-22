<script lang="ts">
  import { DEFAULT_LIMITS, ratioAt, ratioForKey, type SplitLimits } from "#lib/workspace/split.ts";

  /**
   * Draggable separator between two side-by-side panes. Pointer drag (captured, so iframes underneath don't
   * steal the move), arrow keys / Home / End, double-click resets. The parent lays the panes out from `ratio`
   * and should disable pointer events on its iframes while `dragging`.
   */
  let {
    container,
    ratio = $bindable(0.5),
    dragging = $bindable(false),
    limits = DEFAULT_LIMITS,
    initial = 0.5,
    label,
    onCommit,
    class: cls = "",
  }: {
    container: HTMLElement | null;
    ratio?: number;
    dragging?: boolean;
    limits?: SplitLimits;
    /** Ratio a double-click restores. */
    initial?: number;
    label: string;
    /** Called once a drag or key press settles (persist the ratio here). */
    onCommit?: (ratio: number) => void;
    class?: string;
  } = $props();

  function down(event: PointerEvent) {
    if (event.button !== 0 || !container) return;
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    dragging = true;
  }
  function move(event: PointerEvent) {
    if (!dragging || !container) return;
    const rect = container.getBoundingClientRect();
    ratio = ratioAt(event.clientX, rect.left, rect.width, limits);
  }
  function up(event: PointerEvent) {
    if (!dragging) return;
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
    dragging = false;
    onCommit?.(ratio);
  }
  function key(event: KeyboardEvent) {
    const next = ratioForKey(event.key, ratio, event.shiftKey, limits);
    if (next === null) return;
    event.preventDefault();
    ratio = next;
    onCommit?.(ratio);
  }
</script>

<!-- A focusable separator is an interactive widget in ARIA (window splitter pattern). -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  role="separator"
  aria-orientation="vertical"
  aria-label={label}
  aria-valuemin={Math.round(limits.min * 100)}
  aria-valuemax={Math.round(limits.max * 100)}
  aria-valuenow={Math.round(ratio * 100)}
  tabindex="0"
  title={label}
  class="group/split relative z-10 w-3 shrink-0 cursor-col-resize touch-none outline-none select-none {cls}"
  onpointerdown={down}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={up}
  onkeydown={key}
  ondblclick={() => ((ratio = initial), onCommit?.(ratio))}
>
  <span class="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-line transition-colors group-hover/split:bg-line-2 group-focus-visible/split:bg-ink {dragging ? 'bg-ink' : ''}"></span>
  <span class="absolute top-1/2 left-1/2 h-10 w-1.5 -translate-1/2 rounded-full bg-line-2 opacity-0 transition-opacity group-hover/split:opacity-100 group-focus-visible/split:opacity-100 {dragging ? 'opacity-100' : ''}"></span>
</div>
