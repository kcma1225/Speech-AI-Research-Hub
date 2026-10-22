<script lang="ts">
  import { displayName } from "#lib/people.svelte.ts";
  import { Check, CircleSlash, ExternalLink, ListTodo, Lock, Pencil, Plus, Quote, RotateCcw, Sparkles, Trash2, X } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { formatClock } from "#lib/audio/time.ts";
  import { relativeTime, t } from "#lib/i18n.svelte.ts";
  import MarkdownView from "#lib/components/markdown/MarkdownView.svelte";
  import Button from "#lib/components/ui/Button.svelte";
  import ConfirmDialog from "#lib/components/ui/ConfirmDialog.svelte";
  import DatePicker from "#lib/components/ui/DatePicker.svelte";
  import Pill from "#lib/components/ui/Pill.svelte";
  import Select from "#lib/components/ui/Select.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";
  import MarkdownEditor from "#lib/components/markdown/MarkdownEditor.svelte";
  import { uploadMdImage } from "#lib/components/doc-import/api.ts";
  import { session } from "#lib/stores/session.svelte.ts";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import type { Draft, MeetingDetail, MeetingStudy, ProposedTask } from "#lib/meetings/types.ts";
  import { DRAFT_LABEL, DRAFT_TONE } from "#lib/meetings/util.ts";

  /**
   * One study's AI draft. Owners/members of THAT study may edit, confirm (→ 會議筆記 + 待辦 in the study) or dismiss;
   * everyone else (including advisors) only reads it.
   */
  let { draft, study, meetingId, onSeek, onChanged }: {
    draft: Draft;
    study: MeetingStudy | undefined;
    meetingId: string;
    onSeek: (time: number) => void;
    onChanged: (next?: MeetingDetail) => void | Promise<void>;
  } = $props();

  let editing = $state(false);
  // Both draft editors open side by side with a live preview (math, tables…); phones get the edit/preview toggle.
  let summaryLayout = $state<"split" | "edit" | "preview">("split");
  let feedbackLayout = $state<"split" | "edit" | "preview">("split");
  const fontSize = $derived(session.user?.preferences.editor.fontSize ?? 15);
  /** Images pasted into a draft are stored with its study (where the confirmed note lands). */
  const uploadImage = (file: File) => uploadMdImage(`study:${draft.study_id}`, file);
  let summary = $state("");
  let feedback = $state("");
  let tasks = $state<ProposedTask[]>([]);
  let busy = $state(false);
  let confirmOpen = $state(false);
  let dismissOpen = $state(false);

  const assignable = $derived((study?.members ?? []).filter(m => m.role !== "advisor"));
  const nameOf = (id: string | null) => (id ? (study?.members.find(m => m.id === id)?.name ?? null) : null);
  const assigneeOptions = $derived([{ value: "", label: t("meet.draft.unassigned") }, ...assignable.map(m => ({ value: m.id, label: m.name }))]);
  const empty = $derived(!draft.summary_md.trim() && !draft.feedback_md.trim() && !draft.proposed_tasks.length);
  const pending = $derived(draft.status === "pending");

  function startEdit() {
    summary = draft.summary_md;
    feedback = draft.feedback_md;
    tasks = draft.proposed_tasks.map(x => ({ ...x }));
    editing = true;
  }
  const cleanTasks = () => tasks.filter(x => x.title.trim()).map(x => ({ id: x.id, title: x.title.trim(), detail: x.detail, assignee_id: x.assignee_id || null, due: x.due || null }));

  async function call(path: string, body?: Record<string, unknown>, method: "post" | "patch" = "post") {
    busy = true;
    try {
      const next = method === "post" ? await api.post<MeetingDetail & { confirmed?: { note_url: string } }>(path, body) : await api.patch<MeetingDetail>(path, body ?? {});
      await onChanged(next);
      return next;
    } catch (e) {
      toasts.show((e as Error).message, "error");
      return null;
    } finally {
      busy = false;
    }
  }
  async function save() {
    if (await call(`/meetings/${meetingId}/drafts/${draft.id}`, { summary_md: summary, feedback_md: feedback, proposed_tasks: cleanTasks() }, "patch")) {
      editing = false;
      toasts.show(t("meet.draft.saved"), "success");
    }
  }
  async function confirm() {
    const body = editing ? { summary_md: summary, feedback_md: feedback, tasks: cleanTasks() } : {};
    const next = await call(`/meetings/${meetingId}/drafts/${draft.id}/confirm`, body);
    if (next) {
      editing = false;
      toasts.show(t("meet.draft.confirmedToast", { study: draft.study_title }), "success");
    }
  }
  const taskCount = $derived(editing ? cleanTasks().length : draft.proposed_tasks.length);
</script>

<article class="rounded-[22px] border border-line/70 bg-surface p-4 shadow-card sm:p-5" aria-labelledby="draft-{draft.id}">
  <header class="mb-3 flex items-start justify-between gap-3">
    <div class="min-w-0">
      <h3 id="draft-{draft.id}" class="truncate text-[15.5px] font-semibold text-ink"><a href="/studies/{draft.study_slug}" class="hover:underline">{draft.study_title}</a></h3>
      <p class="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12.5px] text-ink-3">
        {#if study?.owner}<span>{t("meet.form.owner", { name: displayName(study.owner) })}</span>{/if}
        <span class="inline-flex items-center gap-1">{#if draft.origin === "ai"}<Sparkles class="size-3" />{t("meet.draft.ai")}{:else}<Pencil class="size-3" />{t("meet.draft.edited", { name: draft.edited_by_name ?? "" })}{/if}</span>
      </p>
    </div>
    <Pill tone={DRAFT_TONE[draft.status]} size="sm" class="shrink-0">{t(DRAFT_LABEL[draft.status])}</Pill>
  </header>

  {#if editing}
    <div class="flex flex-col gap-3">
      <div class="flex flex-col gap-1.5">
        <span class="text-[13px] font-medium text-ink-2">{t("meet.draft.summary")}</span>
        <div class="min-h-48"><MarkdownEditor bind:value={summary} bind:layout={summaryLayout} label={t("meet.draft.summary")} {fontSize} imageUpload={uploadImage} /></div>
      </div>
      <div class="flex flex-col gap-1.5">
        <span class="text-[13px] font-medium text-ink-2">{t("meet.draft.feedback")}</span>
        <div class="min-h-40"><MarkdownEditor bind:value={feedback} bind:layout={feedbackLayout} label={t("meet.draft.feedback")} {fontSize} imageUpload={uploadImage} /></div>
      </div>
      <div class="flex flex-col gap-2">
        <span class="text-[13px] font-medium text-ink-2">{t("meet.draft.tasks")}</span>
        {#each tasks as task, i (task.id)}
          <div class="flex flex-col gap-2 rounded-2xl border border-line/80 p-2.5">
            <div class="flex items-start gap-2">
              <TextField label={t("meet.draft.taskTitle", { n: i + 1 })} bind:value={task.title} class="min-w-0 flex-1" />
              <Button variant="ghost" size="icon" class="mt-6" aria-label={t("meet.draft.removeTask")} onclick={() => (tasks = tasks.filter(x => x.id !== task.id))}><Trash2 /></Button>
            </div>
            <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Select value={task.assignee_id ?? ""} label={t("meet.draft.assignee")} options={assigneeOptions} onValueChange={v => (task.assignee_id = v || null)} class="w-full min-w-0" />
              <DatePicker value={task.due ?? ""} label={t("meet.draft.due")} clearable placeholder={t("meet.draft.noDue")} onValueChange={v => (task.due = v || null)} class="w-full" />
            </div>
          </div>
        {/each}
        <Button variant="ghost" size="sm" class="self-start" onclick={() => (tasks = [...tasks, { id: crypto.randomUUID(), title: "", detail: "", assignee_id: null, due: null }])}><Plus />{t("meet.draft.addTask")}</Button>
      </div>
    </div>
  {:else if empty && pending}
    <p class="rounded-2xl bg-surface-2 px-3.5 py-3 text-[13px] text-ink-3">{t("meet.draft.empty")}</p>
  {:else}
    <div class="flex flex-col gap-4">
      {#if draft.summary_md.trim()}
        <section><h4 class="mb-1 text-[12px] font-semibold tracking-wide text-ink-3">{t("meet.draft.summary")}</h4><MarkdownView source={draft.summary_md} class="text-[14px]" /></section>
      {/if}
      {#if draft.feedback_md.trim()}
        <section><h4 class="mb-1 text-[12px] font-semibold tracking-wide text-ink-3">{t("meet.draft.feedback")}</h4><MarkdownView source={draft.feedback_md} class="text-[14px]" /></section>
      {/if}
      {#if draft.proposed_tasks.length}
        <section>
          <h4 class="mb-1.5 flex items-center gap-1 text-[12px] font-semibold tracking-wide text-ink-3"><ListTodo class="size-3.5" />{t("meet.draft.tasks")}</h4>
          <ul class="flex flex-col gap-1.5">
            {#each draft.proposed_tasks as task (task.id)}
              <li class="flex flex-wrap items-baseline gap-x-2 rounded-xl bg-surface-2 px-3 py-2 text-[13.5px]">
                <span class="min-w-0 flex-1 text-ink">{task.title}</span>
                <span class="text-[12px] text-ink-3">{nameOf(task.assignee_id) ?? t("meet.draft.unassigned")}{task.due ? ` · ${task.due}` : ""}</span>
              </li>
            {/each}
          </ul>
        </section>
      {/if}
      {#if draft.evidence.length}
        <section>
          <h4 class="mb-1.5 flex items-center gap-1 text-[12px] font-semibold tracking-wide text-ink-3"><Quote class="size-3.5" />{t("meet.draft.evidence")}</h4>
          <div class="flex flex-wrap gap-1.5">
            {#each draft.evidence as e (e.start)}
              <button type="button" class="inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-full border border-line-2 px-3 text-left text-[12.5px] text-ink-2 hover:bg-surface-2" onclick={() => onSeek(e.start)} title={t("meet.draft.jump", { time: formatClock(e.start) })}>
                <span class="shrink-0 font-medium tabular-nums text-ink">{formatClock(e.start)}</span><span class="truncate">{e.quote}</span>
              </button>
            {/each}
          </div>
        </section>
      {/if}
    </div>
  {/if}

  <footer class="mt-4 flex flex-col gap-2 border-t border-line/70 pt-3.5 sm:flex-row sm:items-center sm:justify-between">
    {#if draft.status === "confirmed"}
      <p class="text-[12.5px] text-ink-3">{t("meet.draft.confirmedBy", { name: draft.confirmed_by_name ?? "", when: draft.confirmed_at ? relativeTime(draft.confirmed_at) : "" })}</p>
      {#if draft.note_id}<Button size="sm" href="/studies/{draft.study_slug}/notes/{draft.note_id}"><ExternalLink />{t("meet.draft.openNote")}</Button>{/if}
    {:else if draft.status === "dismissed"}
      <p class="text-[12.5px] text-ink-3">{t("meet.draft.dismissedBy", { name: draft.confirmed_by_name ?? "" })}</p>
      {#if draft.can_edit}<Button size="sm" variant="ghost" loading={busy} onclick={() => call(`/meetings/${meetingId}/drafts/${draft.id}/reopen`)}><RotateCcw />{t("meet.draft.reopen")}</Button>{/if}
    {:else if draft.can_edit}
      {#if editing}
        <Button variant="ghost" size="sm" onclick={() => (editing = false)}><X />{t("meet.cancel")}</Button>
        <div class="flex flex-col gap-2 sm:flex-row">
          <Button size="sm" loading={busy} onclick={save}>{t("meet.draft.saveDraft")}</Button>
          <Button variant="primary" size="sm" disabled={busy} onclick={() => (confirmOpen = true)}><Check />{t("meet.draft.confirm")}</Button>
        </div>
      {:else}
        <Button variant="ghost" size="sm" disabled={busy} onclick={() => (dismissOpen = true)}><CircleSlash />{t("meet.draft.dismiss")}</Button>
        <div class="flex flex-col gap-2 sm:flex-row">
          <Button size="sm" onclick={startEdit}><Pencil />{t("meet.draft.edit")}</Button>
          <Button variant="primary" size="sm" disabled={busy || empty} onclick={() => (confirmOpen = true)}><Check />{t("meet.draft.confirm")}</Button>
        </div>
      {/if}
    {:else}
      <p class="flex items-center gap-1.5 text-[12.5px] text-ink-3"><Lock class="size-3.5" />{t("meet.draft.membersOnly")}</p>
    {/if}
  </footer>
</article>

<ConfirmDialog bind:open={confirmOpen} title={t("meet.draft.confirmTitle", { study: draft.study_title })} description={t("meet.draft.confirmHint", { n: taskCount })} confirmLabel={t("meet.draft.confirm")} onConfirm={confirm} />
<ConfirmDialog bind:open={dismissOpen} title={t("meet.draft.dismissTitle")} description={t("meet.draft.dismissHint")} confirmLabel={t("meet.draft.dismiss")} onConfirm={() => call(`/meetings/${meetingId}/drafts/${draft.id}/dismiss`)} />
