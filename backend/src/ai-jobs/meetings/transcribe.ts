/**
 * `ai_meeting_transcribe` (ai-worker, role `asr`): transcribes one ready meeting media file (the transcoded m4a) with the
 * meeting language hint (default zh-TW), diarization and a glossary (study titles, people, decks, papers). ASR chunking,
 * resume and script conversion come from the AI platform; the ASR checkpoint is saved after every durable step so a
 * restarted attempt reuses finished chunks / vendor job ids. Result → `transcripts` (source `asr`), words.json in S3,
 * then it becomes the meeting's current transcript unless the user uploaded the current one (the ASR one then stays as
 * an alternative). `ai_meeting_analyze` is queued only when it became current, the meeting has studies and there is no
 * analysis or study draft yet (re-runs never overwrite reviewed drafts; the user re-analyzes explicitly).
 * Stages: downloading → transcribing → saving → done (`waiting_llm` while `asr` is unavailable).
 */
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { transaction } from "../../db.js";
import { AiJobInputError, type AiJobContext } from "../../ai-worker/registry.js";
import type { MemberCheckpoint } from "../../ai/platform/platform.js";
import { meetingGlossary } from "../../lib/meetings/context.js";
import { meetingKeys } from "../../lib/meetings/keys.js";
import { enqueueAnalyze, jobActive, type TranscribePayload } from "../../lib/meetings/media.js";
import { adoptAsrTranscript, hasAnalysisOrDrafts, refreshStatus, meetingUrl, type MediaRow } from "../../lib/meetings/store.js";
import { notifyFromJob } from "./notify.js";

export type TranscribeResult = { transcriptId: string; segments: number; durationSec: number; speakers: number; model: string; warnings: string[]; analyzeJobId: string | null; current: boolean };

export async function runTranscribe(ctx: AiJobContext<TranscribePayload>): Promise<TranscribeResult> {
  const { meetingId, mediaId } = ctx.job.payload;
  const media = (await ctx.db.query<MediaRow & { language: string; title: string; participants: number }>(
    `SELECT mm.*,m.language,m.title,(SELECT count(*)::int FROM meeting_participants mp WHERE mp.meeting_id=m.id) AS participants
       FROM meeting_media mm JOIN meetings m ON m.id=mm.meeting_id WHERE mm.id=$1 AND mm.meeting_id=$2`,
    [mediaId, meetingId],
  )).rows[0];
  if (!media) throw new AiJobInputError("會議或錄音已被刪除。");
  if (media.status !== "ready" || !media.audio_key) throw new AiJobInputError("錄音還沒處理完成。");

  await ctx.progress("downloading", 2);
  const dir = await mkdtemp(path.join(tmpdir(), "hub-meeting-asr-"));
  try {
    const file = path.join(dir, "audio.m4a");
    const object = await ctx.storage.get(media.audio_key);
    if (!object) throw new AiJobInputError("找不到錄音檔。");
    await pipeline(object.body, createWriteStream(file));

    const glossary = await meetingGlossary(ctx.db, meetingId);
    await ctx.progress("transcribing", 5);
    let lastReport = 0;
    const transcript = await ctx.ai.transcribe(
      {
        audio: { path: file, mime: "audio/mp4" },
        language: media.language === "auto" ? undefined : media.language,
        diarize: true,
        ...(media.participants >= 2 ? { speakers: { min: 1, max: Math.min(12, media.participants + 2) } } : {}),
        ...(media.duration_sec ? { durationSec: media.duration_sec } : {}),
        signal: ctx.signal,
        onProgress: fraction => {
          if (Date.now() - lastReport < 3000) return;
          lastReport = Date.now();
          void ctx.progress("transcribing", Math.round(5 + Math.max(0, Math.min(1, fraction)) * 85)).catch(() => {});
        },
      },
      {
        jobId: ctx.job.id,
        userId: ctx.job.payload.userId ?? undefined,
        signal: ctx.signal,
        glossary,
        resume: (ctx.checkpoint as MemberCheckpoint | null) ?? undefined,
        onCheckpoint: cp => ctx.saveCheckpoint(cp),
      },
    );

    await ctx.progress("saving", 92);
    const model = transcript.route ? `${transcript.route.providerKind}/${transcript.route.model}` : transcript.source.model;
    const segments = transcript.segments
      .filter(s => s.text.trim())
      .map((s, i) => ({ id: i, start: s.start, end: s.end, text: s.text.trim(), ...(s.speaker ? { speaker: s.speaker } : {}) }));
    const result = await transaction(ctx.db, async client => {
      const meeting = (await client.query<{ id: string; title: string; analyze_job_id: string | null; studies: number }>(
        "SELECT id,title,analyze_job_id,(SELECT count(*)::int FROM meeting_studies ms WHERE ms.meeting_id=m.id) AS studies FROM meetings m WHERE id=$1 FOR UPDATE",
        [meetingId],
      )).rows[0];
      if (!meeting) throw new AiJobInputError("會議已被刪除。");
      const id = (await client.query<{ id: string }>(
        `INSERT INTO transcripts(meeting_id,media_id,source,language,segments,speakers,warnings,model,duration_sec,created_by)
         VALUES($1,$2,'asr',$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [meetingId, mediaId, transcript.language ?? media.language, JSON.stringify(segments), JSON.stringify(transcript.speakers), JSON.stringify(transcript.warnings), model.slice(0, 200), transcript.durationSec || media.duration_sec, ctx.job.payload.userId],
      )).rows[0]!.id;
      if (transcript.words?.length) {
        const key = meetingKeys.transcriptWords(meetingId, id);
        await ctx.storage.put(key, JSON.stringify(transcript.words), "application/json");
        await client.query("UPDATE transcripts SET words_key=$2 WHERE id=$1", [id, key]);
      }
      const current = await adoptAsrTranscript(client, meetingId, id);
      let analyzeJobId: string | null = null;
      if (current && meeting.studies > 0 && !(await jobActive(client, meeting.analyze_job_id)) && !(await hasAnalysisOrDrafts(client, meetingId))) analyzeJobId = await enqueueAnalyze(client, meeting, ctx.job.payload.userId);
      await refreshStatus(client, meetingId, { finishingJobId: ctx.job.id });
      return { id, analyzeJobId, title: meeting.title, current };
    });
    if (ctx.job.payload.userId) {
      await notifyFromJob(ctx.db, [ctx.job.payload.userId], { kind: "meeting", title: "會議逐字稿完成", body: `${result.title}：${segments.length} 段`, url: meetingUrl(meetingId) }, "mediaTranscoded");
    }
    await ctx.progress("done", 100);
    return { transcriptId: result.id, segments: segments.length, durationSec: transcript.durationSec, speakers: transcript.speakers.length, model, warnings: transcript.warnings, analyzeJobId: result.analyzeJobId, current: result.current };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
