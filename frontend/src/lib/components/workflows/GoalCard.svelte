<script lang="ts">
  import { onDestroy, onMount, untrack } from "svelte";
  import { ArrowDown, ArrowUp, ChevronRight, CircleCheck, CircleX, Circle, Ban, ExternalLink, Hourglass, ListChecks, Pencil, Play, Plus, RotateCw, SkipForward, Square, Target, Trash2, TriangleAlert } from "@lucide/svelte";
  import { i18n, t } from "#lib/i18n.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import AgentMarkdown from "#lib/components/agent/AgentMarkdown.svelte";
  import Button from "#lib/components/ui/Button.svelte";
  import ConfirmDialog from "#lib/components/ui/ConfirmDialog.svelte";
  import Pill, { type Tone } from "#lib/components/ui/Pill.svelte";
  import Progress from "#lib/components/ui/Progress.svelte";
  import Select from "#lib/components/ui/Select.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import { openArtifact, refFromArtifact } from "#lib/agent/viewer.ts";
  import { goalsApi, GOAL_ACTIVE, type Goal, type Stage, type StageEdit } from "#lib/goals/api.ts";
  import { workflowsApi } from "#lib/workflows/api.ts";
  import type { Artifact, Playbook } from "#lib/workflows/types.ts";
  import WorkflowCard from "./WorkflowCard.svelte";

  /**
   * One goal (backend/src/workflows/goals/): the fixed deliverable, the readiness snapshot and the roadmap of stages
   * (why each, status, artifacts; a stage expands into its own WorkflowCard). The user confirms the roadmap once (and
   * may edit it: reorder / skip / remove / add pending stages), then stages run automatically; a failed stage asks
   * 重試 / 略過 / 停止. Polls while active. Focus key `goal:<id>` (deep links) opens the stage that waits.
   */
  let { id, compact = false }: { id: string; compact?: boolean } = $props();

  const goalId = untrack(() => id);
  let goal = $state<Goal | null>(null);
  let error = $state<string | null>(null);
  let busy = $state<string | null>(null);
  let editing = $state(false);
  let draft = $state<(StageEdit & { key: string; playbook_title?: string; locked?: boolean })[]>([]);
  let playbooks = $state<Playbook[]>([]);
  let addPlaybook = $state("generic");
  let addRequest = $state("");
  let stopOpen = $state(false);
  let historyOpen = $state(false);
  let expanded = $state<Record<string, boolean>>({});
  let timer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;

  const active = $derived(!!goal && GOAL_ACTIVE.includes(goal.status));
  const settled = $derived(goal ? goal.stages.filter((s) => s.status === "done" || s.status === "partial" || s.status === "skipped").length : 0);
  const waiting = $derived(goal?.stages.find((s) => s.status === "waiting") ?? null);

  async function load() {
    try {
      goal = (await goalsApi.get(goalId)).goal;
      error = null;
      // The stage that waits for the user opens by itself (its plan / question card is inside).
      for (const s of goal.stages) if (s.status === "waiting" && s.run_id && expanded[s.id] === undefined) expanded[s.id] = true;
    } catch (e) {
      error = (e as Error).message;
    }
  }
  function schedule() {
    clearTimeout(timer);
    if (destroyed) return;
    const ms = !goal || GOAL_ACTIVE.includes(goal.status) ? (document.hidden ? 20_000 : 4_000) : 0;
    if (ms) timer = setTimeout(async () => (await load(), schedule()), ms);
  }
  onMount(() => {
    void load().then(schedule);
  });
  onDestroy(() => {
    destroyed = true;
    clearTimeout(timer);
  });

  async function act(name: string, fn: () => Promise<{ goal: Goal | null } | void>) {
    busy = name;
    try {
      const r = await fn();
      if (r && r.goal) goal = r.goal;
      else await load();
      schedule();
      return true;
    } catch (e) {
      toasts.show(`${t("goal.actionFailed")}：${(e as Error).message}`, "error");
      return false;
    } finally {
      busy = null;
    }
  }

  const GOAL_TONE: Record<Goal["status"], Tone> = { planning: "sky", awaiting_approval: "butter", running: "sky", awaiting_input: "butter", done: "mint", partial: "peach", failed: "rose", cancelled: "stone" };
  const STAGE_TONE: Record<Stage["status"], Tone> = { pending: "stone", running: "sky", waiting: "butter", done: "mint", partial: "peach", failed: "rose", skipped: "stone", cancelled: "stone" };
  const pbTitle = (s: { playbook_title?: string; playbook_title_en?: string; playbook?: string }) => (i18n.locale === "en" ? s.playbook_title_en : s.playbook_title) ?? s.playbook ?? "";

  async function startEditing() {
    if (!goal) return;
    if (!playbooks.length) playbooks = (await workflowsApi.playbooks().catch(() => ({ playbooks: [] as Playbook[] }))).playbooks.filter((p) => !p.id.startsWith("test_") && !p.id.startsWith("tg_"));
    draft = goal.stages.filter((s) => s.status === "pending" || (s.status === "skipped" && !s.run_id)).map((s) => ({ key: s.id, id: s.id, playbook: s.playbook, title: s.title, request: s.request, skip: s.status === "skipped", playbook_title: pbTitle(s) }));
    editing = true;
  }
  function move(i: number, d: number) {
    const j = i + d;
    if (j < 0 || j >= draft.length) return;
    const next = [...draft];
    [next[i], next[j]] = [next[j]!, next[i]!];
    draft = next;
  }
  function addStage() {
    if (!addRequest.trim()) return;
    const pb = playbooks.find((p) => p.id === addPlaybook);
    draft = [...draft, { key: `new-${Date.now()}`, playbook: addPlaybook, request: addRequest.trim(), title: pb ? (i18n.locale === "en" ? pb.title_en : pb.title) : addPlaybook, playbook_title: pb ? (i18n.locale === "en" ? pb.title_en : pb.title) : addPlaybook }];
    addRequest = "";
  }
  const edits = () => draft.map(({ id: sid, playbook, title, request, skip }) => (sid ? { id: sid, skip } : { playbook, title, request, skip }));
  async function saveEdits() {
    if (await act("save", () => goalsApi.editStages(goalId, edits()))) {
      editing = false;
      toasts.show(t("goal.saved"), "success");
    }
  }
  async function start() {
    if (await act("start", () => goalsApi.approve(goalId, editing ? edits() : undefined))) editing = false;
  }
  function view(a: Artifact) {
    const r = refFromArtifact(a);
    if (r) openArtifact(r.ref, { focus: r.focus });
    else window.location.assign(a.url);
  }
</script>

<article data-goal-card data-focus-key={goal ? `goal:${goalId}` : undefined} class="card mt-2 rounded-[20px] border border-line bg-surface shadow-card {compact ? 'p-3' : 'p-3 sm:p-4'}" aria-label={t("goal.title")} aria-busy={goal?.status === "running"}>
  {#if !goal && !error}
    <div class="flex items-center gap-2 text-[13px] text-ink-3"><Target class="size-4" />{t("goal.title")}…</div>
  {:else if !goal}
    <p class="text-[13px] text-danger">{t("goal.loadFailed")}：{error}</p>
  {:else}
    <header class="flex flex-wrap items-start gap-x-2 gap-y-1">
      <!-- Phones: no icon, the title gets the width. -->
      <span class="grid size-8 shrink-0 place-items-center rounded-full bg-surface-3 text-ink-2 max-sm:hidden"><Target class="size-4" /></span>
      <div class="min-w-0 flex-1">
        <p class="text-[11.5px] tracking-wide text-ink-3 uppercase">{t("goal.title")} · {goal.deliverable.label}</p>
        <p class="text-[14.5px] font-semibold break-words text-ink" title={goal.title}>{goal.title}</p>
      </div>
      <Pill tone={GOAL_TONE[goal.status]} size="sm" dot={goal.status === "running"}>{t(`goal.status.${goal.status}` as MessageKey)}</Pill>
    </header>

    {#if goal.objective}<p class="mt-2 text-[13.5px] leading-relaxed break-words text-ink-2">{goal.objective}</p>{/if}

    {#if !goal.deliverable.direct}
      <p class="mt-2 flex items-start gap-2 rounded-2xl border border-line-2 bg-surface-2 p-3 text-[13px] text-ink-2" data-goal-not-direct>
        <TriangleAlert class="mt-0.5 size-4 shrink-0 text-ink-3" aria-hidden="true" /><span><span class="font-medium text-ink">{t("goal.notDirect")}</span>{goal.deliverable.note ? `：${goal.deliverable.note}` : ""}</span>
      </p>
    {/if}

    {#if goal.readiness.length && (goal.status === "awaiting_approval" || !compact)}
      <div class="mt-2 text-[12.5px] text-ink-3">
        <span class="font-medium text-ink-2">{t("goal.readiness")}：</span>{goal.readiness.join("；")}
      </div>
    {/if}

    {#if goal.status === "awaiting_input" && goal.question}
      <div data-focus-target class="mt-3 flex flex-col gap-2 rounded-2xl border border-line-2 bg-surface-2 p-3">
        <p class="text-[13.5px] break-words whitespace-pre-wrap text-ink-2">{goal.question}</p>
        <div class="flex flex-wrap gap-2">
          <Button variant="primary" class="min-h-10" loading={busy === "retry"} onclick={() => act("retry", () => goalsApi.resume(goalId, "retry"))}><RotateCw />{t("goal.retry")}</Button>
          <Button variant="secondary" class="min-h-10" loading={busy === "skip"} onclick={() => act("skip", () => goalsApi.resume(goalId, "skip"))}><SkipForward />{t("goal.skip")}</Button>
          <Button variant="ghost" class="min-h-10 text-danger" onclick={() => (stopOpen = true)}><Square />{t("goal.stop")}</Button>
        </div>
      </div>
    {:else if waiting && goal.status === "running"}
      <p class="mt-3 flex items-center gap-2 rounded-2xl border border-line-2 bg-surface-2 p-3 text-[13px] text-ink-2"><Hourglass class="size-4 shrink-0 text-ink-3" aria-hidden="true" />{t("goal.waitingStage", { title: waiting.title })}</p>
    {/if}

    <div class="mt-3">
      <div class="mb-1.5 flex flex-wrap items-center gap-x-2 text-[12px] text-ink-3">
        <span class="font-medium text-ink-2"><ListChecks class="mr-1 inline size-3.5" aria-hidden="true" />{t("goal.roadmap")}</span>
        <span class="tabular-nums">{t("goal.stageCount", { done: settled, total: goal.stages.length })}</span>
      </div>
      {#if goal.status === "running"}<Progress value={goal.stages.length ? Math.round((settled / goal.stages.length) * 100) : null} label={t("goal.stageCount", { done: settled, total: goal.stages.length })} class="mb-2 h-1.5" />{/if}

      {#if editing}
        <ol class="flex flex-col gap-1.5" data-goal-editor>
          {#each goal.stages.filter((s) => !draft.some((d) => d.id === s.id)) as s (s.id)}
            <li class="flex items-center gap-2 rounded-xl px-2 py-1.5 text-[13px] text-ink-3"><CircleCheck class="size-4 shrink-0" />{s.title}</li>
          {/each}
          {#each draft as d, i (d.key)}
            <li class="flex flex-col gap-1 rounded-xl border border-line bg-surface-2 p-2 sm:flex-row sm:items-center">
              <div class="min-w-0 flex-1 {d.skip ? 'line-through opacity-60' : ''}">
                <p class="text-[13px] font-medium break-words text-ink">{d.title}</p>
                <p class="text-[12px] text-ink-3">{d.playbook_title}</p>
              </div>
              <div class="flex shrink-0 gap-0.5">
                <Button size="sm" variant="ghost" class="min-h-10" title={t("goal.moveUp")} aria-label={t("goal.moveUp")} disabled={i === 0} onclick={() => move(i, -1)}><ArrowUp /></Button>
                <Button size="sm" variant="ghost" class="min-h-10" title={t("goal.moveDown")} aria-label={t("goal.moveDown")} disabled={i === draft.length - 1} onclick={() => move(i, 1)}><ArrowDown /></Button>
                <Button size="sm" variant="ghost" class="min-h-10" title={d.skip ? t("goal.unskipStage") : t("goal.skipStage")} aria-label={d.skip ? t("goal.unskipStage") : t("goal.skipStage")} onclick={() => (draft[i] = { ...d, skip: !d.skip })}><Ban /></Button>
                <Button size="sm" variant="ghost" class="min-h-10 text-danger" title={t("goal.remove")} aria-label={t("goal.remove")} onclick={() => (draft = draft.filter((x) => x.key !== d.key))}><Trash2 /></Button>
              </div>
            </li>
          {/each}
        </ol>
        <div class="mt-2 flex flex-col gap-2 rounded-xl border border-dashed border-line p-2 sm:flex-row sm:items-end">
          <Select bind:value={addPlaybook} label={t("goal.addPlaybook")} options={playbooks.map((p) => ({ value: p.id, label: i18n.locale === "en" ? p.title_en : p.title }))} class="w-full sm:w-44" />
          <TextField bind:value={addRequest} label={t("goal.addRequest")} class="min-w-0 flex-1" />
          <Button variant="secondary" class="min-h-10" disabled={!addRequest.trim()} onclick={addStage}><Plus />{t("goal.add")}</Button>
        </div>
      {:else}
        <ol class="flex flex-col gap-1.5" data-goal-stages>
          {#each goal.stages as s, i (s.id)}
            <li class="rounded-xl border {s.status === 'waiting' ? 'border-[var(--pill-butter-ink)]/40' : 'border-line'} bg-surface-2 p-2" data-stage-status={s.status}>
              <div class="flex items-start gap-2">
                <span class="mt-0.5 grid size-5 shrink-0 place-items-center text-ink-3" aria-hidden="true">
                  {#if s.status === "done"}<CircleCheck class="size-4 text-success" />{:else if s.status === "failed"}<CircleX class="size-4 text-danger" />{:else if s.status === "running"}<Hourglass class="size-4 text-ink-2" />{:else if s.status === "skipped" || s.status === "cancelled"}<Ban class="size-4" />{:else}<Circle class="size-4" />{/if}
                </span>
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <p class="text-[13.5px] font-medium break-words text-ink"><span class="tabular-nums text-ink-3">{i + 1}.</span> {s.title}</p>
                    <Pill tone={STAGE_TONE[s.status]} size="sm" dot={s.status === "running"}>{t(`goal.stage.${s.status}` as MessageKey)}</Pill>
                  </div>
                  <p class="text-[12px] text-ink-3">{pbTitle(s)}{#if s.added_by === "replan"} · {t("goal.addedByReplan")}{:else if s.added_by === "user"} · {t("goal.addedByUser")}{/if}</p>
                  {#if s.why && (!compact || s.status === "pending" || goal.status === "awaiting_approval")}<p class="mt-0.5 text-[12.5px] leading-relaxed break-words text-ink-2">{s.why}</p>{/if}
                  {#if s.gaps.length && s.status === "pending"}<p class="mt-0.5 text-[12px] text-ink-3">{t("goal.gaps", { gaps: s.gaps.join("、") })}</p>{/if}
                  {#if s.summary && (s.status === "done" || s.status === "partial" || s.status === "failed")}<p class="mt-0.5 text-[12.5px] break-words text-ink-3">{s.summary}</p>{/if}
                  {#if s.artifacts.length}
                    <div class="mt-1 flex flex-wrap gap-1.5">
                      {#each s.artifacts.filter((a) => a.kind !== "paper").slice(0, 4) as a (a.kind + a.id)}
                        <button type="button" class="inline-flex min-h-8 items-center gap-1 rounded-full border border-line bg-surface px-3 text-[12.5px] font-medium text-ink hover:border-line-2" onclick={() => view(a)}><ExternalLink class="size-3.5" />{a.title}</button>
                      {/each}
                    </div>
                  {/if}
                </div>
                {#if s.run_id}
                  <button type="button" class="inline-flex min-h-10 shrink-0 items-center gap-1 rounded-full px-2 text-[12.5px] font-medium text-ink-2 hover:bg-surface-3 hover:text-ink" aria-expanded={!!expanded[s.id]} onclick={() => (expanded[s.id] = !expanded[s.id])}>
                    <ChevronRight class="size-3.5 transition-transform duration-150 motion-reduce:transition-none {expanded[s.id] ? 'rotate-90' : ''}" /><span class="hidden sm:inline">{expanded[s.id] ? t("goal.hideStage") : t("goal.showStage")}</span>
                  </button>
                {/if}
              </div>
              {#if s.run_id && expanded[s.id]}
                <div class={s.status === "waiting" ? "rounded-2xl" : ""} data-focus-target={s.status === "waiting" ? "" : undefined}>{#key s.run_id}<WorkflowCard id={s.run_id} compact collapsible />{/key}</div>
              {/if}
            </li>
          {/each}
        </ol>
      {/if}
    </div>

    {#if goal.status === "awaiting_approval"}
      <div data-focus-target class="mt-3 flex flex-col gap-2 rounded-2xl border border-line-2 bg-surface-2 p-3">
        <p class="text-[12.5px] leading-relaxed text-ink-2">{t("goal.approveHint")}</p>
        <div class="flex flex-wrap gap-2">
          <Button variant="primary" class="min-h-10" loading={busy === "start"} onclick={start}><Play />{t("goal.start")}</Button>
          {#if editing}
            <Button variant="secondary" class="min-h-10" loading={busy === "save"} onclick={saveEdits}>{t("goal.saveEdits")}</Button>
          {:else}
            <Button variant="secondary" class="min-h-10" onclick={startEditing}><Pencil />{t("goal.edit")}</Button>
          {/if}
          <Button variant="ghost" class="min-h-10" onclick={() => (stopOpen = true)}>{t("goal.cancel")}</Button>
        </div>
      </div>
    {:else if goal.status === "running"}
      <div class="mt-3 flex flex-wrap gap-1.5">
        {#if editing}
          <Button size="sm" variant="secondary" class="min-h-10" loading={busy === "save"} onclick={saveEdits}>{t("goal.saveEdits")}</Button>
          <Button size="sm" variant="ghost" class="min-h-10" onclick={() => (editing = false)}>{t("goal.doneEditing")}</Button>
        {:else if goal.stages.some((s) => s.status === "pending")}
          <Button size="sm" variant="ghost" class="min-h-10" onclick={startEditing}><Pencil />{t("goal.edit")}</Button>
        {/if}
        <Button size="sm" variant="ghost" class="min-h-10 text-danger" onclick={() => (stopOpen = true)}><Square />{t("goal.stop")}</Button>
      </div>
    {/if}

    {#if goal.report?.summary_md && !active}
      <div class="mt-3 rounded-2xl border border-line bg-surface-2 p-3 text-[13.5px]">
        <p class="mb-1 text-[12px] font-medium text-ink-3">{t("goal.report")}</p>
        <AgentMarkdown source={goal.report.summary_md} />
      </div>
    {/if}

    {#if goal.history.length && !compact}
      <button type="button" class="mt-2 inline-flex min-h-10 items-center gap-1 rounded-full px-2 text-[12.5px] font-medium text-ink-2 hover:bg-surface-3 hover:text-ink" aria-expanded={historyOpen} onclick={() => (historyOpen = !historyOpen)}>
        <ChevronRight class="size-3.5 transition-transform duration-150 motion-reduce:transition-none {historyOpen ? 'rotate-90' : ''}" />{t("goal.history")}
      </button>
      {#if historyOpen}
        <ul class="mt-1 flex flex-col gap-0.5 text-[12.5px] text-ink-3">{#each goal.history as h, i (i)}<li class="break-words">· {h.text}</li>{/each}</ul>
      {/if}
    {/if}
  {/if}
</article>

<ConfirmDialog bind:open={stopOpen} title={t("goal.stopConfirm")} description={t("goal.stopDesc")} confirmLabel={t("goal.stop")} onConfirm={() => void act("stop", () => goalsApi.cancel(goalId))} />
