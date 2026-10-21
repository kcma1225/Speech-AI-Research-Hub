<script lang="ts">
  import { Clock, FileText, Mic } from "@lucide/svelte";
  import { formatDate, t } from "#lib/i18n.svelte.ts";
  import { formatClock } from "#lib/audio/time.ts";
  import Pill from "#lib/components/ui/Pill.svelte";
  import AvatarStack from "#lib/components/study/AvatarStack.svelte";
  import type { MeetingCard } from "#lib/meetings/types.ts";
  import { DRAFT_LABEL, DRAFT_TONE, meetingTime } from "#lib/meetings/util.ts";
  import StatusPill from "./StatusPill.svelte";

  /** One meeting in a list: date tile, title, studies (with owner and, in a study tab, that study's draft status). */
  let { meeting, studyId = null }: { meeting: MeetingCard; studyId?: string | null } = $props();
  const forStudy = $derived(studyId ? meeting.studies.find(s => s.id === studyId) : null);
</script>

<a
  href="/meetings/{meeting.id}"
  class="group flex min-w-0 gap-3.5 rounded-[20px] border border-line/70 bg-surface p-3.5 shadow-card transition-[border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-line-2 motion-reduce:transition-none motion-reduce:hover:translate-y-0 sm:gap-4 sm:p-4"
>
  <div class="flex w-14 shrink-0 flex-col items-center justify-center rounded-2xl bg-surface-2 py-2 text-center sm:w-16">
    <span class="text-[11px] font-medium text-ink-3">{formatDate(meeting.held_at, { month: "short" })}</span>
    <span class="font-display text-[26px] leading-none text-ink tabular-nums">{formatDate(meeting.held_at, { day: "numeric" }).replace(/\D/g, "")}</span>
    <span class="mt-0.5 text-[11px] text-ink-3">{formatDate(meeting.held_at, { weekday: "short" })}</span>
  </div>
  <div class="flex min-w-0 flex-1 flex-col gap-2">
    <div class="flex min-w-0 items-start justify-between gap-2">
      <h3 class="min-w-0 truncate text-[15.5px] font-semibold text-ink group-hover:underline">{meeting.title}</h3>
      <span class="shrink-0">
        {#if forStudy?.draft_status}<Pill tone={DRAFT_TONE[forStudy.draft_status]} size="sm">{t(DRAFT_LABEL[forStudy.draft_status])}</Pill>
        {:else}<StatusPill status={meeting.status} size="sm" />{/if}
      </span>
    </div>
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-ink-3">
      <span class="inline-flex items-center gap-1"><Clock class="size-3.5" />{meetingTime(meeting.held_at)}</span>
      {#if meeting.duration_sec}<span class="inline-flex items-center gap-1"><Mic class="size-3.5" />{formatClock(meeting.duration_sec)}</span>{/if}
      {#if meeting.has_transcript}<span class="inline-flex items-center gap-1"><FileText class="size-3.5" />{t("meet.card.transcript")}</span>{/if}
      {#if meeting.drafts.pending}<span class="font-medium text-ink-2">{t("meet.card.pending", { n: meeting.drafts.pending })}</span>{/if}
    </div>
    <div class="flex min-w-0 flex-wrap gap-1.5">
      {#each meeting.studies as s (s.id)}
        <span class="inline-flex max-w-full min-w-0 items-center gap-1 rounded-full border border-line/80 bg-surface-2 px-2.5 py-0.5 text-[12px] text-ink-2" title={s.owner ? t("meet.card.studyOf", { name: s.owner.name, title: s.title }) : s.title}>
          <span class="truncate">{s.title}</span>
          {#if s.owner}<span class="shrink-0 text-ink-3">· {s.owner.name}</span>{/if}
        </span>
      {/each}
    </div>
    {#if meeting.participants.length}
      <div class="flex items-center gap-2"><AvatarStack people={meeting.participants} size={24} max={6} /></div>
    {/if}
  </div>
</a>
