<script lang="ts">
  import { Trash2 } from "@lucide/svelte";
  import { toasts } from "./toast.svelte.ts";

  /**
   * Visible 刪除 action for list rows, cards and detail headers. `labelled` shows the text (detail headers);
   * otherwise a 40 px trash icon. `reveal`: inside a `.group` row it appears on hover / keyboard focus, and is always
   * visible on touch screens. Without permission (`reason`) it stays visible but dimmed (`aria-disabled`): the tooltip
   * and a tap explain why instead of doing nothing.
   */
  let { label, reason = null, labelled = false, reveal = false, onclick, class: cls = "" }: {
    label: string;
    reason?: string | null;
    labelled?: boolean;
    reveal?: boolean;
    onclick: () => void;
    class?: string;
  } = $props();

  function click(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (reason) toasts.show(reason);
    else onclick();
  }
</script>

<button
  type="button"
  aria-label={labelled ? undefined : label}
  aria-disabled={reason ? "true" : undefined}
  title={reason ?? label}
  data-delete-action={reason ? "disabled" : "enabled"}
  class="del inline-flex min-h-10 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-full text-[13px] font-medium transition-[background-color,color,opacity] duration-150 [&_svg]:size-4 [&_svg]:shrink-0 {labelled ? 'px-3.5' : 'size-10'} {reason
    ? 'cursor-not-allowed text-ink-3 opacity-60'
    : 'text-ink-3 hover:bg-danger-soft hover:text-danger focus-visible:text-danger'} {reveal ? 'reveal' : ''} {cls}"
  onclick={click}
>
  <Trash2 />{#if labelled}<span>{label}</span>{/if}
</button>

<style>
  .reveal {
    opacity: 0;
  }
  :global(.group:hover) .reveal,
  :global(.group:focus-within) .reveal,
  .reveal:focus-visible {
    opacity: 1;
  }
  @media (hover: none) {
    .reveal {
      opacity: 1;
    }
  }
</style>
