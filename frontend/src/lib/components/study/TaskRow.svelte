<script lang="ts">
  import { displayName } from "#lib/people.svelte.ts";
  import { Bot, UsersRound } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import Avatar from "#lib/components/ui/Avatar.svelte";
  import CheckCircle from "#lib/components/ui/CheckCircle.svelte";
  import Pill, { toneFor } from "#lib/components/ui/Pill.svelte";
  import type { Task } from "#lib/studies/types.ts";
  import DueLabel from "./DueLabel.svelte";

  /** One task line: check toggle, title (opens the task), study (cross-study lists), source, due date, assignee. */
  let { task, canEdit, showStudy = false, onToggle, onOpen }: {
    task: Task;
    canEdit: boolean;
    showStudy?: boolean;
    onToggle?: (task: Task, done: boolean) => void;
    onOpen?: (task: Task) => void;
  } = $props();
  const closed = $derived(task.status !== "open");
</script>

<div class="flex min-w-0 items-center gap-2.5 rounded-xl px-2 py-1 hover:bg-surface-2">
  <CheckCircle
    checked={task.status === "done"}
    disabled={!canEdit || !onToggle}
    label={t(task.status === "done" ? "tasks.reopen" : "tasks.markDone", { title: task.title })}
    onToggle={done => onToggle?.(task, done)}
  />
  {#snippet body()}
    <span class="min-w-0 flex-1 truncate text-[14px] {closed ? 'text-ink-3 line-through' : 'text-ink'}">{task.title}</span>
    <span class="flex min-w-0 shrink-0 items-center gap-2">
      {#if showStudy && task.study}<Pill tone={toneFor(task.study.id)} size="sm" class="max-w-40">{task.study.title}</Pill>{/if}
      {#if task.source === "meeting"}<span title={t("tasks.source.meeting")}><UsersRound class="size-3.5 text-ink-3" /></span>{/if}
      {#if task.source === "ai"}<span title={t("tasks.source.ai")}><Bot class="size-3.5 text-ink-3" /></span>{/if}
      {#if task.due_on}<DueLabel date={task.due_on} done={closed} compact />{/if}
    </span>
  {/snippet}
  {#if onOpen}
    <button type="button" onclick={() => onOpen?.(task)} class="flex min-h-11 min-w-0 flex-1 flex-col justify-center gap-0.5 text-left sm:flex-row sm:items-center sm:gap-3">{@render body()}</button>
  {:else}
    <a href={task.study ? `/studies/${task.study.slug}?tab=tasks` : undefined} class="flex min-h-11 min-w-0 flex-1 flex-col justify-center gap-0.5 text-left sm:flex-row sm:items-center sm:gap-3">{@render body()}</a>
  {/if}
  {#if task.assignee}
    <span title={displayName(task.assignee)}><Avatar name={task.assignee.name} id={task.assignee.id} size={26} class="ring-0" /></span>
  {:else}
    <span class="grid size-[26px] shrink-0 place-items-center rounded-full border border-dashed border-line-2 text-[10px] text-ink-3" title={t("tasks.unassigned")} aria-label={t("tasks.unassigned")}>?</span>
  {/if}
</div>
