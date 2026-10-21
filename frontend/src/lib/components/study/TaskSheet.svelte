<script lang="ts">
  import { Trash2 } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import ConfirmDialog from "#lib/components/ui/ConfirmDialog.svelte";
  import DatePicker from "#lib/components/ui/DatePicker.svelte";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import Select from "#lib/components/ui/Select.svelte";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import Textarea from "#lib/components/ui/Textarea.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import MarkdownView from "#lib/components/markdown/MarkdownView.svelte";
  import type { StudyMember, Task, TaskStatus } from "#lib/studies/types.ts";

  /**
   * Create (`task` null) or edit a task of `studyId`. Read-only viewers see the task without inputs.
   * `onSaved` receives the saved task (or null after delete).
   */
  let { open = $bindable(false), studyId, task, members, canEdit, defaultAssignee = "", onSaved }: {
    open?: boolean;
    studyId: string;
    task: Task | null;
    members: StudyMember[];
    canEdit: boolean;
    defaultAssignee?: string;
    onSaved: (task: Task | null) => void | Promise<void>;
  } = $props();

  let title = $state("");
  let detailMd = $state("");
  let assignee = $state("");
  let due = $state("");
  let status = $state<TaskStatus>("open");
  let saving = $state(false);
  let confirmDelete = $state(false);

  $effect(() => {
    if (!open) return;
    title = task?.title ?? "";
    detailMd = task?.detail_md ?? "";
    assignee = task ? (task.assignee_id ?? "") : defaultAssignee;
    due = task?.due_on ?? "";
    status = task?.status ?? "open";
  });

  const assigneeOptions = $derived([
    { value: "", label: t("tasks.unassigned") },
    ...members.filter(m => !m.disabled || m.id === task?.assignee_id).map(m => ({ value: m.id, label: m.name })),
  ]);
  const statuses: TaskStatus[] = ["open", "done", "dropped"];

  async function save(e?: SubmitEvent) {
    e?.preventDefault();
    if (!title.trim()) return;
    saving = true;
    const body = { title: title.trim(), detail_md: detailMd, assignee_id: assignee || null, due_on: due || null, status };
    try {
      const result = task
        ? await api.patch<{ task: Task }>(`/studies/${studyId}/tasks/${task.id}`, body)
        : await api.post<{ task: Task }>(`/studies/${studyId}/tasks`, body);
      toasts.show(t(task ? "tasks.saved" : "tasks.created"), "success");
      open = false;
      await onSaved(result.task);
    } catch (err) {
      toasts.show((err as Error).message, "error");
    } finally {
      saving = false;
    }
  }

  async function remove() {
    if (!task) return;
    await api.del(`/studies/${studyId}/tasks/${task.id}`);
    toasts.show(t("tasks.deleted"), "success");
    open = false;
    await onSaved(null);
  }
</script>

<Sheet bind:open title={task ? (canEdit ? t("tasks.edit") : task.title) : t("tasks.new")} side="right">
  {#snippet children()}
    {#if canEdit}
      <form id="task-form" class="flex flex-col gap-4 pt-1" onsubmit={save}>
        <TextField label={t("tasks.field.title")} bind:value={title} maxlength={300} required />
        <Textarea label={t("tasks.field.detail")} bind:value={detailMd} rows={4} maxlength={20000} />
        <div class="flex flex-col gap-1.5">
          <span class="text-[13px] font-medium text-ink-2">{t("tasks.field.assignee")}</span>
          <Select bind:value={assignee} label={t("tasks.field.assignee")} class="w-full" options={assigneeOptions} />
        </div>
        <div class="flex flex-col gap-1.5">
          <span class="text-[13px] font-medium text-ink-2">{t("tasks.field.due")}</span>
          <DatePicker bind:value={due} label={t("tasks.field.due")} clearable class="w-full justify-start" />
        </div>
        {#if task}
          <div class="flex flex-col gap-1.5">
            <span class="text-[13px] font-medium text-ink-2">{t("tasks.field.status")}</span>
            <Segmented bind:value={status} label={t("tasks.field.status")} class="w-full" options={statuses.map(s => ({ value: s, label: t(`tasks.status.${s}` as MessageKey) }))} />
          </div>
        {/if}
      </form>
    {:else if task}
      <dl class="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-4 gap-y-3 pt-1 text-[14px]">
        <dt class="text-ink-3">{t("tasks.field.status")}</dt><dd>{t(`tasks.status.${task.status}` as MessageKey)}</dd>
        <dt class="text-ink-3">{t("tasks.field.assignee")}</dt><dd>{task.assignee?.name ?? t("tasks.unassigned")}</dd>
        <dt class="text-ink-3">{t("tasks.field.due")}</dt><dd>{task.due_on ?? "—"}</dd>
      </dl>
      {#if task.detail_md.trim()}<div class="mt-4 border-t border-line pt-4"><MarkdownView source={task.detail_md} /></div>{/if}
    {/if}
  {/snippet}
  {#snippet footer()}
    {#if canEdit}
      {#if task}<Button variant="ghost" class="mr-auto hover:!text-danger" onclick={() => (confirmDelete = true)}><Trash2 />{t("tasks.delete")}</Button>{/if}
      <Button variant="ghost" onclick={() => (open = false)}>{t("action.cancel")}</Button>
      <Button variant="primary" type="submit" form="task-form" loading={saving} disabled={!title.trim()}>{t("action.save")}</Button>
    {:else}
      <Button variant="secondary" onclick={() => (open = false)}>{t("common.close")}</Button>
    {/if}
  {/snippet}
</Sheet>

<ConfirmDialog bind:open={confirmDelete} title={t("tasks.deleteConfirm", { title: task?.title ?? "" })} confirmLabel={t("tasks.delete")} onConfirm={remove} />
