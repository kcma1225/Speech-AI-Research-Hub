<script lang="ts">
  import { t } from "#lib/i18n.svelte.ts";

  /** Status line shown right after sending, until the first token; after 8 s it says the run can be stopped. */
  let { since, label }: { since: number; label?: string } = $props();
  let slow = $state(false);
  $effect(() => {
    slow = Date.now() - since > 8000;
    const id = setTimeout(() => (slow = true), Math.max(0, 8000 - (Date.now() - since)));
    return () => clearTimeout(id);
  });
</script>

<p class="shimmer text-[13.5px] font-medium" role="status" aria-live="polite">{label ?? (slow ? t("agent.stillWorking") : t("agent.thinking"))}</p>

<style>
  .shimmer {
    background: linear-gradient(90deg, var(--ink-3) 0%, var(--ink-3) 35%, var(--ink) 50%, var(--ink-3) 65%, var(--ink-3) 100%);
    background-size: 220% 100%;
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    animation: sweep 1.6s linear infinite;
  }
  @keyframes sweep {
    from {
      background-position: 120% 0;
    }
    to {
      background-position: -100% 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .shimmer {
      animation: none;
      background: none;
      color: var(--ink-3);
    }
  }
</style>
