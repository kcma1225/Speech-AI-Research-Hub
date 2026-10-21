import type { Role, StudyRef } from "#lib/types.ts";

export type StudyStatus = "active" | "paused" | "completed" | "archived";
export type MemberRole = "owner" | "member" | "advisor";
export type TaskStatus = "open" | "done" | "dropped";

/** `permissions` of GET /studies/:ref (and members/tasks lists). */
export type StudyPermissions = { edit: boolean; manage: boolean; comment: boolean; role: MemberRole | null };

export type StudyMember = { id: string; name: string; account_role: Role; role: MemberRole; disabled: boolean; added_at: string };
export type StudyStage = { id: string; position: number; name: string; description: string; started_at: string | null; completed_at: string | null; is_current: boolean };
export type Milestone = { id: string; stage_id: string | null; title: string; due_on: string | null; done_at: string | null; done_by: string | null; created_at: string; updated_at: string };

export type Task = {
  id: string;
  study_id: string;
  title: string;
  detail_md: string;
  assignee_id: string | null;
  assignee: { id: string; name: string } | null;
  due_on: string | null;
  status: TaskStatus;
  source: "manual" | "meeting" | "ai";
  source_ref: string | null;
  completed_at: string | null;
  created_by: string | null;
  creator_name: string | null;
  created_at: string;
  updated_at: string;
  /** Present on cross-study lists (GET /tasks, dashboard). */
  study?: StudyRef;
};

/** Row of GET /studies and dashboard `myStudies`. */
export type StudyCard = {
  id: string;
  slug: string;
  title: string;
  status: StudyStatus;
  summary_excerpt: string;
  created_at: string;
  updated_at: string;
  activity_at: string;
  current_stage: { id: string; name: string; position: number } | null;
  stage_count: number;
  stages_done: number;
  members: { id: string; name: string; role: MemberRole; account_role: Role }[];
  next_milestone: { id: string; title: string; due_on: string | null } | null;
  open_task_count: number;
  my_role: MemberRole | null;
};

export type StudyDetail = {
  study: {
    id: string;
    slug: string;
    title: string;
    summary_md: string;
    /** 研究成熟度 (AI interview; null = not set). */
    maturity?: import("#lib/agent/types.ts").StudyMaturity | null;
    status: StudyStatus;
    current_stage_id: string | null;
    created_by: string | null;
    created_at: string;
    updated_at: string;
    activity_at: string;
    archived_at: string | null;
  };
  stages: StudyStage[];
  milestones: Milestone[];
  members: StudyMember[];
  counts: { openTasks: number; doneTasks: number };
  permissions: StudyPermissions;
};

export type ActivityItem = {
  id: string;
  kind: string;
  title: string;
  url: string | null;
  at: string;
  metadata: Record<string, unknown>;
  actor: { id: string; name: string } | null;
  study: StudyRef;
};

export type DashboardData = {
  myStudies: StudyCard[];
  myTasks: (Task & { study: StudyRef })[];
  activity: ActivityItem[];
  pendingDrafts: { id: string; meeting: { id: string; title: string; held_at: string }; study: StudyRef }[];
  upcomingMeetings: { id: string; title: string; held_at: string }[];
  counts: { myStudies: number; labStudies: number; openTasks: number; overdueTasks: number; dueThisWeek: number };
};

/** `name` = real name; `username` = login id (shown as @username in pickers). */
export type DirectoryUser = { id: string; name: string; name_en?: string | null; person?: import("#lib/people.ts").Person; username: string; role: Role };

/** Stage progress 0..1: completed stages plus half of the current one. */
export function stageProgress(card: { stage_count: number; stages_done: number; current_stage: { position: number } | null }) {
  if (!card.stage_count) return 0;
  const done = Math.max(card.stages_done, card.current_stage ? card.current_stage.position : 0);
  return Math.min(1, (done + (card.current_stage ? 0.5 : 0)) / card.stage_count);
}
