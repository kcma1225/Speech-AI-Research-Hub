<script lang="ts">
  import { Flag, ListTodo } from "@lucide/svelte";
  import { relativeTime, t } from "#lib/i18n.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import Pill from "#lib/components/ui/Pill.svelte";
  import type { StudyCard } from "#lib/studies/types.ts";
  import { statusTone } from "#lib/studies/ui.ts";
  import AvatarStack from "./AvatarStack.svelte";
  import DueLabel from "./DueLabel.svelte";
  import StageBar from "./StageBar.svelte";

  let { study }: { study: StudyCard } = $props();
  const people = $derived(study.members.filter(m => m.role !== "advisor"));
  const advisors = $derived(study.members.filter(m => m.role === "advisor"));
</script>

<a
  href="/studies/{study.slug}"
  class="group flex min-w-0 flex-col gap-4 rounded-[22px] border border-line/70 bg-surface p-4 shadow-card transition-[border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-line-2 motion-reduce:transition-none motion-reduce:hover:translate-y-0 sm:p-5"
>
  <div class="flex items-start justify-between gap-3">
    <div class="min-w-0">
      <h3 class="line-clamp-2 text-[16px] leading-snug font-semibold text-ink group-hover:underline">{study.title}</h3>
      {#if study.summary_excerpt}<p class="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-ink-3">{study.summary_excerpt}</p>{/if}
    </div>
    {#if study.status !== "active"}<Pill tone={statusTone[study.status]} size="sm" class="shrink-0">{t(`studies.status.${study.status}` as MessageKey)}</Pill>{/if}
  </div>

  <div class="flex flex-col gap-2">
    <div class="flex items-baseline justify-between gap-2 text-[12.5px]">
      <span class="min-w-0 truncate font-medium text-ink-2">{study.current_stage?.name ?? t("studies.noStage")}</span>
      {#if study.current_stage}<span class="shrink-0 text-ink-3 tabular-nums">{study.current_stage.position + 1}/{study.stage_count}</span>{/if}
    </div>
    <StageBar count={study.stage_count} done={study.stages_done} current={study.current_stage?.position ?? null} />
  </div>

  <div class="flex min-h-5 flex-col gap-1.5 text-[12.5px]">
    {#if study.next_milestone}
      <span class="flex min-w-0 items-center gap-1.5 text-ink-2">
        <Flag class="size-3.5 shrink-0 text-ink-3" />
        <span class="min-w-0 truncate">{study.next_milestone.title}</span>
        {#if study.next_milestone.due_on}<DueLabel date={study.next_milestone.due_on} compact />{/if}
      </span>
    {:else}
      <span class="flex items-center gap-1.5 text-ink-3"><Flag class="size-3.5" />{t("studies.noMilestone")}</span>
    {/if}
  </div>

  <div class="mt-auto flex items-center justify-between gap-3 border-t border-line/70 pt-3.5">
    <div class="flex min-w-0 items-center gap-2">
      <AvatarStack people={people} size={26} />
      {#if advisors.length}
        <span class="min-w-0 truncate text-[12px] text-ink-3" title={advisors.map(a => a.name).join("、")}>· {advisors.map(a => a.name).join("、")}</span>
      {/if}
    </div>
    <span class="flex shrink-0 items-center gap-3 text-[12px] text-ink-3">
      {#if study.open_task_count}<span class="inline-flex items-center gap-1" title={t("studies.openTasks", { n: study.open_task_count })}><ListTodo class="size-3.5" />{study.open_task_count}</span>{/if}
      <span class="hidden sm:inline">{relativeTime(study.activity_at)}</span>
    </span>
  </div>
</a>
