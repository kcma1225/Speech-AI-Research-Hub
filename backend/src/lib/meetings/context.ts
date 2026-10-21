/**
 * Data gathered for the AI jobs: the ASR glossary (keyterms) and the analysis input, plus writing analysis results.
 */
import type { Queryable } from "../../db.js";
import type { AnalysisInput, AnalysisResult } from "./analysis.js";
import { taipeiDateTime } from "./time.js";
import { withTaskIds } from "./drafts.js";
import { currentTranscript, meetingDecks, meetingStudies, refreshStatus, speakerMap, speakerNames, type MeetingRow } from "./store.js";

/**
 * Keyterms for ASR: study titles, participant and member names, deck titles and the studies' paper titles (≤ 60,
 * each ≤ 60 chars, de-duplicated). Spec §8: zh-TW hint + glossary.
 */
export async function meetingGlossary(db: Queryable, meetingId: string): Promise<string[]> {
  const r = await db.query<{ term: string }>(
    `SELECT term FROM (
       SELECT s.title AS term, 1 AS p FROM meeting_studies ms JOIN studies s ON s.id=ms.study_id WHERE ms.meeting_id=$1
       UNION ALL SELECT u.name, 2 FROM meeting_participants mp JOIN users u ON u.id=mp.user_id WHERE mp.meeting_id=$1
       UNION ALL SELECT u.name, 3 FROM meeting_studies ms JOIN study_members sm ON sm.study_id=ms.study_id JOIN users u ON u.id=sm.user_id WHERE ms.meeting_id=$1
       UNION ALL SELECT d.title, 4 FROM meeting_decks md JOIN decks d ON d.id=md.deck_id WHERE md.meeting_id=$1
       UNION ALL SELECT * FROM (SELECT p.title, 5 FROM meeting_studies ms JOIN study_papers sp ON sp.study_id=ms.study_id JOIN papers p ON p.id=sp.paper_id
                                 WHERE ms.meeting_id=$1 ORDER BY sp.created_at DESC LIMIT 30) papers
     ) t ORDER BY p`,
    [meetingId],
  ).catch(async () =>
    // The library tables may be missing in a partial deployment; fall back to the core terms.
    db.query<{ term: string }>(
      `SELECT s.title AS term FROM meeting_studies ms JOIN studies s ON s.id=ms.study_id WHERE ms.meeting_id=$1
       UNION ALL SELECT u.name FROM meeting_participants mp JOIN users u ON u.id=mp.user_id WHERE mp.meeting_id=$1`,
      [meetingId],
    ),
  );
  const out: string[] = [];
  for (const { term } of r.rows) {
    const t = term?.trim().slice(0, 60);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= 60) break;
  }
  return out;
}

export async function loadAnalysisInput(db: Queryable, meeting: MeetingRow): Promise<AnalysisInput> {
  const [studies, decks, transcript, map, participants, feedback] = await Promise.all([
    meetingStudies(db, meeting.id),
    meetingDecks(db, meeting.id),
    currentTranscript(db, meeting),
    speakerMap(db, meeting.id),
    db.query<{ id: string; name: string }>("SELECT u.id,u.name FROM meeting_participants mp JOIN users u ON u.id=mp.user_id WHERE mp.meeting_id=$1 ORDER BY lower(u.name)", [meeting.id]),
    db.query<{ author: string | null; body_md: string; file_text: string | null }>(
      "SELECT u.name AS author,f.body_md,f.file_text FROM meeting_feedback f LEFT JOIN users u ON u.id=f.author_id WHERE f.meeting_id=$1 ORDER BY f.created_at",
      [meeting.id],
    ),
  ]);
  const segments = transcript?.segments ?? [];
  const names = speakerNames(segments, map);
  const mapped = new Map(map.map(e => [e.speaker_label, e.user_name ?? e.name]));
  return {
    title: meeting.title,
    heldAt: taipeiDateTime(meeting.held_at),
    notes: meeting.notes,
    language: meeting.language,
    studies: studies.map(s => ({
      id: s.id,
      title: s.title,
      owner: s.members.find(m => m.role === "owner")?.name ?? null,
      summary: s.summary_md,
      stage: s.current_stage,
      members: s.members.map(m => ({ id: m.id, name: m.name, role: m.role })),
      decks: decks.filter(d => d.study_id === s.id).map(d => (d.version ? `${d.title} v${d.version}` : d.title)),
    })),
    participants: participants.rows,
    segments,
    // Only mapped names are given to the model; unmapped speakers stay anonymous (#n) so it can guess.
    speakerNames: new Map([...names.keys()].map(label => [label, mapped.get(label) ?? null])),
    feedback: feedback.rows
      .map(f => ({ author: f.author ?? "（已刪除的帳號）", text: [f.body_md, f.file_text].filter(Boolean).join("\n\n").trim() }))
      .filter(f => f.text),
  };
}

/**
 * Writes the analysis: pending drafts written by AI are replaced, drafts a member edited, confirmed or dismissed stay.
 */
export async function saveAnalysis(client: Queryable, meetingId: string, result: AnalysisResult, meta: { model: string | null; chunks: number }) {
  for (const d of result.drafts) {
    const tasks = JSON.stringify(withTaskIds(d.tasks.map(t => ({ ...t }))));
    await client.query(
      `INSERT INTO meeting_study_drafts(meeting_id,study_id,summary_md,feedback_md,proposed_tasks,evidence)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT (meeting_id,study_id) DO UPDATE SET summary_md=EXCLUDED.summary_md, feedback_md=EXCLUDED.feedback_md,
         proposed_tasks=EXCLUDED.proposed_tasks, evidence=EXCLUDED.evidence, updated_at=now()
       WHERE meeting_study_drafts.status='pending' AND meeting_study_drafts.origin='ai'`,
      [meetingId, d.studyId, d.summary_md, d.feedback_md, tasks, JSON.stringify(d.evidence)],
    );
  }
  const analysis = {
    other_md: result.other_md,
    other_evidence: result.other_evidence,
    speaker_guesses: result.speaker_guesses,
    model: meta.model,
    analyzed_at: new Date().toISOString(),
    chunks: meta.chunks,
    warnings: result.warnings.slice(0, 50),
  };
  await client.query("UPDATE meetings SET analysis=$2, analysis_error=NULL, updated_at=now() WHERE id=$1", [meetingId, JSON.stringify(analysis)]);
}

export { refreshStatus };
