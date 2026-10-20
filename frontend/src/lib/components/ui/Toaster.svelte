<script lang="ts">
  import { CircleAlert, CircleCheck } from "@lucide/svelte";
  import { toasts } from "./toast.svelte";
</script>

<div class="pointer-events-none fixed inset-x-0 bottom-[calc(76px+env(safe-area-inset-bottom))] z-[60] flex flex-col items-center gap-2 px-4 lg:bottom-6" aria-live="polite">
  {#each toasts.items as toast (toast.id)}
    <!-- Errors interrupt screen readers; everything else is announced politely. -->
    <div role={toast.tone === "error" ? "alert" : undefined} class="pointer-events-auto max-w-[min(480px,100%)] animate-[sheet-up_200ms_cubic-bezier(.2,.8,.2,1)]">
      <button
        type="button"
        onclick={() => toasts.dismiss(toast.id)}
        class="flex items-center gap-2.5 rounded-[20px] bg-primary px-4 py-2.5 text-left text-sm font-medium text-primary-ink shadow-pop [&_svg]:size-4 [&_svg]:shrink-0"
      >
        {#if toast.tone === "success"}<CircleCheck />{:else if toast.tone === "error"}<CircleAlert class="text-[var(--pill-rose)]" />{/if}
        {toast.message}
      </button>
    </div>
  {/each}
</div>
