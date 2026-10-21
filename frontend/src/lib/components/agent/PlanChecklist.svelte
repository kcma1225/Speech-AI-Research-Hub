<script lang="ts">
  import { ChevronRight, ListChecks } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import type { PlanState } from "#lib/agent/transcript.ts";

  /**
   * The work plan of one assistant turn (`update_plan`): ONE checklist that updates in place as steps are checked off.
   * While the turn works it is open; afterwards it collapses to a one-line summary (「計畫 3/5 完成」) that expands.
   */
  let { plan, live = false }: { plan: PlanState; live?: boolean } = $props();
  let manual = $state<boolean | null>(null);
  const open = $derived(manual ?? live);
  const uid = $props.id();
  const finished = $derived(plan.done === plan.total);
  const nextStep = $derived(plan.current ?? plan.items.find((i) => i.status !== "completed")?.step ?? null);
  const summary = $derived(
    finished
      ? t("agent.plan.summaryDone", { done: plan.done, total: plan.total })
      : nextStep
        ? t(live ? "agent.plan.summaryNow" : "agent.plan.summaryStopped", { done: plan.done, total: plan.total, step: nextStep })
        : t("agent.plan.progress", { done: plan.done, total: plan.total }),
  );
</script>

<section class="plan rounded-2xl border border-line bg-surface" aria-label={t("agent.plan.title")} data-plan-live={live ? "" : undefined}>
  <button type="button" class="flex min-h-11 w-full items-center gap-2 rounded-2xl px-3 text-left text-[13px] text-ink-2 hover:bg-surface-2" aria-expanded={open} aria-controls="plan-{uid}" onclick={() => (manual = !open)}>
    <span class="grid size-7 shrink-0 place-items-center rounded-full bg-surface-3"><ListChecks class="size-3.5" /></span>
    {#if open}
      <span class="flex-1 font-medium">{t("agent.plan.title")}</span>
      <span class="text-[12px] text-ink-3 tabular-nums">{t("agent.plan.progress", { done: plan.done, total: plan.total })}</span>
    {:else}
      <span class="min-w-0 flex-1 truncate"><span class="font-medium">{t("agent.plan.title")}</span> · <span class="tabular-nums">{summary}</span></span>
    {/if}
    <ChevronRight class="size-3.5 shrink-0 text-ink-3 transition-transform duration-150 motion-reduce:transition-none {open ? 'rotate-90' : ''}" />
  </button>
  <div class="bar mx-3 h-0.5 overflow-hidden rounded-full bg-surface-3" aria-hidden="true"><span style="width: {plan.total ? (plan.done / plan.total) * 100 : 0}%"></span></div>
  {#if open}
    <div id="plan-{uid}" class="px-3 pt-1.5 pb-2.5">
      {#if plan.explanation}<p class="mb-1.5 ml-9 text-[12.5px] text-ink-3">{plan.explanation}</p>{/if}
      <ol class="ml-9 flex flex-col gap-1">
        <!-- Keyed by position so a re-sent plan updates rows in place (the check animates instead of a new list). -->
        {#each plan.items as item, i (i)}
          <li class="flex items-start gap-2 text-[13.5px] leading-snug" data-status={item.status}>
            <span class="box mt-[3px]" aria-hidden="true">
              <svg viewBox="0 0 12 12" class="check"><path d="M2.5 6.2 5 8.5 9.5 3.5" /></svg>
              <span class="dot"></span>
            </span>
            <span class="label">
              {item.step}
              <span class="sr-only">（{t(`agent.plan.status.${item.status}`)}）</span>
            </span>
          </li>
        {/each}
      </ol>
      {#if plan.updates > 1}<p class="mt-1.5 ml-9 text-[11.5px] text-ink-3">{t("agent.plan.updated", { n: plan.updates })}</p>{/if}
    </div>
  {/if}
  <p class="sr-only" aria-live="polite">{live ? summary : ""}</p>
</section>

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
  .bar span {
    display: block;
    height: 100%;
    background: var(--success);
    transition: width 300ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .box {
    position: relative;
    display: grid;
    place-items: center;
    flex-shrink: 0;
    width: 14px;
    height: 14px;
    border-radius: 4px;
    border: 1.5px solid var(--line-2);
    transition: border-color 200ms ease-out, background-color 200ms ease-out;
  }
  .label {
    color: var(--ink-2);
    transition: color 200ms ease-out;
  }
  [data-status="completed"] .box {
    border-color: var(--success);
  }
  [data-status="completed"] .label {
    color: var(--ink-3);
    text-decoration: line-through;
    text-decoration-color: color-mix(in srgb, var(--ink-3) 50%, transparent);
  }
  [data-status="in_progress"] .box {
    border-color: var(--ink);
  }
  [data-status="in_progress"] .label {
    color: var(--ink);
    font-weight: 500;
  }
  .dot {
    position: absolute;
    width: 6px;
    height: 6px;
    border-radius: 2px;
    background: var(--ink);
    opacity: 0;
  }
  [data-status="in_progress"] .dot {
    opacity: 1;
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
    stroke-dasharray: 12;
    stroke-dashoffset: 12;
    transition: stroke-dashoffset 260ms ease-out;
  }
  [data-status="completed"] .check {
    stroke-dashoffset: 0;
  }
  @media (prefers-reduced-motion: reduce) {
    .plan,
    [data-status="in_progress"] .dot {
      animation: none;
    }
    .bar span,
    .box,
    .label,
    .check {
      transition: none;
    }
  }
</style>
