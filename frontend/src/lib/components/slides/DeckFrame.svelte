<script lang="ts">
  import type { Snippet } from "svelte";
  import { Minimize } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";

  /**
   * The rendered deck in a sandboxed iframe. Never add allow-same-origin: the deck runs untrusted
   * scripts and must keep an opaque origin (asset URLs carry a view capability instead of cookies).
   */
  let { src, title, class: cls = "", empty }: { src: string | null; title: string; class?: string; empty?: Snippet } = $props();
  let wrapper = $state<HTMLDivElement | null>(null);
  let frame = $state<HTMLIFrameElement | null>(null);
  let native = $state(false);
  // iPhone Safari has no element fullscreen: fall back to a fixed overlay.
  let pseudo = $state(false);
  const isFullscreen = $derived(native || pseudo);

  export function fullscreen() {
    if (!wrapper) return;
    if (document.fullscreenElement) return void document.exitFullscreen();
    if (pseudo) return void (pseudo = false);
    if (wrapper.requestFullscreen) void wrapper.requestFullscreen().then(() => frame?.focus(), () => (pseudo = true));
    else pseudo = true;
  }
  $effect(() => {
    const sync = () => (native = document.fullscreenElement === wrapper);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && (pseudo = false);
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("keydown", esc);
    };
  });
</script>

<div
  bind:this={wrapper}
  class="relative overflow-hidden {native ? 'bg-black' : pseudo ? 'fixed inset-0 z-[70] bg-black pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]' : `bg-surface-2 ${cls}`}"
>
  {#if src}
    {#key src}
      <iframe
        bind:this={frame}
        {src}
        {title}
        sandbox="allow-scripts allow-pointer-lock allow-presentation"
        allow="fullscreen"
        referrerpolicy="no-referrer"
        class="absolute inset-0 size-full border-0"
      ></iframe>
    {/key}
  {:else}
    <div class="absolute inset-0 grid place-items-center p-6 text-center">{@render empty?.()}</div>
  {/if}
  {#if isFullscreen}
    <button
      type="button"
      class="absolute top-[max(12px,env(safe-area-inset-top))] right-3 z-10 grid size-10 place-items-center rounded-full bg-black/50 text-white opacity-60 backdrop-blur transition-opacity hover:opacity-100"
      aria-label={t("common.close")}
      onclick={fullscreen}
    >
      <Minimize class="size-4" />
    </button>
  {/if}
</div>
