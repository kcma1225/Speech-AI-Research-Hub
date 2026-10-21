<script lang="ts">
  import type { AiRoleState } from "#lib/ai/status.svelte.ts";
  /** Small status dot; `pulse` animates degraded/unavailable (disabled under reduced motion by app.css). */
  let { state, pulse = false, class: cls = "" }: { state: AiRoleState | "up" | "down" | "unknown"; pulse?: boolean; class?: string } = $props();
  const tone = $derived(
    state === "ok" || state === "up"
      ? "bg-success"
      : state === "degraded"
        ? "bg-[var(--pill-butter-ink)]"
        : state === "unavailable" || state === "down"
          ? "bg-danger"
          : "bg-ink-3/45",
  );
</script>

<span class="relative inline-flex size-2.5 shrink-0 {cls}" aria-hidden="true">
  {#if pulse && (state === "degraded" || state === "unavailable" || state === "down")}
    <span class="absolute inset-0 animate-ping rounded-full opacity-60 {tone}"></span>
  {/if}
  <span class="relative inline-flex size-2.5 rounded-full {tone}"></span>
</span>
