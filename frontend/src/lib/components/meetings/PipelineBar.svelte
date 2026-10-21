<script lang="ts">
  import { AudioLines, Check, FileText, Sparkles, Wrench, X } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import { aiStatus } from "#lib/ai/status.svelte.ts";
  import AiGate from "#lib/components/ai/AiGate.svelte";
  import Button from "#lib/components/ui/Button.svelte";
  import Progress from "#lib/components/ui/Progress.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import type { JobInfo, MeetingDetail } from "#lib/meetings/types.ts";
  import { jobActive } from "#lib/meetings/util.ts";

  /**
   * The meeting's pipeline: content → transcription (asr) → analysis (analysis) → members confirm. Shows progress, and
   * 「維護中」 honestly when a role is down (recordings stay saved; the jobs resume by themselves).
   */
  let { detail, onChanged }: { detail: MeetingDetail; onChanged: (next?: MeetingDetail) => void | Promise<void> } = $props();
  $effect(() => aiStatus.watch());

  const STAGE: Record<string, MessageKey> = {
    queued: "meet.stage.queued", starting: "meet.stage.queued", downloading: "meet.stage.downloading", transcribing: "meet.stage.transcribing",
    saving: "meet.stage.saving", context: "meet.stage.context", mapping: "meet.stage.mapping", analyzing: "meet.stage.analyzing", waiting_llm: "meet.stage.waiting",
  };
  const stageLabel = (job: JobInfo) => (job ? t(STAGE[job.stage] ?? "meet.stage.working") : "");

  const processingMedia = $derived(detail.media.filter(m => m.status === "processing"));
  const readyMedia = $derived(detail.media.some(m => m.status === "ready" && m.has_audio));
  const hasContent = $derived(detail.media.some(m => m.status !== "failed") || Boolean(detail.transcript));
  const asrTranscript = $derived(detail.transcripts.some(x => x.source !== "live"));
  const tJob = $derived(detail.jobs.transcribe);
  const aJob = $derived(detail.jobs.analyze);
  const transcribing = $derived(jobActive(tJob) || processingMedia.length > 0);
  const analyzing = $derived(jobActive(aJob));
  const asrDown = $derived(!aiStatus.available("asr"));
  const analysisDown = $derived(!aiStatus.available("analysis"));
  const pendingDrafts = $derived(detail.drafts.filter(d => d.status === "pending").length);
  const canAnalyze = $derived(detail.permissions.edit && detail.studies.length > 0 && (Boolean(detail.transcript) || detail.feedback.length > 0));
  let busy = $state(false);

  async function run(path: string) {
    busy = true;
    try {
      await onChanged(await api.post<MeetingDetail>(path));
    } catch (e) {
      toasts.show((e as Error).message, "error");
    } finally {
      busy = false;
    }
  }

  type StepState = "done" | "active" | "waiting" | "failed" | "idle";
  const steps = $derived.by(() => {
    const content: StepState = hasContent ? "done" : "idle";
    const tr: StepState = asrTranscript ? "done" : transcribing ? (asrDown && jobActive(tJob) ? "waiting" : "active") : tJob?.status === "failed" ? "failed" : "idle";
    const an: StepState = analyzing ? (analysisDown ? "waiting" : "active") : detail.drafts.length ? "done" : aJob?.status === "failed" ? "failed" : "idle";
    const rv: StepState = detail.drafts.length ? (pendingDrafts ? "active" : "done") : "idle";
    return [
      { key: "content", label: t("meet.pipe.content"), state: content, icon: AudioLines },
      { key: "transcribe", label: t("meet.pipe.transcribe"), state: tr, icon: FileText },
      { key: "analyze", label: t("meet.pipe.analyze"), state: an, icon: Sparkles },
      { key: "review", label: t("meet.pipe.review"), state: rv, icon: Check },
    ];
  });
</script>

<div class="flex flex-col gap-3">
  <ol class="grid grid-cols-4 gap-1.5 sm:gap-2" aria-label={t("meet.pipe.label")}>
    {#each steps as s (s.key)}
      <li class="flex min-w-0 flex-col gap-1.5">
        <span class="h-1 rounded-full {s.state === 'done' ? 'bg-ink' : s.state === 'active' ? 'bg-ink/40' : s.state === 'failed' ? 'bg-danger' : s.state === 'waiting' ? 'bg-[var(--pill-butter-ink)]' : 'bg-line-2'}"></span>
        <span class="flex min-w-0 flex-col items-start gap-1 text-[12px] leading-tight font-medium sm:flex-row {s.state === 'idle' ? 'text-ink-3' : 'text-ink'}">
          {#if s.state === "done"}<Check class="mt-px size-3.5 shrink-0" />{:else if s.state === "failed"}<X class="mt-px size-3.5 shrink-0 text-danger" />{:else if s.state === "waiting"}<Wrench class="mt-px size-3.5 shrink-0" />{:else}<s.icon class="mt-px size-3.5 shrink-0" />{/if}
          <span class="max-w-full min-w-0 break-words">{s.label}</span>
        </span>
      </li>
    {/each}
  </ol>

  {#if processingMedia.length}
    <div class="rounded-2xl bg-surface-2 px-3.5 py-3 text-[13px] text-ink-2">
      <p>{t("meet.pipe.processingMedia")}</p>
    </div>
  {/if}

  {#if jobActive(tJob)}
    <div class="flex flex-col gap-2 rounded-2xl bg-surface-2 px-3.5 py-3 text-[13px]">
      {#if asrDown}
        <p class="flex items-start gap-2 text-ink-2"><Wrench class="mt-0.5 size-4 shrink-0" /><span><strong class="font-semibold text-ink">{t("meet.pipe.asrDown")}</strong> {t("meet.pipe.asrDownHint")}</span></p>
      {:else}
        <p class="text-ink-2">{t("meet.pipe.transcribing")} · {stageLabel(tJob)}</p>
        <Progress value={tJob!.stage === "queued" ? null : tJob!.progress} label={t("meet.pipe.transcribe")} />
      {/if}
    </div>
  {:else if tJob?.status === "failed" && !asrTranscript}
    <div class="flex flex-col gap-2 rounded-2xl bg-danger-soft px-3.5 py-3 text-[13px] text-danger sm:flex-row sm:items-center sm:justify-between">
      <p>{t("meet.pipe.transcribeFailed")}{tJob.error ? `：${tJob.error}` : ""}</p>
      {#if detail.permissions.edit && readyMedia}<Button size="sm" loading={busy} onclick={() => run(`/meetings/${detail.meeting.id}/transcribe`)}>{t("meet.pipe.retry")}</Button>{/if}
    </div>
  {:else if readyMedia && !asrTranscript && detail.permissions.edit}
    <div class="flex flex-col gap-2 rounded-2xl bg-surface-2 px-3.5 py-3 text-[13px] text-ink-2 sm:flex-row sm:items-center sm:justify-between">
      <p>{t("meet.pipe.readyToTranscribe")}</p>
      <AiGate role="asr" inline><Button size="sm" variant="primary" loading={busy} onclick={() => run(`/meetings/${detail.meeting.id}/transcribe`)}><FileText />{t("meet.pipe.startTranscribe")}</Button></AiGate>
    </div>
  {/if}

  {#if analyzing}
    <div class="flex flex-col gap-2 rounded-2xl bg-surface-2 px-3.5 py-3 text-[13px]">
      {#if analysisDown}
        <p class="flex items-start gap-2 text-ink-2"><Wrench class="mt-0.5 size-4 shrink-0" /><span><strong class="font-semibold text-ink">{t("meet.pipe.analysisDown")}</strong> {t("meet.pipe.analysisDownHint")}</span></p>
      {:else}
        <p class="text-ink-2">{t("meet.pipe.analyzing")} · {stageLabel(aJob)}</p>
        <Progress value={aJob!.stage === "queued" ? null : aJob!.progress} label={t("meet.pipe.analyze")} />
      {/if}
    </div>
  {:else if aJob?.status === "failed" && canAnalyze}
    <div class="flex flex-col gap-2 rounded-2xl bg-danger-soft px-3.5 py-3 text-[13px] text-danger sm:flex-row sm:items-center sm:justify-between">
      <p>{t("meet.pipe.analyzeFailed")}{aJob.error ? `：${aJob.error}` : ""}</p>
      <AiGate role="analysis" inline><Button size="sm" loading={busy} onclick={() => run(`/meetings/${detail.meeting.id}/analyze`)}>{t("meet.pipe.retry")}</Button></AiGate>
    </div>
  {:else if canAnalyze && !detail.drafts.length && !transcribing}
    <div class="flex flex-col gap-2 rounded-2xl bg-surface-2 px-3.5 py-3 text-[13px] text-ink-2 sm:flex-row sm:items-center sm:justify-between">
      <p>{t("meet.pipe.readyToAnalyze")}</p>
      <AiGate role="analysis" inline><Button size="sm" variant="primary" loading={busy} onclick={() => run(`/meetings/${detail.meeting.id}/analyze`)}><Sparkles />{t("meet.pipe.startAnalyze")}</Button></AiGate>
    </div>
  {/if}
</div>
