<script lang="ts">
  import type { Snippet } from "svelte";
  import { Dialog } from "bits-ui";
  import { X } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import DiscardConfirm from "./DiscardConfirm.svelte";
  import { CloseGuard, provideCloseGuard } from "./close-guard.svelte.ts";

  /**
   * Modal panel (the body collapses when `children` renders nothing, e.g. ConfirmDialog): a bottom sheet on phones, a side/center panel from `sm` up.
   * Unsaved-changes guard: once the user edits a field inside (or `dirty`/`busy` says so), dismissing via the backdrop,
   * Esc or the X asks "discard changes?" first. Closing by setting `open = false` (after a save) never asks.
   * Pass `guard={false}` for sheets whose inputs are only filters/search; search inputs and fields under `data-guard-ignore` never count.
   */
  let { open = $bindable(false), title, description, side = "bottom", children, footer, icon, hideTitle = false, onOpenAutoFocus, onCloseAutoFocus, guard = true, dirty = undefined, busy = false }: {
    open?: boolean;
    title: string;
    description?: string;
    side?: "bottom" | "right" | "center";
    children: Snippet;
    footer?: Snippet;
    /** Optional leading visual (e.g. a vendor tile) beside the title. */
    icon?: Snippet;
    hideTitle?: boolean;
    /** Passed to bits-ui; call `preventDefault()` to place focus yourself. */
    onOpenAutoFocus?: (e: Event) => void;
    onCloseAutoFocus?: (e: Event) => void;
    /** Ask before a user dismissal discards edits (default on). */
    guard?: boolean;
    /** Exact dirty state from forms that track it; replaces the automatic "a field was edited" detection. */
    dirty?: boolean;
    /** Work in progress (e.g. an upload) that closing would abandon; always asks. */
    busy?: boolean;
  } = $props();

  const closeGuard = new CloseGuard(() => ({ guard, dirty, busy }));
  provideCloseGuard(closeGuard);

  let content = $state<HTMLElement | null>(null);
  let lastFocus: HTMLElement | null = null;
  let wasOpen = false;
  $effect.pre(() => {
    if (open && !wasOpen) closeGuard.reset();
    wasOpen = open;
  });

  /** A user dismissal (backdrop, Esc, X): returns false (and asks) when edits would be lost. */
  function dismiss(e?: Event) {
    if (closeGuard.request()) return true;
    e?.preventDefault();
    return false;
  }

  function discard() {
    closeGuard.discard();
    open = false;
  }

  // Swipe-to-close (phones, where every side renders as a bottom sheet): dragging the grab handle / header down moves
  // the sheet with the finger; past a distance or flick-velocity threshold it goes through the same guard as the X,
  // otherwise (or when the guard asks first) it springs back. Reduced motion: no slide, it just closes / snaps back.
  let dragY = $state(0);
  let dragging = $state(false);
  let settling = $state(false);
  let drag: { id: number; y0: number; samples: { y: number; t: number }[] } | null = null;
  const reduceMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const phoneLayout = () => side === "bottom" || (typeof matchMedia === "function" && !matchMedia("(min-width: 640px)").matches);
  $effect.pre(() => {
    if (open) return;
    dragY = 0;
    dragging = settling = false;
    drag = null;
  });

  function dragStart(e: PointerEvent) {
    if (!phoneLayout() || (e.pointerType === "mouse" && e.button !== 0)) return;
    if ((e.target as Element | null)?.closest?.("button, a, input, textarea, select, [role=button]")) return;
    drag = { id: e.pointerId, y0: e.clientY, samples: [{ y: e.clientY, t: e.timeStamp }] };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    settling = false;
  }
  function dragMove(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y0;
    if (!dragging && Math.abs(dy) < 4) return;
    dragging = true;
    // Upward pulls get a little rubber-band resistance; the sheet never leaves its top edge by more than a few px.
    dragY = dy > 0 ? dy : -Math.min(12, Math.sqrt(-dy) * 2);
    drag.samples = [...drag.samples.filter(s => e.timeStamp - s.t < 100), { y: e.clientY, t: e.timeStamp }];
  }
  function dragEnd(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.id) return;
    const first = drag.samples[0]!;
    const velocity = e.timeStamp > first.t ? (e.clientY - first.y) / (e.timeStamp - first.t) : 0; // px/ms, + is down
    drag = null;
    if (!dragging) return;
    dragging = false;
    const height = content?.offsetHeight ?? 400;
    const pass = e.type === "pointerup" && (dragY > Math.min(140, height * 0.3) || (velocity > 0.6 && dragY > 24));
    const reduce = reduceMotion();
    settling = !reduce;
    if (pass && closeGuard.request()) {
      dragY = height + 24;
      setTimeout(() => (open = false), reduce ? 0 : 180);
    } else {
      dragY = 0;
      if (!reduce) setTimeout(() => (settling = false), 260);
    }
  }
  const dragStyle = $derived(
    dragging || settling || dragY ? `transform:translateY(${dragY}px);${settling ? "transition:transform 220ms cubic-bezier(.2,.8,.2,1)" : ""}` : undefined,
  );

  const position = {
    bottom: "inset-x-0 bottom-0 max-h-[88dvh] rounded-t-[28px] pb-[env(safe-area-inset-bottom)] data-[state=open]:animate-[sheet-up_220ms_cubic-bezier(.2,.8,.2,1)]",
    right: "inset-x-0 bottom-0 max-h-[88dvh] rounded-t-[28px] sm:inset-y-3 sm:right-3 sm:left-auto sm:max-h-none sm:w-[420px] sm:rounded-[24px] data-[state=open]:animate-[sheet-up_220ms_cubic-bezier(.2,.8,.2,1)] sm:data-[state=open]:animate-[sheet-left_220ms_cubic-bezier(.2,.8,.2,1)]",
    center: "inset-x-0 bottom-0 max-h-[88dvh] rounded-t-[28px] sm:inset-x-auto sm:top-1/2 sm:bottom-auto sm:left-1/2 sm:w-[min(520px,calc(100vw-32px))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-[24px] data-[state=open]:animate-[sheet-up_220ms_cubic-bezier(.2,.8,.2,1)] sm:data-[state=open]:animate-[pop-in_160ms_ease-out]",
  };
</script>

<Dialog.Root bind:open>
  <Dialog.Portal>
    <Dialog.Overlay
      style={dragY > 0 && content ? `opacity:${Math.max(0, 1 - dragY / content.offsetHeight)};${settling ? "transition:opacity 220ms ease" : ""}` : undefined}
      class="fixed inset-0 z-50 bg-[var(--overlay)] backdrop-blur-[2px] data-[state=open]:animate-[fade-in_160ms_ease-out]" />
    <Dialog.Content
      {onOpenAutoFocus}
      {onCloseAutoFocus}
      onEscapeKeydown={dismiss}
      onInteractOutside={dismiss}
      bind:ref={content}
      onfocusin={(e: FocusEvent) => {
        if (e.target instanceof HTMLElement) lastFocus = e.target;
      }}
      oninput={closeGuard.onFieldEvent}
      onchange={closeGuard.onFieldEvent}
      style={dragStyle}
      class="fixed z-50 flex flex-col overflow-hidden border border-line bg-surface shadow-pop outline-none {position[side]}">
      <!-- Drag region (phones): grab handle + header. touch-action:none so the browser doesn't scroll instead.
           Pointer-only enhancement: keyboard / screen-reader users close with Esc or the X button. -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="shrink-0 touch-none select-none max-sm:cursor-grab sm:touch-auto sm:select-auto {dragging ? 'max-sm:cursor-grabbing' : ''}"
        data-sheet-drag
        onpointerdown={dragStart}
        onpointermove={dragMove}
        onpointerup={dragEnd}
        onpointercancel={dragEnd}
      >
      <div class="mx-auto mt-2.5 h-1 w-10 shrink-0 rounded-full bg-line-2 sm:hidden" aria-hidden="true"></div>
      <div class="flex items-center justify-between gap-3 px-5 pt-3 pb-2 sm:px-6 sm:pt-5 {hideTitle ? 'sr-only' : ''}">
        <div class="flex min-w-0 items-center gap-3">
          {#if icon}{@render icon()}{/if}
          <div class="min-w-0">
          <Dialog.Title class="text-base font-semibold text-ink">{title}</Dialog.Title>
          {#if description}<Dialog.Description class="mt-0.5 text-[13px] text-ink-3">{description}</Dialog.Description>{/if}
          </div>
        </div>
        <button
          type="button"
          class="-mr-2 grid size-9 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink"
          aria-label={t("common.close")}
          onclick={() => {
            if (dismiss()) open = false;
          }}><X class="size-4.5" /></button
        >
      </div>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto px-5 pb-5 empty:hidden sm:px-6">{@render children()}</div>
      {#if footer}<div class="flex justify-end gap-2 border-t border-line px-5 py-3.5 sm:px-6">{@render footer()}</div>{/if}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

{#if guard}<DiscardConfirm guard={closeGuard} {busy} onDiscard={discard} returnFocus={() => (open ? (lastFocus?.isConnected ? lastFocus : content) : null)} />{/if}
