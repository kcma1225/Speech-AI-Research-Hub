<script lang="ts">
  import { displayName } from "#lib/people.svelte.ts";
  import { untrack } from "svelte";
  import { ArrowLeft, CalendarDays, FileAudio, MessageSquareText, Pencil, Plus, Presentation, Sparkles, Trash2, TriangleAlert, X } from "@lucide/svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { api, ApiError } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import { viewport } from "#lib/media.svelte.ts";
  import { session } from "#lib/stores/session.svelte.ts";
  import MarkdownView from "#lib/components/markdown/MarkdownView.svelte";
  import AvatarStack from "#lib/components/study/AvatarStack.svelte";
  import Button from "#lib/components/ui/Button.svelte";
  import Card from "#lib/components/ui/Card.svelte";
  import CardHeader from "#lib/components/ui/CardHeader.svelte";
  import ConfirmDialog from "#lib/components/ui/ConfirmDialog.svelte";
  import DeleteButton from "#lib/components/ui/DeleteButton.svelte";
  import EmptyState from "#lib/components/ui/EmptyState.svelte";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import Skeleton from "#lib/components/ui/Skeleton.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import DraftCard from "#lib/components/meetings/DraftCard.svelte";
  import FeedbackPanel from "#lib/components/meetings/FeedbackPanel.svelte";
  import MeetingForm from "#lib/components/meetings/MeetingForm.svelte";
  import PipelineBar from "#lib/components/meetings/PipelineBar.svelte";
  import SourcesPanel from "#lib/components/meetings/SourcesPanel.svelte";
  import StatusPill from "#lib/components/meetings/StatusPill.svelte";
  import Pill from "#lib/components/ui/Pill.svelte";
  import TranscriptPanel from "#lib/components/meetings/TranscriptPanel.svelte";
  import type { MeetingDetail } from "#lib/meetings/types.ts";
  import { formatBytes, formFrom, isBusy, meetingDateTime, type MeetingFormValue } from "#lib/meetings/util.ts";

  const id = $derived(page.params.id ?? "");
  let detail = $state<MeetingDetail | null>(null);
  let error = $state<{ status: number; message: string } | null>(null);
  let transcriptPanel = $state<TranscriptPanel | null>(null);
  let showSources = $state(false);
  /** A browser recording in progress on this page (overrides the stored status in the header). */
  let recording = $state<"recording" | "paused" | null>(null);
  let editOpen = $state(false);
  let editValue = $state<MeetingFormValue | null>(null);
  let saving = $state(false);
  let deleteOpen = $state(false);
  let removeMedia = $state<string | null>(null);
  let removeMediaOpen = $state(false);
  type Section = "transcript" | "drafts" | "feedback";
  let section = $state<Section>("transcript");

  async function load() {
    try {
      detail = await api.get<MeetingDetail>(`/meetings/${id}`);
      error = null;
    } catch (e) {
      error = { status: e instanceof ApiError ? e.status : 0, message: (e as Error).message };
    }
  }
  async function changed(next?: MeetingDetail) {
    if (next && "meeting" in next) detail = next;
    else await load();
  }
  $effect(() => {
    void id;
    untrack(() => {
      detail = null;
      void load();
    });
  });
  // Poll while something is being produced.
  $effect(() => {
    if (!detail || !isBusy(detail)) return;
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  });
  // `?t=<seconds>` (evidence links from notes) seeks once the transcript is there.
  let seeked = false;
  $effect(() => {
    const at = Number(page.url.searchParams.get("t"));
    if (seeked || !detail?.transcript || !transcriptPanel || !Number.isFinite(at) || !page.url.searchParams.has("t")) return;
    seeked = true;
    section = "transcript";
    setTimeout(() => transcriptPanel?.seek(at), 300);
  });

  const unfinished = $derived(detail?.media.find(m => m.kind === "recording" && m.status === "recording" && m.created_by === session.user?.id) ?? null);
  const hasMaterial = $derived(Boolean(detail && (detail.transcript || detail.media.some(m => m.status !== "failed" && m.status !== "recording"))));
  const studyById = $derived(new Map((detail?.studies ?? []).map(s => [s.id, s])));
  const pendingCount = $derived(detail?.drafts.filter(d => d.status === "pending").length ?? 0);
  const sections = $derived([
    { value: "transcript" as Section, label: t("meet.sec.transcript"), icon: FileAudio },
    { value: "drafts" as Section, label: pendingCount ? t("meet.sec.draftsN", { n: pendingCount }) : t("meet.sec.drafts"), icon: Sparkles },
    { value: "feedback" as Section, label: detail?.feedback.length ? t("meet.sec.feedbackN", { n: detail.feedback.length }) : t("meet.sec.feedback"), icon: MessageSquareText },
  ]);
  const show = (s: Section) => viewport.desktop || section === s;

  function seek(time: number) {
    if (!viewport.desktop) section = "transcript";
    setTimeout(() => transcriptPanel?.seek(time), viewport.desktop ? 0 : 120);
  }

  function openEdit() {
    if (!detail) return;
    editValue = formFrom(detail);
    editOpen = true;
  }
  async function saveEdit(body: Record<string, unknown>) {
    saving = true;
    try {
      detail = await api.patch<MeetingDetail>(`/meetings/${id}`, body);
      editOpen = false;
      toasts.show(t("meet.saved"), "success");
    } catch (e) {
      toasts.show((e as Error).message, "error");
    } finally {
      saving = false;
    }
  }
  async function remove() {
    await api.del(`/meetings/${id}`);
    toasts.show(t("meet.deleted"), "success");
    await goto("/meetings");
  }
  async function deleteMedia() {
    if (!removeMedia) return;
    await api.del(`/meetings/${id}/media/${removeMedia}`);
    removeMedia = null;
    toasts.show(t("crud.meeting.mediaDeleted"), "success");
    await load();
  }
</script>

<svelte:head><title>{detail?.meeting.title ?? t("pages.meetings.title")} · Speech-AI Hub</title></svelte:head>

<Button variant="ghost" size="sm" href="/meetings" class="-ml-2 mb-3"><ArrowLeft />{t("pages.meetings.title")}</Button>

{#if error}
  <Card><EmptyState title={error.status === 404 ? t("meet.notFound") : t("common.error")} hint={error.message} /></Card>
{:else if !detail}
  <div class="flex flex-col gap-4"><Skeleton class="h-24" /><Skeleton class="h-16" /><Skeleton class="h-80" /></div>
{:else}
  {@const d = detail}
  <header class="mb-5 flex flex-col gap-3">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div class="min-w-0">
        <h1 class="font-display text-[30px] leading-[1.1] break-words text-ink sm:text-[40px]">{d.meeting.title}</h1>
        <p class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13.5px] text-ink-3">
          <span class="inline-flex items-center gap-1.5"><CalendarDays class="size-4" />{meetingDateTime(d.meeting.held_at)}</span>
          {#if recording}
            <Pill tone={recording === "paused" ? "stone" : "rose"} size="sm" dot={recording === "recording"}>{t(recording === "paused" ? "meet.rec.paused" : "meet.rec.recording")}</Pill>
          {:else}
            <StatusPill status={d.meeting.status} size="sm" />
          {/if}
          {#if d.meeting.creator_name}<span>{t("meet.createdBy", { name: d.meeting.creator_name })}</span>{/if}
        </p>
      </div>
      <div class="flex shrink-0 gap-2">
        {#if d.permissions.edit}<Button onclick={openEdit}><Pencil />{t("meet.edit")}</Button>{/if}
        <!-- Always visible: without permission it explains who may delete (tooltip / tap). -->
        <DeleteButton labelled class="border border-line" label={t("meet.delete")} reason={d.permissions.delete ? null : t("crud.deny.meeting")} onclick={() => (deleteOpen = true)} />
      </div>
    </div>
    <div class="flex flex-wrap items-center gap-2">
      {#each d.studies as s (s.id)}
        <a href="/studies/{s.slug}?tab=meetings" class="inline-flex min-h-9 max-w-full items-center gap-1 rounded-full border border-line/80 bg-surface px-3 text-[13px] text-ink-2 hover:border-line-2 hover:text-ink">
          <span class="truncate">{s.title}</span>{#if s.owner}<span class="shrink-0 text-ink-3">· {displayName(s.owner)}</span>{/if}
        </a>
      {/each}
      {#each d.decks as deck (deck.deck_id)}
        {@const st = studyById.get(deck.study_id)}
        <a href={st ? `/studies/${st.slug}/decks/${deck.deck_id}` : `/slides/${deck.deck_id}`} class="inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-full bg-surface-2 px-3 text-[13px] text-ink-2 hover:text-ink">
          <Presentation class="size-3.5 shrink-0" /><span class="truncate">{deck.title}{deck.version ? ` v${deck.version}` : ""}</span>
        </a>
      {/each}
      {#if d.participants.length}<span class="ml-auto"><AvatarStack people={d.participants} size={28} max={8} /></span>{/if}
    </div>
    {#if d.meeting.notes}<p class="max-w-3xl text-[14px] whitespace-pre-line text-ink-2">{d.meeting.notes}</p>{/if}
  </header>

  {#if hasMaterial || d.drafts.length}
    <Card class="mb-5"><PipelineBar detail={d} onChanged={changed} /></Card>
  {/if}

  {#if !viewport.desktop}
    <div class="sticky top-[calc(var(--topbar-h,56px)+8px)] z-20 mb-4"><Segmented bind:value={section} options={sections} label={t("meet.sec.label")} class="w-full bg-canvas/90 backdrop-blur" /></div>
  {/if}

  <div class="grid grid-cols-[minmax(0,1fr)] items-start gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
    <!-- Sections are hidden, not unmounted, on phones: switching tabs must not stop a recording. -->
    <div class="flex min-w-0 flex-col gap-5" class:hidden={!show("transcript")}>
        <Card>
          <CardHeader title={t("meet.sec.transcript")} subtitle={d.transcript ? t("meet.tr.count", { n: d.transcript.segments.length }) : undefined}>
            {#snippet actions()}
              {#if d.permissions.edit && hasMaterial}
                <Button variant="ghost" size="sm" onclick={() => (showSources = !showSources)}>{#if showSources}<X />{t("meet.close")}{:else}<Plus />{t("meet.addSource")}{/if}</Button>
              {/if}
            {/snippet}
          </CardHeader>
          {#if d.permissions.edit}
            <!-- Kept mounted while hidden, so an ongoing recording survives toggling the panel. -->
            <div class="{hasMaterial ? 'mb-5 border-b border-line/70 pb-5' : ''}" class:hidden={hasMaterial && !showSources && !unfinished}>
              <SourcesPanel meetingId={d.meeting.id} {unfinished} onRecordingState={s => (recording = s)} onChanged={async () => { showSources = false; await load(); }} />
            </div>
          {/if}
          {#if hasMaterial}
            <TranscriptPanel bind:this={transcriptPanel} detail={d} onChanged={changed} />
            {#if !d.transcript}
              <p class="mt-2 text-[13px] text-ink-3">{t("meet.tr.none")}</p>
            {/if}
          {:else if !d.permissions.edit}
            <EmptyState title={t("meet.tr.emptyReadOnly")} hint={t("meet.tr.emptyReadOnlyHint")} />
          {/if}
          {#if d.media.length}
            <ul class="mt-4 flex flex-col gap-1.5 border-t border-line/70 pt-3" aria-label={t("meet.media.title")}>
              {#each d.media as m (m.id)}
                <li class="flex min-h-10 items-center gap-2 text-[12.5px] text-ink-3">
                  <FileAudio class="size-4 shrink-0" />
                  <span class="min-w-0 truncate text-ink-2">{m.file_name || t("meet.media.recording")}</span>
                  <span class="shrink-0">{formatBytes(m.bytes)}{m.has_video ? ` · ${t("meet.media.video")}` : ""}{m.video_url ? ` · ${t("meet.media.videoKept")}` : ""}</span>
                  {#if m.status === "processing"}<span class="shrink-0">· {t("meet.media.processing")}</span>{/if}
                  {#if m.status === "recording"}<span class="shrink-0">· {t("meet.media.recordingNow")}</span>{/if}
                  {#if m.status === "failed"}<span class="inline-flex shrink-0 items-center gap-1 text-danger" title={m.error ?? ""}><TriangleAlert class="size-3.5" />{t("meet.media.failed")}</span>{/if}
                  {#if d.permissions.edit && m.status !== "recording"}
                    <Button variant="ghost" size="icon-sm" class="ml-auto" aria-label={t("meet.media.delete")} onclick={() => ((removeMedia = m.id), (removeMediaOpen = true))}><Trash2 /></Button>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </Card>
    </div>

    <div class="flex min-w-0 flex-col gap-5">
        <section class="flex flex-col gap-4" aria-labelledby="drafts-title" class:hidden={!show("drafts")}>
          <div class="flex items-end justify-between gap-2">
            <div>
              <h2 id="drafts-title" class="text-[15px] font-semibold text-ink">{t("meet.sec.drafts")}</h2>
              <p class="mt-0.5 text-[12.5px] text-ink-3">{t("meet.draft.intro")}</p>
            </div>
            {#if d.drafts.length && d.permissions.edit}
              <Button variant="ghost" size="sm" onclick={async () => { try { await changed(await api.post(`/meetings/${id}/analyze`)); } catch (e) { toasts.show((e as Error).message, "error"); } }} disabled={isBusy(d)}><Sparkles />{t("meet.draft.reanalyze")}</Button>
            {/if}
          </div>
          {#if d.drafts.length}
            {#each d.drafts as draft (draft.id)}
              <DraftCard {draft} study={studyById.get(draft.study_id)} meetingId={d.meeting.id} onSeek={seek} onChanged={changed} />
            {/each}
            {#if d.analysis?.other_md?.trim()}
              <article class="rounded-[22px] border border-dashed border-line-2 p-4 sm:p-5">
                <h3 class="mb-2 text-[14.5px] font-semibold text-ink">{t("meet.draft.other")}</h3>
                <MarkdownView source={d.analysis.other_md} class="text-[14px]" />
              </article>
            {/if}
          {:else}
            <Card><EmptyState title={t("meet.draft.none")} hint={t("meet.draft.noneHint")}>{#snippet icon()}<Sparkles />{/snippet}</EmptyState></Card>
          {/if}
        </section>
        <div class:hidden={!show("feedback")}>
          <Card>
            <CardHeader title={t("meet.sec.feedback")} subtitle={t("meet.fb.subtitle")} />
            <FeedbackPanel detail={d} onChanged={changed} />
          </Card>
        </div>
    </div>
  </div>

  {#if editValue}
    <Sheet bind:open={editOpen} title={t("meet.edit")} side="right">
      <MeetingForm bind:value={editValue} mode="stacked" submitLabel={t("meet.save")} busy={saving} onSubmit={saveEdit} onCancel={() => (editOpen = false)} />
    </Sheet>
  {/if}
  <ConfirmDialog bind:open={deleteOpen} title={t("crud.meeting.deleteTitle", { title: d.meeting.title })} description={t("meet.deleteHint")} confirmLabel={t("meet.delete")} danger onConfirm={remove} />
  <ConfirmDialog bind:open={removeMediaOpen} title={t("meet.media.deleteTitle")} description={t("meet.media.deleteHint")} confirmLabel={t("meet.media.delete")} danger onConfirm={deleteMedia} />
{/if}
