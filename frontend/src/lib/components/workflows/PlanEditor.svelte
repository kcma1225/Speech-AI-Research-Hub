<script lang="ts">
  import { ChevronDown, ChevronUp, Plus, X } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Switch from "#lib/components/ui/Switch.svelte";
  import Textarea from "#lib/components/ui/Textarea.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import { workflowsApi, type ApproveEdits } from "#lib/workflows/api.ts";
  import { cleanOutline, moveItem, outlineChanged, type EditableOutline } from "#lib/workflows/reduce.ts";
  import type { Step, Workflow } from "#lib/workflows/types.ts";
  import type { WorkflowSession } from "#lib/workflows/session.svelte.ts";

  /**
   * The plan card (status awaiting_plan_approval): the full outline page by page (editable: titles, points, add /
   * remove / reorder), the acceptance criteria and the pending task steps (instructions, skip), then 開始 / 修改 / 取消.
   */
  let { session, workflow, steps, onCancel }: { session: WorkflowSession; workflow: Workflow; steps: Step[]; onCancel: () => void } = $props();

  const original = $derived(workflow.plan?.outline);
  let outline = $state<EditableOutline>([]);
  let criteria = $state<{ id?: string; text: string }[]>([]);
  let stepEdits = $state<Record<string, { instructions: string; skip: boolean }>>({});
  let editingStep = $state<string | null>(null);
  let seeded = $state("");
  let busy = $state(false);
  let reviseOpen = $state(false);
  let feedback = $state("");
  const owned = $derived(new Set((original ?? []).filter((p) => p.student_owned).map((p) => p.title)));
  const tasks = $derived(steps.filter((s) => s.kind === "task" && s.status === "pending"));

  // Seed the editors from each new plan (a re-plan replaces them).
  $effect(() => {
    const key = `${workflow.id}:${workflow.updated_at}:${workflow.plan?.summary ?? ""}`;
    if (key === seeded || busy) return;
    seeded = key;
    outline = (workflow.plan?.outline ?? []).map((p) => ({ title: p.title, points: [...p.points] }));
    criteria = workflow.criteria.map((c) => ({ id: c.id, text: c.text }));
    stepEdits = Object.fromEntries(steps.filter((s) => s.kind === "task").map((s) => [s.key, { instructions: s.instructions, skip: false }]));
  });

  function edits(): ApproveEdits {
    const out: ApproveEdits = {};
    if (original && outlineChanged(original, outline)) out.outline = cleanOutline(outline);
    const before = workflow.criteria.map((c) => ({ id: c.id, text: c.text }));
    const cleaned = criteria.map((c) => ({ ...c, text: c.text.trim() })).filter((c) => c.text);
    if (JSON.stringify(before) !== JSON.stringify(cleaned)) out.criteria = cleaned;
    const changed = tasks
      .map((s) => ({ s, e: stepEdits[s.key] }))
      .filter(({ s, e }) => e && (e.skip || e.instructions.trim() !== s.instructions))
      .map(({ s, e }) => ({ key: s.key, ...(e!.instructions.trim() !== s.instructions ? { instructions: e!.instructions.trim() } : {}), ...(e!.skip ? { skip: true } : {}) }));
    if (changed.length && !out.outline) out.steps = changed;
    return out;
  }

  async function start() {
    busy = true;
    try {
      const r = await workflowsApi.approve(workflow.id, edits());
      session.setWorkflow(r.workflow);
    } catch (e) {
      toasts.show(`${t("wf.actionFailed")}：${(e as Error).message}`, "error");
    } finally {
      busy = false;
    }
  }
  async function revise() {
    if (!feedback.trim()) return;
    busy = true;
    try {
      const r = await workflowsApi.revise(workflow.id, feedback.trim());
      session.setWorkflow(r.workflow);
      feedback = "";
      reviseOpen = false;
    } catch (e) {
      toasts.show(`${t("wf.actionFailed")}：${(e as Error).message}`, "error");
    } finally {
      busy = false;
    }
  }
</script>

<section class="plan flex flex-col gap-4 rounded-2xl border border-[var(--pill-butter-ink)]/30 bg-[var(--pill-butter)]/40 p-3 sm:p-4" aria-label={t("wf.plan")}>
  <div>
    <p class="text-[14px] font-semibold text-ink">{t("wf.planReview")}</p>
    <p class="mt-0.5 text-[12.5px] text-ink-3">{t("wf.planHint")}</p>
    {#if workflow.plan?.summary}<p class="mt-2 text-[13.5px] leading-relaxed text-ink-2">{workflow.plan.summary}</p>{/if}
    {#if workflow.plan?.notes}<p class="mt-1 text-[12.5px] text-[var(--pill-peach-ink)]">{workflow.plan.notes}</p>{/if}
  </div>

  {#if original}
    <div>
      <p class="mb-2 text-[13px] font-semibold text-ink">{t("wf.outline")} · {t("wf.outlinePages", { n: outline.length })}</p>
      <ol class="flex flex-col gap-2">
        {#each outline as page, i (i)}
          <!-- Controls sit in a header row so the title and points get the full width (phones too); points wrap. -->
          <li class="rounded-xl border border-line bg-surface p-2.5">
            <div class="flex items-center gap-1">
              <span class="pl-2 text-[12px] text-ink-3 tabular-nums">{t("wf.page", { n: i + 1 })}</span>
              {#if owned.has(page.title)}<span class="ml-1 rounded-full bg-surface-3 px-2 py-0.5 text-[11.5px] text-ink-3">{t("wf.studentOwned")}</span>{/if}
              <span class="flex-1"></span>
              <button type="button" class="grid size-9 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink disabled:opacity-30" aria-label={t("wf.moveUp")} disabled={i === 0} onclick={() => (outline = moveItem(outline, i, i - 1))}><ChevronUp class="size-4" /></button>
              <button type="button" class="grid size-9 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink disabled:opacity-30" aria-label={t("wf.moveDown")} disabled={i === outline.length - 1} onclick={() => (outline = moveItem(outline, i, i + 1))}><ChevronDown class="size-4" /></button>
              <button type="button" class="grid size-9 place-items-center rounded-full text-ink-3 hover:bg-danger-soft hover:text-danger disabled:opacity-30" aria-label={t("wf.removePage")} disabled={outline.length <= 1} onclick={() => (outline = outline.filter((__, k) => k !== i))}><X class="size-4" /></button>
            </div>
            <label class="sr-only" for="wf-page-{workflow.id}-{i}">{t("wf.pageTitlePlaceholder")}</label>
            <input id="wf-page-{workflow.id}-{i}" class="h-10 w-full rounded-lg border border-transparent bg-transparent px-2 text-[14px] font-medium text-ink outline-none hover:border-line focus:border-ink" bind:value={page.title} placeholder={t("wf.pageTitlePlaceholder")} />
            <ul class="mt-0.5 flex flex-col gap-0.5">
              {#each page.points as _, j (j)}
                <li class="flex items-start gap-1">
                  <span class="mt-2 ml-2 text-ink-3" aria-hidden="true">•</span>
                  <label class="sr-only" for="wf-pt-{workflow.id}-{i}-{j}">{t("wf.point")}</label>
                  <textarea id="wf-pt-{workflow.id}-{i}-{j}" rows="1" class="point min-h-9 min-w-0 flex-1 resize-none rounded-lg border border-transparent bg-transparent px-2 py-1.5 text-[13px] leading-snug text-ink-2 outline-none hover:border-line focus:border-ink" bind:value={page.points[j]} onkeydown={(e) => e.key === "Enter" && !e.isComposing && e.preventDefault()}></textarea>
                  <button type="button" class="grid size-9 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label={t("wf.removePoint")} onclick={() => (page.points = page.points.filter((__, k) => k !== j))}><X class="size-3.5" /></button>
                </li>
              {/each}
            </ul>
            {#if page.points.length < 8}<button type="button" class="mt-0.5 inline-flex min-h-9 items-center gap-1 rounded-full px-2 text-[12.5px] text-ink-3 hover:bg-surface-3 hover:text-ink" onclick={() => (page.points = [...page.points, ""])}><Plus class="size-3.5" />{t("wf.addPoint")}</button>{/if}
          </li>
        {/each}
      </ol>
      <button type="button" class="mt-2 inline-flex min-h-10 items-center gap-1.5 rounded-full border border-dashed border-line-2 px-4 text-[13px] text-ink-2 hover:border-ink hover:text-ink" onclick={() => (outline = [...outline, { title: "", points: [] }])}><Plus class="size-4" />{t("wf.addPage")}</button>
    </div>
  {/if}

  <div>
    <p class="mb-2 text-[13px] font-semibold text-ink">{t("wf.criteria")}</p>
    <ul class="flex flex-col gap-1">
      {#each criteria as c, i (i)}
        <li class="flex items-center gap-1">
          <span class="grid size-5 shrink-0 place-items-center rounded-full border border-line-2" aria-hidden="true"></span>
          <label class="sr-only" for="wf-cr-{workflow.id}-{i}">{t("wf.criteria")} {i + 1}</label>
          <input id="wf-cr-{workflow.id}-{i}" class="h-10 min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-2 text-[13.5px] text-ink outline-none hover:border-line focus:border-ink" bind:value={c.text} />
          <button type="button" class="grid size-9 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label={t("wf.crit.remove")} onclick={() => (criteria = criteria.filter((__, k) => k !== i))}><X class="size-3.5" /></button>
        </li>
      {/each}
    </ul>
    <button type="button" class="mt-1 inline-flex min-h-9 items-center gap-1 rounded-full px-2 text-[12.5px] text-ink-3 hover:bg-surface-3 hover:text-ink" onclick={() => (criteria = [...criteria, { text: "" }])}><Plus class="size-3.5" />{t("wf.crit.add")}</button>
  </div>

  {#if tasks.length && !(original && outlineChanged(original, outline))}
    <div>
      <p class="mb-2 text-[13px] font-semibold text-ink">{t("wf.steps")}</p>
      <ul class="flex flex-col gap-1.5">
        {#each tasks as s (s.key)}
          {@const e = stepEdits[s.key]}
          {#if e}
            <li class="rounded-xl border border-line bg-surface p-2.5">
              <div class="flex items-center gap-2">
                <span class="min-w-0 flex-1 text-[13.5px] break-words {e.skip ? 'text-ink-3 line-through' : 'text-ink'}">{s.title}</span>
                <button type="button" class="min-h-9 shrink-0 rounded-full px-2.5 text-[12px] text-ink-3 hover:bg-surface-3 hover:text-ink" onclick={() => (editingStep = editingStep === s.key ? null : s.key)}>{t("wf.editInstructions")}</button>
                <Switch label={t("wf.stepSkip")} checked={!e.skip} onCheckedChange={(v) => (e.skip = !v)} />
              </div>
              {#if editingStep === s.key}
                <Textarea class="mt-2" rows={3} bind:value={e.instructions} label={t("wf.editInstructions")} />
              {/if}
            </li>
          {/if}
        {/each}
      </ul>
    </div>
  {/if}

  {#if workflow.plan?.writes?.length}
    <div class="text-[12.5px] text-ink-2">
      <span class="font-medium text-ink">{t("wf.writes")}：</span>{workflow.plan.writes.map((w) => w.label).join("、")}
    </div>
  {/if}
  {#if workflow.tainted && workflow.taint_sources.length}
    <p class="text-[12px] text-ink-3">{t("wf.tainted", { sources: workflow.taint_sources.slice(-3).join("、") })}</p>
  {/if}

  {#if reviseOpen}
    <div class="flex flex-col gap-2">
      <Textarea rows={3} bind:value={feedback} label={t("wf.reviseHint")} />
      <div class="flex flex-wrap gap-2">
        <Button variant="primary" loading={busy} disabled={!feedback.trim()} onclick={revise}>{t("wf.reviseSend")}</Button>
        <Button variant="ghost" onclick={() => (reviseOpen = false)}>{t("wf.cancel")}</Button>
      </div>
    </div>
  {:else}
    <div class="flex flex-wrap gap-2">
      <Button variant="primary" loading={busy} onclick={start}>{t("wf.start")}</Button>
      <Button variant="secondary" disabled={busy} onclick={() => (reviseOpen = true)}>{t("wf.revise")}</Button>
      <Button variant="ghost" disabled={busy} onclick={onCancel}>{t("wf.cancel")}</Button>
    </div>
  {/if}
</section>

<style>
  /* Points grow with their text (wrapping instead of a one-line field that cuts long points off). */
  .point {
    field-sizing: content;
  }
  .plan {
    animation: plan-in 200ms cubic-bezier(0.2, 0, 0, 1);
  }
  @keyframes plan-in {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .plan {
      animation: none;
    }
  }
</style>
