import type { Queryable } from "../../db.js";
import { markdownExcerpt } from "../text/excerpt.js";
import type { StudyMemberRole, StudyStatus } from "./access.js";

export type StudyMember = { id: string; name: string; account_role: "student" | "professor" | "admin"; role: StudyMemberRole; disabled: boolean; added_at: string };
export type StudyStage = { id: string; position: number; name: string; description: string; started_at: string | null; completed_at: string | null; is_current: boolean };
export type Milestone = { id: string; stage_id: string | null; title: string; due_on: string | null; done_at: string | null; done_by: string | null; created_at: string; updated_at: string };

/** Members, owner first, then members, then advisors (by join time). */
export async function listMembers(db: Queryable, studyId: string): Promise<StudyMember[]> {
  return (await db.query<StudyMember>(
    `SELECT m.user_id AS id,u.name,u.role AS account_role,m.role,(u.disabled_at IS NOT NULL) AS disabled,m.added_at
       FROM study_members m JOIN users u ON u.id=m.user_id WHERE m.study_id=$1
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'member' THEN 1 ELSE 2 END, m.added_at, lower(u.name)`,
    [studyId],
  )).rows;
}

export async function listStages(db: Queryable, studyId: string): Promise<StudyStage[]> {
  return (await db.query<StudyStage>(
    `SELECT g.id,g.position,g.name,g.description,g.started_at,g.completed_at,(s.current_stage_id=g.id) AS is_current
       FROM study_stages g JOIN studies s ON s.id=g.study_id WHERE g.study_id=$1 ORDER BY g.position`,
    [studyId],
  )).rows;
}

export const MILESTONE_SELECT = `SELECT m.id,m.stage_id,m.title,to_char(m.due_on,'YYYY-MM-DD') AS due_on,m.done_at,m.done_by,m.created_at,m.updated_at FROM milestones m`;

/** Open milestones by due date (undated last), then done ones. */
export async function listMilestones(db: Queryable, studyId: string): Promise<Milestone[]> {
  return (await db.query<Milestone>(
    `${MILESTONE_SELECT} WHERE m.study_id=$1 ORDER BY (m.done_at IS NOT NULL), m.due_on NULLS LAST, m.created_at`,
    [studyId],
  )).rows;
}

export type StudyCardFilter = {
  /** Only studies this user belongs to (any member role). */
  memberId?: string | null;
  /** `null` = every status except archived; `"all"` = everything. */
  status?: StudyStatus | "all" | null;
  /** Current stage name (exact). */
  stage?: string | null;
  /** Title / summary / slug substring. */
  q?: string | null;
  ids?: string[] | null;
  limit?: number;
};

type CardRow = {
  id: string; slug: string; title: string; status: StudyStatus; summary_md: string;
  created_at: string; updated_at: string; activity_at: string;
  current_stage: { id: string; name: string; position: number } | null;
  stage_count: number; stages_done: number;
  members: { id: string; name: string; role: StudyMemberRole; account_role: "student" | "professor" | "admin" }[];
  next_milestone: { id: string; title: string; due_on: string | null } | null;
  open_task_count: number;
  my_role: StudyMemberRole | null;
};

const escapeLike = (value: string) => value.replace(/[\\%_]/g, match => `\\${match}`);

/** Study cards for lists and the dashboard (newest activity first). `viewerId` fills `my_role`. */
export async function studyCards(db: Queryable, viewerId: string, filter: StudyCardFilter = {}) {
  const q = filter.q?.trim() ? `%${escapeLike(filter.q.trim())}%` : null;
  const rows = (await db.query<CardRow>(
    `SELECT s.id,s.slug,s.title,s.status,s.summary_md,s.created_at,s.updated_at,s.activity_at,
            CASE WHEN cs.id IS NULL THEN NULL ELSE json_build_object('id',cs.id,'name',cs.name,'position',cs.position) END AS current_stage,
            (SELECT count(*)::int FROM study_stages g WHERE g.study_id=s.id) AS stage_count,
            (SELECT count(*)::int FROM study_stages g WHERE g.study_id=s.id AND g.completed_at IS NOT NULL) AS stages_done,
            COALESCE((SELECT json_agg(json_build_object('id',u.id,'name',u.name,'role',m.role,'account_role',u.role)
                              ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'member' THEN 1 ELSE 2 END, m.added_at)
                        FROM study_members m JOIN users u ON u.id=m.user_id WHERE m.study_id=s.id),'[]') AS members,
            (SELECT json_build_object('id',ms.id,'title',ms.title,'due_on',to_char(ms.due_on,'YYYY-MM-DD'))
               FROM milestones ms WHERE ms.study_id=s.id AND ms.done_at IS NULL ORDER BY ms.due_on NULLS LAST, ms.created_at LIMIT 1) AS next_milestone,
            (SELECT count(*)::int FROM tasks t WHERE t.study_id=s.id AND t.status='open') AS open_task_count,
            (SELECT m.role FROM study_members m WHERE m.study_id=s.id AND m.user_id=$1) AS my_role
       FROM studies s LEFT JOIN study_stages cs ON cs.id=s.current_stage_id
      WHERE ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM study_members m WHERE m.study_id=s.id AND m.user_id=$2))
        AND (CASE WHEN $3::text IS NULL THEN s.status<>'archived' WHEN $3='all' THEN true ELSE s.status=$3 END)
        AND ($4::text IS NULL OR cs.name=$4)
        AND ($5::text IS NULL OR s.title ILIKE $5 OR s.slug ILIKE $5 OR s.summary_md ILIKE $5)
        AND ($6::uuid[] IS NULL OR s.id=ANY($6))
      ORDER BY s.activity_at DESC, s.id
      LIMIT $7`,
    [viewerId, filter.memberId ?? null, filter.status ?? null, filter.stage ?? null, q, filter.ids ?? null, filter.limit ?? 500],
  )).rows;
  return rows.map(({ summary_md, ...row }) => ({ ...row, summary_excerpt: markdownExcerpt(summary_md, 160) }));
}
