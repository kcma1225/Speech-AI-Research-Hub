<script lang="ts">
  import { Mic, Pause, Play, Square, X } from "@lucide/svelte";
  import { ApiError } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import { prefersReducedMotion } from "svelte/motion";
  import Button from "#lib/components/ui/Button.svelte";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import Switch from "#lib/components/ui/Switch.svelte";

  /**
   * Voice input: records in the browser (MediaRecorder, ≤ 10 min, level meter, pause/resume), uploads to
   * POST /api/notes/<id>/transcribe (role asr) and hands the text to `onText` (inserted at the cursor by the
   * editor). With 「整理成條列」 the caller also asks the writing role for a bullet-list suggestion.
   */
  let { open = $bindable(false), noteId, onText }: { open?: boolean; noteId: string; onText: (text: string, bullets: boolean) => void | Promise<void> } = $props();

  const MAX_SECONDS = 600;
  type Phase = "idle" | "recording" | "paused" | "uploading" | "error";
  let phase = $state<Phase>("idle");
  let error = $state<string | null>(null);
  let elapsed = $state(0);
  let bullets = $state(false);
  let levels = $state<number[]>(Array(28).fill(0));

  let recorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let audio: AudioContext | null = null;
  let chunks: Blob[] = [];
  let tick: ReturnType<typeof setInterval> | undefined;
  let raf = 0;
  let startedAt = 0;
  let pausedTotal = 0;
  let pausedAt = 0;
  let discard = false;

  const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const mime = () => ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm", "audio/mp4"].find(m => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) ?? "";

  function meter(analyser: AnalyserNode) {
    const data = new Uint8Array(analyser.fftSize);
    const loop = () => {
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v - 128) / 128);
      if (phase === "recording") levels = [...levels.slice(1), Math.min(1, peak * 1.8)];
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
  }

  async function start() {
    error = null;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      phase = "error";
      error = t("voice.unsupported");
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      phase = "error";
      error = t("voice.denied");
      return;
    }
    chunks = [];
    discard = false;
    const type = mime();
    recorder = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 48_000 } : undefined);
    recorder.ondataavailable = e => e.data.size && chunks.push(e.data);
    recorder.onstop = () => void finish();
    recorder.start(1000);
    audio = new AudioContext();
    const analyser = audio.createAnalyser();
    analyser.fftSize = 1024;
    audio.createMediaStreamSource(stream).connect(analyser);
    meter(analyser);
    startedAt = Date.now();
    pausedTotal = 0;
    elapsed = 0;
    phase = "recording";
    tick = setInterval(() => {
      if (phase !== "recording") return;
      elapsed = (Date.now() - startedAt - pausedTotal) / 1000;
      if (elapsed >= MAX_SECONDS) stop();
    }, 250);
  }

  function pause() {
    if (recorder?.state !== "recording") return;
    recorder.pause();
    pausedAt = Date.now();
    phase = "paused";
  }
  function resume() {
    if (recorder?.state !== "paused") return;
    recorder.resume();
    pausedTotal += Date.now() - pausedAt;
    phase = "recording";
  }
  function stop() {
    if (!recorder || recorder.state === "inactive") return;
    if (phase === "paused") pausedTotal += Date.now() - pausedAt;
    elapsed = Math.min(MAX_SECONDS, (Date.now() - startedAt - pausedTotal) / 1000);
    phase = "uploading";
    recorder.stop();
  }

  function release() {
    clearInterval(tick);
    cancelAnimationFrame(raf);
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
    void audio?.close().catch(() => {});
    audio = null;
    levels = Array(28).fill(0);
  }

  async function finish() {
    release();
    if (discard) return;
    const blob = new Blob(chunks, { type: recorder?.mimeType || "audio/webm" });
    chunks = [];
    if (blob.size < 512 || elapsed < 0.5) {
      phase = "error";
      error = t("voice.tooShort");
      return;
    }
    const form = new FormData();
    form.append("durationSec", elapsed.toFixed(2));
    form.append("file", blob, `voice.${blob.type.includes("ogg") ? "ogg" : blob.type.includes("mp4") ? "m4a" : "webm"}`);
    try {
      const response = await fetch(`/api/notes/${noteId}/transcribe`, { method: "POST", body: form, credentials: "same-origin" });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new ApiError(response.status, data?.error ?? t("common.error"));
      const text = String(data?.text ?? "").trim();
      if (!text) throw new ApiError(422, t("voice.empty"));
      phase = "idle";
      open = false;
      await onText(text, bullets);
    } catch (e) {
      phase = "error";
      error = (e as Error).message;
    }
  }

  function cancel() {
    discard = true;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    else release();
    phase = "idle";
    open = false;
  }

  // Closing the sheet (Esc, backdrop) discards an unfinished recording.
  $effect(() => {
    if (!open && (phase === "recording" || phase === "paused")) cancel();
  });
  $effect(() => () => {
    discard = true;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    release();
  });
</script>

<Sheet bind:open title={t("voice.title")} description={t("voice.hint")} side="center">
  <div class="flex flex-col items-center gap-5 pt-2 pb-1">
    <div class="flex h-16 w-full max-w-sm items-center justify-center gap-[3px]" aria-hidden="true">
      {#each levels as level, i (i)}
        <span
          class="w-[5px] rounded-full {phase === 'recording' ? 'bg-ink' : 'bg-line-2'}"
          style="height:{Math.max(6, level * 64)}px;{prefersReducedMotion.current ? '' : 'transition: height 80ms linear'}"
        ></span>
      {/each}
    </div>
    <p class="font-mono text-[28px] font-semibold text-ink tabular-nums" aria-live="off">
      {fmt(elapsed)}<span class="text-[15px] font-medium text-ink-3"> / {fmt(MAX_SECONDS)}</span>
    </p>
    <p class="min-h-5 text-[13px] text-ink-3" role="status">
      {#if phase === "recording"}{t("voice.recording")}{:else if phase === "paused"}{t("voice.paused")}{:else if phase === "uploading"}{t("voice.transcribing")}{:else if phase === "error"}<span class="text-danger">{error}</span>{:else}{t("voice.ready")}{/if}
    </p>
    <div class="flex items-center gap-3">
      {#if phase === "idle" || phase === "error"}
        <button type="button" class="grid size-16 place-items-center rounded-full bg-danger text-white shadow-pop transition-transform active:scale-95" aria-label={t("voice.start")} onclick={start}><Mic class="size-7" /></button>
      {:else if phase === "recording" || phase === "paused"}
        <Button variant="secondary" size="icon" aria-label={phase === "paused" ? t("voice.resume") : t("voice.pause")} onclick={phase === "paused" ? resume : pause}>
          {#if phase === "paused"}<Play />{:else}<Pause />{/if}
        </Button>
        <button type="button" class="grid size-16 place-items-center rounded-full bg-ink text-surface shadow-pop transition-transform active:scale-95" aria-label={t("voice.stop")} onclick={stop}><Square class="size-6" fill="currentColor" /></button>
        <Button variant="ghost" size="icon" aria-label={t("voice.discard")} onclick={cancel}><X /></Button>
      {:else}
        <span class="grid size-16 place-items-center rounded-full bg-surface-3"><span class="size-6 animate-spin rounded-full border-2 border-ink-3 border-t-transparent motion-reduce:animate-none"></span></span>
      {/if}
    </div>
    <label class="flex min-h-10 items-center gap-3 text-[13.5px] text-ink-2">
      <Switch bind:checked={bullets} label={t("voice.bullets")} disabled={phase === "uploading"} />
      <span>{t("voice.bullets")}</span>
    </label>
  </div>
</Sheet>
