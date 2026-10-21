<script lang="ts">
  import { page } from "$app/state";
  import { Columns3, List, ListTodo, Plus } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import { session } from "#lib/stores/session.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Card from "#lib/components/ui/Card.svelte";
  import EmptyState from "#lib/components/ui/EmptyState.svelte";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import Select from "#lib/components/ui/Select.svelte";
  import Skeleton from "#lib/components/ui/Skeleton.svelte";
  import Switch from "#lib/components/ui/Switch.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import type { Task, TaskStatus } from "#lib/studies/types.ts";
  import TaskRow from "../TaskRow.svelte";
  import TaskSheet from "../TaskSheet.svelte";
  import type { StudyTabProps } from "./registry.ts";

  let { detail, reload }: StudyTabProps = $props();
  const canEdit = $derived(detail.permissions.edit);
  const studyId = $derived(detail.study.id);

  const VIEW_KEY = "hub-tasks-view";
  let view = $state<"list" | "board">(readView());
  function readView(): "list" | "board" {
    try {
      return localStorage.getItem(VIEW_KEY) === "board" ? "board" : "list";
    } catch {
      return "list";
    }
  }
  $effect(() => {
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {}
  });

  let assignee = $state("all");
  let showClosed = $state(false);
  let tasks = $state<Task[] | null>(null);
  let error = $state<string | null>(null);

  async function load() {
    try {
      tasks = (await api.get<{ tasks: Task[] }>(`/studies/${studyId}/tasks`)).tasks;
      error = null;
    } catch (e) {
      error = (e as Error).message;
    }
  }
  $effect(() => {
    void studyId;
    void load();
  });

  const matches = (task: Task) =>
    assignee === "all" ? true : assignee === "none" ? !task.assignee_id : assignee === "me" ? task.assignee_id === session.user?.id : task.assignee_id === assignee;
  const filtered = $derived((tasks ?? []).filter(matches));
  const visible = $derived(view === "board" || showClosed ? filtered : filtered.filter(task => task.status === "open"));
  const columns: TaskStatus[] = ["open", "done", "dropped"];

  const assigneeOptions = $derived([
    { value: "all", label: t("tasks.filter.everyone") },
    { value: "me", label: t("tasks.filter.mine") },
    { value: "none", label: t("tasks.filter.unassigned") },
    ...detail.members.filter(m => m.id !== session.user?.id).map(m => ({ value: m.id, label: m.name })),
  ]);

  let sheetOpen = $state(false);
  let current = $state<Task | null>(null);
  function open(task: Task | null) {
    current = task;
    sheetOpen = true;
  }
  // `?tab=tasks&new=1` (e.g. from the overview) opens the create sheet once.
  $effect(() => {
    if (page.url.searchParams.get("new") === "1" && canEdit) open(null);
  });

  async function toggle(task: Task, done: boolean) {
    const status: TaskStatus = done ? "done" : "open";
    tasks = (tasks ?? []).map(x => (x.id === task.id ? { ...x, status } : x));
    try {
      await api.patch(`/studies/${studyId}/tasks/${task.id}`, { status });
      await reload();
    } catch (e) {
      toasts.show((e as Error).message, "error");
    }
    await load();
  }

  async function saved() {
    await Promise.all([load(), reload()]);
  }
</script>

<div class="mb-4 flex flex-wrap items-center gap-2 sm:mb-5">
  <Select bind:value={assignee} label={t("tasks.filter.assignee")} options={assigneeOptions} class="min-w-0 max-w-[60vw] sm:max-w-56" />
  <Segmented
    bind:value={view}
    label={t("tasks.view")}
    options={[{ value: "list", label: t("tasks.view.list"), icon: List }, { value: "board", label: t("tasks.view.board"), icon: Columns3 }]}
  />
  {#if view === "list"}
    <span class="flex h-10 items-center gap-2 px-1 text-[13px] text-ink-2"><Switch bind:checked={showClosed} label={t("tasks.showClosed")} /><span>{t("tasks.showClosed")}</span></span>
  {/if}
  <span class="hidden text-[12.5px] text-ink-3 md:inline">{t("tasks.summary", { open: detail.counts.openTasks, done: detail.counts.doneTasks })}</span>
  {#if canEdit}<Button variant="primary" class="ml-auto" onclick={() => open(null)}><Plus />{t("tasks.new")}</Button>{/if}
</div>

{#if error}
  <Card><EmptyState title={t("common.error")} hint={error} /></Card>
{:else if !tasks}
  <Card><div class="flex flex-col gap-2">{#each [0, 1, 2] as i (i)}<Skeleton class="h-11" />{/each}</div></Card>
{:else if view === "list"}
  <Card padded={false} class="p-2 sm:p-3">
    {#if !visible.length}
      <EmptyState title={t("tasks.empty")} hint={canEdit ? t("tasks.emptyHint") : undefined} class="py-10">
        {#snippet icon()}<ListTodo />{/snippet}
        {#snippet action()}{#if canEdit}<Button size="sm" variant="secondary" onclick={() => open(null)}><Plus />{t("tasks.new")}</Button>{/if}{/snippet}
      </EmptyState>
    {:else}
      <ul class="flex flex-col">
        {#each visible as task (task.id)}<li><TaskRow {task} {canEdit} onToggle={toggle} onOpen={open} /></li>{/each}
      </ul>
    {/if}
  </Card>
{:else}
  <div class="grid grid-cols-[minmax(0,1fr)] gap-3 sm:gap-4 md:grid-cols-3">
    {#each columns as column (column)}
      {@const items = visible.filter(task => task.status === column)}
      <section class="flex min-w-0 flex-col gap-2 rounded-[22px] border border-line/70 bg-surface-2/60 p-2.5 sm:p-3" aria-label={t(`tasks.status.${column}` as MessageKey)}>
        <h3 class="flex items-center justify-between px-1.5 pt-1 text-[13px] font-semibold text-ink-2">
          {t(`tasks.status.${column}` as MessageKey)}<span class="text-[12px] font-medium text-ink-3 tabular-nums">{items.length}</span>
        </h3>
        {#each items as task (task.id)}
          <div class="rounded-2xl border border-line/70 bg-surface shadow-card"><TaskRow {task} {canEdit} onToggle={toggle} onOpen={open} /></div>
        {:else}
          <p class="px-1.5 py-3 text-[12.5px] text-ink-3">—</p>
        {/each}
      </section>
    {/each}
  </div>
{/if}

<TaskSheet bind:open={sheetOpen} {studyId} task={current} members={detail.members} {canEdit} defaultAssignee={session.user?.id && detail.members.some(m => m.id === session.user?.id) ? session.user.id : ""} onSaved={saved} />
