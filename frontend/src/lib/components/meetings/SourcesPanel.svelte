<script lang="ts">
  import { untrack } from "svelte";
  import { FileAudio, FileText, ListTodo, Mic, Upload } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import FileDrop from "#lib/components/ui/FileDrop.svelte";
  import Progress from "#lib/components/ui/Progress.svelte";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import type { Media } from "#lib/meetings/types.ts";
  import { MEDIA_ACCEPT, TRANSCRIPT_ACCEPT } from "#lib/meetings/util.ts";
  import RecorderPanel from "./RecorderPanel.svelte";
  import SummaryImport from "./SummaryImport.svelte";

  /**
   * Where the meeting's content comes from: record in the browser, upload audio/video, upload a transcript, or import
   * a Markdown summary written on another platform (→ drafts with every action item as a task).
   */
  let { meetingId, unfinished = null, maxBytes = 1024 ** 3, initial = "record", summary = "", hasStudies = true, onChanged, onRecordingState }: {
    meetingId: string;
    unfinished?: Media | null;
    maxBytes?: number;
    initial?: "record" | "media" | "transcript" | "summary";
    summary?: string;
    hasStudies?: boolean;
    onChanged: () => void | Promise<void>;
    onRecordingState?: (state: "recording" | "paused" | null) => void;
  } = $props();

  type Tab = "record" | "media" | "transcript" | "summary";
  let tab = $state<Tab>(untrack(() => initial));
  let file = $state<File | null>(null);
  let transcriptFile = $state<File | null>(null);
  let progress = $state<number | null>(null);
  let uploading = $state(false);

  const tabs = $derived([
    { value: "record" as Tab, label: t("meet.src.record"), icon: Mic },
    { value: "media" as Tab, label: t("meet.src.media"), icon: FileAudio },
    { value: "transcript" as Tab, label: t("meet.src.transcript"), icon: FileText },
    { value: "summary" as Tab, label: t("meet.src.summary"), icon: ListTodo },
  ]);

  /** XHR for upload progress (fetch has none). Resolves with the parsed body or rejects with the backend's message. */
  function send(url: string, form: FormData): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api${url}`);
      xhr.withCredentials = true;
      xhr.upload.onprogress = e => {
        if (e.lengthComputable) progress = Math.round((e.loaded / e.total) * 100);
      };
      xhr.onload = () => {
        let body: { error?: string } | null = null;
        try {
          body = JSON.parse(xhr.responseText);
        } catch {}
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else reject(new Error(body?.error ?? (xhr.status === 413 ? t("meet.src.tooLarge") : t("common.error"))));
      };
      xhr.onerror = () => reject(new Error(t("common.offline")));
      xhr.send(form);
    });
  }

  async function upload(kind: "media" | "transcript") {
    const f = kind === "media" ? file : transcriptFile;
    if (!f) return;
    uploading = true;
    progress = 0;
    try {
      const form = new FormData();
      form.append("file", f, f.name);
      await send(kind === "media" ? `/meetings/${meetingId}/media` : `/meetings/${meetingId}/transcripts`, form);
      toasts.show(kind === "media" ? t("meet.src.mediaUploaded") : t("meet.src.transcriptUploaded"), "success");
      if (kind === "media") file = null;
      else transcriptFile = null;
      await onChanged();
    } catch (e) {
      toasts.show((e as Error).message, "error");
    } finally {
      uploading = false;
      progress = null;
    }
  }
</script>

<div class="flex flex-col gap-4">
  <Segmented bind:value={tab} options={tabs} label={t("meet.src.label")} class="w-full" />
  {#if tab === "record"}
    <RecorderPanel {meetingId} {unfinished} {onChanged} {onRecordingState} />
  {:else if tab === "media"}
    <FileDrop bind:file accept={MEDIA_ACCEPT} label={t("meet.src.mediaDrop")} hint={t("meet.src.mediaHint")} {maxBytes} onError={m => toasts.show(m, "error")} />
    {#if uploading && progress !== null}<Progress value={progress} label={t("meet.src.uploading")} />{/if}
    <div class="flex justify-end"><Button variant="primary" disabled={!file} loading={uploading} onclick={() => upload("media")}><Upload />{t("meet.src.upload")}</Button></div>
  {:else if tab === "summary"}
    <SummaryImport {meetingId} initial={summary} {hasStudies} onDone={() => onChanged()} />
  {:else}
    <FileDrop bind:file={transcriptFile} accept={TRANSCRIPT_ACCEPT} label={t("meet.src.transcriptDrop")} hint={t("meet.src.transcriptHint")} maxBytes={20 * 1024 * 1024} onError={m => toasts.show(m, "error")} />
    {#if uploading && progress !== null}<Progress value={progress} label={t("meet.src.uploading")} />{/if}
    <div class="flex justify-end"><Button variant="primary" disabled={!transcriptFile} loading={uploading} onclick={() => upload("transcript")}><Upload />{t("meet.src.upload")}</Button></div>
  {/if}
</div>
