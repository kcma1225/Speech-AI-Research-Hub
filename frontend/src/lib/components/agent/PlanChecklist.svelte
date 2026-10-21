<script lang="ts">
  import { ListChecks } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import type { ToolCall } from "#lib/agent/types.ts";

  /** An `update_plan` call rendered as a live checklist (the plan of a multi-step request). */
  let { call }: { call: ToolCall } = $props();
  type Item = { step: string; status: "pending" | "in_progress" | "completed" };
  const items = $derived.by((): Item[] => {
    const raw = (call.args as { plan?: unknown }).plan;
    return Array.isArray(raw) ? raw.filter((p): p is Item => !!p && typeof (p as Item).step === "string").slice(0, 12) : [];
  });
  const explanation = $derived(typeof (call.args as { explanation?: unknown }).explanation === "string" ? ((call.args as { explanation: string }).explanation) : "");
  const done = $derived(items.filter((i) => i.status === "completed").length);
</script>

<li class="plan my-1 rounded-2xl border border-line bg-surface px-3 py-2.5" aria-label={t("agent.plan.title")}>
  <div class="flex items-center gap-2 text-[13px] font-medium text-ink-2">
    <span class="grid size-7 place-items-center rounded-full bg-surface-3"><ListChecks class="size-3.5" /></span>
    <span class="flex-1">{t("agent.plan.title")}</span>
    <span class="text-[12px] text-ink-3 tabular-nums">{t("agent.plan.progress", { done, total: items.length })}</span>
  </div>
  {#if explanation}<p class="mt-1.5 ml-9 text-[12.5px] text-ink-3">{explanation}</p>{/if}
  <ol class="mt-1.5 ml-9 flex flex-col gap-1">
    {#each items as item, i (i + item.step)}
      <li class="flex items-start gap-2 text-[13.5px] leading-snug" data-status={item.status}>
        <span class="box mt-[3px]" aria-hidden="true">
          {#if item.status === "completed"}
            <svg viewBox="0 0 12 12" class="check"><path d="M2.5 6.2 5 8.5 9.5 3.5" /></svg>
          {:else if item.status === "in_progress"}
            <span class="dot"></span>
          {/if}
        </span>
        <span class={item.status === "completed" ? "text-ink-3 line-through decoration-ink-3/50" : item.status === "in_progress" ? "font-medium text-ink" : "text-ink-2"}>
          {item.step}
          <span class="sr-only">（{t(`agent.plan.status.${item.status}`)}）</span>
        </span>
      </li>
    {/each}
  </ol>
</li>

<style>
  .plan {
    animation: plan-in 150ms ease-out;
  }
  @keyframes plan-in {
    from {
      opacity: 0;
      transform: translateY(-2px);
    }
  }
  .box {
    display: grid;
    place-items: center;
    flex-shrink: 0;
    width: 14px;
    height: 14px;
    border-radius: 4px;
    border: 1.5px solid var(--line-2);
  }
  [data-status="completed"] .box {
    border-color: var(--success);
  }
  [data-status="in_progress"] .box {
    border-color: var(--ink);
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 2px;
    background: var(--ink);
    animation: pulse 1.2s ease-in-out infinite;
  }
  @keyframes pulse {
    50% {
      opacity: 0.35;
    }
  }
  .check {
    width: 10px;
    height: 10px;
    fill: none;
    stroke: var(--success);
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  @media (prefers-reduced-motion: reduce) {
    .plan,
    .dot {
      animation: none;
    }
  }
</style>
