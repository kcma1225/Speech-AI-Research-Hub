<script lang="ts">
  import type { Snippet } from "svelte";
  import { Dialog } from "bits-ui";
  import { X } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";

  /** Like ui/Sheet (bottom sheet on phones) but a wide centred panel from `md` up, for previews and result lists. */
  let { open = $bindable(false), title, description, children, footer, header, onOpenAutoFocus, onOpenChange }: {
    open?: boolean;
    title: string;
    description?: string;
    children: Snippet;
    footer?: Snippet;
    /** Extra content under the title (e.g. a search field), outside the scroll area. */
    header?: Snippet;
    onOpenAutoFocus?: (e: Event) => void;
    onOpenChange?: (open: boolean) => void;
  } = $props();
</script>

<Dialog.Root bind:open {onOpenChange}>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-50 bg-[var(--overlay)] backdrop-blur-[2px] data-[state=open]:animate-[fade-in_160ms_ease-out]" />
    <Dialog.Content
      {onOpenAutoFocus}
      class="fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col overflow-hidden rounded-t-[28px] border border-line bg-surface pb-[env(safe-area-inset-bottom)] shadow-pop outline-none data-[state=open]:animate-[sheet-up_220ms_cubic-bezier(.2,.8,.2,1)] md:inset-x-auto md:top-1/2 md:bottom-auto md:left-1/2 md:max-h-[min(860px,calc(100dvh-48px))] md:w-[min(920px,calc(100vw-48px))] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-[24px] md:data-[state=open]:animate-[pop-in_160ms_ease-out]"
    >
      <div class="mx-auto mt-2.5 h-1 w-10 shrink-0 rounded-full bg-line-2 md:hidden" aria-hidden="true"></div>
      <div class="flex items-start justify-between gap-3 px-5 pt-3 pb-2 md:px-7 md:pt-6">
        <div class="min-w-0">
          <Dialog.Title class="text-base font-semibold text-ink md:text-[17px]">{title}</Dialog.Title>
          {#if description}<Dialog.Description class="mt-0.5 text-[13px] text-ink-3">{description}</Dialog.Description>{/if}
        </div>
        <Dialog.Close class="-mr-2 grid size-10 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label={t("common.close")}><X class="size-4.5" /></Dialog.Close>
      </div>
      {#if header}<div class="px-5 pb-3 md:px-7">{@render header()}</div>{/if}
      <div class="min-h-0 flex-1 overflow-y-auto px-5 pb-5 md:px-7">{@render children()}</div>
      {#if footer}<div class="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3.5 md:px-7">{@render footer()}</div>{/if}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
