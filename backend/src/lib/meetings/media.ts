/**
 * Meeting media: browser recordings (chunked upload), uploaded audio/video, the `media_transcode` worker job and its
 * finalizer, which queues the transcription (`ai_meeting_transcribe`).
 */
import { Readable } from "node:stream";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import type { FastifyBaseLogger } from "fastify";
import type { Queryable } from "../../db.js";
import { enqueueJob, registerFinalizer, type MediaTranscodePayload, type MediaTranscodeResult } from "../../jobs/queue.js";
import type { Notifier } from "../notify.js";
import type { Storage } from "../storage.js";
import { meetingKeys } from "./keys.js";
import { meetingUrl, refreshStatus, type MediaRow } from "./store.js";

export const TRANSCRIBE_JOB = "ai_meeting_transcribe";
export const ANALYZE_JOB = "ai_meeting_analyze";

/** One MediaRecorder chunk (≈ 10 s of Opus is ~40 KB; generous for high bitrates). */
export const CHUNK_MAX_BYTES = 8 * 1024 * 1024;
export const MAX_PARTS = 20;
export const MAX_SEQ = 99_999;
/** Uploaded videos up to this size are kept for playback; larger ones keep only the extracted audio. */
export const VIDEO_KEEP_BYTES = 500 * 1024 * 1024;

export const MEDIA_EXTENSIONS = ["mp4", "mkv", "webm", "mov", "m4v", "m4a", "mp3", "wav", "ogg", "oga", "opus", "flac", "aac"] as const;
const VIDEO_PLAYABLE = new Set(["mp4", "webm", "mov", "m4v"]);
export const extensionOf = (name: string) => /\.([a-z0-9]{1,5})$/i.exec(name)?.[1]?.toLowerCase() ?? "";
export const isMediaFile = (name: string) => (MEDIA_EXTENSIONS as readonly string[]).includes(extensionOf(name));
/** Whether an uploaded file may be kept as playback video (browser-playable container, not too large). */
export const mayKeepVideo = (name: string, bytes: number) => VIDEO_PLAYABLE.has(extensionOf(name)) && bytes <= VIDEO_KEEP_BYTES;

export type TranscribePayload = { meetingId: string; mediaId: string; userId: string | null; fileName?: string };
export type AnalyzePayload = { meetingId: string; userId: string | null; fileName?: string };

/** Payload extension understood by the worker (worker/src/types.ts). */
export type MeetingTranscodePayload = MediaTranscodePayload & { extraSourceKeys?: string[]; keepSource?: boolean };
export type MeetingTranscodeResult = MediaTranscodeResult & { hasVideo?: boolean; keptSource?: boolean };

export async function enqueueTranscode(client: Queryable, media: { id: string; meeting_id: string; file_name: string }, sourceKeys: string[], keepSource: boolean, userId: string | null) {
  const [sourceKey, ...extra] = sourceKeys;
  const payload: MeetingTranscodePayload = {
    itemId: media.id,
    sourceKey: sourceKey!,
    outputKey: meetingKeys.mediaAudio(media.meeting_id, media.id),
    fileName: media.file_name || "會議錄音",
    ...(extra.length ? { extraSourceKeys: extra } : {}),
    ...(keepSource ? { keepSource: true } : {}),
  };
  const jobId = await enqueueJob(client, "media_transcode", payload, userId, 3);
  await client.query("UPDATE meeting_media SET status='processing', job_id=$2, error=NULL, updated_at=now() WHERE id=$1", [media.id, jobId]);
  return jobId;
}

/** Queues the ASR job for `mediaId` and remembers it on the meeting. */
export async function enqueueTranscribe(client: Queryable, meeting: { id: string; title: string }, mediaId: string, userId: string | null) {
  const payload: TranscribePayload = { meetingId: meeting.id, mediaId, userId, fileName: `${meeting.title} 轉錄` };
  const jobId = await enqueueJob(client, TRANSCRIBE_JOB, payload, userId, 4);
  await client.query("UPDATE meetings SET transcribe_job_id=$2, updated_at=now() WHERE id=$1", [meeting.id, jobId]);
  return jobId;
}

export async function enqueueAnalyze(client: Queryable, meeting: { id: string; title: string }, userId: string | null) {
  const payload: AnalyzePayload = { meetingId: meeting.id, userId, fileName: `${meeting.title} 分析` };
  const jobId = await enqueueJob(client, ANALYZE_JOB, payload, userId, 3);
  await client.query("UPDATE meetings SET analyze_job_id=$2, analysis_error=NULL, updated_at=now() WHERE id=$1", [meeting.id, jobId]);
  return jobId;
}

export async function jobActive(db: Queryable, jobId: string | null) {
  if (!jobId) return false;
  const r = await db.query("SELECT 1 FROM jobs WHERE id=$1 AND status IN ('queued','running')", [jobId]);
  return Boolean(r.rowCount);
}

/** Lists object keys under `prefix` (sorted) with their sizes. */
export async function listKeys(storage: Storage, prefix: string) {
  const out: { key: string; size: number }[] = [];
  let token: string | undefined;
  do {
    const page = await storage.client.send(new ListObjectsV2Command({ Bucket: storage.bucket, Prefix: prefix, ContinuationToken: token }));
    for (const item of page.Contents ?? []) if (item.Key) out.push({ key: item.Key, size: item.Size ?? 0 });
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Concatenates the uploaded chunks of each recorder part into one WebM object per part (byte concatenation is a valid
 * WebM stream: the first chunk carries the header). Returns the source keys in part order and the total size.
 */
export async function assembleRecording(storage: Storage, meetingId: string, mediaId: string, parts: number[]) {
  const sources: string[] = [];
  let bytes = 0;
  for (const part of [...parts].sort((a, b) => a - b)) {
    const chunks = await listKeys(storage, meetingKeys.recordingPartPrefix(meetingId, mediaId, part));
    if (!chunks.length) continue;
    const target = sources.length === 0 ? meetingKeys.mediaSource(mediaId) : meetingKeys.mediaPart(mediaId, sources.length);
    async function* concat() {
      for (const chunk of chunks) {
        const object = await storage.get(chunk.key);
        if (!object) continue;
        for await (const piece of object.body) yield piece as Buffer;
      }
    }
    await storage.put(target, Readable.from(concat()), "audio/webm");
    sources.push(target);
    bytes += chunks.reduce((sum, c) => sum + c.size, 0);
  }
  return { sources, bytes };
}

const validPeaks = (value: unknown): number[] | null =>
  Array.isArray(value) && value.length <= 2000 && value.every(v => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1) ? (value as number[]) : null;

/**
 * Finalizer for `media_transcode` jobs of meeting media. Success → media `ready` (+ peaks, duration, kept video) and,
 * when the meeting has no ASR/uploaded transcript and no transcription running, `ai_meeting_transcribe` is queued.
 */
export function registerMeetingMediaFinalizer(deps: { storage: Storage; notifier: Notifier; log: FastifyBaseLogger }) {
  registerFinalizer("media_transcode", async (job, { client }) => {
    const payload = job.payload as MeetingTranscodePayload;
    const media = (await client.query<MediaRow & { title: string }>(
      "SELECT mm.*,m.title FROM meeting_media mm JOIN meetings m ON m.id=mm.meeting_id WHERE mm.id=$1 FOR UPDATE OF mm, m",
      [payload.itemId],
    )).rows[0];
    const sources = [payload.sourceKey, ...(payload.extraSourceKeys ?? [])];
    if (!media || media.job_id !== job.id) {
      // Meeting/media deleted or superseded by a retry: clean up whatever this job produced.
      return async () => {
        await deps.storage.delete(payload.outputKey).catch(() => {});
      };
    }
    if (job.status === "succeeded") {
      const result = (job.result ?? {}) as MeetingTranscodeResult;
      const kept = Boolean(payload.keepSource && result.keptSource && result.hasVideo);
      await client.query(
        `UPDATE meeting_media SET status='ready', audio_key=$2, duration_sec=COALESCE($3,duration_sec), peaks=$4, has_video=$5, video_key=$6, error=NULL, updated_at=now() WHERE id=$1`,
        [media.id, payload.outputKey, typeof result.durationSeconds === "number" ? result.durationSeconds : null, JSON.stringify(validPeaks(result.peaks)), Boolean(result.hasVideo), kept ? payload.sourceKey : null],
      );
      const transcript = await client.query("SELECT 1 FROM transcripts WHERE meeting_id=$1 AND source IN ('asr','upload')", [media.meeting_id]);
      const meeting = (await client.query<{ transcribe_job_id: string | null }>("SELECT transcribe_job_id FROM meetings WHERE id=$1", [media.meeting_id])).rows[0];
      if (!transcript.rowCount && !(await jobActive(client, meeting?.transcribe_job_id ?? null))) {
        await enqueueTranscribe(client, { id: media.meeting_id, title: media.title }, media.id, media.created_by);
      }
      await refreshStatus(client, media.meeting_id);
      return undefined;
    }
    const message = job.status === "cancelled" ? "已取消。" : (job.error ?? "無法處理媒體檔。").slice(-500);
    await client.query("UPDATE meeting_media SET status='failed', error=$2, updated_at=now() WHERE id=$1", [media.id, message]);
    await refreshStatus(client, media.meeting_id);
    const notice = { kind: "meeting", title: "會議錄音處理失敗", body: `${media.title}：${message}`, url: meetingUrl(media.meeting_id) };
    if (media.created_by && job.status === "failed") await deps.notifier.record(client, [media.created_by], notice);
    return async () => {
      for (const key of sources) await deps.storage.delete(key).catch(() => {});
      if (media.created_by && job.status === "failed") await deps.notifier.push([media.created_by], notice, { pref: "mediaTranscoded", tag: `meeting-media-${media.id}` });
    };
  });
}
