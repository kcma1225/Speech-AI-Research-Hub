<script lang="ts">
  import { onDestroy } from "svelte";
  import { CloudUpload, Captions, Mic, MicOff, Pause, Play, RotateCcw, Square, SunMedium, TriangleAlert } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import { formatClock } from "#lib/audio/time.ts";
  import { aiStatus } from "#lib/ai/status.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import ConfirmDialog from "#lib/components/ui/ConfirmDialog.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import { forgetRecording, MeetingRecorder, recordingSupported, savedRecording } from "#lib/meetings/recorder.svelte.ts";
  import type { Media } from "#lib/meetings/types.ts";

  /**
   * Browser recording: big record button, timer, level meter, pause/resume, stop; live captions when `asr_live` is
   * available. `unfinished` = a recording of this meeting left open by a reload/crash (continue it or finish it).
   */
  let { meetingId, unfinished = null, onChanged, onRecordingState }: {
    meetingId: string;
    unfinished?: Media | null;
    onChanged: () => void | Promise<void>;
    /** Reports "recording" / "paused" while a browser recording is in progress, null otherwise (header status pill). */
    onRecordingState?: (state: "recording" | "paused" | null) => void;
  } = $props();

  $effect(() => aiStatus.watch());
  const liveAvailable = $derived(aiStatus.available("asr_live"));
  let recorder = $state<MeetingRecorder | null>(null);
  let confirmStop = $state(false);
  let finishing = $state(false);
  const supported = recordingSupported();
  const active = $derived(recorder !== null && (recorder.state === "recording" || recorder.state === "paused" || recorder.state === "starting" || recorder.state === "stopping"));

  $effect(() => {
    const state = recorder?.state;
    onRecordingState?.(state === "paused" ? "paused" : state === "recording" || state === "starting" || state === "stopping" ? "recording" : null);
  });
  onDestroy(() => {
    onRecordingState?.(null);
    recorder?.dispose();
  });

  function ensure() {
    recorder ??= new MeetingRecorder(meetingId, { liveCaptions: liveAvailable });
    return recorder;
  }

  async function start() {
    const r = ensure();
    await r.start();
    if (r.state === "error") toasts.show(r.error === "denied" ? t("meet.rec.denied") : r.error === "nodevice" ? t("meet.rec.noDevice") : (r.error ?? t("common.error")), "error");
  }

  async function continueUnfinished() {
    if (!unfinished) return;
    const saved = savedRecording(meetingId);
    const r = ensure();
    await r.start({
      mediaId: unfinished.id,
      nextPart: Math.max(unfinished.parts, saved?.mediaId === unfinished.id ? saved.part + 1 : 0),
      elapsed: saved?.mediaId === unfinished.id ? saved.elapsed : 0,
      mime: saved?.mediaId === unfinished.id ? saved.mime : undefined,
    });
    if (r.state === "error") toasts.show(r.error === "denied" ? t("meet.rec.denied") : t("common.error"), "error");
  }

  async function finishUnfinished() {
    if (!unfinished) return;
    finishing = true;
    try {
      const saved = savedRecording(meetingId);
      await api.post(`/meetings/${meetingId}/recordings/${unfinished.id}/finish`, saved?.mediaId === unfinished.id ? { duration_sec: Math.round(saved.elapsed) } : {});
      forgetRecording(meetingId);
      toasts.show(t("meet.rec.finished"), "success");
      await onChanged();
    } catch (e) {
      toasts.show((e as Error).message, "error");
    } finally {
      finishing = false;
    }
  }

  async function stop() {
    if (!recorder) return;
    try {
      const result = await recorder.stop();
      if (result?.captions.length) {
        await api.post(`/meetings/${meetingId}/transcripts/live`, {
          media_id: result.mediaId,
          segments: result.captions.map(c => ({ start: Math.round(c.start * 10) / 10, end: Math.round(c.end * 10) / 10, text: c.text })),
        }).catch(() => {});
      }
      toasts.show(t("meet.rec.finished"), "success");
      recorder = null;
      await onChanged();
    } catch (e) {
      toasts.show((e as Error).message, "error");
    }
  }

  // Leaving the page while recording: the browser asks first (chunks already uploaded stay safe).
  function beforeUnload(e: BeforeUnloadEvent) {
    if (active) e.preventDefault();
  }

  const bars = 24;
  const reduceMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
</script>

<svelte:window onbeforeunload={beforeUnload} />

{#if !supported}
  <p class="flex items-center gap-2 rounded-2xl bg-surface-2 px-4 py-3 text-[13px] text-ink-2"><MicOff class="size-4 shrink-0" />{t("meet.rec.unsupported")}</p>
{:else if !active && unfinished}
  <div class="flex flex-col gap-3 rounded-2xl border border-line-2 bg-surface-2 p-4">
    <p class="flex items-start gap-2 text-[14px] text-ink"><TriangleAlert class="mt-0.5 size-4 shrink-0 text-ink-3" />{t("meet.rec.unfinished", { size: Math.round(unfinished.bytes / 1024) })}</p>
    <div class="flex flex-col gap-2 sm:flex-row">
      <Button variant="primary" onclick={continueUnfinished}><Mic />{t("meet.rec.continue")}</Button>
      <Button onclick={finishUnfinished} loading={finishing}><Square />{t("meet.rec.finishNow")}</Button>
    </div>
  </div>
{:else if !active}
  <div class="flex flex-col items-center gap-4 py-4 text-center">
    <button
      type="button"
      class="group grid size-24 place-items-center rounded-full bg-danger text-white shadow-pop transition-transform hover:scale-[1.03] active:scale-95 motion-reduce:transition-none"
      aria-label={t("meet.rec.start")}
      onclick={start}
      disabled={recorder?.state === "starting"}
    >
      <Mic class="size-9" />
    </button>
    <div>
      <p class="text-[15px] font-semibold text-ink">{t("meet.rec.start")}</p>
      <p class="mt-1 max-w-sm text-[13px] text-ink-3">{t("meet.rec.hint")}</p>
    </div>
    <p class="inline-flex items-center gap-1.5 text-[12.5px] text-ink-3">
      <Captions class="size-3.5" />{liveAvailable ? t("meet.rec.liveOn") : t("meet.rec.liveOff")}
    </p>
  </div>
{:else if recorder}
  <div class="flex flex-col gap-4" aria-live="polite">
    <div class="flex flex-col items-center gap-3 py-2">
      <div class="flex items-center gap-2 text-[13px] font-medium {recorder.state === 'paused' ? 'text-ink-3' : 'text-danger'}">
        <span class="size-2.5 rounded-full {recorder.state === 'paused' ? 'bg-ink-3' : 'bg-danger'} {recorder.state === 'recording' && !reduceMotion ? 'animate-pulse' : ''}"></span>
        {recorder.state === "paused" ? t("meet.rec.paused") : recorder.state === "stopping" ? t("meet.rec.stopping") : recorder.state === "starting" ? t("meet.rec.starting") : t("meet.rec.recording")}
      </div>
      <p class="font-display text-[52px] leading-none text-ink tabular-nums sm:text-[60px]" role="timer" aria-label={t("meet.rec.elapsed")}>{formatClock(recorder.elapsed)}</p>
      <div class="flex h-10 items-end gap-[3px]" aria-hidden="true">
        {#each Array(bars) as _, i (i)}
          {@const center = 1 - Math.abs(i - (bars - 1) / 2) / (bars / 2)}
          <span class="w-1.5 rounded-full bg-ink/80 transition-[height] duration-75 motion-reduce:transition-none" style="height:{Math.max(4, recorder.level * 40 * (0.35 + 0.65 * center))}px"></span>
        {/each}
      </div>
      <div class="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[12.5px] text-ink-3">
        <span class="inline-flex items-center gap-1 {recorder.uploadTrouble ? 'text-danger' : ''}"><CloudUpload class="size-3.5" />{recorder.uploadTrouble ? t("meet.rec.uploadRetry", { n: recorder.pending }) : recorder.pending ? t("meet.rec.uploading", { n: recorder.pending }) : t("meet.rec.saved")}</span>
        {#if recorder.wakeLock}<span class="inline-flex items-center gap-1"><SunMedium class="size-3.5" />{t("meet.rec.screenOn")}</span>{/if}
      </div>
    </div>

    <div class="flex items-center justify-center gap-3">
      {#if recorder.state === "paused"}
        <Button size="lg" onclick={() => recorder?.resume()}><Play />{t("meet.rec.resume")}</Button>
      {:else}
        <Button size="lg" onclick={() => recorder?.pause()} disabled={recorder.state !== "recording"}><Pause />{t("meet.rec.pause")}</Button>
      {/if}
      <Button size="lg" variant="danger" onclick={() => (confirmStop = true)} loading={recorder.state === "stopping"} disabled={recorder.state === "starting"}><Square />{t("meet.rec.stop")}</Button>
    </div>

    {#if recorder.live !== "off" || recorder.captions.length}
      <div class="rounded-2xl border border-line/80 bg-surface-2 p-3">
        <p class="mb-2 flex items-center gap-1.5 text-[12px] font-semibold text-ink-3">
          <Captions class="size-3.5" />{t("meet.rec.captions")}
          {#if recorder.live === "connecting"}<span class="font-normal">· {t("meet.rec.liveConnecting")}</span>{/if}
          {#if recorder.live === "error"}<span class="font-normal text-danger">· {recorder.liveError ?? t("meet.rec.liveError")}</span>{/if}
        </p>
        <div class="flex max-h-48 flex-col-reverse overflow-y-auto overscroll-contain text-[14.5px] leading-relaxed">
          <div>
            {#each recorder.captions.slice(-30) as c (c.id + c.start)}<p class="text-ink-2">{c.text}</p>{/each}
            {#if recorder.partial}<p class="text-ink-3">{recorder.partial.text}</p>{/if}
            {#if !recorder.captions.length && !recorder.partial && recorder.live === "on"}<p class="text-ink-3">{t("meet.rec.captionsWaiting")}</p>{/if}
          </div>
        </div>
        <p class="mt-2 flex items-center gap-1 text-[11.5px] text-ink-3"><RotateCcw class="size-3" />{t("meet.rec.captionsNote")}</p>
      </div>
    {/if}
  </div>
{/if}

<ConfirmDialog bind:open={confirmStop} title={t("meet.rec.stopTitle")} description={t("meet.rec.stopHint")} confirmLabel={t("meet.rec.stop")} onConfirm={stop} />
