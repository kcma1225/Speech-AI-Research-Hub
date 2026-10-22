import { z } from "zod";
import { transaction } from "../../db.js";
import { forbidden, notFound } from "../../lib/http.js";
import { loadStudyAccess, type StudyAccess } from "../../lib/studies/access.js";
import { listMembers } from "../../lib/studies/queries.js";
import type { AgentTarget, AgentToolContext } from "./registry.js";

/** `study` argument shared by study tools: id (uuid) or slug. */
export const studyRef = z.string().trim().min(1).max(80).describe("Study id (uuid) or slug, e.g. from list_studies");
export const uuidArg = (what: string) => z.string().trim().min(1).max(64).describe(`${what} id (uuid)`);
export const dateArg = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Date YYYY-MM-DD");

export const isUuid = (v: string) => z.uuid().safeParse(v).success;

export const taipeiToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());

/** Read access (everyone signed in reads every study). 404 when missing. */
export const readStudy = (ctx: AgentToolContext, ref: string) => loadStudyAccess(ctx.db, ref, ctx.user);

/** The refusal for a caller who may read but not edit the study (advisors comment and give feedback only). */
const notEditor = (access: StudyAccess) =>
  forbidden(access.isAdvisor
    ? `你是〈${access.study.title}〉的指導教授：可以閱讀與留言回饋，但不能直接修改研究內容（由研究成員修改）。`
    : `你不是〈${access.study.title}〉的成員，不能修改這個研究。`);

/** Edit access (study owner/member) or 403 — the same rule as the HTTP routes. */
export async function editStudy(ctx: AgentToolContext, ref: string): Promise<StudyAccess> {
  const access = await loadStudyAccess(ctx.db, ref, ctx.user);
  if (!access.canEdit) throw notEditor(access);
  return access;
}

export const studyTarget = (access: StudyAccess): AgentTarget => ({
  studyId: access.study.id,
  studySlug: access.study.slug,
  label: access.study.title,
  url: `/studies/${access.study.slug}`,
});

/** Locks the study row and re-checks edit access inside the transaction. */
export function withEditableStudy<T>(ctx: AgentToolContext, ref: string, work: (client: import("pg").PoolClient, access: StudyAccess) => Promise<T>) {
  return transaction(ctx.db, async (client) => {
    const access = await loadStudyAccess(client, ref, ctx.user, { forUpdate: true });
    if (!access.canEdit) throw notEditor(access);
    return work(client, access);
  });
}

/** True when someone other than the caller can write the study's content (its text is then untrusted). */
export async function sharedAuthorship(ctx: AgentToolContext, access: StudyAccess) {
  if (access.study.created_by !== ctx.user.id) return true;
  const members = await listMembers(ctx.db, access.study.id);
  return members.some((m) => m.id !== ctx.user.id && (m.role === "owner" || m.role === "member"));
}

export const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** Removes zero-width and bidi-control characters (hidden-prompt tricks) from text returned to the model. */
export const scrub = (text: string) => text.replace(/[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g, "");

export function notFoundIf<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw notFound(message);
  return value;
}
