<script lang="ts">
  import { untrack } from "svelte";
  import { Tween, prefersReducedMotion } from "svelte/motion";
  import { cubicOut } from "svelte/easing";
  import { relativeTime, t } from "#lib/i18n.svelte.ts";
  import { pct } from "#lib/ai/routing.ts";
  import type { StatRow } from "#lib/ai/admin.ts";

  /** A function block's live line: calls (tweened when it changes) · success rate · last used. `now` re-renders the relative time. */
  let { stat, now }: { stat: StatRow; now: number } = $props();
  const calls = new Tween(0, { duration: 0 });
  let first = true;
  $effect(() => {
    const target = stat.calls;
    untrack(() => {
      void calls.set(target, { duration: first || prefersReducedMotion.current ? 0 : 600, easing: cubicOut });
      first = false;
    });
  });
  const lastUsed = $derived((void now, stat.last_used ? relativeTime(stat.last_used) : ""));
</script>

<span class="tabular-nums">{t("aiAdmin.diagram.roleLive", { calls: Math.round(calls.current), rate: pct(stat.success_rate) })}</span>{#if lastUsed}{` · ${lastUsed}`}{/if}
