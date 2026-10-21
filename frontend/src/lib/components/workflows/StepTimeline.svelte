<script lang="ts">
  import { ChevronRight, CircleCheck, CircleX, Circle, SkipForward } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import type { Activity, Step } from "#lib/workflows/types.ts";
  import { ROLE_ICON } from "./meta.ts";

  /** The plan's steps: role icon, status, live activity line, verdict chip with issues, fix-round badges. */
  let { steps, activity }: { steps: Step[]; activity: Record<string, Activity> } = $props();
  let openKey = $state<string | null>(null);
  const uid = $props.id();
</script>

<ol class="flex flex-col gap-1">
  {#each steps as step (step.id)}
    {@const Icon = ROLE_ICON[step.role] ?? ROLE_ICON.orchestrator}
    {@const live = activity[step.key]}
    {@const issues = (step.verdict?.issues ?? []).filter((i) => i.severity !== "low")}
    {@const working = step.status === "running" || step.status === "verifying"}
    <li class="step rounded-2xl {working ? 'bg-surface-2' : ''}" data-status={step.status}>
      <button
        type="button"
        class="flex min-h-11 w-full items-start gap-2.5 rounded-2xl px-2 py-1.5 text-left hover:bg-surface-2"
        aria-expanded={openKey === step.key}
        aria-controls="wfstep-{uid}-{step.key}"
        onclick={() => (openKey = openKey === step.key ? null : step.key)}
      >
        <span class="relative mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-surface-3 text-ink-2" title={t(`wf.role.${step.role}` as MessageKey)}>
          <Icon class="size-3.5" />
          <span class="badge" aria-hidden="true">
            {#if working}<span class="spin"></span>
            {:else if step.status === "passed"}<CircleCheck class="size-3 text-success" />
            {:else if step.status === "failed"}<CircleX class="size-3 text-danger" />
            {:else if step.status === "skipped" || step.status === "cancelled"}<SkipForward class="size-2.5 text-ink-3" />
            {:else}<Circle class="size-2.5 text-ink-3" />{/if}
          </span>
        </span>
        <span class="min-w-0 flex-1">
          <span class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span class="min-w-0 text-[13.5px] break-words {step.status === 'skipped' || step.status === 'cancelled' ? 'text-ink-3' : 'text-ink'}">{step.title}</span>
            <span class="text-[11.5px] text-ink-3">{t(`wf.role.${step.role}` as MessageKey)}</span>
            {#if step.round > 0}<span class="chip chip-butter">{t("wf.round", { n: step.round })}</span>{/if}
            {#if step.verdict && !working}
              <span class="chip {step.verdict.verdict === 'pass' ? 'chip-mint' : 'chip-rose'}">{t(step.verdict.verdict === "pass" ? "wf.verdict.pass" : "wf.verdict.revise")}{#if issues.length} · {t("wf.issues", { n: issues.length })}{/if}</span>
            {/if}
          </span>
          {#if working && live}
            <span class="live mt-0.5 block truncate text-[12px] text-ink-2" aria-live="polite">{t("wf.activity", { text: live.text })}</span>
          {:else if step.output?.summary && step.status !== "pending"}
            <span class="mt-0.5 block truncate text-[12px] text-ink-3">{step.output.summary}</span>
          {/if}
        </span>
        <span class="mt-1 shrink-0 text-[12px] text-ink-3">{t(`wf.step.${step.status}` as MessageKey)}</span>
        <ChevronRight class="mt-1.5 size-3.5 shrink-0 text-ink-3 transition-transform duration-150 {openKey === step.key ? 'rotate-90' : ''}" />
      </button>
      {#if openKey === step.key}
        <div id="wfstep-{uid}-{step.key}" class="mx-2 mb-2 ml-[46px] flex flex-col gap-2 rounded-xl border border-line bg-surface p-3 text-[12.5px] text-ink-2">
          {#if step.instructions}<p class="whitespace-pre-wrap">{step.instructions}</p>{/if}
          {#if step.expected}<p class="text-ink-3">→ {step.expected}</p>{/if}
          {#if step.error}<p class="text-danger">{step.error}</p>{/if}
          {#if step.verdict}
            {#if step.verdict.checks.length}
              <div>
                <p class="mb-1 font-medium text-ink-2">{t("wf.checks")}</p>
                <ul class="flex flex-col gap-0.5">
                  {#each step.verdict.checks as c, i (i)}
                    <li class="flex gap-1.5"><span class={c.ok ? "text-success" : "text-danger"}>{c.ok ? "✓" : "✗"}</span><span class="min-w-0 break-words">{c.detail}</span></li>
                  {/each}
                </ul>
              </div>
            {/if}
            {#if step.verdict.issues.length}
              <div>
                <p class="mb-1 font-medium text-ink-2">{step.verdict.judged ? t("wf.judged") : t("wf.issues", { n: step.verdict.issues.length })}</p>
                <ul class="flex flex-col gap-1">
                  {#each step.verdict.issues as issue, i (i)}
                    <li class="flex gap-1.5"><span class="sev sev-{issue.severity}" aria-hidden="true"></span><span class="min-w-0 break-words">{#if issue.where}<span class="text-ink-3">{issue.where}：</span>{/if}{issue.text}</span></li>
                  {/each}
                </ul>
              </div>
            {/if}
          {/if}
          {#if step.history.length > 1}
            <p class="text-ink-3">{t("wf.rounds", { n: step.history.length - 1 })}：{step.history.map((h) => (h.verdict.verdict === "pass" ? "✓" : "✗")).join(" → ")}</p>
          {/if}
          {#if step.output?.excerpt}
            <pre class="max-h-48 overflow-auto rounded-lg bg-surface-2 p-2 text-[12px] leading-relaxed whitespace-pre-wrap">{step.output.excerpt}</pre>
          {/if}
        </div>
      {/if}
    </li>
  {/each}
</ol>

<style>
  .step {
    animation: step-in 160ms ease-out;
  }
  @keyframes step-in {
    from {
      opacity: 0;
      transform: translateY(-2px);
    }
  }
  .badge {
    position: absolute;
    right: -3px;
    bottom: -3px;
    display: grid;
    place-items: center;
    width: 14px;
    height: 14px;
    border-radius: 999px;
    background: var(--surface);
  }
  .spin {
    width: 9px;
    height: 9px;
    border-radius: 999px;
    border: 1.5px solid var(--line-2);
    border-top-color: var(--ink);
    animation: spin 1s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .chip {
    border-radius: 999px;
    padding: 1px 8px;
    font-size: 11px;
    font-weight: 500;
    white-space: nowrap;
  }
  .chip-butter {
    background: var(--pill-butter);
    color: var(--pill-butter-ink);
  }
  .chip-mint {
    background: var(--pill-mint);
    color: var(--pill-mint-ink);
  }
  .chip-rose {
    background: var(--pill-rose);
    color: var(--pill-rose-ink);
  }
  .sev {
    margin-top: 6px;
    width: 6px;
    height: 6px;
    flex-shrink: 0;
    border-radius: 999px;
    background: var(--ink-3);
  }
  .sev-high {
    background: var(--danger);
  }
  .sev-medium {
    background: var(--pill-peach-ink);
  }
  .live {
    animation: fade 300ms ease-out;
  }
  @keyframes fade {
    from {
      opacity: 0.3;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .step,
    .live {
      animation: none;
    }
    .spin {
      animation: none;
      background: var(--ink-3);
      border: none;
      width: 6px;
      height: 6px;
    }
  }
</style>
