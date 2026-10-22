<script lang="ts">
  import { ArrowUpRight, BookOpen, CalendarClock, Check, ClipboardCheck, Flag, FlaskConical, ListTodo, PenLine, Plus, Presentation, Sparkles, UserPlus, UsersRound, Workflow } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { formatDate, i18n, relativeTime, t } from "#lib/i18n.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import { session } from "#lib/stores/session.svelte.ts";
  import { displayName } from "#lib/people.svelte.ts";
  import Avatar from "#lib/components/ui/Avatar.svelte";
  import Button from "#lib/components/ui/Button.svelte";
  import Card from "#lib/components/ui/Card.svelte";
  import CardHeader from "#lib/components/ui/CardHeader.svelte";
  import EmptyState from "#lib/components/ui/EmptyState.svelte";
  import Pill, { toneFor, type Tone } from "#lib/components/ui/Pill.svelte";
  import Skeleton from "#lib/components/ui/Skeleton.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import DueLabel from "#lib/components/study/DueLabel.svelte";
  import StageBar from "#lib/components/study/StageBar.svelte";
  import TaskRow from "#lib/components/study/TaskRow.svelte";
  import type { DashboardData, Task } from "#lib/studies/types.ts";
  import { groupActivity } from "#lib/studies/activity.ts";

  let data = $state<DashboardData | null>(null);
  let error = $state<string | null>(null);
  function load() {
    error = null;
    api.get<DashboardData>("/dashboard").then(d => (data = d), e => (error = e.message));
  }
  $effect(load);

  // English greets by given name ("Good evening, Ya-Ting"); Chinese by full name.
  const greetingName = $derived(i18n.locale === "en" ? session.user!.person?.en_given || displayName(session.user!) : session.user!.name);
  const hour = Number(new Intl.DateTimeFormat("en", { hour: "numeric", hourCycle: "h23", timeZone: "Asia/Taipei" }).format(new Date()));
  const greeting: MessageKey = hour >= 5 && hour < 11 ? "dash.greeting.morning" : hour >= 11 && hour < 18 ? "dash.greeting.afternoon" : "dash.greeting.evening";

  const kinds: Record<string, { icon: typeof Flag; tone: Tone }> = {
    study_created: { icon: Sparkles, tone: "peach" },
    study_renamed: { icon: PenLine, tone: "peach" },
    stage_changed: { icon: Workflow, tone: "lilac" },
    milestone_done: { icon: Flag, tone: "mint" },
    task_done: { icon: Check, tone: "sky" },
    deck_published: { icon: Presentation, tone: "butter" },
    member_added: { icon: UserPlus, tone: "rose" },
    meeting_confirmed: { icon: ClipboardCheck, tone: "mint" },
    paper_added: { icon: BookOpen, tone: "sky" },
    paper_read: { icon: BookOpen, tone: "lilac" },
    papers_imported: { icon: BookOpen, tone: "butter" },
  };
  const meetingTime = (iso: string) => formatDate(iso, { month: "short", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });
  const c = $derived(data?.counts);
  const kindOf = (kind: string) => kinds[kind] ?? { icon: ArrowUpRight, tone: "stone" as Tone };
  const kindLabel = (kind: string) => (kind in kinds ? t(`dash.kind.${kind}` as MessageKey) : t("dash.kind.other"));

  // Bursts (ten papers imported, a dozen note edits) collapse into one entry; older ones load on demand.
  const activityGroups = $derived(groupActivity(data?.activity ?? []));
  let activityLimit = $state(10);
  let expanded = $state(new Set<string>());
  function toggleGroup(key: string) {
    const next = new Set(expanded);
    if (!next.delete(key)) next.add(key);
    expanded = next;
  }

  async function toggle(task: Task, done: boolean) {
    if (!task.study) return;
    try {
      await api.patch(`/studies/${task.study.id}/tasks/${task.id}`, { status: done ? "done" : "open" });
      load();
    } catch (e) {
      toasts.show((e as Error).message, "error");
    }
  }
</script>

<svelte:head><title>{t("nav.overview")} · Speech-AI Hub</title></svelte:head>

<div class="mb-6 flex flex-col gap-4 sm:mb-8 sm:flex-row sm:items-end sm:justify-between">
  <div>
    <h1 class="font-display text-[34px] leading-[1.05] sm:text-[46px]">{t(greeting, { name: greetingName })}</h1>
    <p class="mt-2 text-[14px] text-ink-3">{t("dash.subtitle")}</p>
  </div>
  <Button variant="primary" href="/studies/new" class="w-fit"><Plus />{t("dash.newStudy")}</Button>
</div>

{#if error}
  <Card>
    <EmptyState title={t("common.error")} hint={error}>
      {#snippet action()}<Button variant="secondary" onclick={load}>{t("action.retry")}</Button>{/snippet}
    </EmptyState>
  </Card>
{:else}
  <!-- Stats -->
  <div class="mb-4 grid grid-cols-2 gap-3 sm:mb-5 sm:gap-4 lg:grid-cols-3">
    {#snippet stat(label: string, value: number | undefined, icon: typeof Flag, tone: Tone, foot: string, href: string, cls = "", footHref = "")}
      {@const Icon = icon}
      <!-- The whole card links to `href` (stretched link); an optional foot line links elsewhere. -->
      <div class="group relative flex items-start justify-between gap-3 rounded-[22px] border border-line/70 bg-surface p-4 shadow-card transition-colors hover:border-line-2 sm:p-5 {cls}">
        <div class="min-w-0 flex-1">
          {#if value === undefined}<Skeleton class="h-9 w-14" />{:else}<p class="font-display text-[34px] leading-none tabular-nums sm:text-[38px]">{value}</p>{/if}
          <a {href} class="mt-2 block text-[13px] font-medium text-ink-2 after:absolute after:inset-0 after:rounded-[22px] after:content-[''] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ink">{label}</a>
          {#if foot && footHref}
            <a href={footHref} class="relative z-10 -mx-1 -my-2 inline-flex min-h-10 max-w-full items-center truncate rounded-full px-1 text-[12px] text-ink-3 underline-offset-2 hover:text-ink hover:underline">{foot}</a>
          {:else}
            <p class="mt-0.5 truncate text-[12px] text-ink-3">{foot || "\u00a0"}</p>
          {/if}
        </div>
        <span class="grid size-9 shrink-0 place-items-center rounded-xl" style="background:var(--pill-{tone});color:var(--pill-{tone}-ink)"><Icon class="size-[18px]" /></span>
        <ArrowUpRight class="absolute right-4 bottom-4 size-4 text-ink-3 opacity-0 transition-opacity group-hover:opacity-100 sm:right-5 sm:bottom-5" />
      </div>
    {/snippet}
    {@render stat(t("dash.stat.myStudies"), c?.myStudies, FlaskConical, "peach", c ? t("dash.stat.labStudies", { n: c.labStudies }) : "", "/studies?scope=mine", "", "/studies?scope=lab")}
    {@render stat(t("dash.stat.openTasks"), c?.openTasks, ListTodo, "sky", c ? (c.overdueTasks ? t("dash.stat.overdue", { n: c.overdueTasks }) : t("dash.stat.noOverdue")) : "", "#my-tasks")}
    {@render stat(t("dash.stat.dueWeek"), c?.dueThisWeek, CalendarClock, "butter", "", "#my-tasks", "col-span-2 lg:col-span-1")}
  </div>

  <div class="grid grid-cols-[minmax(0,1fr)] items-start gap-4 sm:gap-5 xl:grid-cols-[minmax(0,1fr)_400px] 2xl:grid-cols-[minmax(0,1fr)_460px]">
    <!-- My studies -->
    <Card>
      <CardHeader title={t("dash.myStudies")}>
        {#snippet actions()}<Button size="sm" variant="ghost" href="/studies?scope=mine">{t("action.viewAll")}<ArrowUpRight /></Button>{/snippet}
      </CardHeader>
      {#if !data}
        <div class="flex flex-col gap-3">{#each [0, 1] as i (i)}<Skeleton class="h-20" />{/each}</div>
      {:else if !data.myStudies.length}
        <EmptyState title={t("dash.myStudies.empty")} hint={t("dash.myStudies.emptyHint")} class="py-8">
          {#snippet icon()}<FlaskConical />{/snippet}
          {#snippet action()}<Button size="sm" variant="primary" href="/studies/new"><Plus />{t("dash.newStudy")}</Button>{/snippet}
        </EmptyState>
      {:else}
        <ul class="-mx-2 flex flex-col">
          {#each data.myStudies as study (study.id)}
            <li>
              <a href="/studies/{study.slug}" class="group flex flex-col gap-2.5 rounded-2xl px-2 py-3 hover:bg-surface-2 sm:flex-row sm:items-center sm:gap-5">
                <div class="min-w-0 flex-1">
                  <p class="truncate text-[14.5px] font-semibold text-ink group-hover:underline">{study.title}</p>
                  <p class="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12.5px] text-ink-3">
                    <Flag class="size-3.5 shrink-0" />
                    {#if study.next_milestone}
                      <span class="min-w-0 truncate">{study.next_milestone.title}</span>
                      {#if study.next_milestone.due_on}<DueLabel date={study.next_milestone.due_on} compact />{/if}
                    {:else}{t("dash.noMilestone")}{/if}
                  </p>
                </div>
                <div class="flex w-full shrink-0 flex-col gap-1.5 sm:w-52">
                  <div class="flex items-baseline justify-between gap-2 text-[12px]">
                    <span class="truncate font-medium text-ink-2">{study.current_stage?.name ?? t("studies.noStage")}</span>
                    {#if study.open_task_count}<span class="inline-flex shrink-0 items-center gap-1 text-ink-3"><ListTodo class="size-3.5" />{study.open_task_count}</span>{/if}
                  </div>
                  <StageBar count={study.stage_count} done={study.stages_done} current={study.current_stage?.position ?? null} />
                </div>
              </a>
            </li>
          {/each}
        </ul>
      {/if}
    </Card>

    <!-- My tasks -->
    <div id="my-tasks" class="min-w-0 scroll-mt-24 xl:row-span-2">
    <Card>
      <CardHeader title={t("dash.myTasks")} />
      {#if !data}
        <div class="flex flex-col gap-2">{#each [0, 1, 2] as i (i)}<Skeleton class="h-11" />{/each}</div>
      {:else if !data.myTasks.length}
        <EmptyState title={t("dash.myTasks.empty")} class="py-8">{#snippet icon()}<Check />{/snippet}</EmptyState>
      {:else}
        <ul class="-mx-2 flex flex-col">
          {#each data.myTasks as task (task.id)}<li><TaskRow {task} canEdit showStudy onToggle={toggle} /></li>{/each}
        </ul>
      {/if}
    </Card>
    {#if data && (data.pendingDrafts?.length || data.upcomingMeetings?.length)}
      <!-- Meetings: drafts waiting for the caller's confirmation, then upcoming ones -->
      <Card class="mt-4 sm:mt-5">
        <CardHeader title={t("dash.meetings")}>
          {#snippet actions()}<Button size="sm" variant="ghost" href="/meetings">{t("action.viewAll")}<ArrowUpRight /></Button>{/snippet}
        </CardHeader>
        {#if data.pendingDrafts?.length}
          <p class="mb-1 text-[12px] font-medium text-ink-3">{t("dash.meetings.drafts")}</p>
          <ul class="-mx-2 mb-3 flex flex-col">
            {#each data.pendingDrafts as draft (draft.id)}
              <li>
                <a href="/meetings/{draft.meeting.id}" class="flex min-h-11 min-w-0 items-center gap-3 rounded-2xl px-2 py-2 hover:bg-surface-2">
                  <span class="grid size-8 shrink-0 place-items-center rounded-xl" style="background:var(--pill-peach);color:var(--pill-peach-ink)"><ClipboardCheck class="size-4" /></span>
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-[13.5px] font-medium text-ink">{draft.meeting.title}</p>
                    <p class="mt-0.5 flex min-w-0 items-center gap-2 text-[12px] text-ink-3">
                      <Pill tone={toneFor(draft.study.id)} size="sm" class="max-w-[60%]">{draft.study.title}</Pill>
                      <span class="shrink-0">{relativeTime(draft.meeting.held_at)}</span>
                    </p>
                  </div>
                  <span class="shrink-0 text-[12.5px] font-medium text-ink-2">{t("dash.meetings.review")}</span>
                </a>
              </li>
            {/each}
          </ul>
        {/if}
        {#if data.upcomingMeetings?.length}
          <p class="mb-1 text-[12px] font-medium text-ink-3">{t("dash.meetings.upcoming")}</p>
          <ul class="-mx-2 flex flex-col">
            {#each data.upcomingMeetings as meeting (meeting.id)}
              <li>
                <a href="/meetings/{meeting.id}" class="flex min-h-11 min-w-0 items-center gap-3 rounded-2xl px-2 py-2 hover:bg-surface-2">
                  <span class="grid size-8 shrink-0 place-items-center rounded-xl" style="background:var(--pill-sky);color:var(--pill-sky-ink)"><UsersRound class="size-4" /></span>
                  <p class="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink">{meeting.title}</p>
                  <span class="shrink-0 text-[12px] text-ink-3">{meetingTime(meeting.held_at)}</span>
                </a>
              </li>
            {/each}
          </ul>
        {/if}
      </Card>
    {/if}
    </div>

    <!-- Activity -->
    <Card>
      <CardHeader title={t("dash.activity")} />
      {#if !data}
        <div class="flex flex-col gap-3">{#each [0, 1, 2] as i (i)}<Skeleton class="h-12" />{/each}</div>
      {:else if !data.activity.length}
        <EmptyState title={t("dash.activity.empty")} class="py-8" />
      {:else}
        <ul class="-mx-2 flex flex-col">
          {#each activityGroups.slice(0, activityLimit) as group (group.key)}
            {@const meta = kindOf(group.kind)}
            {@const Icon = meta.icon}
            {@const first = group.items[0]!}
            {@const many = group.items.length > 1}
            {@const open = expanded.has(group.key)}
            {@const shown = many ? group.items.slice(0, open ? group.items.length : 3) : []}
            {@const titleOf = (item: typeof first) => (item.kind === "member_added" ? displayName(item.title) : item.title)}
            <li class="relative flex min-w-0 items-start gap-3 rounded-2xl px-2 py-2.5 {many ? '' : 'hover:bg-surface-2'}">
              <span class="mt-0.5 grid size-8 shrink-0 place-items-center rounded-xl" style="background:var(--pill-{meta.tone});color:var(--pill-{meta.tone}-ink)"><Icon class="size-4" /></span>
              <div class="min-w-0 flex-1">
                <p class="text-[13.5px] leading-snug text-ink">
                  {#if group.actor}<span class="font-semibold">{displayName(group.actor)}</span>{/if}
                  <span class="text-ink-2">{kindLabel(group.kind)}</span>
                  {#if many}
                    <span class="font-medium">{t("dash.activity.count", { n: group.items.length })}</span>
                  {:else}
                    <a href={first.url ?? `/studies/${group.study.slug}`} class="font-medium break-words after:absolute after:inset-0 after:rounded-2xl after:content-[''] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ink">{titleOf(first)}</a>
                  {/if}
                </p>
                {#if many}
                  <ul class="mt-1 flex flex-col">
                    {#each shown as item (item.id)}
                      <li class="min-w-0">
                        <a href={item.url ?? `/studies/${group.study.slug}`} title={titleOf(item)} class="-mx-1.5 flex min-h-10 sm:min-h-7 min-w-0 items-center rounded-lg px-1.5 text-[13px] text-ink-2 hover:bg-surface-2 hover:text-ink"><span class="truncate">{titleOf(item)}</span></a>
                      </li>
                    {/each}
                  </ul>
                  {#if group.items.length > 3}
                    <button type="button" class="-mx-1.5 mt-0.5 inline-flex min-h-10 sm:min-h-7 items-center rounded-lg px-1.5 text-[12.5px] font-medium text-ink-3 hover:bg-surface-2 hover:text-ink" aria-expanded={open} onclick={() => toggleGroup(group.key)}>
                      {open ? t("dash.activity.fewerItems") : t("dash.activity.moreItems", { n: group.items.length - 3 })}
                    </button>
                  {/if}
                {/if}
                <p class="mt-1 flex min-w-0 items-center gap-2 text-[12px] text-ink-3">
                  <Pill tone={toneFor(group.study.id)} size="sm" class="max-w-[60%]">{group.study.title}</Pill>
                  <span class="shrink-0">{relativeTime(group.at)}</span>
                </p>
              </div>
              {#if group.actor}<span class="hidden sm:block"><Avatar name={group.actor.name} id={group.actor.id} size={28} class="ring-0" /></span>{/if}
            </li>
          {/each}
        </ul>
        {#if activityGroups.length > activityLimit}
          <div class="mt-2 flex justify-center"><Button size="sm" variant="ghost" onclick={() => (activityLimit += 10)}>{t("dash.activity.showMore")}</Button></div>
        {/if}
      {/if}
    </Card>
  </div>
{/if}
