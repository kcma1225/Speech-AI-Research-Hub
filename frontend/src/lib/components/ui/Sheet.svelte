<script lang="ts">
  import type { Snippet } from "svelte";
  import { Dialog } from "bits-ui";
  import { X } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";

  /** Modal panel: a bottom sheet on phones, a side/center panel from `sm` up. */
  let { open = $bindable(false), title, description, side = "bottom", children, footer, hideTitle = false }: {
    open?: boolean;
    title: string;
    description?: string;
    side?: "bottom" | "right" | "center";
    children: Snippet;
    footer?: Snippet;
    hideTitle?: boolean;
  } = $props();

  const position = {
    bottom: "inset-x-0 bottom-0 max-h-[88dvh] rounded-t-[28px] pb-[env(safe-area-inset-bottom)] data-[state=open]:animate-[sheet-up_220ms_cubic-bezier(.2,.8,.2,1)]",
    right: "inset-x-0 bottom-0 max-h-[88dvh] rounded-t-[28px] sm:inset-y-3 sm:right-3 sm:left-auto sm:max-h-none sm:w-[420px] sm:rounded-[24px] data-[state=open]:animate-[sheet-up_220ms_cubic-bezier(.2,.8,.2,1)] sm:data-[state=open]:animate-[sheet-left_220ms_cubic-bezier(.2,.8,.2,1)]",
    center: "inset-x-0 bottom-0 max-h-[88dvh] rounded-t-[28px] sm:inset-x-auto sm:top-1/2 sm:bottom-auto sm:left-1/2 sm:w-[min(520px,calc(100vw-32px))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-[24px] data-[state=open]:animate-[sheet-up_220ms_cubic-bezier(.2,.8,.2,1)] sm:data-[state=open]:animate-[pop-in_160ms_ease-out]",
  };
</script>

<Dialog.Root bind:open>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-50 bg-[var(--overlay)] backdrop-blur-[2px] data-[state=open]:animate-[fade-in_160ms_ease-out]" />
    <Dialog.Content class="fixed z-50 flex flex-col overflow-hidden border border-line bg-surface shadow-pop outline-none {position[side]}">
      {#if side !== "center"}<div class="mx-auto mt-2.5 h-1 w-10 shrink-0 rounded-full bg-line-2 sm:hidden" aria-hidden="true"></div>{/if}
      <div class="flex items-center justify-between gap-3 px-5 pt-3 pb-2 sm:px-6 sm:pt-5 {hideTitle ? 'sr-only' : ''}">
        <div>
          <Dialog.Title class="text-base font-semibold text-ink">{title}</Dialog.Title>
          {#if description}<Dialog.Description class="mt-0.5 text-[13px] text-ink-3">{description}</Dialog.Description>{/if}
        </div>
        <Dialog.Close class="-mr-2 grid size-9 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label={t("common.close")}><X class="size-4.5" /></Dialog.Close>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto px-5 pb-5 sm:px-6">{@render children()}</div>
      {#if footer}<div class="flex justify-end gap-2 border-t border-line px-5 py-3.5 sm:px-6">{@render footer()}</div>{/if}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
