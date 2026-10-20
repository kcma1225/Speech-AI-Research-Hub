<script lang="ts">
  import { onDestroy } from "svelte";
  import { ArrowUpRight, AudioLines, Captions, Mic, RefreshCw, Trash2, Upload, X } from "@lucide/svelte";
  import { api, ApiError } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import { jobsStore } from "#lib/stores/jobs.svelte.ts";
  import { formatDuration, MEDIA_ACCEPT, type MediaJob, type NoteDetail } from "#lib/notes/types.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import ConfirmDialog from "#lib/components/ui/ConfirmDialog.svelte";
  import FileDrop from "#lib/components/ui/FileDrop.svelte";
  import Progress from "#lib/components/ui/Progress.svelte";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";

  /** Recording + transcript of a note: compact card linking to /recordings/<id>, uploads for editors. */
  let { note, canEdit, onChanged }: { note: NoteDetail; canEdit: boolean; onChanged: () => Promise<void> } = $props();

  let mediaOpen = $state(false);
  let mediaFile = $state<File | null>(null);
  let uploadPct = $state<number | null>(null);
  let uploading = $state(false);
  let srtOpen = $state(false);
  let srtFile = $state<File | null>(null);
  let srtBusy = $state(false);
  let removeOpen = $state(false);

  /** Job being tracked: own upload (status via /media-jobs/:id) or an in-flight job reported by the note. */
  let job = $state<MediaJob | null>(null);
  let ownJob = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let alive = true;
  onDestroy(() => {
    alive = false;
    clearTimeout(timer);
  });

  const activeJob = $derived(job ?? (note.media_job ? { ...note.media_job, item_id: note.id, duration_seconds: null, error: null } : null));

  // A job already running when the note loads (e.g. upload from another tab): follow it.
  $effect(() => {
    const pending = note.media_job;
    if (pending && !job) {
      job = { ...pending, item_id: note.id, duration_seconds: null, error: null };
      ownJob = false;
      schedule(pending.id, 1500);
    }
  });

  function schedule(id: string, ms = 2000) {
    clearTimeout(timer);
    timer = setTimeout(() => poll(id), ms);
  }

  async function poll(id: string) {
    if (!alive) return;
    try {
      const next = (await api.get<{ job: MediaJob }>(`/media-jobs/${id}`)).job;
      ownJob = true;
      job = next;
      if (next.status === "processing") return schedule(id);
      await finish(next);
    } catch (e) {
      // Someone else's job: /media-jobs/:id is owner-only, so follow the note instead.
      if (e instanceof ApiError && e.status === 404) {
        await onChanged().catch(() => {});
        if (note.media_job) {
          job = { ...note.media_job, item_id: note.id, duration_seconds: null, error: null };
          return schedule(id, 4000);
        }
        job = null;
        return;
      }
      schedule(id, 5000);
    }
  }

  async function finish(done: MediaJob) {
    void jobsStore.refresh();
    if (done.status === "completed") toasts.show(t("notes.media.done"), "success");
    else if (done.status === "failed") toasts.show(done.error || t("notes.media.failed"), "error", 6000);
    else toasts.show(t("notes.media.cancelled"));
    // The finalizer applies the result shortly after the job finishes; reload twice to catch it.
    await onChanged().catch(() => {});
    job = null;
    if (done.status === "completed") setTimeout(() => alive && onChanged().catch(() => {}), 1500);
  }

  function send(file: File): Promise<{ jobId: string }> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/items/${note.id}/media`);
      xhr.upload.onprogress = e => (uploadPct = e.lengthComputable ? (e.loaded / e.total) * 100 : null);
      xhr.onload = () => {
        let data: { jobId?: string; error?: string } | null = null;
        try {
          data = JSON.parse(xhr.responseText);
        } catch {}
        if (xhr.status >= 200 && xhr.status < 300 && data?.jobId) resolve({ jobId: data.jobId });
        else reject(new Error(data?.error ?? (xhr.statusText || t("common.error"))));
      };
      xhr.onerror = () => reject(new Error(t("common.offline")));
      const form = new FormData();
      form.append("file", file, file.name);
      xhr.send(form);
    });
  }

  async function uploadMedia() {
    if (!mediaFile) return;
    uploading = true;
    uploadPct = 0;
    const fileName = mediaFile.name;
    try {
      const { jobId } = await send(mediaFile);
      mediaOpen = false;
      mediaFile = null;
      ownJob = true;
      job = { id: jobId, item_id: note.id, status: "processing", stage: "排隊中", progress: 0, duration_seconds: null, error: null, file_name: fileName, created_at: new Date().toISOString() };
      void jobsStore.refresh();
      toasts.show(t("notes.media.queued"));
      schedule(jobId, 1200);
    } catch (e) {
      toasts.show((e as Error).message, "error");
    } finally {
      uploading = false;
      uploadPct = null;
    }
  }

  async function cancelJob() {
    if (!job) return;
    try {
      await api.del(`/media-jobs/${job.id}`);
      schedule(job.id, 300);
    } catch (e) {
      toasts.show((e as Error).message, "error");
    }
  }

  async function uploadSrt() {
    if (!srtFile) return;
    srtBusy = true;
    try {
      const form = new FormData();
      form.append("file", srtFile, srtFile.name);
      const result = await api.post<{ count: number }>(`/items/${note.id}/transcript`, form);
      srtOpen = false;
      srtFile = null;
      toasts.show(t("notes.transcript.uploaded", { n: result.count }), "success");
      await onChanged();
    } catch (e) {
      toasts.show((e as Error).message, "error");
    } finally {
      srtBusy = false;
    }
  }

  async function removeTranscript() {
    try {
      await api.del(`/items/${note.id}/transcript`);
      toasts.show(t("notes.transcript.removed"));
      await onChanged();
    } catch (e) {
      toasts.show((e as Error).message, "error");
      throw e;
    }
  }

  const sizeLabel = (bytes: number | null) => (bytes ? (bytes >= 1 << 20 ? `${(bytes / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`) : "");
</script>

{#if note.audio || activeJob || canEdit}
  <section class="flex flex-col gap-2" aria-label={t("notes.media.section")}>
    {#if note.audio}
      <div class="flex flex-col gap-0 overflow-hidden rounded-2xl border border-line bg-surface-2/60">
        <a href="/recordings/{note.id}" class="group flex items-center gap-3 p-3 transition-colors hover:bg-surface-2 sm:p-3.5">
          <span class="grid size-10 shrink-0 place-items-center rounded-xl" style="background:var(--pill-mint);color:var(--pill-mint-ink)"><AudioLines class="size-[18px]" /></span>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm font-medium text-ink group-hover:underline">{note.audio.name ?? t("notes.media.recording")}</span>
            <span class="block text-[12px] text-ink-3 tabular-nums">
              {[formatDuration(note.audio.duration_seconds), sizeLabel(note.audio.bytes)].filter(Boolean).join(" · ")}
            </span>
          </span>
          <span class="hidden shrink-0 items-center gap-1 text-[13px] font-medium text-ink-2 group-hover:text-ink sm:inline-flex">{t("notes.media.open")}<ArrowUpRight class="size-3.5" /></span>
          <ArrowUpRight class="size-4 shrink-0 text-ink-3 sm:hidden" />
        </a>
        <div class="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2 sm:px-3.5">
          <Captions class="size-4 shrink-0 text-ink-3" />
          {#if note.transcript}
            <span class="min-w-0 flex-1 truncate text-[13px] text-ink-2">{t("notes.transcript.has", { n: note.transcript.length })}{#if note.transcript_name}<span class="text-ink-3"> · {note.transcript_name}</span>{/if}</span>
          {:else}
            <span class="min-w-0 flex-1 text-[13px] text-ink-3">{t("notes.transcript.none")}</span>
          {/if}
          {#if canEdit}
            <div class="flex gap-1">
              <Button size="sm" variant="ghost" onclick={() => (srtOpen = true)}>
                {#if note.transcript}<RefreshCw />{t("notes.transcript.replace")}{:else}<Upload />{t("notes.transcript.upload")}{/if}
              </Button>
              {#if note.transcript}<Button size="icon-sm" variant="ghost" onclick={() => (removeOpen = true)} aria-label={t("notes.transcript.remove")} title={t("notes.transcript.remove")}><Trash2 /></Button>{/if}
            </div>
          {/if}
        </div>
      </div>
    {/if}

    {#if activeJob}
      <div class="flex items-center gap-3 rounded-2xl border border-line bg-surface p-3 sm:p-3.5" aria-live="polite">
        <span class="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-3 text-ink-2"><Mic class="size-[18px]" /></span>
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline justify-between gap-3">
            <p class="truncate text-sm font-medium">{activeJob.file_name || t("notes.media.recording")}</p>
            <p class="shrink-0 text-[12px] text-ink-3 tabular-nums">{activeJob.stage}{activeJob.progress ? ` · ${Math.round(activeJob.progress)}%` : ""}</p>
          </div>
          <Progress value={activeJob.progress || null} class="mt-2" />
        </div>
        {#if ownJob && canEdit}
          <Button size="icon-sm" variant="ghost" onclick={cancelJob} aria-label={t("notes.media.cancel")} title={t("notes.media.cancel")}><X /></Button>
        {/if}
      </div>
    {:else if canEdit}
      {#if note.audio}
        <button type="button" onclick={() => (mediaOpen = true)} class="inline-flex w-fit items-center gap-1.5 px-1 text-[12.5px] font-medium text-ink-3 hover:text-ink"><RefreshCw class="size-3.5" />{t("notes.media.replace")}</button>
      {:else}
        <button
          type="button"
          onclick={() => (mediaOpen = true)}
          class="flex items-center gap-3 rounded-2xl border border-dashed border-line-2 p-3 text-left transition-colors hover:border-ink-3 hover:bg-surface-2/60 sm:p-3.5"
        >
          <span class="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-3 text-ink-2"><Mic class="size-[18px]" /></span>
          <span class="min-w-0 flex-1">
            <span class="block text-sm font-medium text-ink">{t("notes.media.add")}</span>
            <span class="block text-[12px] text-ink-3">{t("notes.media.addHint")}</span>
          </span>
          <Upload class="size-4 shrink-0 text-ink-3" />
        </button>
      {/if}
    {/if}
  </section>
{/if}

<Sheet bind:open={mediaOpen} title={note.audio ? t("notes.media.replace") : t("notes.media.add")} description={t("notes.media.sheetHint")} side="center">
  <div class="flex flex-col gap-3 pt-2">
    <FileDrop bind:file={mediaFile} accept={MEDIA_ACCEPT} label={t("notes.media.drop")} hint={t("notes.media.types")} onError={m => toasts.show(m, "error")} />
    {#if uploading}
      <div class="flex items-center gap-3"><Progress value={uploadPct} class="flex-1" /><span class="w-10 text-right text-[12px] text-ink-3 tabular-nums">{uploadPct === null ? "" : `${Math.round(uploadPct)}%`}</span></div>
    {/if}
  </div>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (mediaOpen = false)}>{t("action.cancel")}</Button>
    <Button variant="primary" disabled={!mediaFile} loading={uploading} onclick={uploadMedia}><Upload />{t("notes.media.uploadAction")}</Button>
  {/snippet}
</Sheet>

<Sheet bind:open={srtOpen} title={note.transcript ? t("notes.transcript.replace") : t("notes.transcript.upload")} description={t("notes.transcript.sheetHint")} side="center">
  <div class="pt-2">
    <FileDrop bind:file={srtFile} accept=".srt" label={t("notes.transcript.drop")} hint={t("notes.transcript.types")} maxBytes={5 * 1024 * 1024} onError={m => toasts.show(m, "error")} />
  </div>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (srtOpen = false)}>{t("action.cancel")}</Button>
    <Button variant="primary" disabled={!srtFile} loading={srtBusy} onclick={uploadSrt}><Upload />{t("notes.transcript.uploadAction")}</Button>
  {/snippet}
</Sheet>

<ConfirmDialog bind:open={removeOpen} title={t("notes.transcript.removeTitle")} description={t("notes.transcript.removeHint")} confirmLabel={t("notes.transcript.remove")} onConfirm={removeTranscript} />
