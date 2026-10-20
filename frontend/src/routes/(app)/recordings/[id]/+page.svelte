<script lang="ts">
  import { page } from "$app/state";
  import { ArrowLeft, Captions, FileText, FileUp, Keyboard, Loader, Mic, Trash2 } from "@lucide/svelte";
  import { api, ApiError } from "#lib/api.ts";
  import { formatDate, t } from "#lib/i18n.svelte.ts";
  import { viewport } from "#lib/media.svelte.ts";
  import { session } from "#lib/stores/session.svelte.ts";
  import { formatBytes, formatClock, stageLabel, type RecordingDetail } from "#lib/recordings/types.ts";
  import AudioPlayer from "#lib/components/audio/AudioPlayer.svelte";
  import TranscriptView from "#lib/components/audio/TranscriptView.svelte";
  import Avatar from "#lib/components/ui/Avatar.svelte";
  import Button from "#lib/components/ui/Button.svelte";
  import Card from "#lib/components/ui/Card.svelte";
  import CardHeader from "#lib/components/ui/CardHeader.svelte";
  import ConfirmDialog from "#lib/components/ui/ConfirmDialog.svelte";
  import EmptyState from "#lib/components/ui/EmptyState.svelte";
  import FileDrop from "#lib/components/ui/FileDrop.svelte";
  import Kbd from "#lib/components/ui/Kbd.svelte";
  import Pill, { tagTone, toneFor } from "#lib/components/ui/Pill.svelte";
  import Progress from "#lib/components/ui/Progress.svelte";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import Skeleton from "#lib/components/ui/Skeleton.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";

  const MAX_SRT = 5 * 1024 * 1024;
  const id = $derived(page.params.id ?? "");

  let item = $state<RecordingDetail | null>(null);
  let error = $state<{ status: number; message: string } | null>(null);
  let player = $state<ReturnType<typeof AudioPlayer> | null>(null);
  let currentTime = $state(0);
  let playing = $state(false);
  let playerHeight = $state(0);
  let audioVersion = $state(0);

  let srtFile = $state<File | null>(null);
  let uploadOpen = $state(false);
  let uploading = $state(false);
  let removeOpen = $state(false);

  async function load(target = id) {
    try {
      const result = await api.get<{ item: RecordingDetail }>(`/items/${target}`);
      if (target !== id) return;
      // A finished transcode replaces the audio behind the same URL: bust the element's source.
      if (item?.media_job && !result.item.media_job) audioVersion++;
      item = result.item;
      error = null;
    } catch (e) {
      if (target !== id) return;
      // 400 = malformed id in the URL: same as a missing recording for the reader.
      const status = e instanceof ApiError ? (e.status === 400 ? 404 : e.status) : 0;
      error = { status, message: (e as Error).message };
    }
  }

  $effect(() => {
    item = null;
    error = null;
    currentTime = 0;
    void load(id);
  });

  // While a transcode runs, poll until the job disappears (the finalizer then fills audio + peaks).
  $effect(() => {
    if (!item?.media_job) return;
    const timer = setTimeout(() => load(), document.hidden ? 15_000 : 3_000);
    return () => clearTimeout(timer);
  });

  async function uploadTranscript(file = srtFile) {
    if (!file || !item) return;
    uploading = true;
    try {
      const form = new FormData();
      form.append("file", file, file.name);
      const result = await api.post<{ count: number }>(`/items/${item.id}/transcript`, form);
      toasts.show(t("recordings.transcript.uploaded", { n: result.count }), "success");
      srtFile = null;
      uploadOpen = false;
      await load();
    } catch (e) {
      toasts.show((e as Error).message, "error", 5000);
    } finally {
      uploading = false;
    }
  }
  async function removeTranscript() {
    if (!item) return;
    try {
      await api.del(`/items/${item.id}/transcript`);
      toasts.show(t("recordings.transcript.removed"), "success");
      await load();
    } catch (e) {
      toasts.show((e as Error).message, "error", 5000);
      throw e;
    }
  }

  const cues = $derived(item?.transcript ?? []);
  const duration = $derived(item?.audio?.duration_seconds ?? null);
  const author = $derived(item?.created_by.name ?? null);
  const seekFromTranscript = (time: number) => player?.seek(time, true);
</script>

<svelte:head><title>{item?.title ?? t("recordings.title")} · Speech-AI Hub</title></svelte:head>

<a href="/recordings" class="mb-3 inline-flex items-center gap-1.5 rounded-full text-[13px] font-medium text-ink-3 transition-colors hover:text-ink lg:mb-4">
  <ArrowLeft class="size-4" />{t("recordings.title")}
</a>

{#if error}
  <Card>
    <EmptyState title={error.status === 404 ? t("recordings.detail.notFound") : t("common.error")} hint={error.status === 404 ? t("recordings.detail.notFoundHint") : error.message}>
      {#snippet icon()}<Mic />{/snippet}
      {#snippet action()}
        {#if error?.status === 404}<Button href="/recordings">{t("recordings.detail.backToList")}</Button>{:else}<Button onclick={() => load()}>{t("action.retry")}</Button>{/if}
      {/snippet}
    </EmptyState>
  </Card>
{:else if !item}
  <Skeleton class="mb-3 h-11 w-2/3" />
  <Skeleton class="mb-6 h-5 w-1/2" />
  <Skeleton class="mb-5 h-[190px] rounded-[22px]" />
  <div class="grid gap-5 lg:grid-cols-3"><Skeleton class="h-[420px] rounded-[22px] lg:col-span-2" /><Skeleton class="h-[280px] rounded-[22px]" /></div>
{:else}
  <!-- Header -->
  <div class="mb-5 flex flex-col gap-4 sm:mb-6 sm:flex-row sm:items-end sm:justify-between">
    <div class="min-w-0">
      <h1 class="font-display text-[30px] leading-[1.08] text-balance text-ink sm:text-[42px]">{item.title}</h1>
      <div class="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[13px] text-ink-3">
        <span>{formatDate(item.event_date)}</span>
        {#if author}
          <span aria-hidden="true">·</span>
          <span class="inline-flex items-center gap-1.5 text-ink-2"><Avatar name={author} size={20} class="ring-0" />{author}</span>
        {/if}
        {#if item.audio}
          <span aria-hidden="true">·</span>
          <span class="tabular-nums">{formatClock(duration)}</span>
        {/if}
        {#if item.tags.length}
          <span aria-hidden="true">·</span>
          {#each item.tags as tag (tag.id)}<Pill tone={tagTone(tag)} size="sm">{tag.name}</Pill>{/each}
        {/if}
      </div>
    </div>
    <Button href="/notes/{item.id}" class="w-fit"><FileText />{t("recordings.detail.openNote")}</Button>
  </div>

  {#if item.media_job}
    {@const job = item.media_job}
    <Card class="mb-5">
      <div class="flex items-center gap-3">
        <span class="grid size-10 shrink-0 place-items-center rounded-xl" style="background:var(--pill-butter);color:var(--pill-butter-ink)"><Loader class="size-[18px] animate-spin [animation-duration:2.4s]" /></span>
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium text-ink">{item.audio ? t("recordings.job.replacing") : t("recordings.job.title")}</p>
          <p class="mt-0.5 truncate text-[12.5px] text-ink-3">
            {[stageLabel(job.stage), job.progress != null ? `${Math.round(job.progress)}%` : null, job.file_name].filter(Boolean).join(" · ")}
          </p>
        </div>
      </div>
      <Progress value={job.progress} class="mt-4" />
    </Card>
  {/if}

  {#if item.audio}
    <!-- Player: a card on desktop, a compact bar pinned above the bottom tabs on phones. -->
    <section
      bind:offsetHeight={playerHeight}
      aria-label={t("recordings.player.label")}
      class={viewport.desktop
        ? "mb-5 rounded-[var(--radius-card)] border border-line/70 bg-surface px-6 pt-10 pb-5 shadow-card"
        : "fixed inset-x-2 bottom-[calc(70px+env(safe-area-inset-bottom))] z-30 rounded-[22px] border border-line bg-surface px-3.5 pt-3 pb-2.5 shadow-pop"}
    >
      <AudioPlayer
        bind:this={player}
        bind:currentTime
        bind:playing
        src={audioVersion ? `${item.audio.url}?v=${audioVersion}` : item.audio.url}
        title={item.title}
        artist={author ?? ""}
        peaks={item.audio_peaks}
        duration={duration}
        compact={!viewport.desktop}
      />
    </section>
  {:else if !item.media_job}
    <Card class="mb-5">
      <EmptyState title={t("recordings.detail.noAudio")} hint={t("recordings.detail.noAudioHint")}>
        {#snippet icon()}<Mic />{/snippet}
        {#snippet action()}<Button href="/notes/{item!.id}"><FileText />{t("recordings.detail.openNote")}</Button>{/snippet}
      </EmptyState>
    </Card>
  {/if}

  {#if item.audio}
    <div class="grid items-start gap-4 sm:gap-5 lg:grid-cols-3">
      <!-- Transcript -->
      <Card class="lg:col-span-2" padded={false}>
        <div class="px-4 pt-5 pb-3 sm:px-6 sm:pt-6">
          <CardHeader
            title={t("recordings.transcript.title")}
            subtitle={item.transcript ? t("recordings.transcript.count", { n: cues.length }) : undefined}
          >
            {#snippet actions()}
              {#if item?.transcript && session.canEdit}
                <Button variant="ghost" size="icon-sm" aria-label={t("recordings.transcript.replace")} title={t("recordings.transcript.replace")} onclick={() => (uploadOpen = true)}><FileUp /></Button>
                <Button variant="ghost" size="icon-sm" aria-label={t("recordings.transcript.remove")} title={t("recordings.transcript.remove")} onclick={() => (removeOpen = true)}><Trash2 /></Button>
              {/if}
            {/snippet}
          </CardHeader>
          {#if item.transcript}
            <TranscriptView
              {cues}
              {currentTime}
              {playing}
              onSeek={seekFromTranscript}
              scroll={viewport.desktop ? "self" : "page"}
              listClass="h-[min(560px,calc(100dvh-300px))] min-h-[320px]"
              insetTop={76}
              insetBottom={70 + playerHeight}
            />
          {:else}
            <div class="pb-3">
              <EmptyState
                title={t("recordings.transcript.empty")}
                hint={session.canEdit ? t("recordings.transcript.emptyHint") : t("recordings.transcript.emptyHintReadonly")}
                class="pt-4 pb-6"
              >
                {#snippet icon()}<Captions />{/snippet}
              </EmptyState>
              {#if session.canEdit}
                <div class="mx-auto flex max-w-md flex-col gap-3">
                  <FileDrop bind:file={srtFile} accept=".srt" maxBytes={MAX_SRT} label={t("recordings.transcript.drop")} hint={t("recordings.transcript.dropHint")} onError={m => toasts.show(m, "error")} />
                  {#if srtFile}<Button variant="primary" loading={uploading} onclick={() => uploadTranscript()}>{t("recordings.transcript.upload")}</Button>{/if}
                </div>
              {/if}
            </div>
          {/if}
        </div>
      </Card>

      <!-- Details -->
      <Card>
        <CardHeader title={t("recordings.detail.info")} />
        <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5 text-[13.5px]">
          <dt class="text-ink-3">{t("recordings.detail.note")}</dt>
          <dd class="min-w-0"><a href="/notes/{item.id}" class="line-clamp-2 font-medium text-ink underline decoration-line-2 underline-offset-[3px] hover:decoration-ink">{item.title}</a></dd>
          <dt class="text-ink-3">{t("recordings.detail.date")}</dt>
          <dd class="text-ink">{formatDate(item.event_date)}</dd>
          {#if author}
            <dt class="text-ink-3">{t("recordings.detail.author")}</dt>
            <dd class="text-ink">{author}</dd>
          {/if}
          <dt class="text-ink-3">{t("recordings.detail.file")}</dt>
          <dd class="min-w-0 truncate text-ink" title={item.audio.name ?? ""}>{item.audio.name ?? "—"}</dd>
          <dt class="text-ink-3">{t("recordings.detail.duration")}</dt>
          <dd class="text-ink tabular-nums">{formatClock(duration)}</dd>
          <dt class="text-ink-3">{t("recordings.detail.size")}</dt>
          <dd class="text-ink tabular-nums">{formatBytes(item.audio.bytes)}</dd>
          <dt class="text-ink-3">{t("recordings.detail.transcript")}</dt>
          <dd class="min-w-0 truncate text-ink" title={item.transcript_name ?? ""}>{item.transcript ? (item.transcript_name ?? t("recordings.transcript.count", { n: cues.length })) : t("recordings.detail.none")}</dd>
        </dl>

        {#if viewport.desktop}
          <div class="mt-5 border-t border-line pt-4">
            <p class="mb-2.5 flex items-center gap-1.5 text-[12px] font-medium text-ink-3"><Keyboard class="size-3.5" />{t("recordings.keys.title")}</p>
            <ul class="grid gap-2 text-[12.5px] text-ink-2">
              <li class="flex items-center justify-between gap-3"><span>{t("recordings.keys.play")}</span><span class="flex gap-1"><Kbd>Space</Kbd><Kbd>K</Kbd></span></li>
              <li class="flex items-center justify-between gap-3"><span>{t("recordings.keys.skip10")}</span><span class="flex gap-1"><Kbd>J</Kbd><Kbd>L</Kbd></span></li>
              <li class="flex items-center justify-between gap-3"><span>{t("recordings.keys.skip5")}</span><span class="flex gap-1"><Kbd>←</Kbd><Kbd>→</Kbd></span></li>
            </ul>
          </div>
        {/if}
      </Card>
    </div>
    <!-- Room for the pinned phone player. -->
    {#if !viewport.desktop}<div style="height:{playerHeight}px" aria-hidden="true"></div>{/if}
  {/if}
{/if}

<Sheet bind:open={uploadOpen} title={t("recordings.transcript.replaceTitle")} description={t("recordings.transcript.replaceHint")} side="center">
  <FileDrop bind:file={srtFile} accept=".srt" maxBytes={MAX_SRT} label={t("recordings.transcript.drop")} hint={t("recordings.transcript.dropHint")} onError={m => toasts.show(m, "error")} />
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (uploadOpen = false)}>{t("action.cancel")}</Button>
    <Button variant="primary" disabled={!srtFile} loading={uploading} onclick={() => uploadTranscript()}>{t("recordings.transcript.upload")}</Button>
  {/snippet}
</Sheet>

<ConfirmDialog
  bind:open={removeOpen}
  title={t("recordings.transcript.removeTitle")}
  description={t("recordings.transcript.removeHint")}
  confirmLabel={t("recordings.transcript.remove")}
  onConfirm={removeTranscript}
/>
