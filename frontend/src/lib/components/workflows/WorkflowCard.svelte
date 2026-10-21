<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { ChevronRight, CircleCheck, CircleX, Circle, ExternalLink, Hourglass, MessageSquarePlus, PanelRight, Pause, Pencil, Play, RotateCw, Square, Upload, Workflow as WorkflowIcon } from "@lucide/svelte";
  import { i18n, t, relativeTime } from "#lib/i18n.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import AgentMarkdown from "#lib/components/agent/AgentMarkdown.svelte";
  import Button from "#lib/components/ui/Button.svelte";
  import ConfirmDialog from "#lib/components/ui/ConfirmDialog.svelte";
  import Pill from "#lib/components/ui/Pill.svelte";
  import Progress from "#lib/components/ui/Progress.svelte";
  import Textarea from "#lib/components/ui/Textarea.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import { openArtifact, refFromArtifact } from "#lib/agent/viewer.ts";
  import { workflowsApi } from "#lib/workflows/api.ts";
  import { budgetUsage, criteriaPassed, minutes } from "#lib/workflows/reduce.ts";
  import { announceArtifact, WorkflowSession } from "#lib/workflows/session.svelte.ts";
  import { ACTIVE, FINISHED, WORKING, type Artifact } from "#lib/workflows/types.ts";
  import { fmtTokens, STATUS_TONE } from "./meta.ts";
  import PlanEditor from "./PlanEditor.svelte";
  import StepTimeline from "./StepTimeline.svelte";
  import WorkflowAsk from "./WorkflowAsk.svelte";

  /**
   * Live card of one workflow run (in the chat under the start_workflow tool row, and on /assistant/workflows):
   * objective, criteria checklist, plan card, step timeline with sub-agent activity and verdicts, budget, artifacts,
   * controls and the final report.
   */
  let { id, compact = false, collapsible = false, onRemoved }: {
    id: string;
    compact?: boolean;
    /** In the chat: compact by default (objective, progress, current activity); 「顯示詳細內容」 shows criteria, steps, budget. */
    collapsible?: boolean;
    onRemoved?: () => void;
  } = $props();

  // The card is keyed by id at every call site; a new id mounts a new card.
  const session = new WorkflowSession(untrack(() => id));
  void session.load();
  onDestroy(() => session.destroy());

  const w = $derived(session.workflow);
  const steps = $derived(session.steps);
  const working = $derived(!!w && WORKING.includes(w.status));
  const active = $derived(!!w && ACTIVE.includes(w.status));
  const finished = $derived(!!w && FINISHED.includes(w.status));
  const waitingLlm = $derived(w?.job?.stage === "waiting_llm" && working);
  const usage = $derived(w ? budgetUsage(w) : null);
  const passed = $derived(w ? criteriaPassed(w) : 0);
  const fixRounds = $derived(steps.reduce((n, s) => n + Math.max(0, s.history.length - 1), 0));
  let more = $state(false);
  const detailed = $derived(!collapsible || more);
  let showSteps = $state<boolean | null>(null);
  const stepsOpen = $derived(showSteps ?? (collapsible ? true : working || w?.status === "paused"));
  const stepsPassed = $derived(steps.filter((s) => s.status === "passed" || s.status === "skipped").length);
  const progressPct = $derived(steps.length ? Math.round((stepsPassed / steps.length) * 100) : null);
  // The newest live line of a running sub-agent.
  const current = $derived(Object.values(session.state.activity).sort((a, b) => b.at - a.at)[0] ?? null);
  const runningStep = $derived(steps.find((s) => s.status === "running" || s.status === "verifying") ?? null);
  let busy = $state<string | null>(null);
  const pendingAsk = $derived(w?.asks?.find((a) => a.pending) ?? null);
  const answeredAsks = $derived((w?.asks ?? []).filter((a) => !a.pending && a.answers));
  let panel = $state<"guidance" | "objective" | null>(null);
  let guidance = $state("");
  let objective = $state("");
  let answer = $state("");
  let stopOpen = $state(false);
  let publishOpen = $state(false);
  let deleteOpen = $state(false);

  async function act(name: string, fn: () => Promise<{ workflow: import("#lib/workflows/types.ts").Workflow | null } | void>) {
    busy = name;
    try {
      const r = await fn();
      if (r && "workflow" in r) session.setWorkflow(r.workflow);
      return true;
    } catch (e) {
      toasts.show(`${t("wf.actionFailed")}：${(e as Error).message}`, "error");
      throw e;
    } finally {
      busy = null;
    }
  }
  const quiet = (p: Promise<unknown>) => p.catch(() => undefined);

  async function sendGuidance() {
    if (!guidance.trim()) return;
    await quiet(act("guidance", () => workflowsApi.guidance(id, guidance.trim())).then(() => {
      guidance = "";
      panel = null;
      toasts.show(t("wf.guidanceSent"), "success");
    }));
  }
  async function saveObjective() {
    if (!objective.trim()) return;
    await quiet(act("objective", () => workflowsApi.patch(id, { objective: objective.trim() })).then(() => (panel = null)));
  }
  async function sendAnswer() {
    if (!answer.trim()) return;
    await quiet(act("answer", () => workflowsApi.guidance(id, answer.trim())).then(() => (answer = "")));
  }
  async function publish() {
    busy = "publish";
    try {
      const r = await workflowsApi.publish(id);
      toasts.show(t("wf.published", { n: r.version }), "success");
    } catch (e) {
      toasts.show(`${t("wf.actionFailed")}：${(e as Error).message}`, "error");
      throw e;
    } finally {
      busy = null;
    }
  }
  function viewArtifact(a: Artifact) {
    announceArtifact(a, id, "open");
    const r = refFromArtifact(a);
    if (r) openArtifact(r.ref, { focus: r.focus });
  }
</script>

<article data-workflow-card class="card mt-2 rounded-[20px] border border-line bg-surface shadow-card {compact ? 'p-3' : 'p-3 sm:p-4'}" aria-busy={working} aria-label={t("wf.title")}>
  {#if session.loading && !w}
    <div class="flex items-center gap-2 text-[13px] text-ink-3"><WorkflowIcon class="size-4" />{t("wf.title")}…</div>
  {:else if session.error && !w}
    <p class="text-[13px] text-danger">{t("wf.loadFailed")}：{session.error}</p>
  {:else if w}
    <header class="flex flex-wrap items-start gap-x-2 gap-y-1">
      <span class="grid size-8 shrink-0 place-items-center rounded-full bg-surface-3 text-ink-2"><WorkflowIcon class="size-4" /></span>
      <div class="min-w-0 flex-1">
        <p class="text-[11.5px] tracking-wide text-ink-3 uppercase">{t("wf.title")} · {i18n.locale === "en" ? w.playbook_title_en : w.playbook_title}</p>
        <p class="text-[14.5px] font-semibold break-words text-ink">{w.title}</p>
      </div>
      <div class="flex items-center gap-1.5">
        {#if waitingLlm}<Pill tone="butter" size="sm"><Hourglass class="size-3" />{t("wf.waitingLlm")}</Pill>{/if}
        <Pill tone={STATUS_TONE[w.status]} size="sm" dot={working}>{t(`wf.status.${w.status}` as MessageKey)}</Pill>
      </div>
    </header>

    {#if w.objective}
      <div class="mt-3">
        <p class="text-[12px] font-medium text-ink-3">{t("wf.objective")}</p>
        <p class="mt-0.5 text-[13.5px] leading-relaxed break-words text-ink-2 {detailed ? '' : 'line-clamp-3'}">{w.objective}</p>
      </div>
    {:else if w.status === "planning"}
      <p class="mt-3 text-[13px] text-ink-3">{w.request}</p>
    {/if}

    {#if w.status === "planning"}
      <div class="mt-3"><Progress value={null} label={t("wf.status.planning")} /></div>
    {/if}

    {#if pendingAsk}
      <WorkflowAsk runId={id} ask={pendingAsk} onUpdated={(x) => x && session.setWorkflow(x)} />
    {:else if w.status === "awaiting_input" && w.question}
      <div class="mt-3 flex flex-col gap-2 rounded-2xl border border-line-2 bg-surface-2 p-3">
        <p class="text-[13px] font-semibold text-ink">{t("wf.question")}</p>
        <p class="text-[13.5px] whitespace-pre-wrap text-ink-2">{w.question}</p>
        <Textarea rows={2} bind:value={answer} placeholder={t("wf.answerPlaceholder")} label={t("wf.answer")} />
        <div class="flex flex-wrap gap-2">
          <Button variant="primary" loading={busy === "answer"} disabled={!answer.trim()} onclick={sendAnswer}><MessageSquarePlus />{t("wf.answer")}</Button>
          <Button variant="ghost" onclick={() => (stopOpen = true)}>{t("wf.cancel")}</Button>
        </div>
      </div>
    {/if}

    {#each answeredAsks as a (a.id)}
      <WorkflowAsk runId={id} ask={a} canEdit={!working && w.status !== "cancelled"} onUpdated={(x) => x && session.setWorkflow(x)} />
    {/each}

    {#if !detailed && steps.length && w.status !== "awaiting_plan_approval"}
      <div class="mt-3" data-wf-summary>
        <div class="mb-1 flex flex-wrap items-center gap-x-2 text-[12px] text-ink-3">
          <span class="tabular-nums">{t("agentRuns.steps", { done: stepsPassed, total: steps.length })}</span>
          {#if w.criteria.length}<span class="tabular-nums">· {t("wf.criteria")} {t("wf.criteriaCount", { passed, total: w.criteria.length })}</span>{/if}
          {#if usage && w.usage.calls > 0}<span class="tabular-nums">· {t("agentRuns.budget", { pct: usage.max })}</span>{/if}
        </div>
        <Progress value={progressPct} label={t("agentRuns.steps", { done: stepsPassed, total: steps.length })} class="h-1.5" />
        {#if working && (current || runningStep)}
          <p class="live-line mt-1.5 truncate text-[12.5px] text-ink-2" aria-live="polite">
            <span class="font-medium text-ink">{t(`wf.role.${current?.role ?? runningStep?.role ?? "orchestrator"}` as MessageKey)}</span> · {current ? current.text : runningStep?.title}
          </p>
        {/if}
      </div>
    {/if}

    {#if w.status === "awaiting_plan_approval"}
      <div class="mt-3"><PlanEditor {session} workflow={w} {steps} onCancel={() => (stopOpen = true)} /></div>
    {:else if w.criteria.length && detailed}
      <div class="mt-3">
        <p class="flex items-center gap-2 text-[12px] font-medium text-ink-3">{t("wf.criteria")}<span class="tabular-nums">{t("wf.criteriaCount", { passed, total: w.criteria.length })}</span></p>
        <ul class="mt-1 flex flex-col gap-1">
          {#each w.criteria as c (c.id)}
            <li class="crit flex items-start gap-2 text-[13px]" data-status={c.status}>
              <span class="mt-0.5 shrink-0">
                {#if c.status === "pass"}<CircleCheck class="size-4 text-success" />{:else if c.status === "fail"}<CircleX class="size-4 text-danger" />{:else}<Circle class="size-4 text-ink-3" />{/if}
              </span>
              <span class="min-w-0 flex-1 break-words">
                <span class={c.status === "pass" ? "text-ink" : "text-ink-2"}>{c.text}</span>
                <span class="sr-only">（{t(`wf.crit.${c.status}` as MessageKey)}）</span>
                {#if c.reason && c.status === "fail"}<span class="block text-[12px] text-ink-3">{c.reason}</span>{/if}
              </span>
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    {#if steps.length && w.status !== "awaiting_plan_approval" && detailed}
      <div class="mt-3">
        <button type="button" class="inline-flex min-h-10 items-center gap-1.5 rounded-full px-2 text-[12.5px] font-medium text-ink-2 hover:bg-surface-3 hover:text-ink" aria-expanded={stepsOpen} onclick={() => (showSteps = !stepsOpen)}>
          {stepsOpen ? t("wf.hideSteps") : t("wf.showSteps")} · {steps.filter((s) => s.status === "passed").length}/{steps.length}{#if fixRounds} · {t("wf.rounds", { n: fixRounds })}{/if}
        </button>
        {#if stepsOpen}<div class="mt-1"><StepTimeline {steps} activity={session.state.activity} /></div>{/if}
      </div>
    {/if}

    {#if usage && detailed && (working || finished || w.status === "paused") && w.usage.calls > 0}
      <div class="mt-3" title={t("wf.budgetDetail", { calls: w.usage.calls, maxCalls: w.budget.max_calls, tokens: fmtTokens(w.usage.tokens_in + w.usage.tokens_out), maxTokens: fmtTokens(w.budget.max_tokens), min: minutes(w.usage.active_ms), maxMin: w.budget.max_minutes })}>
        <div class="mb-1 flex flex-wrap items-center justify-between gap-x-2 text-[11.5px] text-ink-3">
          <span>{t("wf.budget")}</span>
          <span class="tabular-nums">{t("wf.budgetDetail", { calls: w.usage.calls, maxCalls: w.budget.max_calls, tokens: fmtTokens(w.usage.tokens_in + w.usage.tokens_out), maxTokens: fmtTokens(w.budget.max_tokens), min: minutes(w.usage.active_ms), maxMin: w.budget.max_minutes })}</span>
        </div>
        <Progress value={usage.max} label={t("wf.budget")} />
      </div>
    {/if}

    {#if w.artifacts.length}
      <div class="mt-3">
        <p class="text-[12px] font-medium text-ink-3">{t("wf.artifacts")}</p>
        <ul class="mt-1 flex flex-col gap-1.5">
          {#each w.artifacts as a (a.kind + a.id)}
            <li class="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2">
              <span class="min-w-0 flex-1 text-[13px] break-words text-ink">{a.title}{#if a.revision} <span class="text-ink-3">r{a.revision}</span>{/if}</span>
              <Pill size="sm" tone={a.role === "suggestion" ? "lilac" : "sky"}>{t(`wf.artifactRole.${a.role}` as MessageKey)}</Pill>
              <div class="flex gap-1">
                <Button size="sm" variant="ghost" class="min-h-10" onclick={() => viewArtifact(a)}><PanelRight />{t("wf.openViewer")}</Button>
                <Button size="sm" variant="ghost" class="min-h-10" href={a.url}><ExternalLink />{t("wf.open")}</Button>
              </div>
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    {#if w.report?.summary_md && finished}
      <div class="mt-3 rounded-2xl border border-line bg-surface-2 p-3 text-[13.5px] {detailed ? '' : 'max-h-28 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]'}">
        <p class="mb-1 text-[12px] font-medium text-ink-3">{t("wf.report")}</p>
        <AgentMarkdown source={w.report.summary_md} />
      </div>
    {/if}
    {#if w.error && w.status === "failed"}<p class="mt-2 text-[13px] text-danger">{w.error.error}</p>{/if}

    {#if session.state.log.length && working && detailed}
      <p class="mt-2 truncate text-[12px] text-ink-3" aria-live="polite">{session.state.log.at(-1)!.text}</p>
    {/if}

    {#if panel === "guidance"}
      <div class="mt-3 flex flex-col gap-2">
        <Textarea rows={2} bind:value={guidance} label={t("wf.guidance")} placeholder={t("wf.guidanceHint")} />
        <div class="flex gap-2"><Button variant="primary" size="sm" loading={busy === "guidance"} disabled={!guidance.trim()} onclick={sendGuidance}>{t("wf.guidanceSend")}</Button><Button variant="ghost" size="sm" onclick={() => (panel = null)}>{t("wf.cancel")}</Button></div>
      </div>
    {:else if panel === "objective"}
      <div class="mt-3 flex flex-col gap-2">
        <Textarea rows={3} bind:value={objective} label={t("wf.editObjective")} />
        <div class="flex gap-2"><Button variant="primary" size="sm" loading={busy === "objective"} disabled={!objective.trim()} onclick={saveObjective}>{t("wf.saveObjective")}</Button><Button variant="ghost" size="sm" onclick={() => (panel = null)}>{t("wf.cancel")}</Button></div>
      </div>
    {/if}

    {#if collapsible && w.status !== "awaiting_plan_approval" && (steps.length || w.criteria.length || w.report?.summary_md)}
      <button type="button" class="mt-2 inline-flex min-h-10 items-center gap-1.5 rounded-full px-2 text-[12.5px] font-medium text-ink-2 hover:bg-surface-3 hover:text-ink" aria-expanded={more} onclick={() => (more = !more)}>
        <ChevronRight class="size-3.5 transition-transform duration-150 motion-reduce:transition-none {more ? 'rotate-90' : ''}" />{more ? t("wfCard.less") : t("wfCard.more")}
      </button>
    {/if}

    {#if w.status !== "awaiting_plan_approval" && w.status !== "awaiting_input"}
      <footer class="mt-3 flex flex-wrap items-center gap-1.5 border-t border-line pt-3">
        {#if working}
          <Button size="sm" variant="secondary" class="min-h-10" loading={busy === "pause"} onclick={() => quiet(act("pause", () => workflowsApi.pause(id)))}><Pause />{t("wf.pause")}</Button>
        {/if}
        {#if w.status === "paused"}
          <Button size="sm" variant="primary" class="min-h-10" loading={busy === "resume"} onclick={() => quiet(act("resume", () => workflowsApi.resume(id)))}><Play />{t("wf.resume")}</Button>
        {/if}
        {#if w.status === "partial" || w.status === "failed"}
          <Button size="sm" variant="primary" class="min-h-10" title={t("wf.moreHint")} loading={busy === "more"} onclick={() => quiet(act("more", () => workflowsApi.resume(id, true)))}><RotateCw />{t("wf.more")}</Button>
        {/if}
        {#if finished && w.playbook === "slides" && w.artifacts.some((a) => a.kind === "deck") && w.status !== "cancelled"}
          <Button size="sm" variant="secondary" class="min-h-10" loading={busy === "publish"} onclick={() => (publishOpen = true)}><Upload />{t("wf.publish")}</Button>
        {/if}
        {#if w.status !== "cancelled"}
          <Button size="sm" variant="ghost" class="min-h-10" onclick={() => (panel = panel === "guidance" ? null : "guidance")}><MessageSquarePlus />{t("wf.guidance")}</Button>
        {/if}
        {#if w.status === "paused" || (finished && w.status !== "cancelled")}
          <Button size="sm" variant="ghost" class="min-h-10" onclick={() => ((objective = w.objective), (panel = panel === "objective" ? null : "objective"))}><Pencil />{t("wf.editObjective")}</Button>
        {/if}
        <span class="flex-1"></span>
        {#if active}
          <Button size="sm" variant="ghost" class="min-h-10 text-danger" onclick={() => (stopOpen = true)}><Square />{t("wf.stop")}</Button>
        {:else if onRemoved}
          <Button size="sm" variant="ghost" class="min-h-10" onclick={() => (deleteOpen = true)}>{t("wf.delete")}</Button>
        {/if}
        <span class="w-full text-right text-[11.5px] text-ink-3 sm:w-auto">{relativeTime(w.updated_at)}</span>
      </footer>
    {/if}
  {/if}
</article>

<ConfirmDialog bind:open={stopOpen} title={t("wf.stopConfirm")} description={t("wf.stopDesc")} confirmLabel={t("wf.stop")} onConfirm={() => act("cancel", () => workflowsApi.cancel(id))} />
<ConfirmDialog bind:open={publishOpen} danger={false} title={t("wf.publishConfirm")} description={t("wf.publishDesc")} confirmLabel={t("wf.publish")} onConfirm={publish} />
<ConfirmDialog bind:open={deleteOpen} title={t("wf.deleteConfirm")} description={t("wf.deleteDesc")} confirmLabel={t("wf.delete")} onConfirm={() => act("delete", async () => { await workflowsApi.remove(id); onRemoved?.(); })} />

<style>
  .card {
    animation: card-in 200ms cubic-bezier(0.2, 0, 0, 1);
  }
  @keyframes card-in {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
  }
  .crit[data-status="pass"] :global(svg) {
    animation: pop 220ms cubic-bezier(0.2, 0, 0, 1.4);
  }
  @keyframes pop {
    from {
      transform: scale(0.6);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .card,
    .crit[data-status="pass"] :global(svg) {
      animation: none;
    }
  }
</style>
