<script lang="ts">
  import { untrack } from "svelte";
  import { Plus, UsersRound } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Card from "#lib/components/ui/Card.svelte";
  import EmptyState from "#lib/components/ui/EmptyState.svelte";
  import Skeleton from "#lib/components/ui/Skeleton.svelte";
  import type { StudyTabProps } from "#lib/components/study/tabs/registry.ts";
  import type { MeetingCard } from "#lib/meetings/types.ts";
  import MeetingCardView from "./MeetingCard.svelte";

  /** Study tab 會議: meetings that include this study (also cross-study ones created by others), with this study's draft status. */
  let { detail }: StudyTabProps = $props();
  let meetings = $state<MeetingCard[] | null>(null);
  let error = $state<string | null>(null);
  const studyId = $derived(detail.study.id);

  async function load() {
    try {
      meetings = (await api.get<{ meetings: MeetingCard[] }>(`/studies/${detail.study.slug}/meetings`)).meetings;
      error = null;
    } catch (e) {
      error = (e as Error).message;
    }
  }
  $effect(() => {
    void studyId;
    untrack(() => void load());
  });
  const pending = $derived(meetings?.filter(m => m.studies.find(s => s.id === studyId)?.draft_status === "pending") ?? []);
  const others = $derived(meetings?.filter(m => !pending.includes(m)) ?? []);
</script>

<div class="flex flex-col gap-5">
  <div class="flex flex-wrap items-end justify-between gap-3">
    <p class="text-[13px] text-ink-3">{t("meet.tab.hint")}</p>
    <Button variant="primary" href="/meetings/new?study={encodeURIComponent(detail.study.slug)}"><Plus />{t("meet.new")}</Button>
  </div>
  {#if error}
    <Card><EmptyState title={t("common.error")} hint={error} /></Card>
  {:else if !meetings}
    <div class="flex flex-col gap-3">{#each [0, 1] as i (i)}<Skeleton class="h-[120px] rounded-[20px]" />{/each}</div>
  {:else if !meetings.length}
    <Card><EmptyState title={t("meet.tab.empty")} hint={t("meet.tab.emptyHint")} class="py-12">{#snippet icon()}<UsersRound />{/snippet}</EmptyState></Card>
  {:else}
    {#if pending.length}
      <section aria-label={t("meet.tab.pending")} class="flex flex-col gap-3">
        <h3 class="text-[13px] font-semibold text-ink-3">{t("meet.tab.pending")} <span class="font-normal tabular-nums">{pending.length}</span></h3>
        <div class="grid grid-cols-[minmax(0,1fr)] gap-3 lg:grid-cols-2">{#each pending as meeting (meeting.id)}<MeetingCardView {meeting} {studyId} />{/each}</div>
      </section>
    {/if}
    {#if others.length}
      <section aria-label={t("meet.tab.all")} class="flex flex-col gap-3">
        {#if pending.length}<h3 class="text-[13px] font-semibold text-ink-3">{t("meet.tab.all")}</h3>{/if}
        <div class="grid grid-cols-[minmax(0,1fr)] gap-3 lg:grid-cols-2">{#each others as meeting (meeting.id)}<MeetingCardView {meeting} {studyId} />{/each}</div>
      </section>
    {/if}
  {/if}
</div>
