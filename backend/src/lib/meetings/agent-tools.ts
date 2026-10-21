/**
 * Agent tools of the meetings module (read only): list_meetings, get_meeting, get_transcript_excerpt.
 * Everyone signed in may read every meeting, so they need no extra checks; transcripts, feedback and drafts are other
 * people's words → `untrusted`.
 */
import { z } from "zod";
import { registerAgentTool } from "../../agent/tools/registry.js";
import { notFound } from "../http.js";
import { loadStudyAccess } from "../studies/access.js";
import { parseTime } from "./analysis.js";
import { currentTranscript, findMeeting, listDrafts, listMeetings, meetingDecks, meetingStudies, meetingUrl, speakerMap, speakerNames } from "./store.js";
import { formatClock, taipeiDateTime } from "./time.js";

const meetingArg = z.string().trim().min(1).max(64).describe("Meeting id (uuid), e.g. from list_meetings");
const isUuid = (v: string) => z.uuid().safeParse(v).success;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

async function meetingOr404(db: Parameters<typeof findMeeting>[0], id: string) {
  const meeting = isUuid(id) ? await findMeeting(db, id) : null;
  if (!meeting) throw notFound("會議不存在。");
  return meeting;
}

registerAgentTool({
  name: "list_meetings",
  title: "列出會議",
  titleEn: "List meetings",
  risk: "read",
  description: "List lab meetings (newest first, or soonest first for `when: upcoming`) with id, title, time, status, studies and per-study draft status. Filter by study (id or slug) or by person (`me` or a user id). `past` excludes meetings that started less than an hour ago; for 「上次會議」 prefer the default `all` and take the latest one held before now.",
  input: z.object({
    study: z.string().trim().min(1).max(80).optional().describe("Study id (uuid) or slug"),
    person: z.string().trim().max(40).optional().describe("`me` or a user id: meetings they created or attended"),
    when: z.enum(["upcoming", "past", "all"]).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  summarize: a => (a.study ? `列出研究 ${a.study} 的會議` : "列出會議"),
  async execute(a, ctx) {
    const study = a.study ? (await loadStudyAccess(ctx.db, a.study, ctx.user)).study.id : undefined;
    const person = a.person === "me" ? ctx.user.id : a.person && isUuid(a.person) ? a.person : undefined;
    const meetings = await listMeetings(ctx.db, { study, person, when: a.when ?? "all", limit: a.limit ?? 20 });
    return {
      data: {
        meetings: meetings.map(m => ({
          id: m.id, title: m.title, held_at: taipeiDateTime(m.held_at), status: m.status, has_transcript: m.has_transcript,
          studies: m.studies.map(s => ({ id: s.id, slug: s.slug, title: s.title, owner: s.owner?.name ?? null, draft_status: s.draft_status })),
          participants: m.participants.map(p => p.name), url: meetingUrl(m.id),
        })),
      },
    };
  },
});

registerAgentTool({
  name: "get_meeting",
  title: "讀取會議",
  titleEn: "Read meeting",
  risk: "read",
  description: "Read a meeting: title, time, studies, participants, decks, feedback, the AI drafts per study (summary, feedback, proposed tasks, status) and transcript info (use get_transcript_excerpt for the text).",
  input: z.object({ meeting_id: meetingArg }),
  summarize: a => `讀取會議 ${a.meeting_id}`,
  async execute(a, ctx) {
    const meeting = await meetingOr404(ctx.db, a.meeting_id);
    const [studies, decks, drafts, transcript, map, feedback, participants] = await Promise.all([
      meetingStudies(ctx.db, meeting.id),
      meetingDecks(ctx.db, meeting.id),
      listDrafts(ctx.db, meeting.id),
      currentTranscript(ctx.db, meeting),
      speakerMap(ctx.db, meeting.id),
      ctx.db.query<{ author: string | null; body_md: string; file_name: string | null; file_text: string | null }>(
        "SELECT u.name AS author,f.body_md,f.file_name,f.file_text FROM meeting_feedback f LEFT JOIN users u ON u.id=f.author_id WHERE f.meeting_id=$1 ORDER BY f.created_at",
        [meeting.id],
      ),
      ctx.db.query<{ name: string }>("SELECT u.name FROM meeting_participants mp JOIN users u ON u.id=mp.user_id WHERE mp.meeting_id=$1 ORDER BY lower(u.name)", [meeting.id]),
    ]);
    const names = transcript ? speakerNames(transcript.segments, map) : new Map<string, string>();
    return {
      data: {
        id: meeting.id, title: meeting.title, held_at: taipeiDateTime(meeting.held_at), status: meeting.status, notes: clip(meeting.notes, 2000),
        url: meetingUrl(meeting.id),
        studies: studies.map(s => ({ id: s.id, slug: s.slug, title: s.title, owner: s.members.find(m => m.role === "owner")?.name ?? null })),
        participants: participants.rows.map(p => p.name),
        decks: decks.map(d => ({ id: d.deck_id, title: d.title, version: d.version })),
        feedback: feedback.rows.map(f => ({ author: f.author, text: clip([f.body_md, f.file_text].filter(Boolean).join("\n\n"), 3000), file: f.file_name })),
        drafts: drafts.map(d => ({
          study: d.study_title, study_id: d.study_id, status: d.status, summary_md: clip(d.summary_md, 3000), feedback_md: clip(d.feedback_md, 3000),
          tasks: d.proposed_tasks.map(t => ({ title: t.title, due: t.due })), note_id: d.note_id,
        })),
        other_md: meeting.analysis?.other_md ?? "",
        transcript: transcript
          ? { source: transcript.source, segments: transcript.segments.length, duration: formatClock(transcript.duration_sec ?? transcript.segments.at(-1)?.end ?? 0), speakers: [...names.values()] }
          : null,
      },
      untrusted: true,
      source: `會議〈${meeting.title}〉`,
      links: [{ label: meeting.title, url: meetingUrl(meeting.id), kind: "meeting" as const }],
    };
  },
});

registerAgentTool({
  name: "get_transcript_excerpt",
  title: "讀取逐字稿片段",
  titleEn: "Read transcript excerpt",
  risk: "read",
  description: "Read part of a meeting's transcript as `[mm:ss] speaker：text` lines. Give a time range (`from`/`to` as mm:ss or seconds) and/or a keyword `q` (lines containing it plus one line of context). Output is limited to about `max_chars` characters (default 4000, max 12000).",
  input: z.object({
    meeting_id: meetingArg,
    from: z.string().trim().max(12).optional(),
    to: z.string().trim().max(12).optional(),
    q: z.string().trim().max(100).optional(),
    max_chars: z.number().int().min(200).max(12000).optional(),
  }),
  summarize: a => (a.q ? `在會議逐字稿中找「${a.q}」` : `讀取會議逐字稿${a.from ? `（${a.from} 起）` : ""}`),
  async execute(a, ctx) {
    const meeting = await meetingOr404(ctx.db, a.meeting_id);
    const transcript = await currentTranscript(ctx.db, meeting);
    if (!transcript) return { data: { meeting: meeting.title, lines: [], note: "這場會議還沒有逐字稿。" } };
    const names = speakerNames(transcript.segments, await speakerMap(ctx.db, meeting.id));
    const from = a.from ? parseTime(a.from) : 0;
    const to = a.to ? parseTime(a.to) : Infinity;
    let segs = transcript.segments.filter(s => s.end >= (Number.isFinite(from) ? from : 0) && s.start <= (Number.isFinite(to) ? to : Infinity));
    if (a.q) {
      const needle = a.q.toLowerCase();
      const keep = new Set<number>();
      segs.forEach((s, i) => {
        if (s.text.toLowerCase().includes(needle)) for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < segs.length) keep.add(j);
      });
      segs = segs.filter((_, i) => keep.has(i));
    }
    const max = a.max_chars ?? 4000;
    const lines: string[] = [];
    let size = 0;
    for (const s of segs) {
      const line = `[${formatClock(s.start)}] ${s.speaker ? `${names.get(s.speaker) ?? s.speaker}：` : ""}${s.text}`;
      if (size + line.length > max) break;
      lines.push(line);
      size += line.length + 1;
    }
    return {
      data: { meeting: meeting.title, url: meetingUrl(meeting.id), source: transcript.source, lines, truncated: lines.length < segs.length, total_segments: transcript.segments.length },
      text: `會議〈${meeting.title}〉逐字稿${lines.length < segs.length ? "（已截斷）" : ""}：\n${lines.join("\n")}`,
      untrusted: true,
      source: `會議〈${meeting.title}〉的逐字稿`,
    };
  },
});
