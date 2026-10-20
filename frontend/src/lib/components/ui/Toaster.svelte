<script lang="ts">
  import { CircleAlert, CircleCheck } from "@lucide/svelte";
  import { toasts } from "./toast.svelte";
</script>

<div class="pointer-events-none fixed inset-x-0 bottom-[calc(76px+env(safe-area-inset-bottom))] z-[60] flex flex-col items-center gap-2 px-4 lg:bottom-6" aria-live="polite">
  {#each toasts.items as toast (toast.id)}
    <button
      type="button"
      onclick={() => toasts.dismiss(toast.id)}
      class="pointer-events-auto flex items-center gap-2.5 rounded-full bg-primary px-4 py-2.5 text-sm font-medium text-primary-ink shadow-pop animate-[sheet-up_200ms_cubic-bezier(.2,.8,.2,1)] [&_svg]:size-4"
    >
      {#if toast.tone === "success"}<CircleCheck />{:else if toast.tone === "error"}<CircleAlert class="text-[var(--pill-rose)]" />{/if}
      {toast.message}
    </button>
  {/each}
</div>
