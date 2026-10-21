/**
 * Meetings domain: queries, permissions and the derived status. docs/architecture.md "Meetings".
 * Everyone signed in reads every meeting. Editing the meeting (details, media, transcript, speakers, analysis) is for its
 * creator, its participants, owners/members of an included study, and admins. Feedback is open to everyone. Study drafts
 * are edited/confirmed only by owners/members of THAT study (advisors and other professors cannot confirm).
 */
import type { Queryable } from "../../db.js";
import type { CurrentUser } from "../auth.js";
import { badRequest, forbidden, notFound } from "../http.js";

export type MeetingStatus = "draft" | "recorded" | "processing" | "transcribed" | "analyzing" | "review" | "done";
export const MEETING_MISSING = "會議不存在。";

export type MeetingRow = {
  id: string;
  title: string;
  held_at: string;
  status: MeetingStatus;
  notes: string;
  language: string;
  transcript_id: string | null;
  analysis: MeetingAnalysis | null;
  analysis_error: string | null;
  transcribe_job_id: string | null;
  analyze_job_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type Evidence = { start: number; end: number; quote: string };
export type SpeakerGuess = { label: string; user_id: string | null; name: string | null; reason: string };
export type MeetingAnalysis = {
  other_md: string;
  other_evidence: Evidence[];
  speaker_guesses: SpeakerGuess[];
  model: string | null;
  analyzed_at: string;
  chunks: number;
};

export type ProposedTask = { id: string; title: string; detail: string; assignee_id: string | null; due: string | null };

export async function findMeeting(db: Queryable, id: string, forUpdate = false): Promise<MeetingRow | null> {
  const r = await db.query<MeetingRow>(`SELECT * FROM meetings WHERE id=$1${forUpdate ? " FOR UPDATE" : ""}`, [id]);
  return r.rows[0] ?? null;
}

export async function requireMeeting(db: Queryable, id: string, forUpdate = false) {
  const m = await findMeeting(db, id, forUpdate);
  if (!m) throw notFound(MEETING_MISSING);
  return m;
}

/** Study ids of the meeting where `user` is owner/member (may edit/confirm that study's draft). */
export async function editableStudyIds(db: Queryable, meetingId: string, userId: string): Promise<Set<string>> {
  const r = await db.query<{ study_id: string }>(
    `SELECT ms.study_id FROM meeting_studies ms JOIN study_members sm ON sm.study_id=ms.study_id
      WHERE ms.meeting_id=$1 AND sm.user_id=$2 AND sm.role IN ('owner','member')`,
    [meetingId, userId],
  );
  return new Set(r.rows.map(row => row.study_id));
}

export type MeetingPermissions = { edit: boolean; delete: boolean; feedback: boolean; studies: string[] };

export async function meetingPermissions(db: Queryable, meeting: MeetingRow, user: CurrentUser): Promise<MeetingPermissions> {
  const studies = await editableStudyIds(db, meeting.id, user.id);
  const participant = (await db.query("SELECT 1 FROM meeting_participants WHERE meeting_id=$1 AND user_id=$2", [meeting.id, user.id])).rowCount;
  const creator = meeting.created_by === user.id;
  return {
    edit: user.is_admin || creator || Boolean(participant) || studies.size > 0,
    delete: user.is_admin || creator,
    feedback: true,
    studies: [...studies],
  };
}

export async function requireMeetingEditor(db: Queryable, meetingId: string, user: CurrentUser, forUpdate = false) {
  const meeting = await requireMeeting(db, meetingId, forUpdate);
  const permissions = await meetingPermissions(db, meeting, user);
  if (!permissions.edit) throw forbidden("只有會議建立者、參與者或相關研究的成員可以修改會議。");
  return { meeting, permissions };
}

// ---------------------------------------------------------------- validation of related ids

/** Enabled users only; returns the ids in input order without duplicates. */
export async function checkUsers(db: Queryable, ids: string[]) {
  const unique = [...new Set(ids)];
  if (!unique.length) return unique;
  const r = await db.query<{ id: string }>("SELECT id FROM users WHERE id = ANY($1) AND disabled_at IS NULL AND role <> 'admin'", [unique]);
  if (r.rowCount !== unique.length) throw badRequest("參與者必須是啟用中的學生或教授帳號。");
  return unique;
}

/** Existing studies (id or slug) → ids in input order. */
export async function checkStudies(db: Queryable, refs: string[]) {
  const unique = [...new Set(refs)];
  if (!unique.length) return unique;
  const r = await db.query<{ id: string; slug: string }>("SELECT id,slug FROM studies WHERE id::text = ANY($1) OR slug = ANY($1)", [unique]);
  const byRef = new Map<string, string>();
  for (const row of r.rows) {
    byRef.set(row.id, row.id);
    byRef.set(row.slug, row.id);
  }
  const ids = unique.map(ref => byRef.get(ref));
  if (ids.some(id => !id)) throw badRequest("找不到選擇的研究。");
  return [...new Set(ids as string[])];
}

/** Decks must belong to one of `studyIds`; a version must be a published/review version of that deck. */
export async function checkDecks(db: Queryable, decks: { deckId: string; versionId?: string | null }[], studyIds: string[]) {
  const out: { deckId: string; versionId: string | null }[] = [];
  const seen = new Set<string>();
  for (const d of decks) {
    if (seen.has(d.deckId)) continue;
    seen.add(d.deckId);
    const deck = (await db.query<{ study_id: string }>("SELECT study_id FROM decks WHERE id=$1", [d.deckId])).rows[0];
    if (!deck || !studyIds.includes(deck.study_id)) throw badRequest("簡報必須屬於會議選擇的研究。");
    if (d.versionId) {
      const v = await db.query("SELECT 1 FROM slide_versions WHERE id=$1 AND deck_id=$2 AND status IN ('published','review')", [d.versionId, d.deckId]);
      if (!v.rowCount) throw badRequest("找不到選擇的簡報版本。");
    }
    out.push({ deckId: d.deckId, versionId: d.versionId ?? null });
  }
  return out;
}

export async function setParticipants(db: Queryable, meetingId: string, userIds: string[]) {
  await db.query("DELETE FROM meeting_participants WHERE meeting_id=$1 AND NOT (user_id = ANY($2))", [meetingId, userIds]);
  if (userIds.length) await db.query("INSERT INTO meeting_participants(meeting_id,user_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING", [meetingId, userIds]);
}

/** Replaces the study list; drafts of removed studies are deleted unless confirmed. */
export async function setStudies(db: Queryable, meetingId: string, studyIds: string[]) {
  await db.query("DELETE FROM meeting_studies WHERE meeting_id=$1 AND NOT (study_id = ANY($2))", [meetingId, studyIds]);
  await db.query("DELETE FROM meeting_study_drafts WHERE meeting_id=$1 AND NOT (study_id = ANY($2)) AND status<>'confirmed'", [meetingId, studyIds]);
  for (const [i, id] of studyIds.entries()) {
    await db.query("INSERT INTO meeting_studies(meeting_id,study_id,position) VALUES($1,$2,$3) ON CONFLICT (meeting_id,study_id) DO UPDATE SET position=EXCLUDED.position", [meetingId, id, i]);
  }
  // Decks of removed studies go too.
  await db.query("DELETE FROM meeting_decks md USING decks d WHERE md.meeting_id=$1 AND d.id=md.deck_id AND NOT (d.study_id = ANY($2))", [meetingId, studyIds]);
}

export async function setDecks(db: Queryable, meetingId: string, decks: { deckId: string; versionId: string | null }[]) {
  await db.query("DELETE FROM meeting_decks WHERE meeting_id=$1", [meetingId]);
  for (const [i, d] of decks.entries()) {
    await db.query("INSERT INTO meeting_decks(meeting_id,deck_id,version_id,position) VALUES($1,$2,$3,$4)", [meetingId, d.deckId, d.versionId, i]);
  }
}

// ---------------------------------------------------------------- status

const ACTIVE = "('queued','running')";

/**
 * Derives the meeting status from its facts (drafts, jobs, transcript, media) and stores it. Call after every change,
 * inside the change's transaction.
 */
export async function refreshStatus(db: Queryable, meetingId: string, opts: { finishingJobId?: string } = {}): Promise<MeetingStatus> {
  const r = await db.query<{ drafts: number; open_drafts: number; analyzing: boolean; transcribing: boolean; has_transcript: boolean; media: number }>(
    `SELECT
       (SELECT count(*)::int FROM meeting_study_drafts WHERE meeting_id=m.id) AS drafts,
       (SELECT count(*)::int FROM meeting_study_drafts WHERE meeting_id=m.id AND status='pending') AS open_drafts,
       EXISTS (SELECT 1 FROM jobs j WHERE j.id=m.analyze_job_id AND j.status IN ${ACTIVE} AND j.id IS DISTINCT FROM $2::uuid) AS analyzing,
       EXISTS (SELECT 1 FROM jobs j WHERE j.id=m.transcribe_job_id AND j.status IN ${ACTIVE} AND j.id IS DISTINCT FROM $2::uuid)
         OR EXISTS (SELECT 1 FROM meeting_media mm WHERE mm.meeting_id=m.id AND mm.status='processing') AS transcribing,
       m.transcript_id IS NOT NULL AS has_transcript,
       (SELECT count(*)::int FROM meeting_media WHERE meeting_id=m.id AND status<>'failed') AS media
     FROM meetings m WHERE m.id=$1`,
    [meetingId, opts.finishingJobId ?? null],
  );
  const f = r.rows[0];
  if (!f) return "draft";
  let status: MeetingStatus;
  if (f.analyzing) status = "analyzing";
  else if (f.drafts > 0) status = f.open_drafts > 0 ? "review" : "done";
  else if (f.transcribing && !f.has_transcript) status = "processing";
  else if (f.has_transcript) status = "transcribed";
  else if (f.media > 0) status = "recorded";
  else status = "draft";
  await db.query("UPDATE meetings SET status=$2, updated_at=now() WHERE id=$1 AND status IS DISTINCT FROM $2", [meetingId, status]);
  return status;
}

// ---------------------------------------------------------------- list

export type MeetingListFilter = { study?: string; person?: string; when?: "upcoming" | "past" | "all"; q?: string; limit?: number; status?: MeetingStatus };

const likeEscape = (value: string) => value.replace(/[\\%_]/g, c => `\\${c}`);

/** Card columns: studies (with owner name), participants, draft counts. */
const CARD_SELECT = `SELECT m.id,m.title,m.held_at,m.status,m.created_by,cu.name AS creator_name,m.created_at,m.updated_at,
    (m.transcript_id IS NOT NULL) AS has_transcript,
    (SELECT max(duration_sec) FROM meeting_media mm WHERE mm.meeting_id=m.id AND mm.status='ready') AS duration_sec,
    (SELECT count(*)::int FROM meeting_media mm WHERE mm.meeting_id=m.id AND mm.status<>'failed') AS media_count,
    COALESCE((SELECT json_agg(json_build_object('id',s.id,'slug',s.slug,'title',s.title,
        'owner', (SELECT json_build_object('id',ou.id,'name',ou.name) FROM study_members om JOIN users ou ON ou.id=om.user_id WHERE om.study_id=s.id AND om.role='owner' LIMIT 1),
        'draft_status', (SELECT d.status FROM meeting_study_drafts d WHERE d.meeting_id=m.id AND d.study_id=s.id))
        ORDER BY ms.position) FROM meeting_studies ms JOIN studies s ON s.id=ms.study_id WHERE ms.meeting_id=m.id), '[]') AS studies,
    COALESCE((SELECT json_agg(json_build_object('id',u.id,'name',u.name,'role',u.role) ORDER BY lower(u.name))
        FROM meeting_participants mp JOIN users u ON u.id=mp.user_id WHERE mp.meeting_id=m.id), '[]') AS participants,
    (SELECT json_build_object(
        'pending', count(*) FILTER (WHERE d.status='pending'),
        'confirmed', count(*) FILTER (WHERE d.status='confirmed'),
        'dismissed', count(*) FILTER (WHERE d.status='dismissed'))
       FROM meeting_study_drafts d WHERE d.meeting_id=m.id) AS drafts
  FROM meetings m LEFT JOIN users cu ON cu.id=m.created_by`;

export type MeetingCard = {
  id: string; title: string; held_at: string; status: MeetingStatus; created_by: string | null; creator_name: string | null;
  created_at: string; updated_at: string; has_transcript: boolean; duration_sec: number | null; media_count: number;
  studies: { id: string; slug: string; title: string; owner: { id: string; name: string } | null; draft_status: "pending" | "confirmed" | "dismissed" | null }[];
  participants: { id: string; name: string; role: string }[];
  drafts: { pending: number; confirmed: number; dismissed: number };
};

export async function listMeetings(db: Queryable, filter: MeetingListFilter): Promise<MeetingCard[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replaceAll("?", `$${params.length}`));
  };
  if (filter.study) add("EXISTS (SELECT 1 FROM meeting_studies x WHERE x.meeting_id=m.id AND x.study_id=?)", filter.study);
  if (filter.person) add("(m.created_by=? OR EXISTS (SELECT 1 FROM meeting_participants x WHERE x.meeting_id=m.id AND x.user_id=?))", filter.person);
  if (filter.status) add("m.status=?", filter.status);
  if (filter.q) add("m.title ILIKE ? ESCAPE '\\'", `%${likeEscape(filter.q)}%`);
  // Upcoming = later than an hour ago (a meeting that just started is still "upcoming/now").
  if (filter.when === "upcoming") where.push("m.held_at >= now() - interval '1 hour'");
  if (filter.when === "past") where.push("m.held_at < now() - interval '1 hour'");
  params.push(Math.min(filter.limit ?? 100, 300));
  const order = filter.when === "upcoming" ? "m.held_at ASC" : "m.held_at DESC";
  const r = await db.query<MeetingCard>(
    `${CARD_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${order} LIMIT $${params.length}`,
    params,
  );
  return r.rows.map(row => ({ ...row, drafts: row.drafts ?? { pending: 0, confirmed: 0, dismissed: 0 } }));
}

export async function meetingCard(db: Queryable, id: string): Promise<MeetingCard | null> {
  const r = await db.query<MeetingCard>(`${CARD_SELECT} WHERE m.id=$1`, [id]);
  return r.rows[0] ?? null;
}

// ---------------------------------------------------------------- detail parts

export type MediaRow = {
  id: string; meeting_id: string; kind: "recording" | "upload"; status: "recording" | "processing" | "ready" | "failed";
  file_name: string; mime: string; bytes: string; parts: Record<string, number>; has_video: boolean; video_key: string | null;
  audio_key: string | null; duration_sec: number | null; peaks: number[] | null; job_id: string | null; error: string | null;
  created_by: string | null; created_at: string; updated_at: string;
};

export const mediaView = (m: MediaRow) => ({
  id: m.id, kind: m.kind, status: m.status, file_name: m.file_name, mime: m.mime, bytes: Number(m.bytes), has_video: m.has_video,
  has_audio: Boolean(m.audio_key), video: Boolean(m.video_key), duration_sec: m.duration_sec, peaks: m.peaks, error: m.error,
  parts: Object.keys(m.parts ?? {}).length, created_by: m.created_by, created_at: m.created_at,
  audio_url: m.audio_key && m.status === "ready" ? `/api/meetings/${m.meeting_id}/media/${m.id}/audio` : null,
  video_url: m.video_key && m.status === "ready" ? `/api/meetings/${m.meeting_id}/media/${m.id}/video` : null,
});

export type Segment = { id: number; start: number; end: number; text: string; speaker?: string | null };
export type TranscriptRow = {
  id: string; meeting_id: string; media_id: string | null; source: "asr" | "upload" | "live"; language: string | null;
  segments: Segment[]; speakers: { id: string; label: string | null }[]; words_key: string | null; warnings: string[];
  model: string | null; file_name: string | null; duration_sec: number | null; created_by: string | null; created_at: string;
};

export async function currentTranscript(db: Queryable, meeting: Pick<MeetingRow, "id" | "transcript_id">): Promise<TranscriptRow | null> {
  if (!meeting.transcript_id) return null;
  return (await db.query<TranscriptRow>("SELECT * FROM transcripts WHERE id=$1", [meeting.transcript_id])).rows[0] ?? null;
}

/** Picks the transcript to show: newest asr/upload, else newest live. */
export async function pickCurrentTranscript(db: Queryable, meetingId: string) {
  const r = await db.query<{ id: string }>(
    "SELECT id FROM transcripts WHERE meeting_id=$1 ORDER BY (source='live'), created_at DESC LIMIT 1",
    [meetingId],
  );
  const id = r.rows[0]?.id ?? null;
  await db.query("UPDATE meetings SET transcript_id=$2, updated_at=now() WHERE id=$1", [meetingId, id]);
  return id;
}

/**
 * A finished ASR transcript becomes current unless the user uploaded the current one (their upload wins; the ASR
 * transcript stays in the list as an alternative to switch to). Returns whether it became current.
 */
export async function adoptAsrTranscript(db: Queryable, meetingId: string, transcriptId: string): Promise<boolean> {
  const r = await db.query(
    `UPDATE meetings m SET transcript_id=$2, updated_at=now()
      WHERE m.id=$1 AND NOT EXISTS (SELECT 1 FROM transcripts t WHERE t.id=m.transcript_id AND t.source='upload')`,
    [meetingId, transcriptId],
  );
  return Boolean(r.rowCount);
}

/** True when the meeting already has an analysis or any study draft (auto-analysis must not overwrite them). */
export async function hasAnalysisOrDrafts(db: Queryable, meetingId: string): Promise<boolean> {
  const r = await db.query<{ v: boolean }>(
    "SELECT (m.analysis IS NOT NULL OR EXISTS (SELECT 1 FROM meeting_study_drafts d WHERE d.meeting_id=m.id)) AS v FROM meetings m WHERE m.id=$1",
    [meetingId],
  );
  return Boolean(r.rows[0]?.v);
}

export type SpeakerMapEntry = { speaker_label: string; user_id: string | null; name: string | null; user_name: string | null };
export async function speakerMap(db: Queryable, meetingId: string): Promise<SpeakerMapEntry[]> {
  return (await db.query<SpeakerMapEntry>(
    "SELECT sm.speaker_label,sm.user_id,sm.name,u.name AS user_name FROM speaker_map sm LEFT JOIN users u ON u.id=sm.user_id WHERE sm.meeting_id=$1 ORDER BY sm.speaker_label",
    [meetingId],
  )).rows;
}

/** Display name per speaker label ("語者 1" when unmapped; numbering follows order of first appearance). */
export function speakerNames(segments: Segment[], map: SpeakerMapEntry[]): Map<string, string> {
  const byLabel = new Map(map.map(e => [e.speaker_label, e.user_name ?? e.name ?? null]));
  const names = new Map<string, string>();
  let n = 0;
  for (const s of segments) {
    if (!s.speaker || names.has(s.speaker)) continue;
    n++;
    names.set(s.speaker, byLabel.get(s.speaker) ?? `語者 ${n}`);
  }
  return names;
}

export type DraftRow = {
  id: string; meeting_id: string; study_id: string; summary_md: string; feedback_md: string; proposed_tasks: ProposedTask[];
  evidence: Evidence[]; status: "pending" | "confirmed" | "dismissed"; origin: "ai" | "edited"; edited_by: string | null;
  confirmed_by: string | null; confirmed_at: string | null; note_id: string | null; task_ids: string[]; created_at: string; updated_at: string;
};

export async function listDrafts(db: Queryable, meetingId: string) {
  return (await db.query<DraftRow & { study_slug: string; study_title: string; confirmed_by_name: string | null; edited_by_name: string | null }>(
    `SELECT d.*,s.slug AS study_slug,s.title AS study_title,cu.name AS confirmed_by_name,eu.name AS edited_by_name
       FROM meeting_study_drafts d JOIN studies s ON s.id=d.study_id
       JOIN meeting_studies ms ON ms.meeting_id=d.meeting_id AND ms.study_id=d.study_id
       LEFT JOIN users cu ON cu.id=d.confirmed_by LEFT JOIN users eu ON eu.id=d.edited_by
      WHERE d.meeting_id=$1 ORDER BY ms.position`,
    [meetingId],
  )).rows;
}

export type JobInfo = { id: string; status: string; stage: string; progress: number; error: string | null; run_after: string; attempts: number } | null;
export async function jobInfo(db: Queryable, jobId: string | null): Promise<JobInfo> {
  if (!jobId) return null;
  return (await db.query<NonNullable<JobInfo>>("SELECT id,status,stage,progress,error,run_after,attempts FROM jobs WHERE id=$1", [jobId])).rows[0] ?? null;
}

/** Studies of a meeting with members (for permissions, prompts and the assignee pickers). */
export async function meetingStudies(db: Queryable, meetingId: string) {
  return (await db.query<{
    id: string; slug: string; title: string; summary_md: string; status: string; current_stage: string | null;
    members: { id: string; name: string; role: string; account_role: string }[];
  }>(
    `SELECT s.id,s.slug,s.title,s.summary_md,s.status,st.name AS current_stage,
       COALESCE((SELECT json_agg(json_build_object('id',u.id,'name',u.name,'role',sm.role,'account_role',u.role)
           ORDER BY CASE sm.role WHEN 'owner' THEN 0 WHEN 'member' THEN 1 ELSE 2 END, lower(u.name))
         FROM study_members sm JOIN users u ON u.id=sm.user_id WHERE sm.study_id=s.id), '[]') AS members
       FROM meeting_studies ms JOIN studies s ON s.id=ms.study_id LEFT JOIN study_stages st ON st.id=s.current_stage_id
      WHERE ms.meeting_id=$1 ORDER BY ms.position`,
    [meetingId],
  )).rows;
}

export async function meetingDecks(db: Queryable, meetingId: string) {
  return (await db.query<{ deck_id: string; title: string; slug: string; kind: string; study_id: string; version_id: string | null; version: number | null }>(
    `SELECT md.deck_id,d.title,d.slug,d.kind,d.study_id,md.version_id,v.version
       FROM meeting_decks md JOIN decks d ON d.id=md.deck_id LEFT JOIN slide_versions v ON v.id=md.version_id
      WHERE md.meeting_id=$1 ORDER BY md.position`,
    [meetingId],
  )).rows;
}

export const meetingUrl = (id: string, query = "") => `/meetings/${id}${query}`;
