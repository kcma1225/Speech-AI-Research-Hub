import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { transaction, type Queryable } from "../db.js";
import { cancelJob } from "../jobs/queue.js";
import { requireUser, type CurrentUser } from "../lib/auth.js";
import { badRequest, conflict, forbidden, HttpError, notFound, parse } from "../lib/http.js";
import { loadStudyAccess, permissionsOf } from "../lib/studies/access.js";
import type { AfterCommit } from "../lib/studies/tasks.js";
import { confirmDraft, confirmInput, draftPatchInput, patchDraft, setDraftStatus } from "../lib/meetings/drafts.js";
import { feedbackFileText, parseTranscriptFile, UnreadableFile } from "../lib/meetings/files.js";
import { meetingKeys } from "../lib/meetings/keys.js";
import { enqueueAnalyze, enqueueTranscribe, jobActive, registerMeetingMediaFinalizer } from "../lib/meetings/media.js";
import {
  checkDecks, checkStudies, checkUsers, currentTranscript, jobInfo, listDrafts, listMeetings, mediaView, meetingCard, meetingDecks,
  meetingPermissions, meetingStudies, pickCurrentTranscript, refreshStatus, requireMeeting, requireMeetingEditor, setDecks,
  setParticipants, setStudies, speakerMap, speakerNames, type MediaRow, type MeetingRow, type MeetingStatus, type TranscriptRow,
} from "../lib/meetings/store.js";
import meetingMedia from "./meetings-media.js";
import meetingLive from "./meetings-live.js";
import "../lib/meetings/agent-tools.js"; // agent tools list_meetings / get_meeting / get_transcript_excerpt

/**
 * Meetings (`/meetings/*`, `/studies/:ref/meetings`): cross-study meetings, media, transcripts, speakers, feedback,
 * AI analysis and per-study drafts. docs/architecture.md "Meetings". Child plugins: media/recordings
 * (meetings-media.ts) and live captions (meetings-live.ts, WebSocket — registered after notes in app.ts).
 */

const idParams = z.object({ id: z.uuid() });
const draftParams = z.object({ id: z.uuid(), draftId: z.uuid() });
const feedbackParams = z.object({ id: z.uuid(), feedbackId: z.uuid() });
const transcriptParams = z.object({ id: z.uuid(), transcriptId: z.uuid() });
const STATUSES = ["draft", "recorded", "processing", "transcribed", "analyzing", "review", "done"] as const;

const isoDateTime = z.string().trim().max(40).refine(v => !Number.isNaN(Date.parse(v)), "invalid date");
const language = z.string().trim().regex(/^([a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*|auto)$/).max(20);
const deckInput = z.object({ deck_id: z.uuid(), version_id: z.uuid().nullable().optional() });

const createInput = z.object({
  title: z.string().trim().min(1).max(160),
  held_at: isoDateTime,
  notes: z.string().max(20000).optional(),
  language: language.optional(),
  participant_ids: z.array(z.uuid()).max(60).default([]),
  study_ids: z.array(z.string().trim().min(1).max(80)).min(1).max(20),
  decks: z.array(deckInput).max(40).default([]),
});
const patchInput = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  held_at: isoDateTime.optional(),
  notes: z.string().max(20000).optional(),
  language: language.optional(),
  participant_ids: z.array(z.uuid()).max(60).optional(),
  study_ids: z.array(z.string().trim().min(1).max(80)).min(1).max(20).optional(),
  decks: z.array(deckInput).max(40).optional(),
});
const listQuery = z.object({
  when: z.enum(["upcoming", "past", "all"]).default("all"),
  study: z.string().trim().min(1).max(80).optional(),
  person: z.string().trim().max(40).optional(),
  q: z.string().trim().max(200).optional(),
  status: z.enum(STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(300).optional(),
});
const speakersInput = z.object({
  speakers: z.array(z.object({
    label: z.string().trim().min(1).max(40),
    user_id: z.uuid().nullable().optional(),
    name: z.string().trim().min(1).max(80).nullable().optional(),
  })).max(60),
});
const liveTranscriptInput = z.object({
  segments: z.array(z.object({ start: z.number().min(0).max(86400), end: z.number().min(0).max(86400), text: z.string().trim().min(1).max(4000), speaker: z.string().max(40).nullable().optional() })).min(1).max(20000),
  media_id: z.uuid().nullable().optional(),
});
const feedbackInput = z.object({ body_md: z.string().max(50000) });
const deckOptionsQuery = z.object({ studies: z.string().trim().min(1).max(2000) });

const TRANSCRIPT_MAX = 20 * 1024 * 1024;
const FEEDBACK_FILE_MAX = 30 * 1024 * 1024;

async function runAfter(app: FastifyInstance, callbacks: (AfterCommit | null | undefined)[]) {
  for (const callback of callbacks) if (callback) await callback().catch(error => app.log.warn({ err: error }, "post-commit step failed"));
}

function transcriptView(t: TranscriptRow | null) {
  if (!t) return null;
  return {
    id: t.id, source: t.source, language: t.language, segments: t.segments, speakers: t.speakers, warnings: t.warnings, model: t.model,
    file_name: t.file_name, duration_sec: t.duration_sec, media_id: t.media_id, created_at: t.created_at, has_words: Boolean(t.words_key),
  };
}

/** Full meeting page payload. */
export async function meetingDetail(db: Queryable, meeting: MeetingRow, user: CurrentUser) {
  const [card, studies, decks, media, transcript, transcripts, speakers, feedback, drafts, permissions, transcribeJob, analyzeJob] = await Promise.all([
    meetingCard(db, meeting.id),
    meetingStudies(db, meeting.id),
    meetingDecks(db, meeting.id),
    db.query<MediaRow>("SELECT * FROM meeting_media WHERE meeting_id=$1 ORDER BY created_at", [meeting.id]),
    currentTranscript(db, meeting),
    db.query("SELECT id,source,language,model,file_name,duration_sec,media_id,created_at,jsonb_array_length(segments) AS segment_count FROM transcripts WHERE meeting_id=$1 ORDER BY created_at DESC", [meeting.id]),
    speakerMap(db, meeting.id),
    db.query<{ id: string; author_id: string | null; author_name: string | null; author_role: string | null; body_md: string; file_name: string | null; file_key: string | null; has_text: boolean; created_at: string; updated_at: string }>(
      `SELECT f.id,f.author_id,u.name AS author_name,u.role AS author_role,f.body_md,f.file_name,f.file_key,(f.file_text IS NOT NULL AND f.file_text<>'') AS has_text,f.created_at,f.updated_at
         FROM meeting_feedback f LEFT JOIN users u ON u.id=f.author_id WHERE f.meeting_id=$1 ORDER BY f.created_at`,
      [meeting.id],
    ),
    listDrafts(db, meeting.id),
    meetingPermissions(db, meeting, user),
    jobInfo(db, meeting.transcribe_job_id),
    jobInfo(db, meeting.analyze_job_id),
  ]);
  const editable = new Set(permissions.studies);
  return {
    meeting: {
      id: meeting.id, title: meeting.title, held_at: meeting.held_at, status: meeting.status, notes: meeting.notes, language: meeting.language,
      created_by: meeting.created_by, creator_name: card?.creator_name ?? null, created_at: meeting.created_at, updated_at: meeting.updated_at,
      transcript_id: meeting.transcript_id,
    },
    studies: studies.map(s => ({
      id: s.id, slug: s.slug, title: s.title, status: s.status, current_stage: s.current_stage,
      owner: s.members.find(m => m.role === "owner") ?? null, members: s.members, can_edit: editable.has(s.id),
    })),
    participants: card?.participants ?? [],
    decks,
    media: media.rows.map(mediaView),
    transcript: transcriptView(transcript),
    transcripts: transcripts.rows,
    speaker_map: speakers,
    feedback: feedback.rows.map(({ file_key, ...f }) => ({
      ...f, has_file: Boolean(file_key), file_url: file_key ? `/api/meetings/${meeting.id}/feedback/${f.id}/file` : null,
      can_edit: user.is_admin || f.author_id === user.id,
    })),
    drafts: drafts.map(d => ({ ...d, can_edit: editable.has(d.study_id) })),
    analysis: meeting.analysis ? { ...meeting.analysis, error: meeting.analysis_error } : meeting.analysis_error ? { error: meeting.analysis_error } : null,
    jobs: { transcribe: transcribeJob, analyze: analyzeJob },
    permissions,
  };
}

async function sendDetail(app: FastifyInstance, meetingId: string, user: CurrentUser) {
  const meeting = await requireMeeting(app.db, meetingId);
  return meetingDetail(app.db, meeting, user);
}

/** Reads one uploaded file (≤ maxBytes) into memory, plus text fields. */
async function readSmallUpload(request: import("fastify").FastifyRequest, maxBytes: number) {
  if (!request.isMultipart()) return null;
  const fields: Record<string, string> = {};
  let file: { name: string; buffer: Buffer } | null = null;
  for await (const part of request.parts({ limits: { fileSize: maxBytes, files: 1 } })) {
    if (part.type === "file") {
      const buffer = await part.toBuffer();
      if (part.file.truncated) throw new HttpError(413, "檔案超過大小限制。");
      file = { name: part.filename || "file", buffer };
    } else if (typeof part.value === "string") fields[part.fieldname] = part.value;
  }
  return { fields, file };
}

export default async function meetingRoutes(app: FastifyInstance) {
  registerMeetingMediaFinalizer({ storage: app.storage, notifier: app.notifier, log: app.log });

  // ---------------------------------------------------------------- list / create

  app.get("/meetings", async (request, reply) => {
    const user = await requireUser(request);
    const q = parse(listQuery, request.query);
    let study: string | undefined;
    if (q.study) study = (await loadStudyAccess(app.db, q.study, user)).study.id;
    let person: string | undefined;
    if (q.person) {
      if (q.person === "me") person = user.id;
      else if (z.uuid().safeParse(q.person).success) person = q.person;
      else throw badRequest("篩選條件不正確。");
    }
    const meetings = await listMeetings(app.db, { when: q.when, study, person, q: q.q, status: q.status as MeetingStatus | undefined, limit: q.limit });
    return reply.header("Cache-Control", "no-store").send({ meetings });
  });

  app.get("/studies/:ref/meetings", async (request, reply) => {
    const user = await requireUser(request);
    const { ref } = parse(z.object({ ref: z.string().min(1).max(80) }), request.params);
    const access = await loadStudyAccess(app.db, ref, user);
    const meetings = await listMeetings(app.db, { study: access.study.id, when: "all" });
    return reply.header("Cache-Control", "no-store").send({ meetings, permissions: permissionsOf(access) });
  });

  /** Decks (with published/review versions) of the given studies, for the wizard's deck picker. */
  app.get("/meetings/deck-options", async (request, reply) => {
    await requireUser(request);
    const { studies } = parse(deckOptionsQuery, request.query);
    const ids = await checkStudies(app.db, studies.split(",").map(s => s.trim()).filter(Boolean).slice(0, 20));
    const decks = await app.db.query(
      `SELECT d.id,d.title,d.slug,d.kind,d.study_id,s.title AS study_title,d.active_version_id,
         COALESCE((SELECT json_agg(json_build_object('id',v.id,'version',v.version,'status',v.status,'published_at',v.published_at) ORDER BY v.version DESC)
            FROM slide_versions v WHERE v.deck_id=d.id AND v.status IN ('published','review')), '[]') AS versions
         FROM decks d JOIN studies s ON s.id=d.study_id WHERE d.study_id = ANY($1) ORDER BY s.title, d.updated_at DESC`,
      [ids],
    );
    return reply.header("Cache-Control", "no-store").send({ decks: decks.rows });
  });

  app.post("/meetings", async (request, reply) => {
    const user = await requireUser(request);
    const input = parse(createInput, request.body);
    const id = await transaction(app.db, async client => {
      const studyIds = await checkStudies(client, input.study_ids);
      const participants = await checkUsers(client, [user.id, ...input.participant_ids]);
      const decks = await checkDecks(client, input.decks.map(d => ({ deckId: d.deck_id, versionId: d.version_id })), studyIds);
      const meetingId = (await client.query<{ id: string }>(
        "INSERT INTO meetings(title,held_at,notes,language,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id",
        [input.title, new Date(input.held_at), input.notes ?? "", input.language ?? "zh-TW", user.id],
      )).rows[0]!.id;
      await setParticipants(client, meetingId, participants);
      await setStudies(client, meetingId, studyIds);
      await setDecks(client, meetingId, decks);
      return meetingId;
    });
    return reply.code(201).send(await sendDetail(app, id, user));
  });

  app.get("/meetings/:id", async (request, reply) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params);
    return reply.header("Cache-Control", "no-store").send(await sendDetail(app, id, user));
  });

  app.patch("/meetings/:id", async (request) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params);
    const input = parse(patchInput, request.body);
    await transaction(app.db, async client => {
      await requireMeetingEditor(client, id, user, true);
      await client.query(
        "UPDATE meetings SET title=COALESCE($2,title), held_at=COALESCE($3,held_at), notes=COALESCE($4,notes), language=COALESCE($5,language), updated_at=now() WHERE id=$1",
        [id, input.title ?? null, input.held_at ? new Date(input.held_at) : null, input.notes ?? null, input.language ?? null],
      );
      if (input.participant_ids) await setParticipants(client, id, await checkUsers(client, input.participant_ids));
      let studyIds: string[] | null = null;
      if (input.study_ids) {
        studyIds = await checkStudies(client, input.study_ids);
        await setStudies(client, id, studyIds);
      }
      if (input.decks) {
        studyIds ??= (await client.query<{ study_id: string }>("SELECT study_id FROM meeting_studies WHERE meeting_id=$1", [id])).rows.map(r => r.study_id);
        await setDecks(client, id, await checkDecks(client, input.decks.map(d => ({ deckId: d.deck_id, versionId: d.version_id })), studyIds));
      }
      await refreshStatus(client, id);
    });
    return sendDetail(app, id, user);
  });

  app.delete("/meetings/:id", async (request) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params);
    const mediaIds = await transaction(app.db, async client => {
      const meeting = await requireMeeting(client, id, true);
      const permissions = await meetingPermissions(client, meeting, user);
      if (!permissions.delete) throw forbidden("只有會議建立者或管理員可以刪除會議。");
      const media = await client.query<{ id: string; job_id: string | null }>("SELECT id,job_id FROM meeting_media WHERE meeting_id=$1", [id]);
      for (const jobId of [meeting.transcribe_job_id, meeting.analyze_job_id, ...media.rows.map(m => m.job_id)]) if (jobId) await cancelJob(client, jobId);
      await client.query("DELETE FROM meetings WHERE id=$1", [id]);
      return media.rows.map(m => m.id);
    });
    // Objects go after commit; a failed delete leaves orphans but never blocks the delete.
    void (async () => {
      for (const prefix of [meetingKeys.meetingPrefix(id), meetingKeys.mediaAudioPrefix(id), ...mediaIds.map(meetingKeys.mediaUploadPrefix)]) {
        await app.storage.deletePrefix(prefix).catch(error => app.log.warn({ err: error, prefix }, "meeting cleanup failed"));
      }
    })();
    return { ok: true };
  });

  // ---------------------------------------------------------------- transcripts

  app.get("/meetings/:id/transcripts", async (request, reply) => {
    await requireUser(request);
    const { id } = parse(idParams, request.params);
    await requireMeeting(app.db, id);
    const rows = await app.db.query("SELECT id,source,language,model,file_name,duration_sec,media_id,created_at,jsonb_array_length(segments) AS segment_count FROM transcripts WHERE meeting_id=$1 ORDER BY created_at DESC", [id]);
    return reply.header("Cache-Control", "no-store").send({ transcripts: rows.rows });
  });

  /** Upload an existing transcript (SRT / VTT / TXT / DOCX). Becomes the current transcript; analysis is queued. */
  app.post("/meetings/:id/transcripts", async (request, reply) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params);
    await requireMeetingEditor(app.db, id, user);
    const upload = await readSmallUpload(request, TRANSCRIPT_MAX);
    if (!upload?.file) throw badRequest("請選擇逐字稿檔案。");
    let parsed;
    try {
      parsed = await parseTranscriptFile(upload.file.name, upload.file.buffer);
    } catch (error) {
      if (error instanceof UnreadableFile) throw badRequest(error.message);
      throw error;
    }
    const analyze = upload.fields.analyze !== "0";
    await transaction(app.db, async client => {
      const meeting = await requireMeeting(client, id, true);
      await client.query(
        `INSERT INTO transcripts(meeting_id,source,language,segments,speakers,warnings,file_name,duration_sec,created_by) VALUES($1,'upload',$2,$3,$4,$5,$6,$7,$8)`,
        [id, meeting.language === "auto" ? null : meeting.language, JSON.stringify(parsed.segments), JSON.stringify(parsed.speakers), JSON.stringify(parsed.warnings), upload.file!.name.slice(0, 300), parsed.durationSec, user.id],
      );
      // Speaker names that match an account map automatically ("林雅婷：…" in the file).
      if (parsed.speakers.length) {
        await client.query(
          `INSERT INTO speaker_map(meeting_id,speaker_label,user_id,updated_by)
           SELECT $1, s.label, u.id, $3 FROM unnest($2::text[]) AS s(label) JOIN users u ON lower(u.name)=lower(s.label) AND u.disabled_at IS NULL
           ON CONFLICT DO NOTHING`,
          [id, parsed.speakers.map(s => s.id), user.id],
        );
      }
      await pickCurrentTranscript(client, id);
      const studies = await client.query("SELECT 1 FROM meeting_studies WHERE meeting_id=$1", [id]);
      if (analyze && studies.rowCount && !(await jobActive(client, meeting.analyze_job_id))) await enqueueAnalyze(client, meeting, user.id);
      await refreshStatus(client, id);
    });
    return reply.code(201).send(await sendDetail(app, id, user));
  });

  /** Live captions collected while recording (fallback transcript until the ASR transcript arrives). */
  app.post("/meetings/:id/transcripts/live", async (request, reply) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params);
    const input = parse(liveTranscriptInput, request.body);
    await transaction(app.db, async client => {
      const meeting = await requireMeetingEditor(client, id, user, true);
      if (input.media_id) {
        const m = await client.query("SELECT 1 FROM meeting_media WHERE id=$1 AND meeting_id=$2", [input.media_id, id]);
        if (!m.rowCount) throw badRequest("錄音不存在。");
      }
      const segments = input.segments
        .map(s => ({ start: s.start, end: Math.max(s.start, s.end), text: s.text, ...(s.speaker ? { speaker: s.speaker } : {}) }))
        .sort((a, b) => a.start - b.start)
        .map((s, i) => ({ id: i, ...s }));
      await client.query(
        "INSERT INTO transcripts(meeting_id,media_id,source,language,segments,duration_sec,created_by) VALUES($1,$2,'live',$3,$4,$5,$6)",
        [id, input.media_id ?? null, meeting.meeting.language, JSON.stringify(segments), segments.at(-1)?.end ?? null, user.id],
      );
      await pickCurrentTranscript(client, id);
      await refreshStatus(client, id);
    });
    return reply.code(201).send(await sendDetail(app, id, user));
  });

  app.put("/meetings/:id/transcript", async (request) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params);
    const { transcript_id } = parse(z.object({ transcript_id: z.uuid() }), request.body);
    await transaction(app.db, async client => {
      await requireMeetingEditor(client, id, user, true);
      const t = await client.query("UPDATE meetings SET transcript_id=$2, updated_at=now() WHERE id=$1 AND EXISTS (SELECT 1 FROM transcripts WHERE id=$2 AND meeting_id=$1)", [id, transcript_id]);
      if (!t.rowCount) throw notFound("逐字稿不存在。");
      await refreshStatus(client, id);
    });
    return sendDetail(app, id, user);
  });

  app.delete("/meetings/:id/transcripts/:transcriptId", async (request) => {
    const user = await requireUser(request);
    const { id, transcriptId } = parse(transcriptParams, request.params);
    const wordsKey = await transaction(app.db, async client => {
      await requireMeetingEditor(client, id, user, true);
      const t = (await client.query<{ words_key: string | null }>("DELETE FROM transcripts WHERE id=$1 AND meeting_id=$2 RETURNING words_key", [transcriptId, id])).rows[0];
      if (!t) throw notFound("逐字稿不存在。");
      await pickCurrentTranscript(client, id);
      await refreshStatus(client, id);
      return t.words_key;
    });
    if (wordsKey) await app.storage.delete(wordsKey).catch(() => {});
    return sendDetail(app, id, user);
  });

  app.get("/meetings/:id/transcripts/:transcriptId/export", async (request, reply) => {
    await requireUser(request);
    const { id, transcriptId } = parse(transcriptParams, request.params);
    const meeting = await requireMeeting(app.db, id);
    const t = (await app.db.query<TranscriptRow>("SELECT * FROM transcripts WHERE id=$1 AND meeting_id=$2", [transcriptId, id])).rows[0];
    if (!t) throw notFound("逐字稿不存在。");
    const map = await speakerMap(app.db, id);
    const names = speakerNames(t.segments, map);
    const pad = (n: number, w = 2) => String(n).padStart(w, "0");
    const srtTime = (s: number) => `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(Math.floor(s % 60))},${pad(Math.round((s % 1) * 1000), 3)}`;
    const body = t.segments.map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${s.speaker ? `${names.get(s.speaker) ?? s.speaker}：` : ""}${s.text}\n`).join("\n");
    const name = `${meeting.title.replace(/[\\/:*?"<>|\r\n]+/g, " ").trim() || "meeting"}.srt`;
    return reply
      .header("Content-Type", "application/x-subrip; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="meeting.srt"; filename*=UTF-8''${encodeURIComponent(name)}`)
      .header("Cache-Control", "no-store")
      .send(body);
  });

  // ---------------------------------------------------------------- speakers

  app.put("/meetings/:id/speakers", async (request) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params);
    const { speakers } = parse(speakersInput, request.body);
    await transaction(app.db, async client => {
      await requireMeetingEditor(client, id, user, true);
      const userIds = speakers.map(s => s.user_id).filter((v): v is string => Boolean(v));
      if (userIds.length) await checkUsers(client, userIds);
      for (const s of speakers) {
        if (!s.user_id && !s.name) {
          await client.query("DELETE FROM speaker_map WHERE meeting_id=$1 AND speaker_label=$2", [id, s.label]);
          continue;
        }
        await client.query(
          `INSERT INTO speaker_map(meeting_id,speaker_label,user_id,name,updated_by) VALUES($1,$2,$3,$4,$5)
           ON CONFLICT (meeting_id,speaker_label) DO UPDATE SET user_id=EXCLUDED.user_id, name=EXCLUDED.name, updated_by=EXCLUDED.updated_by, updated_at=now()`,
          [id, s.label, s.user_id ?? null, s.user_id ? null : (s.name ?? null), user.id],
        );
      }
    });
    return { speaker_map: await speakerMap(app.db, id) };
  });

  // ---------------------------------------------------------------- jobs

  app.post("/meetings/:id/transcribe", async (request, reply) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params);
    const { media_id } = parse(z.object({ media_id: z.uuid().optional() }), request.body ?? {});
    await transaction(app.db, async client => {
      const { meeting } = await requireMeetingEditor(client, id, user, true);
      if (await jobActive(client, meeting.transcribe_job_id)) throw conflict("轉錄已在進行中。");
      const media = (await client.query<{ id: string }>(
        `SELECT id FROM meeting_media WHERE meeting_id=$1 AND status='ready' AND audio_key IS NOT NULL ${media_id ? "AND id=$2" : ""} ORDER BY created_at DESC LIMIT 1`,
        media_id ? [id, media_id] : [id],
      )).rows[0];
      if (!media) throw badRequest("沒有可以轉錄的錄音。");
      await enqueueTranscribe(client, meeting, media.id, user.id);
      await refreshStatus(client, id);
    });
    return reply.code(202).send(await sendDetail(app, id, user));
  });

  app.post("/meetings/:id/analyze", async (request, reply) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params);
    await transaction(app.db, async client => {
      const { meeting } = await requireMeetingEditor(client, id, user, true);
      if (await jobActive(client, meeting.analyze_job_id)) throw conflict("分析已在進行中。");
      const facts = (await client.query<{ studies: number; feedback: number }>(
        "SELECT (SELECT count(*)::int FROM meeting_studies WHERE meeting_id=$1) AS studies,(SELECT count(*)::int FROM meeting_feedback WHERE meeting_id=$1) AS feedback",
        [id],
      )).rows[0]!;
      if (!facts.studies) throw badRequest("請先選擇會議涉及的研究。");
      if (!meeting.transcript_id && !facts.feedback) throw badRequest("還沒有逐字稿或回饋可以分析。");
      await enqueueAnalyze(client, meeting, user.id);
      await refreshStatus(client, id);
    });
    return reply.code(202).send(await sendDetail(app, id, user));
  });

  app.post("/meetings/:id/jobs/:which/cancel", async (request) => {
    const user = await requireUser(request);
    const { id, which } = parse(z.object({ id: z.uuid(), which: z.enum(["transcribe", "analyze"]) }), request.params);
    await transaction(app.db, async client => {
      const { meeting } = await requireMeetingEditor(client, id, user, true);
      const jobId = which === "transcribe" ? meeting.transcribe_job_id : meeting.analyze_job_id;
      if (!jobId || !(await cancelJob(client, jobId))) throw conflict("沒有進行中的工作。");
      await refreshStatus(client, id);
    });
    return sendDetail(app, id, user);
  });

  // ---------------------------------------------------------------- feedback (everyone signed in)

  app.post("/meetings/:id/feedback", async (request, reply) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params);
    await requireMeeting(app.db, id);
    let body = "";
    let file: { name: string; buffer: Buffer } | null = null;
    if (request.isMultipart()) {
      const upload = await readSmallUpload(request, FEEDBACK_FILE_MAX);
      body = (upload?.fields.body_md ?? "").slice(0, 50000);
      file = upload?.file ?? null;
    } else body = parse(feedbackInput, request.body).body_md;
    let fileText: string | null = null;
    if (file) {
      try {
        fileText = await feedbackFileText(file.name, file.buffer);
      } catch (error) {
        if (error instanceof UnreadableFile) throw badRequest(error.message);
        throw error;
      }
    }
    if (!body.trim() && !fileText) throw badRequest("請輸入回饋內容或附上檔案。");
    const feedbackId = (await app.db.query<{ id: string }>(
      "INSERT INTO meeting_feedback(meeting_id,author_id,body_md,file_name,file_text) VALUES($1,$2,$3,$4,$5) RETURNING id",
      [id, user.id, body, file?.name.slice(0, 300) ?? null, fileText],
    )).rows[0]!.id;
    if (file) {
      const key = meetingKeys.feedbackFile(id, feedbackId);
      await app.storage.put(key, file.buffer, "application/octet-stream");
      await app.db.query("UPDATE meeting_feedback SET file_key=$2 WHERE id=$1", [feedbackId, key]);
    }
    return reply.code(201).send(await sendDetail(app, id, user));
  });

  app.patch("/meetings/:id/feedback/:feedbackId", async (request) => {
    const user = await requireUser(request);
    const { id, feedbackId } = parse(feedbackParams, request.params);
    const { body_md } = parse(feedbackInput, request.body);
    const f = (await app.db.query<{ author_id: string | null }>("SELECT author_id FROM meeting_feedback WHERE id=$1 AND meeting_id=$2", [feedbackId, id])).rows[0];
    if (!f) throw notFound("回饋不存在。");
    if (f.author_id !== user.id && !user.is_admin) throw forbidden("只能修改自己的回饋。");
    await app.db.query("UPDATE meeting_feedback SET body_md=$2, updated_at=now() WHERE id=$1", [feedbackId, body_md]);
    return sendDetail(app, id, user);
  });

  app.delete("/meetings/:id/feedback/:feedbackId", async (request) => {
    const user = await requireUser(request);
    const { id, feedbackId } = parse(feedbackParams, request.params);
    const f = (await app.db.query<{ author_id: string | null; file_key: string | null }>("SELECT author_id,file_key FROM meeting_feedback WHERE id=$1 AND meeting_id=$2", [feedbackId, id])).rows[0];
    if (!f) throw notFound("回饋不存在。");
    if (f.author_id !== user.id && !user.is_admin) throw forbidden("只能刪除自己的回饋。");
    await app.db.query("DELETE FROM meeting_feedback WHERE id=$1", [feedbackId]);
    if (f.file_key) await app.storage.delete(f.file_key).catch(() => {});
    return sendDetail(app, id, user);
  });

  app.get("/meetings/:id/feedback/:feedbackId/file", async (request, reply) => {
    await requireUser(request);
    const { id, feedbackId } = parse(feedbackParams, request.params);
    const f = (await app.db.query<{ file_key: string | null; file_name: string | null }>("SELECT file_key,file_name FROM meeting_feedback WHERE id=$1 AND meeting_id=$2", [feedbackId, id])).rows[0];
    if (!f?.file_key) throw notFound("檔案不存在。");
    const object = await app.storage.get(f.file_key);
    if (!object) throw notFound("檔案不存在。");
    const name = f.file_name ?? "feedback";
    return reply
      .header("Content-Type", "application/octet-stream")
      .header("Content-Disposition", `attachment; filename="feedback"; filename*=UTF-8''${encodeURIComponent(name)}`)
      .header("X-Content-Type-Options", "nosniff")
      .header("Cache-Control", "private, no-store")
      .send(object.body);
  });

  // ---------------------------------------------------------------- drafts (members of THAT study)

  app.patch("/meetings/:id/drafts/:draftId", async (request) => {
    const user = await requireUser(request);
    const { id, draftId } = parse(draftParams, request.params);
    const input = parse(draftPatchInput, request.body);
    await transaction(app.db, client => patchDraft(client, id, draftId, user, input));
    return sendDetail(app, id, user);
  });

  app.post("/meetings/:id/drafts/:draftId/confirm", async (request) => {
    const user = await requireUser(request);
    const { id, draftId } = parse(draftParams, request.params);
    const input = parse(confirmInput, request.body ?? {});
    const result = await transaction(app.db, async client => {
      const meeting = await requireMeeting(client, id, true);
      return confirmDraft(client, app.notifier, meeting, draftId, user, input);
    });
    await runAfter(app, result.after);
    return { ...(await sendDetail(app, id, user)), confirmed: { note_id: result.noteId, note_url: result.noteUrl, task_ids: result.taskIds } };
  });

  app.post("/meetings/:id/drafts/:draftId/dismiss", async (request) => {
    const user = await requireUser(request);
    const { id, draftId } = parse(draftParams, request.params);
    await transaction(app.db, client => setDraftStatus(client, id, draftId, user, "dismissed"));
    return sendDetail(app, id, user);
  });

  app.post("/meetings/:id/drafts/:draftId/reopen", async (request) => {
    const user = await requireUser(request);
    const { id, draftId } = parse(draftParams, request.params);
    await transaction(app.db, client => setDraftStatus(client, id, draftId, user, "pending"));
    return sendDetail(app, id, user);
  });

  await app.register(meetingMedia);
  await app.register(meetingLive);
}
