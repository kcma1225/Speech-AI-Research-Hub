<script lang="ts">
  import { Download, Trash2, Users } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import AudioPlayer from "#lib/components/audio/AudioPlayer.svelte";
  import TranscriptView from "#lib/components/audio/TranscriptView.svelte";
  import Button from "#lib/components/ui/Button.svelte";
  import ConfirmDialog from "#lib/components/ui/ConfirmDialog.svelte";
  import Pill from "#lib/components/ui/Pill.svelte";
  import Select from "#lib/components/ui/Select.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import type { MeetingDetail } from "#lib/meetings/types.ts";
  import { speakerInfo } from "#lib/meetings/util.ts";
  import SpeakerSheet from "./SpeakerSheet.svelte";

  /**
   * Player (audio waveform, or the kept video) + transcript synced to it: click to seek, search, speaker colours.
   * `seek(t)` is exported for evidence links (`?t=` and draft evidence chips).
   */
  let { detail, onChanged }: { detail: MeetingDetail; onChanged: (next?: MeetingDetail) => void | Promise<void> } = $props();

  let player = $state<AudioPlayer | null>(null);
  let video = $state<HTMLVideoElement | null>(null);
  let currentTime = $state(0);
  let playing = $state(false);
  let videoPaused = $state(true);
  let speakersOpen = $state(false);
  let confirmDelete = $state(false);

  const transcript = $derived(detail.transcript);
  const media = $derived.by(() => {
    const ready = detail.media.filter(m => m.status === "ready");
    return ready.find(m => m.id === transcript?.media_id) ?? ready.at(-1) ?? null;
  });
  const cues = $derived((transcript?.segments ?? []).map(s => ({ start: s.start, end: s.end, text: s.text })));
  const speakers = $derived(speakerInfo(transcript?.segments ?? [], detail.speaker_map));
  const noTimes = $derived(Boolean(transcript?.warnings.includes("no_timestamps")));

  export function seek(time: number) {
    if (video) {
      video.currentTime = time;
      void video.play().catch(() => {});
    } else player?.seek(time, true);
    currentTime = time;
  }

  const sourceLabel = (s: string) => (s === "asr" ? t("meet.tr.source.asr") : s === "upload" ? t("meet.tr.source.upload") : t("meet.tr.source.live"));
  const transcriptOptions = $derived(detail.transcripts.map(x => ({ value: x.id, label: `${sourceLabel(x.source)} · ${t("meet.tr.count", { n: x.segment_count })}`, hint: x.file_name ?? x.model ?? undefined })));
  const canSwitch = $derived(detail.transcripts.length > 1 && detail.permissions.edit);
  /** A finished ASR transcript the user has not switched to while their uploaded one stays current. */
  const asrAlternative = $derived(
    transcript?.source === "upload" ? (detail.transcripts.find(x => x.source === "asr" && x.created_at > transcript.created_at) ?? null) : null,
  );

  async function choose(id: string) {
    try {
      await onChanged(await api.put<MeetingDetail>(`/meetings/${detail.meeting.id}/transcript`, { transcript_id: id }));
    } catch (e) {
      toasts.show((e as Error).message, "error");
    }
  }
  async function remove() {
    if (!transcript) return;
    await onChanged(await api.del<MeetingDetail>(`/meetings/${detail.meeting.id}/transcripts/${transcript.id}`));
  }
</script>

<div class="flex flex-col gap-4">
  {#if media?.video_url}
    <!-- svelte-ignore a11y_media_has_caption -->
    <video
      bind:this={video}
      bind:currentTime
      bind:paused={videoPaused}
      src={media.video_url}
      controls
      playsinline
      preload="metadata"
      class="aspect-video w-full rounded-2xl bg-black"
    ></video>
  {:else if media?.audio_url}
    <AudioPlayer bind:this={player} bind:currentTime bind:playing src={media.audio_url} title={detail.meeting.title} artist={t("pages.meetings.title")} peaks={media.peaks} duration={media.duration_sec} />
  {/if}

  {#if transcript}
    <div class="flex flex-wrap items-center gap-2">
      {#if canSwitch}
        <Select value={transcript.id} label={t("meet.tr.version")} options={transcriptOptions} onValueChange={choose} class="w-auto min-w-0 max-w-full sm:min-w-48" />
      {:else}
        <Pill tone={transcript.source === "live" ? "butter" : "sky"} size="sm">{sourceLabel(transcript.source)}</Pill>
      {/if}
      {#if transcript.model}<span class="text-[12px] text-ink-3">{transcript.model}</span>{/if}
      {#if transcript.source === "live"}<span class="text-[12px] text-ink-3">{t("meet.tr.liveNote")}</span>{/if}
      {#if noTimes}<span class="text-[12px] text-ink-3">{t("meet.tr.noTimes")}</span>{/if}
    </div>
    {#if asrAlternative && detail.permissions.edit}
      <div class="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2 text-[12.5px] text-ink-2">
        <span class="min-w-0 flex-1">{t("meet.tr.asrAlternative")}</span>
        <Button variant="secondary" size="sm" class="h-9" onclick={() => choose(asrAlternative.id)}>{t("meet.tr.useAsr")}</Button>
      </div>
    {/if}
    <TranscriptView {cues} {currentTime} playing={video ? !videoPaused : playing} onSeek={seek} listClass="max-h-[520px] lg:max-h-[max(520px,calc(100dvh-16rem))]">
      {#snippet actions()}
        {#if speakers.size && detail.permissions.edit}
          <Button variant="ghost" size="sm" onclick={() => (speakersOpen = true)} class="h-9"><Users />{t("meet.tr.speakers")}</Button>
        {/if}
        <Button variant="ghost" size="icon-sm" href="/api/meetings/{detail.meeting.id}/transcripts/{transcript.id}/export" aria-label={t("meet.tr.export")} title={t("meet.tr.export")} class="size-9"><Download /></Button>
        {#if detail.permissions.edit}
          <Button variant="ghost" size="icon-sm" onclick={() => (confirmDelete = true)} aria-label={t("meet.tr.delete")} title={t("meet.tr.delete")} class="size-9"><Trash2 /></Button>
        {/if}
      {/snippet}
      {#snippet meta(i)}
        {@const sp = transcript.segments[i]?.speaker}
        {#if sp}
          {@const info = speakers.get(sp)}
          {#if info}
            <span class="inline-flex items-center gap-1.5 text-[12px] font-semibold" style="color: var(--pill-{info.tone}-ink)">
              <span class="size-2 rounded-full" style="background: var(--pill-{info.tone}-ink)"></span>{info.name || t("meet.tr.speakerN", { n: info.index })}
            </span>
          {/if}
        {/if}
      {/snippet}
    </TranscriptView>
  {/if}
</div>

{#if transcript}
  <SpeakerSheet bind:open={speakersOpen} {detail} {speakers} {onChanged} />
  <ConfirmDialog bind:open={confirmDelete} title={t("meet.tr.deleteTitle")} description={t("meet.tr.deleteHint")} confirmLabel={t("meet.tr.delete")} danger onConfirm={remove} />
{/if}
