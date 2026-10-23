<script lang="ts">
  import { ChevronDown, ChevronUp, Plus, X } from "@lucide/svelte";
  import { hasMessage, t } from "#lib/i18n.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
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
  // 「你的要求」: typed requirements (language, pages, topics…); `standing` ones are kept from the artifact (沿用).
  let reqs = $state<{ id?: string; type?: string; text: string; source?: string; quote?: string }[]>([]);
  // The Brief (backend brief.ts): deliverable + the user's own words + what they left unspecified (read-only here).
  const brief = $derived(workflow.brief ?? null);
  const kindLabel = $derived(brief ? (hasMessage(`wf.brief.kind.${brief.deliverable.kind}`) ? t(`wf.brief.kind.${brief.deliverable.kind}` as MessageKey) : brief.deliverable.label) : "");
  const UNSPEC: Record<string, string> = { 語言: "language", 頁數: "pages", 篇幅: "length", 要報告的論文: "paper" };
  const unspecLabel = (u: string) => (UNSPEC[u] ? t(`wf.brief.unspec.${UNSPEC[u]}` as MessageKey) : u);
  // 「未指定」 → a new requirement row the user fills in (「頁數：」).
  function specify(u: string) {
    reqs = [...reqs, { text: `${unspecLabel(u)}：` }];
    requestAnimationFrame(() => document.getElementById(`wf-req-${workflow.id}-${reqs.length - 1}`)?.focus());
  }
  const reqType = (type?: string) => (hasMessage(`wf.req.type.${type ?? "other"}`) ? `wf.req.type.${type ?? "other"}` : "wf.req.type.other") as MessageKey;
  const ownCriteria = $derived(workflow.criteria.filter((c) => !c.id.startsWith("req_")));
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
    criteria = ownCriteria.map((c) => ({ id: c.id, text: c.text }));
    reqs = (workflow.plan?.requirements ?? []).map((r) => ({ id: r.id, type: r.type, text: r.text, source: r.source, quote: r.quote }));
    stepEdits = Object.fromEntries(steps.filter((s) => s.kind === "task").map((s) => [s.key, { instructions: s.instructions, skip: false }]));
  });

  function edits(): ApproveEdits {
    const out: ApproveEdits = {};
    if (original && outlineChanged(original, outline)) out.outline = cleanOutline(outline);
    const before = ownCriteria.map((c) => ({ id: c.id, text: c.text }));
    const cleaned = criteria.map((c) => ({ ...c, text: c.text.trim() })).filter((c) => c.text);
    if (JSON.stringify(before) !== JSON.stringify(cleaned)) out.criteria = cleaned;
    const reqBefore = (workflow.plan?.requirements ?? []).map((r) => ({ id: r.id, text: r.text }));
    const reqNow = reqs.map((r) => ({ id: r.id, text: r.text.trim() })).filter((r) => r.text);
    if (JSON.stringify(reqBefore) !== JSON.stringify(reqNow)) out.requirements = reqNow.map((r) => ({ ...r, type: reqs.find((x) => x.id && x.id === r.id)?.type }));
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

<section class="plan @container flex flex-col gap-4 rounded-2xl border border-[var(--pill-butter-ink)]/30 bg-[var(--pill-butter)]/40 p-3 max-sm:-mx-1.5 max-sm:px-2.5 sm:p-4" aria-label={t("wf.plan")}>
  <div>
    <p class="text-[14px] font-semibold text-ink">{t("wf.planReview")}</p>
    <p class="mt-0.5 text-[12.5px] text-ink-3">{t("wf.planHint")}</p>
    {#if workflow.plan?.summary}<p class="mt-2 max-w-[90ch] text-[13.5px] leading-relaxed text-ink-2">{workflow.plan.summary}</p>{/if}
    {#if workflow.plan?.notes}<p class="mt-1 text-[12.5px] text-[var(--pill-peach-ink)]">{workflow.plan.notes}</p>{/if}
  </div>

  {#if brief}
    <div data-wf-brief class="flex max-w-[52rem] flex-col gap-2 rounded-xl border border-line bg-surface p-2.5 sm:p-3">
      <div class="flex flex-wrap items-baseline gap-x-2">
        <p class="text-[13px] font-semibold text-ink">{t("wf.brief.title")}</p>
        <span class="text-[11.5px] text-ink-3 tabular-nums">{t("wf.brief.version", { n: brief.version })}</span>
      </div>
      <p class="-mt-1 text-[12px] text-ink-3">{t("wf.brief.hint")}</p>
      <p class="text-[13px] text-ink-2"><span class="font-medium text-ink">{t("wf.brief.deliverable")}：</span>{kindLabel}<span class="ml-1 text-[12px] text-ink-3">{t("wf.brief.hard")}</span></p>
      {#if brief.user_words.length}
        <div>
          <p class="mb-1 text-[12.5px] font-medium text-ink">{t("wf.brief.words")}</p>
          <ul class="flex flex-col gap-1">
            {#each brief.user_words as w, i (i)}
              <li class="border-l-2 border-[var(--pill-butter-ink)]/50 pl-2.5 text-[13px] leading-relaxed break-words whitespace-pre-wrap text-ink">「{w}」</li>
            {/each}
          </ul>
        </div>
      {/if}
      {#if brief.paraphrase}
        <details class="text-[12.5px] text-ink-3">
          <summary class="min-h-9 cursor-pointer py-2">{t("wf.brief.paraphrase")}</summary>
          <p class="break-words whitespace-pre-wrap">{brief.paraphrase}</p>
        </details>
      {/if}
      {#if brief.unspecified.length}
        <div>
          <p class="text-[12.5px] font-medium text-ink">{t("wf.brief.unspecified")}</p>
          <p class="mb-1 text-[12px] text-ink-3">{t("wf.brief.unspecifiedHint")}</p>
          <div class="flex flex-wrap gap-1.5">
            {#each brief.unspecified as u (u)}
              <button type="button" class="inline-flex min-h-9 items-center gap-1 rounded-full border border-dashed border-line-2 px-3 text-[12.5px] text-ink-2 hover:border-ink hover:text-ink" onclick={() => specify(u)}><Plus class="size-3.5" />{unspecLabel(u)}：{t("wf.brief.unset")}</button>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  {/if}

  <div data-wf-requirements>
    <p class="text-[13px] font-semibold text-ink">{t("wf.req.title")}</p>
    <p class="mb-2 text-[12px] text-ink-3">{t("wf.req.hint")}</p>
    {#if workflow.plan?.edit_kind}<p class="mb-1.5 text-[12.5px] text-ink-2">{t(workflow.plan.edit_kind === "expand" ? "wf.edit.expand" : "wf.edit.revise")}</p>{/if}
    {#if workflow.plan?.front_title}<p class="mb-1.5 text-[12.5px] break-words text-ink-2">{t("wf.frontTitle", { title: workflow.plan.front_title })}</p>{/if}
    <ul class="flex max-w-[52rem] flex-col gap-1">
      {#each reqs as r, i (i)}
        <li class="flex items-start gap-1.5">
          <span class="mt-2.5 min-w-[3.25rem] shrink-0 rounded-full bg-surface-3 px-2 py-0.5 text-center text-[11.5px] text-ink-2">{t(reqType(r.type))}</span>
          {#if r.source === "standing"}<span class="mt-2.5 shrink-0 rounded-full bg-[var(--pill-sky)] px-2 py-0.5 text-[11.5px] text-[var(--pill-sky-ink)]">{t("wf.req.inherited")}</span>{/if}
          <label class="sr-only" for="wf-req-{workflow.id}-{i}">{t("wf.req.title")} {i + 1}</label>
          <!-- Wraps (phones): a one-line field would cut the requirement off. -->
          <textarea id="wf-req-{workflow.id}-{i}" rows="1" class="point min-h-10 min-w-0 flex-1 resize-none rounded-lg border border-transparent bg-transparent px-2 py-2 text-[13.5px] leading-snug text-ink outline-none hover:border-line focus:border-ink" bind:value={r.text} placeholder={t("wf.req.placeholder")} onkeydown={(e) => e.key === "Enter" && !e.isComposing && e.preventDefault()}></textarea>
          <button type="button" class="grid size-9 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label={t("wf.req.remove")} onclick={() => (reqs = reqs.filter((__, k) => k !== i))}><X class="size-3.5" /></button>
        </li>
        {#if r.quote}<li class="-mt-1 pl-[4.25rem] text-[11.5px] break-words text-ink-3">{t("wf.req.quote", { quote: r.quote })}</li>{/if}
      {/each}
    </ul>
    {#if reqs.length < 12}<button type="button" class="mt-1 inline-flex min-h-9 items-center gap-1 rounded-full px-2 text-[12.5px] text-ink-3 hover:bg-surface-3 hover:text-ink" onclick={() => (reqs = [...reqs, { text: "" }])}><Plus class="size-3.5" />{t("wf.req.add")}</button>{/if}
  </div>

  {#if original}
    <div>
      <p class="mb-2 text-[13px] font-semibold text-ink">{t("wf.outline")} · {t("wf.outlinePages", { n: outline.length })}</p>
      <!-- Wide cards: two pages side by side (reading order left → right), so a long outline is not one tall column. -->
      <ol class="grid gap-2 @min-[52rem]:grid-cols-2">
        {#each outline as page, i (i)}
          <!-- Controls sit in a header row so the title and points get the full width (phones too); points wrap. -->
          <li class="rounded-xl border border-line bg-surface p-2 sm:p-2.5">
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
                  <span class="mt-2 ml-1 text-ink-3 sm:ml-2" aria-hidden="true">•</span>
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
    <ul class="flex max-w-[52rem] flex-col gap-1">
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
      <ul class="flex max-w-[52rem] flex-col gap-1.5">
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
