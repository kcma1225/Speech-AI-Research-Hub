import type { FastifyRequest } from "fastify";
import { z } from "zod";
import type { Queryable } from "../../db.js";
import { requireUser, type CurrentUser } from "../auth.js";
import { forbidden, notFound } from "../http.js";

export type StudyStatus = "active" | "paused" | "completed" | "archived";
export type StudyMemberRole = "owner" | "member" | "advisor";
export const STUDY_MATURITIES = ["exploring", "problem_defined", "method_first", "continuation", "assigned", "well_defined"] as const;
export type StudyMaturity = (typeof STUDY_MATURITIES)[number];
export const STUDY_MATURITY_ZH: Record<StudyMaturity, string> = {
  exploring: "探索中", problem_defined: "有問題、方法未定", method_first: "有方法、找應用",
  continuation: "延續或復現", assigned: "指派的題目或計畫", well_defined: "方向明確",
};

export type Study = {
  id: string;
  slug: string;
  title: string;
  summary_md: string;
  summary_format: "prose" | "bullets";
  /** 研究成熟度 (AI interview; NULL = not set). */
  maturity: StudyMaturity | null;
  status: StudyStatus;
  current_stage_id: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  activity_at: string;
  archived_at: string | null;
};

/**
 * What a user may do in one study (docs/architecture.md "Roles"). Everyone signed in can read every study.
 * - `canEdit`: study owner or member (content: summary, stages, milestones, tasks, notes, decks, papers…).
 * - `canManage`: study owner (members, transfer, archive, delete). Admin accounts never reach study routes (workspace guard).
 * - `canComment`: everyone signed in (reviews, comments, meeting feedback).
 * Advisors (professor accounts) read and comment but never edit student content.
 */
export type StudyAccess = {
  study: Study;
  membership: { role: StudyMemberRole } | null;
  canEdit: boolean;
  canManage: boolean;
  canComment: boolean;
  /** The caller is the study's owner. */
  isOwner: boolean;
  /** The caller is one of the study's advisors. */
  isAdvisor: boolean;
};

export const STUDY_MISSING = "研究不存在。";
export const STUDY_COLUMNS = "s.id,s.slug,s.title,s.summary_md,s.summary_format,s.maturity,s.status,s.current_stage_id,s.created_by,s.updated_by,s.created_at,s.updated_at,s.activity_at,s.archived_at";

const isUuid = (value: string) => z.uuid().safeParse(value).success;

/** A study by id or slug (routes accept either); null when missing. `forUpdate` locks the row. */
export async function findStudy(db: Queryable, ref: string, forUpdate = false): Promise<Study | null> {
  if (!ref || ref.length > 80) return null;
  const column = isUuid(ref) ? "s.id" : "s.slug";
  const result = await db.query<Study>(`SELECT ${STUDY_COLUMNS} FROM studies s WHERE ${column}=$1${forUpdate ? " FOR UPDATE" : ""}`, [ref]);
  return result.rows[0] ?? null;
}

/** Access of `user` to the study `ref` (id or slug). Throws 404 when the study does not exist. */
export async function loadStudyAccess(db: Queryable, ref: string, user: CurrentUser, options: { forUpdate?: boolean } = {}): Promise<StudyAccess> {
  const study = await findStudy(db, ref, options.forUpdate);
  if (!study) throw notFound(STUDY_MISSING);
  const role = (await db.query<{ role: StudyMemberRole }>("SELECT role FROM study_members WHERE study_id=$1 AND user_id=$2", [study.id, user.id])).rows[0]?.role;
  return accessFor(study, user, role ?? null);
}

export function accessFor(study: Study, user: CurrentUser, role: StudyMemberRole | null): StudyAccess {
  const isOwner = role === "owner";
  const canEdit = role === "owner" || role === "member";
  return {
    study,
    membership: role ? { role } : null,
    canEdit,
    canManage: isOwner,
    canComment: true,
    isOwner,
    isAdvisor: role === "advisor",
  };
}

/** Signed-in user who may edit the study's content (owner or member). 403 otherwise. */
export async function requireStudyEditor(request: FastifyRequest, ref: string, db: Queryable = request.server.db): Promise<{ user: CurrentUser; access: StudyAccess }> {
  const user = await requireUser(request);
  const access = await loadStudyAccess(db, ref, user);
  if (!access.canEdit) throw forbidden("只有研究成員可以修改。");
  return { user, access };
}

/** Signed-in user who may manage the study (members, archive, delete): its owner or a system admin. */
export async function requireStudyManager(request: FastifyRequest, ref: string, db: Queryable = request.server.db): Promise<{ user: CurrentUser; access: StudyAccess }> {
  const user = await requireUser(request);
  const access = await loadStudyAccess(db, ref, user);
  if (!access.canManage) throw forbidden("只有研究擁有者可以管理此研究。");
  return { user, access };
}

/** Signed-in user plus their access (read). */
export async function requireStudyReader(request: FastifyRequest, ref: string): Promise<{ user: CurrentUser; access: StudyAccess }> {
  const user = await requireUser(request);
  return { user, access: await loadStudyAccess(request.server.db, ref, user) };
}

/** Permission flags as sent to the SPA. */
export const permissionsOf = (access: StudyAccess) => ({
  edit: access.canEdit,
  manage: access.canManage,
  comment: access.canComment,
  role: access.membership?.role ?? null,
});

/** SPA path of a study page; `tab` selects a tab (see frontend study tab registry). */
export const studyUrl = (slug: string, tab?: string) => `/studies/${encodeURIComponent(slug)}${tab ? `?tab=${encodeURIComponent(tab)}` : ""}`;
