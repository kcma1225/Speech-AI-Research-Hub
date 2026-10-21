/**
 * Study context for 「AI 草擬」 of a note (role `writing`): the study's other recent notes (titles + short excerpts),
 * open tasks, the latest meeting feedback and the study's reading list, so experiment/weekly notes can be filled from
 * what the lab already wrote instead of 「待補」. Bounded: each part has its own cap and the whole block ≤ MAX_CHARS.
 */
import type { Queryable } from "../../db.js";
import { markdownExcerpt } from "../text/excerpt.js";

export const NOTE_CONTEXT_MAX_CHARS = 9000;

export type NoteDraftContextParts = {
  notes: { title: string; date: string | null; kind: string; author: string | null; excerpt: string }[];
  tasks: { title: string; due_on: string | null; assignee: string | null }[];
  feedback: { meeting: string; date: string; text: string }[];
  papers: { cite_key: string; title: string; year: number | null; reading_status: string; notes: string }[];
};

const STATUS_ZH: Record<string, string> = { unread: "未讀", reading: "閱讀中", read: "已讀" };
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

export async function loadNoteDraftContext(db: Queryable, studyId: string, excludeNoteId: string | null): Promise<NoteDraftContextParts> {
  const [notes, tasks, papers] = await Promise.all([
    db.query<{ title: string; date: string | null; kind: string; author: string | null; content_md: string }>(
      `SELECT n.title,to_char(n.event_date,'YYYY-MM-DD') AS date,n.kind,u.name AS author,left(n.content_md, 4000) AS content_md
         FROM notes n LEFT JOIN users u ON u.id=n.created_by
        WHERE n.study_id=$1 AND ($2::uuid IS NULL OR n.id<>$2)
        ORDER BY coalesce(n.event_date, n.created_at::date) DESC, n.created_at DESC LIMIT 6`,
      [studyId, excludeNoteId],
    ),
    db.query<{ title: string; due_on: string | null; assignee: string | null }>(
      `SELECT t.title,to_char(t.due_on,'YYYY-MM-DD') AS due_on,u.name AS assignee FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id
        WHERE t.study_id=$1 AND t.status='open' ORDER BY t.due_on NULLS LAST, t.created_at DESC LIMIT 15`,
      [studyId],
    ),
    db.query<{ cite_key: string; title: string; year: number | null; reading_status: string; notes_md: string }>(
      `SELECT sp.cite_key,p.title,p.year,sp.reading_status,left(sp.notes_md, 1000) AS notes_md FROM study_papers sp JOIN papers p ON p.id=sp.paper_id
        WHERE sp.study_id=$1 ORDER BY sp.updated_at DESC LIMIT 12`,
      [studyId],
    ),
  ]);
  let feedback: NoteDraftContextParts["feedback"] = [];
  try {
    const rows = (await db.query<{ title: string; date: string; direct: string | null; draft: string | null }>(
      `SELECT m.title,to_char(m.held_at AT TIME ZONE 'Asia/Taipei','YYYY-MM-DD') AS date,
              (SELECT string_agg(f.body_md, E'\n' ORDER BY f.created_at) FROM meeting_feedback f WHERE f.meeting_id=m.id) AS direct,
              d.feedback_md AS draft
         FROM meetings m JOIN meeting_studies ms ON ms.meeting_id=m.id
         LEFT JOIN meeting_study_drafts d ON d.meeting_id=m.id AND d.study_id=ms.study_id AND d.status<>'dismissed'
        WHERE ms.study_id=$1 AND m.held_at <= now() ORDER BY m.held_at DESC LIMIT 2`,
      [studyId],
    )).rows;
    feedback = rows
      .map((r) => ({ meeting: r.title, date: r.date, text: clip([r.direct, r.draft].filter((x) => x?.trim()).join("\n").trim(), 1200) }))
      .filter((f) => f.text);
  } catch {
    feedback = []; // meetings module not installed
  }
  return {
    notes: notes.rows.map((n) => ({ title: n.title, date: n.date, kind: n.kind, author: n.author, excerpt: oneLine(markdownExcerpt(n.content_md, 280)) })),
    tasks: tasks.rows,
    feedback,
    papers: papers.rows.map((p) => ({ cite_key: p.cite_key, title: p.title, year: p.year, reading_status: p.reading_status, notes: oneLine(markdownExcerpt(p.notes_md ?? "", 160)) })),
  };
}

/** Plain-text block for the prompt (fenced by the caller); empty string when the study has nothing yet. */
export function formatNoteDraftContext(c: NoteDraftContextParts, max = NOTE_CONTEXT_MAX_CHARS): string {
  const parts: string[] = [];
  if (c.notes.length) parts.push(["### 最近的筆記", ...c.notes.map((n) => `- ${n.date ?? "（無日期）"}「${n.title}」${n.author ? `（${n.author}）` : ""}：${n.excerpt || "（空白）"}`)].join("\n"));
  if (c.tasks.length) parts.push(["### 未完成的待辦", ...c.tasks.map((t) => `- ${t.title}${t.assignee ? `（負責：${t.assignee}）` : ""}${t.due_on ? `（期限 ${t.due_on}）` : ""}`)].join("\n"));
  if (c.feedback.length) parts.push(["### 最近會議的回饋", ...c.feedback.map((f) => `- ${f.date}「${f.meeting}」：${oneLine(f.text)}`)].join("\n"));
  if (c.papers.length) parts.push(["### 研究文獻庫", ...c.papers.map((p) => `- [${p.cite_key}] ${p.title}${p.year ? ` (${p.year})` : ""}，${STATUS_ZH[p.reading_status] ?? p.reading_status}${p.notes ? `；筆記：${p.notes}` : ""}`)].join("\n"));
  return clip(parts.join("\n\n"), max);
}

export async function noteDraftContext(db: Queryable, studyId: string, excludeNoteId: string | null) {
  return formatNoteDraftContext(await loadNoteDraftContext(db, studyId, excludeNoteId));
}
