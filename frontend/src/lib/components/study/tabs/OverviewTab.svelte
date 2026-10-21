<script lang="ts">
  import { DropdownMenu } from "bits-ui";
  import { goto } from "$app/navigation";
  import { Archive, ArchiveRestore, ArrowDown, ArrowUp, Check, Ellipsis, FileInput, Flag, PenLine, Plus, Trash2, X } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { formatDate, t } from "#lib/i18n.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import { session } from "#lib/stores/session.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Card from "#lib/components/ui/Card.svelte";
  import CardHeader from "#lib/components/ui/CardHeader.svelte";
  import CheckCircle from "#lib/components/ui/CheckCircle.svelte";
  import ConfirmDialog from "#lib/components/ui/ConfirmDialog.svelte";
  import DatePicker from "#lib/components/ui/DatePicker.svelte";
  import EmptyState from "#lib/components/ui/EmptyState.svelte";
  import Select from "#lib/components/ui/Select.svelte";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";
  import { menuContent, menuItem } from "#lib/components/ui/menu.ts";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import MarkdownEditor from "#lib/components/markdown/MarkdownEditor.svelte";
  import StudyWorkflows from "#lib/components/workflows/StudyWorkflows.svelte";
  import MarkdownView from "#lib/components/markdown/MarkdownView.svelte";
  import DocImportSheet from "#lib/components/doc-import/DocImportSheet.svelte";
  import SummaryReview from "#lib/components/doc-import/SummaryReview.svelte";
  import { uploadMdImage, type ImportedDocument } from "#lib/components/doc-import/api.ts";
  import type { Milestone, StudyStage, StudyStatus } from "#lib/studies/types.ts";
  import DueLabel from "../DueLabel.svelte";
  import type { StudyTabProps } from "./registry.ts";
  import { MATURITIES } from "#lib/agent/maturity.ts";

  let { detail, reload }: StudyTabProps = $props();
  const study = $derived(detail.study);
  const canEdit = $derived(detail.permissions.edit);
  const canManage = $derived(detail.permissions.manage);
  const base = $derived(`/studies/${study.id}`);

  async function run<T>(work: () => Promise<T>, success?: string): Promise<T | undefined> {
    try {
      const result = await work();
      if (success) toasts.show(success, "success");
      await reload();
      return result;
    } catch (e) {
      toasts.show((e as Error).message, "error");
      return undefined;
    }
  }

  // ───── Summary ─────
  let editingSummary = $state(false);
  let summaryDraft = $state("");
  let summaryLayout = $state<"split" | "edit" | "preview">(session.user?.preferences.editor.layout ?? "split");
  let savingSummary = $state(false);
  function editSummary() {
    summaryDraft = study.summary_md;
    editingSummary = true;
  }
  // 「從檔案匯入」: while editing, the Markdown goes into the draft; otherwise it becomes a suggestion to review.
  let importOpen = $state(false);
  let summaryReview = $state<ReturnType<typeof SummaryReview> | null>(null);
  function importedIntoDraft(markdown: string, doc: ImportedDocument) {
    summaryDraft = summaryDraft.trim() ? `${summaryDraft.replace(/\s+$/, "")}\n\n${markdown}` : markdown;
    toasts.show(doc.truncated ? t("docimport.truncated") : t("docimport.done", { name: doc.filename }), "success");
  }
  async function importedAsSuggestion() {
    toasts.show(t("docimport.doneSuggestion"), "success");
    await summaryReview?.show();
  }
  const uploadImage = (file: File) => uploadMdImage(`study:${study.id}`, file);
  async function saveSummary() {
    savingSummary = true;
    const ok = await run(() => api.patch(base, { summary_md: summaryDraft }), t("studies.summary.saved"));
    savingSummary = false;
    if (ok !== undefined) editingSummary = false;
  }

  // ───── Stages ─────
  const stageState = (stage: StudyStage) => (stage.completed_at ? "done" : stage.is_current ? "current" : "todo");
  const setCurrent = (stage: StudyStage) => run(() => api.post(`${base}/stages/${stage.id}/current`), t("studies.stages.changed", { name: stage.name }));
  const setComplete = (stage: StudyStage, completed: boolean) => run(() => api.post(`${base}/stages/${stage.id}/complete`, { completed }));

  let stagesOpen = $state(false);
  let newStage = $state("");
  let renames = $state<Record<string, string>>({});
  $effect(() => {
    if (stagesOpen) renames = Object.fromEntries(detail.stages.map(s => [s.id, s.name]));
  });
  async function addStage(e: SubmitEvent) {
    e.preventDefault();
    if (!newStage.trim()) return;
    await run(() => api.post(`${base}/stages`, { name: newStage.trim() }));
    newStage = "";
  }
  async function renameStage(stage: StudyStage) {
    const name = renames[stage.id]?.trim();
    if (!name || name === stage.name) return;
    await run(() => api.patch(`${base}/stages/${stage.id}`, { name }));
  }
  async function moveStage(index: number, delta: number) {
    const ids = detail.stages.map(s => s.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(index + delta, 0, moved!);
    await run(() => api.put(`${base}/stages/order`, { ids }));
  }
  let stageToDelete = $state<StudyStage | null>(null);
  let stageDeleteOpen = $state(false);
  const deleteStage = (stage: StudyStage) => ((stageToDelete = stage), (stageDeleteOpen = true));
  async function confirmDeleteStage() {
    const stage = stageToDelete;
    if (stage) await run(() => api.del(`${base}/stages/${stage.id}`), t("crud.stage.deleted"));
  }

  // ───── Milestones ─────
  let milestoneOpen = $state(false);
  let editingMilestone = $state<Milestone | null>(null);
  let msTitle = $state("");
  let msDue = $state("");
  let msStage = $state("");
  let msSaving = $state(false);
  function openMilestone(milestone: Milestone | null) {
    editingMilestone = milestone;
    msTitle = milestone?.title ?? "";
    msDue = milestone?.due_on ?? "";
    msStage = milestone?.stage_id ?? "";
    milestoneOpen = true;
  }
  async function saveMilestone(e?: SubmitEvent) {
    e?.preventDefault();
    if (!msTitle.trim()) return;
    msSaving = true;
    const body = { title: msTitle.trim(), due_on: msDue || null, stage_id: msStage || null };
    const ok = await run(
      () => (editingMilestone ? api.patch(`${base}/milestones/${editingMilestone.id}`, body) : api.post(`${base}/milestones`, body)),
      t("studies.milestones.saved"),
    );
    msSaving = false;
    if (ok !== undefined) milestoneOpen = false;
  }
  const toggleMilestone = (milestone: Milestone, done: boolean) => run(() => api.patch(`${base}/milestones/${milestone.id}`, { done }));
  let confirmMilestone = $state(false);
  async function deleteMilestone() {
    if (!editingMilestone) return;
    const ok = await run(() => api.del(`${base}/milestones/${editingMilestone!.id}`));
    if (ok !== undefined) milestoneOpen = false;
  }
  const stageName = (id: string | null) => detail.stages.find(s => s.id === id)?.name ?? null;

  // ───── Settings ─────
  const statuses: StudyStatus[] = ["active", "paused", "completed"];
  // ───── Rename (the slug stays) ─────
  let titleDraft = $state("");
  let savingTitle = $state(false);
  $effect.pre(() => {
    titleDraft = study.title;
  });
  async function saveTitle(e: SubmitEvent) {
    e.preventDefault();
    const title = titleDraft.trim();
    if (!title || title === study.title) return;
    savingTitle = true;
    await run(() => api.patch(base, { title }), t("studies.rename.saved"));
    savingTitle = false;
  }
  const setStatus = (status: StudyStatus) => run(() => api.patch(base, { status }), t("studies.settings.saved"));
  const setMaturity = (maturity: string) => run(() => api.patch(base, { maturity: maturity || null }), t("studies.maturity.saved"));
  let confirmDelete = $state(false);
  async function deleteStudy() {
    await api.del(base);
    toasts.show(t("studies.deleted"), "success");
    await goto("/studies", { replace: true });
  }
  const iconButton = "grid size-10 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent";
</script>

<div class="grid grid-cols-[minmax(0,1fr)] items-start gap-4 sm:gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
  <div class="flex min-w-0 flex-col gap-4 sm:gap-5">
    <StudyWorkflows study={detail.study.slug} />
    <!-- Summary -->
    <Card>
      <CardHeader title={t("studies.summary")}>
        {#snippet actions()}
          {#if canEdit && !editingSummary}
            <Button size="sm" variant="ghost" aria-label={t("docimport.title")} onclick={() => (importOpen = true)}><FileInput /><span class="hidden sm:inline">{t("docimport.title")}</span></Button>
            <Button size="sm" variant="ghost" onclick={editSummary}><PenLine />{t("studies.summary.edit")}</Button>
          {/if}
        {/snippet}
      </CardHeader>
      {#if !editingSummary}<SummaryReview bind:this={summaryReview} studyId={study.id} summary={study.summary_md} onApplied={reload} />{/if}
      {#if editingSummary}
        <div class="flex flex-col gap-3">
          <MarkdownEditor bind:value={summaryDraft} bind:layout={summaryLayout} fontSize={session.user?.preferences.editor.fontSize ?? 15} label={t("studies.summary")} imageUpload={uploadImage} onImport={() => (importOpen = true)} />
          <div class="flex justify-end gap-2">
            <Button variant="ghost" onclick={() => (editingSummary = false)}>{t("action.cancel")}</Button>
            <Button variant="primary" loading={savingSummary} onclick={saveSummary}>{t("action.save")}</Button>
          </div>
        </div>
      {:else if study.summary_md.trim()}
        {#if study.maturity}<p class="mb-3"><span class="inline-flex h-7 items-center rounded-full bg-[var(--pill-lilac)] px-3 text-[12px] font-medium text-[var(--pill-lilac-ink)]" title={t(`studies.maturity.${study.maturity}.hint`)}>{t("studies.maturity")}：{t(`studies.maturity.${study.maturity}`)}</span></p>{/if}
        <MarkdownView source={study.summary_md} fontSize={session.user?.preferences.editor.fontSize} />
      {:else}
        <EmptyState title={t("studies.summary.empty")} hint={canEdit ? t("studies.summary.emptyHint") : undefined} class="py-6">
          {#snippet action()}{#if canEdit}<Button size="sm" variant="secondary" onclick={editSummary}><PenLine />{t("studies.summary.edit")}</Button>{/if}{/snippet}
        </EmptyState>
      {/if}
    </Card>

    {#if canEdit}
      <DocImportSheet
        bind:open={importOpen}
        target={editingSummary ? { kind: "draft", purpose: "study_summary", studyId: study.id } : { kind: "summary", studyId: study.id, hasText: !!study.summary_md.trim() }}
        onMarkdown={importedIntoDraft}
        onSuggestion={importedAsSuggestion}
      />
    {/if}

    <!-- Stage timeline -->
    <Card>
      <CardHeader title={t("studies.stages")}>
        {#snippet actions()}{#if canEdit}<Button size="sm" variant="ghost" onclick={() => (stagesOpen = true)}><PenLine />{t("studies.stages.manage")}</Button>{/if}{/snippet}
      </CardHeader>
      <ol class="relative flex flex-col">
        {#each detail.stages as stage, i (stage.id)}
          {@const state = stageState(stage)}
          <li class="relative flex gap-3.5 pb-5 last:pb-0">
            {#if i < detail.stages.length - 1}
              <span class="absolute top-7 bottom-0 left-[13px] w-px {state === 'done' ? 'bg-ink' : 'bg-line-2'}" aria-hidden="true"></span>
            {/if}
            <span
              class="relative z-[1] grid size-[27px] shrink-0 place-items-center rounded-full border-[1.5px] text-[12px] font-semibold tabular-nums {state === 'done'
                ? 'border-ink bg-ink text-surface'
                : state === 'current'
                  ? 'border-ink bg-surface text-ink ring-4 ring-surface-3'
                  : 'border-line-2 bg-surface text-ink-3'}"
              aria-hidden="true"
            >
              {#if state === "done"}<Check class="size-3.5" strokeWidth={3} />{:else}{i + 1}{/if}
            </span>
            <div class="flex min-w-0 flex-1 items-start justify-between gap-2">
              <div class="min-w-0 pt-0.5">
                <p class="flex flex-wrap items-center gap-2 text-[14.5px] font-medium {state === 'todo' ? 'text-ink-2' : 'text-ink'}">
                  {stage.name}
                  {#if state === "current"}<span class="rounded-full bg-ink px-2 py-0.5 text-[11px] font-semibold text-surface">{t("studies.stages.current")}</span>{/if}
                </p>
                <p class="mt-0.5 text-[12.5px] text-ink-3">
                  {#if stage.completed_at}{t("studies.stages.completedOn", { date: formatDate(stage.completed_at) })}
                  {:else if stage.started_at}{t("studies.stages.started", { date: formatDate(stage.started_at) })}
                  {:else}{t("studies.stages.upcoming")}{/if}
                  {#if stage.description}<span class="block text-ink-3">{stage.description}</span>{/if}
                </p>
              </div>
              {#if canEdit}
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger class="{iconButton} -mt-1.5 -mr-2" aria-label={t("studies.stages.actions", { name: stage.name })}><Ellipsis class="size-4" /></DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content align="end" sideOffset={4} class="{menuContent} w-52">
                      {#if !stage.is_current}<DropdownMenu.Item class={menuItem} onSelect={() => setCurrent(stage)}><Flag />{t("studies.stages.setCurrent")}</DropdownMenu.Item>{/if}
                      {#if stage.completed_at}
                        <DropdownMenu.Item class={menuItem} onSelect={() => setComplete(stage, false)}><X />{t("studies.stages.uncomplete")}</DropdownMenu.Item>
                      {:else}
                        <DropdownMenu.Item class={menuItem} onSelect={() => setComplete(stage, true)}><Check />{t("studies.stages.complete")}</DropdownMenu.Item>
                      {/if}
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              {/if}
            </div>
          </li>
        {/each}
      </ol>
    </Card>
  </div>

  <div class="flex min-w-0 flex-col gap-4 sm:gap-5">
    <!-- Milestones -->
    <Card>
      <CardHeader title={t("studies.milestones")}>
        {#snippet actions()}{#if canEdit}<Button size="sm" variant="ghost" onclick={() => openMilestone(null)}><Plus />{t("studies.milestones.add")}</Button>{/if}{/snippet}
      </CardHeader>
      {#if !detail.milestones.length}
        <EmptyState title={t("studies.milestones.empty")} hint={canEdit ? t("studies.milestones.emptyHint") : undefined} class="py-5">
          {#snippet icon()}<Flag />{/snippet}
        </EmptyState>
      {:else}
        <ul class="-mx-2 flex flex-col">
          {#each detail.milestones as milestone (milestone.id)}
            <li class="flex items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-surface-2">
              <CheckCircle
                checked={Boolean(milestone.done_at)}
                disabled={!canEdit}
                label={t(milestone.done_at ? "studies.milestones.markOpen" : "studies.milestones.markDone", { title: milestone.title })}
                onToggle={done => toggleMilestone(milestone, done)}
              />
              <button type="button" class="flex min-h-10 min-w-0 flex-1 flex-col items-start justify-center text-left disabled:cursor-default" disabled={!canEdit} onclick={() => openMilestone(milestone)}>
                <span class="w-full truncate text-[14px] {milestone.done_at ? 'text-ink-3 line-through' : 'text-ink'}">{milestone.title}</span>
                <span class="flex items-center gap-2">
                  {#if milestone.due_on}<DueLabel date={milestone.due_on} done={Boolean(milestone.done_at)} />{/if}
                  {#if stageName(milestone.stage_id)}<span class="truncate text-[12px] text-ink-3">{stageName(milestone.stage_id)}</span>{/if}
                </span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </Card>

    <!-- Settings -->
    {#if canEdit || canManage}
      <Card>
        <CardHeader title={t("studies.settings")} />
        <div class="flex flex-col gap-4">
          {#if canEdit}
            <form class="flex items-end gap-2" onsubmit={saveTitle}>
              <TextField label={t("studies.field.title")} bind:value={titleDraft} maxlength={200} hint={t("studies.rename.hint")} class="min-w-0 flex-1" />
              <Button type="submit" size="sm" variant="secondary" class="mb-[26px] h-11" loading={savingTitle} disabled={!titleDraft.trim() || titleDraft.trim() === study.title}>{t("action.save")}</Button>
            </form>
          {/if}
          {#if study.status !== "archived"}
            <div class="flex flex-col gap-1.5">
              <span class="text-[13px] font-medium text-ink-2">{t("studies.settings.status")}</span>
              <Select
                value={study.status}
                label={t("studies.settings.status")}
                class="w-full"
                options={statuses.map(s => ({ value: s, label: t(`studies.status.${s}` as MessageKey) }))}
                onValueChange={v => setStatus(v)}
              />
            </div>
          {/if}
          {#if canEdit}
            <div class="flex flex-col gap-1.5">
              <span class="text-[13px] font-medium text-ink-2">{t("studies.maturity")}</span>
              <Select
                value={study.maturity ?? ""}
                label={t("studies.maturity")}
                class="w-full"
                options={[{ value: "", label: t("studies.maturity.none") }, ...MATURITIES.map(m => ({ value: m, label: t(`studies.maturity.${m}`), hint: t(`studies.maturity.${m}.hint`) }))]}
                onValueChange={v => setMaturity(v)}
              />
            </div>
          {/if}
          {#if canManage}
            <div class="flex flex-wrap gap-2">
              {#if study.status === "archived"}
                <Button size="sm" variant="secondary" onclick={() => setStatus("active")}><ArchiveRestore />{t("studies.unarchive")}</Button>
              {:else}
                <Button size="sm" variant="secondary" onclick={() => setStatus("archived")}><Archive />{t("studies.archive")}</Button>
              {/if}
              <Button size="sm" variant="ghost" class="hover:!text-danger" onclick={() => (confirmDelete = true)}><Trash2 />{t("studies.delete")}</Button>
            </div>
          {:else}
            <p class="text-[12.5px] text-ink-3">{t("studies.manageOnly")}</p>
          {/if}
        </div>
      </Card>
    {/if}
  </div>
</div>

<!-- Stage editor -->
<Sheet bind:open={stagesOpen} title={t("studies.stages.manage")} side="right">
  {#snippet children()}
    <ol class="flex flex-col gap-2 pt-1">
      {#each detail.stages as stage, i (stage.id)}
        <li class="flex items-center gap-1.5 rounded-2xl border border-line p-2 pl-3">
          <span class="w-5 shrink-0 text-center text-[12px] font-semibold text-ink-3 tabular-nums">{i + 1}</span>
          <input
            class="h-10 min-w-0 flex-1 rounded-lg bg-transparent px-2 text-[15px] text-ink outline-none focus:bg-surface-2 sm:text-sm"
            aria-label={t("studies.stages.name")}
            maxlength={60}
            bind:value={renames[stage.id]}
            onblur={() => renameStage(stage)}
            onkeydown={e => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
          />
          <button type="button" class={iconButton} disabled={i === 0} aria-label={t("studies.stages.moveUp", { name: stage.name })} onclick={() => moveStage(i, -1)}><ArrowUp class="size-4" /></button>
          <button type="button" class={iconButton} disabled={i === detail.stages.length - 1} aria-label={t("studies.stages.moveDown", { name: stage.name })} onclick={() => moveStage(i, 1)}><ArrowDown class="size-4" /></button>
          <button type="button" class="{iconButton} hover:!text-danger" disabled={stage.is_current} aria-label={t("studies.stages.delete", { name: stage.name })} onclick={() => deleteStage(stage)}><Trash2 class="size-4" /></button>
        </li>
      {/each}
    </ol>
    <form class="mt-4 flex items-end gap-2" onsubmit={addStage}>
      <TextField label={t("studies.stages.add")} bind:value={newStage} maxlength={60} class="flex-1" />
      <Button type="submit" variant="primary" disabled={!newStage.trim()}><Plus />{t("studies.stages.add")}</Button>
    </form>
  {/snippet}
</Sheet>

<!-- Milestone editor -->
<Sheet bind:open={milestoneOpen} title={editingMilestone ? t("studies.milestones.edit") : t("studies.milestones.add")} side="right">
  {#snippet children()}
    <form id="milestone-form" class="flex flex-col gap-4 pt-1" onsubmit={saveMilestone}>
      <TextField label={t("studies.milestones.title")} bind:value={msTitle} maxlength={200} required />
      <div class="flex flex-col gap-1.5">
        <span class="text-[13px] font-medium text-ink-2">{t("studies.milestones.due")}</span>
        <DatePicker bind:value={msDue} label={t("studies.milestones.due")} clearable class="w-full justify-start" />
      </div>
      <div class="flex flex-col gap-1.5">
        <span class="text-[13px] font-medium text-ink-2">{t("studies.milestones.stage")}</span>
        <Select
          bind:value={msStage}
          label={t("studies.milestones.stage")}
          class="w-full"
          options={[{ value: "", label: t("studies.milestones.noStage") }, ...detail.stages.map(s => ({ value: s.id, label: s.name }))]}
        />
      </div>
    </form>
  {/snippet}
  {#snippet footer()}
    {#if editingMilestone}<Button variant="ghost" class="mr-auto hover:!text-danger" onclick={() => (confirmMilestone = true)}><Trash2 />{t("studies.milestones.delete")}</Button>{/if}
    <Button variant="ghost" onclick={() => (milestoneOpen = false)}>{t("action.cancel")}</Button>
    <Button variant="primary" type="submit" form="milestone-form" loading={msSaving} disabled={!msTitle.trim()}>{t("action.save")}</Button>
  {/snippet}
</Sheet>

<ConfirmDialog
  bind:open={confirmMilestone}
  title={t("studies.milestones.deleteConfirm", { title: editingMilestone?.title ?? "" })}
  confirmLabel={t("studies.milestones.delete")}
  onConfirm={deleteMilestone}
/>
<ConfirmDialog bind:open={stageDeleteOpen} title={t("crud.stage.deleteTitle", { name: stageToDelete?.name ?? "" })} description={t("crud.stage.deleteDescription")} confirmLabel={t("crud.delete")} onConfirm={confirmDeleteStage} />
<ConfirmDialog bind:open={confirmDelete} title={t("studies.deleteConfirm", { title: study.title })} description={t("studies.deleteDesc")} confirmLabel={t("studies.delete")} onConfirm={deleteStudy} />
