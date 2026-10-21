import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { transaction, type Queryable } from "../db.js";
import { audit, requireUser, type CurrentUser } from "../lib/auth.js";
import { badRequest, conflict, forbidden, isUniqueViolation, notFound, parse } from "../lib/http.js";
import {
  loadStudyAccess, permissionsOf, requireStudyEditor, requireStudyManager, requireStudyReader, STUDY_MISSING, studyUrl,
  type Study, type StudyAccess,
  STUDY_MATURITIES,
} from "../lib/studies/access.js";
import { recordActivity } from "../lib/studies/activity.js";
import { runStudyCleanups } from "../lib/studies/cleanup.js";
import { listMembers, listMilestones, listStages, MILESTONE_SELECT, studyCards, type Milestone } from "../lib/studies/queries.js";
import { uniqueStudySlug, validStudySlug } from "../lib/studies/slug.js";
import { createTask, dateOnly, getTask, TASK_SELECT, taskCreateInput, taskPatchInput, updateTask, type AfterCommit, type Task } from "../lib/studies/tasks.js";

const ref = z.object({ ref: z.string().min(1).max(80) });
const memberParams = ref.extend({ userId: z.uuid() });
const stageParams = ref.extend({ stageId: z.uuid() });
const milestoneParams = ref.extend({ milestoneId: z.uuid() });
const taskParams = ref.extend({ taskId: z.uuid() });

const title = z.string().trim().min(1).max(200);
const slug = z.string().trim().toLowerCase().max(80).refine(validStudySlug);
const summary = z.string().max(100000);
/** Legacy 段落/條列 toggle: still accepted from old clients, ignored (the Markdown decides the format). */
const summaryFormat = z.string().max(20);
const status = z.enum(["active", "paused", "completed", "archived"]);
const maturity = z.enum(STUDY_MATURITIES).nullable();
const stageName = z.string().trim().min(1).max(60);
const stageDescription = z.string().trim().max(2000);

const createInput = z.object({
  title,
  slug: slug.optional(),
  summary_md: summary.optional(),
  summary_format: summaryFormat.optional(),
  maturity: maturity.optional(),
  templateId: z.uuid().optional(),
  members: z.array(z.object({ userId: z.uuid(), role: z.enum(["member", "advisor"]) })).max(50).optional(),
});
const patchInput = z.object({
  title: title.optional(),
  slug: slug.optional(),
  summary_md: summary.optional(),
  summary_format: summaryFormat.optional(),
  maturity: maturity.optional(),
  status: status.optional(),
});
const listQuery = z.object({
  member: z.string().max(40).optional(),
  status: z.union([status, z.literal("all")]).optional(),
  stage: z.string().trim().max(60).optional(),
  q: z.string().max(200).optional(),
});
const memberInput = z.object({ userId: z.uuid(), role: z.enum(["member", "advisor"]) });
const memberPatch = z.object({ role: z.enum(["member", "advisor"]) });
const transferInput = z.object({ userId: z.uuid() });
const stageInput = z.object({ name: stageName, description: stageDescription.optional() });
const stagePatch = z.object({ name: stageName.optional(), description: stageDescription.optional() });
const stageOrder = z.object({ ids: z.array(z.uuid()).min(1).max(50) });
const completeInput = z.object({ completed: z.boolean().default(true) });
const milestoneInput = z.object({ title: z.string().trim().min(1).max(200), due_on: dateOnly.nullable().optional(), stage_id: z.uuid().nullable().optional() });
const milestonePatch = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  due_on: dateOnly.nullable().optional(),
  stage_id: z.uuid().nullable().optional(),
  done: z.boolean().optional(),
});
const taskListQuery = z.object({
  status: z.enum(["open", "done", "dropped", "all"]).optional(),
  assignee: z.string().max(40).optional(),
});
const myTasksQuery = z.object({
  assignee: z.string().max(40).optional(),
  status: z.enum(["open", "done", "dropped", "all"]).optional(),
  study: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** Fallback when the stage template table is empty. */
const FALLBACK_STAGES = ["題目發想", "文獻探討", "實驗", "撰寫", "投稿/口試"].map(name => ({ name, description: "" }));

/** `me` → the caller, a uuid → that user, `none` → unassigned, else undefined. */
function userFilter(value: string | undefined, user: CurrentUser): string | "none" | undefined {
  if (!value) return undefined;
  if (value === "me") return user.id;
  if (value === "none") return "none";
  if (!z.uuid().safeParse(value).success) throw badRequest("篩選條件不正確。");
  return value;
}

async function runAfter(callbacks: (AfterCommit | null)[], log: { warn: (obj: object, msg: string) => void }) {
  for (const callback of callbacks) if (callback) await callback().catch(error => log.warn({ err: error }, "post-commit step failed"));
}

async function studyDetail(db: Queryable, access: StudyAccess) {
  const { study } = access;
  const [stages, milestones, members, counts] = await Promise.all([
    listStages(db, study.id),
    listMilestones(db, study.id),
    listMembers(db, study.id),
    db.query<{ open: number; done: number }>(
      "SELECT count(*) FILTER (WHERE status='open')::int AS open,count(*) FILTER (WHERE status='done')::int AS done FROM tasks WHERE study_id=$1",
      [study.id],
    ),
  ]);
  return {
    study: {
      id: study.id, slug: study.slug, title: study.title, summary_md: study.summary_md, maturity: study.maturity,
      status: study.status, current_stage_id: study.current_stage_id, created_by: study.created_by,
      created_at: study.created_at, updated_at: study.updated_at, activity_at: study.activity_at, archived_at: study.archived_at,
    },
    stages,
    milestones,
    members,
    counts: { openTasks: counts.rows[0]!.open, doneTasks: counts.rows[0]!.done },
    permissions: permissionsOf(access),
  };
}

/** Locks the study row and re-reads access inside a transaction. */
async function lockedAccess(client: Queryable, refValue: string, user: CurrentUser) {
  return loadStudyAccess(client, refValue, user, { forUpdate: true });
}

async function addMember(client: Queryable, study: Study, actor: CurrentUser, userId: string, role: "member" | "advisor") {
  const target = (await client.query<{ name: string; role: "student" | "professor" | "admin" }>("SELECT name,role FROM users WHERE id=$1 AND disabled_at IS NULL", [userId])).rows[0];
  if (!target) throw notFound("帳號不存在或已停用。");
  if (target.role === "admin") throw badRequest("管理員帳號不能加入研究。");
  if (role === "advisor" && target.role !== "professor") throw badRequest("指導教授必須是教授帳號。");
  const inserted = await client.query(
    "INSERT INTO study_members(study_id,user_id,role,added_by) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
    [study.id, userId, role, actor.id],
  );
  if (!inserted.rowCount) throw conflict("此帳號已是研究成員。");
  await recordActivity(client, {
    studyId: study.id, actorId: actor.id, kind: "member_added", title: target.name, url: studyUrl(study.slug, "members"),
    targetType: "user", targetId: userId, metadata: { role },
  });
  return { name: target.name };
}

const studies: FastifyPluginAsync = async app => {
  // ───────────── Studies ─────────────

  app.get("/studies", async (request, reply) => {
    const user = await requireUser(request);
    const query = parse(listQuery, request.query, "篩選條件不正確。");
    const member = userFilter(query.member, user);
    const cards = await studyCards(app.db, user.id, {
      memberId: member === "none" ? null : member ?? null,
      status: query.status ?? null,
      stage: query.stage || null,
      q: query.q ?? null,
    });
    return reply.header("Cache-Control", "no-store").send({ studies: cards });
  });

  app.post("/studies", async (request, reply) => {
    const user = await requireUser(request);
    const input = parse(createInput, request.body, "請確認研究名稱（1–200 字）、網址代稱與成員。");
    try {
      const result = await transaction(app.db, async client => {
        const slugValue = await uniqueStudySlug(client, input.title, input.slug);
        if (input.slug && slugValue !== input.slug) throw conflict("這個網址代稱已被使用。");
        const template = (await client.query<{ stages: { name: string; description?: string }[] }>(
          input.templateId ? "SELECT stages FROM stage_templates WHERE id=$1" : "SELECT stages FROM stage_templates WHERE is_default LIMIT 1",
          input.templateId ? [input.templateId] : [],
        )).rows[0];
        if (input.templateId && !template) throw notFound("階段範本不存在。");
        const stageList = (template?.stages ?? FALLBACK_STAGES)
          .filter(stage => typeof stage?.name === "string" && stage.name.trim())
          .slice(0, 20)
          .map(stage => ({ name: stage.name.trim().slice(0, 60), description: (stage.description ?? "").slice(0, 2000) }));
        const study = (await client.query<{ id: string }>(
          `INSERT INTO studies(slug,title,summary_md,maturity,created_by,updated_by) VALUES($1,$2,$3,$5,$4,$4) RETURNING id`,
          [slugValue, input.title, input.summary_md ?? "", user.id, input.maturity ?? null],
        )).rows[0]!;
        let first: string | null = null;
        for (const [position, stage] of (stageList.length ? stageList : FALLBACK_STAGES).entries()) {
          const id = (await client.query<{ id: string }>(
            "INSERT INTO study_stages(study_id,position,name,description,started_at) VALUES($1,$2,$3,$4,CASE WHEN $2=0 THEN now() END) RETURNING id",
            [study.id, position, stage.name, stage.description],
          )).rows[0]!.id;
          first ??= id;
        }
        await client.query("UPDATE studies SET current_stage_id=$2 WHERE id=$1", [study.id, first]);
        await client.query("INSERT INTO study_members(study_id,user_id,role,added_by) VALUES($1,$2,'owner',$2)", [study.id, user.id]);
        const access = await loadStudyAccess(client, study.id, user);
        for (const member of input.members ?? []) {
          if (member.userId === user.id) continue;
          await addMember(client, access.study, user, member.userId, member.role);
        }
        await recordActivity(client, { studyId: study.id, actorId: user.id, kind: "study_created", title: input.title, url: studyUrl(slugValue), targetType: "study", targetId: study.id });
        return studyDetail(client, await loadStudyAccess(client, study.id, user));
      });
      await audit(request, user.id, "study_created", "study", result.study.id);
      return reply.code(201).send(result);
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict("這個網址代稱已被使用。");
      throw error;
    }
  });

  app.get("/studies/:ref", async (request, reply) => {
    const params = parse(ref, request.params, STUDY_MISSING);
    const { access } = await requireStudyReader(request, params.ref);
    return reply.header("Cache-Control", "no-store").send(await studyDetail(app.db, access));
  });

  app.patch("/studies/:ref", async request => {
    const user = await requireUser(request);
    const params = parse(ref, request.params, STUDY_MISSING);
    const input = parse(patchInput, request.body, "請確認研究名稱、網址代稱與狀態。");
    try {
      return await transaction(app.db, async client => {
        const access = await lockedAccess(client, params.ref, user);
        if (!access.canEdit && !access.canManage) throw forbidden("只有研究成員可以修改。");
        const contentChange = input.title !== undefined || input.slug !== undefined || input.summary_md !== undefined || input.maturity !== undefined;
        if (contentChange && !access.canEdit) throw forbidden("只有研究成員可以修改。");
        // Archiving (and un-archiving) is a management action; other statuses are ordinary edits.
        if (input.status !== undefined && (input.status === "archived" || access.study.status === "archived") && !access.canManage) {
          throw forbidden("只有研究擁有者可以封存研究。");
        }
        if (input.status !== undefined && !access.canEdit && !access.canManage) throw forbidden("只有研究成員可以修改。");
        await client.query(
          `UPDATE studies SET title=COALESCE($2,title),slug=COALESCE($3,slug),summary_md=COALESCE($4,summary_md),
                  status=COALESCE($5,status),
                  archived_at=CASE WHEN $5::text IS NULL THEN archived_at WHEN $5='archived' THEN COALESCE(archived_at,now()) ELSE NULL END,
                  maturity=CASE WHEN $7::boolean THEN $8 ELSE maturity END,
                  updated_by=$6,updated_at=now(),activity_at=now()
            WHERE id=$1`,
          [access.study.id, input.title ?? null, input.slug ?? null, input.summary_md ?? null, input.status ?? null, user.id, input.maturity !== undefined, input.maturity ?? null],
        );
        // Renaming keeps the slug (links stay stable) unless one is given explicitly.
        if (input.title !== undefined && input.title !== access.study.title) {
          await recordActivity(client, {
            studyId: access.study.id, actorId: user.id, kind: "study_renamed", title: input.title,
            url: studyUrl(input.slug ?? access.study.slug), targetType: "study", targetId: access.study.id, metadata: { from: access.study.title },
          });
        }
        return studyDetail(client, await loadStudyAccess(client, access.study.id, user));
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict("這個網址代稱已被使用。");
      throw error;
    }
  });

  app.delete("/studies/:ref", async request => {
    const params = parse(ref, request.params, STUDY_MISSING);
    const { user } = await requireStudyManager(request, params.ref);
    const { after, id } = await transaction(app.db, async client => {
      const access = await lockedAccess(client, params.ref, user);
      if (!access.canManage) throw forbidden("只有研究擁有者可以刪除研究。");
      const callbacks = await runStudyCleanups(client, access.study.id);
      await client.query("DELETE FROM studies WHERE id=$1", [access.study.id]);
      return { after: callbacks, id: access.study.id };
    });
    await audit(request, user.id, "study_deleted", "study", id);
    await runAfter(after, request.log);
    return { ok: true };
  });

  // ───────────── Members ─────────────

  app.get("/studies/:ref/members", async (request, reply) => {
    const params = parse(ref, request.params, STUDY_MISSING);
    const { access } = await requireStudyReader(request, params.ref);
    return reply.header("Cache-Control", "no-store").send({ members: await listMembers(app.db, access.study.id), permissions: permissionsOf(access) });
  });

  app.post("/studies/:ref/members", async (request, reply) => {
    const params = parse(ref, request.params, STUDY_MISSING);
    const input = parse(memberInput, request.body, "請選擇帳號與身分。");
    const { user } = await requireStudyManager(request, params.ref);
    const members = await transaction(app.db, async client => {
      const access = await lockedAccess(client, params.ref, user);
      const { name } = await addMember(client, access.study, user, input.userId, input.role);
      if (input.userId !== user.id) {
        await app.notifier.record(client, [input.userId], { kind: "study", title: `${user.name} 將你加入研究`, body: `${access.study.title}（${input.role === "advisor" ? "指導教授" : "成員"}）`, url: studyUrl(access.study.slug) });
      }
      void name;
      return listMembers(client, access.study.id);
    });
    return reply.code(201).send({ members });
  });

  app.patch("/studies/:ref/members/:userId", async request => {
    const params = parse(memberParams, request.params, STUDY_MISSING);
    const input = parse(memberPatch, request.body, "身分不正確。");
    const { user } = await requireStudyManager(request, params.ref);
    return transaction(app.db, async client => {
      const access = await lockedAccess(client, params.ref, user);
      const current = (await client.query<{ role: string; account_role: string }>(
        "SELECT m.role,u.role AS account_role FROM study_members m JOIN users u ON u.id=m.user_id WHERE m.study_id=$1 AND m.user_id=$2 FOR UPDATE OF m",
        [access.study.id, params.userId],
      )).rows[0];
      if (!current) throw notFound("此帳號不是研究成員。");
      if (current.role === "owner") throw badRequest("請使用「轉移擁有者」變更擁有者。");
      if (input.role === "advisor" && current.account_role !== "professor") throw badRequest("指導教授必須是教授帳號。");
      await client.query("UPDATE study_members SET role=$3 WHERE study_id=$1 AND user_id=$2", [access.study.id, params.userId, input.role]);
      return { members: await listMembers(client, access.study.id) };
    });
  });

  /** The manager removes anyone but the owner; any non-owner member may leave. */
  app.delete("/studies/:ref/members/:userId", async request => {
    const params = parse(memberParams, request.params, STUDY_MISSING);
    const user = await requireUser(request);
    return transaction(app.db, async client => {
      const access = await lockedAccess(client, params.ref, user);
      if (!access.canManage && params.userId !== user.id) throw forbidden("只有研究擁有者可以管理成員。");
      const current = (await client.query<{ role: string }>("SELECT role FROM study_members WHERE study_id=$1 AND user_id=$2", [access.study.id, params.userId])).rows[0];
      if (!current) throw notFound("此帳號不是研究成員。");
      if (current.role === "owner") throw badRequest("無法移除擁有者；請先轉移擁有者。");
      await client.query("DELETE FROM study_members WHERE study_id=$1 AND user_id=$2", [access.study.id, params.userId]);
      // Open tasks of a removed member become unassigned (assignees must be members).
      await client.query("UPDATE tasks SET assignee_id=NULL,updated_at=now() WHERE study_id=$1 AND assignee_id=$2 AND status='open'", [access.study.id, params.userId]);
      return { members: await listMembers(client, access.study.id) };
    });
  });

  /** Makes a current member (role member) the owner; the previous owner becomes a member. */
  app.post("/studies/:ref/transfer", async request => {
    const params = parse(ref, request.params, STUDY_MISSING);
    const input = parse(transferInput, request.body, "請選擇新的擁有者。");
    const { user } = await requireStudyManager(request, params.ref);
    const result = await transaction(app.db, async client => {
      const access = await lockedAccess(client, params.ref, user);
      const target = (await client.query<{ role: string }>("SELECT role FROM study_members WHERE study_id=$1 AND user_id=$2 FOR UPDATE", [access.study.id, input.userId])).rows[0];
      if (!target) throw notFound("此帳號不是研究成員。");
      if (target.role === "owner") return { members: await listMembers(client, access.study.id) };
      if (target.role !== "member") throw badRequest("只能轉移給一般成員；指導教授請先改為成員。");
      await client.query("UPDATE study_members SET role='member' WHERE study_id=$1 AND role='owner'", [access.study.id]);
      await client.query("UPDATE study_members SET role='owner' WHERE study_id=$1 AND user_id=$2", [access.study.id, input.userId]);
      await app.notifier.record(client, [input.userId], { kind: "study", title: `${user.name} 將研究轉移給你`, body: access.study.title, url: studyUrl(access.study.slug) });
      return { members: await listMembers(client, access.study.id) };
    });
    await audit(request, user.id, "study_transferred", "study", null, { to: input.userId });
    return result;
  });

  // ───────────── Stages ─────────────

  app.get("/studies/:ref/stages", async (request, reply) => {
    const params = parse(ref, request.params, STUDY_MISSING);
    const { access } = await requireStudyReader(request, params.ref);
    return reply.header("Cache-Control", "no-store").send({ stages: await listStages(app.db, access.study.id) });
  });

  app.post("/studies/:ref/stages", async (request, reply) => {
    const params = parse(ref, request.params, STUDY_MISSING);
    const input = parse(stageInput, request.body, "階段名稱須為 1–60 字。");
    const { user } = await requireStudyEditor(request, params.ref);
    const stages = await transaction(app.db, async client => {
      const { study } = await lockedAccess(client, params.ref, user);
      const count = (await client.query<{ n: number }>("SELECT count(*)::int AS n FROM study_stages WHERE study_id=$1", [study.id])).rows[0]!.n;
      if (count >= 50) throw badRequest("階段最多 50 個。");
      await client.query(
        "INSERT INTO study_stages(study_id,position,name,description) VALUES($1,(SELECT COALESCE(max(position)+1,0) FROM study_stages WHERE study_id=$1),$2,$3)",
        [study.id, input.name, input.description ?? ""],
      );
      await client.query("UPDATE studies SET activity_at=now() WHERE id=$1", [study.id]);
      return listStages(client, study.id);
    });
    return reply.code(201).send({ stages });
  });

  app.put("/studies/:ref/stages/order", async request => {
    const params = parse(ref, request.params, STUDY_MISSING);
    const input = parse(stageOrder, request.body, "階段順序不正確。");
    const { user } = await requireStudyEditor(request, params.ref);
    return transaction(app.db, async client => {
      const { study } = await lockedAccess(client, params.ref, user);
      const existing = (await client.query<{ id: string }>("SELECT id FROM study_stages WHERE study_id=$1", [study.id])).rows.map(row => row.id);
      const wanted = new Set(input.ids);
      if (wanted.size !== input.ids.length || wanted.size !== existing.length || !existing.every(id => wanted.has(id))) {
        throw badRequest("請提供此研究的所有階段，且不可重複。");
      }
      for (const [position, id] of input.ids.entries()) await client.query("UPDATE study_stages SET position=$3 WHERE id=$1 AND study_id=$2", [id, study.id, position]);
      return { stages: await listStages(client, study.id) };
    });
  });

  app.patch("/studies/:ref/stages/:stageId", async request => {
    const params = parse(stageParams, request.params, "階段不存在。");
    const input = parse(stagePatch, request.body, "階段名稱須為 1–60 字。");
    const { user } = await requireStudyEditor(request, params.ref);
    return transaction(app.db, async client => {
      const { study } = await lockedAccess(client, params.ref, user);
      const updated = await client.query(
        "UPDATE study_stages SET name=COALESCE($3,name),description=COALESCE($4,description) WHERE id=$1 AND study_id=$2",
        [params.stageId, study.id, input.name ?? null, input.description ?? null],
      );
      if (!updated.rowCount) throw notFound("階段不存在。");
      return { stages: await listStages(client, study.id) };
    });
  });

  /**
   * Makes a stage current: earlier stages are marked completed (if not already), later ones not completed;
   * the stage gets `started_at` (first time) and loses `completed_at`.
   */
  app.post("/studies/:ref/stages/:stageId/current", async request => {
    const params = parse(stageParams, request.params, "階段不存在。");
    const { user } = await requireStudyEditor(request, params.ref);
    return transaction(app.db, async client => {
      const { study } = await lockedAccess(client, params.ref, user);
      await setCurrentStage(client, study, user, params.stageId);
      return { stages: await listStages(client, study.id), current_stage_id: params.stageId };
    });
  });

  /** Marks a stage completed (or not). Completing the current stage moves "current" to the next stage, if any. */
  app.post("/studies/:ref/stages/:stageId/complete", async request => {
    const params = parse(stageParams, request.params, "階段不存在。");
    const input = parse(completeInput, request.body ?? {}, "欄位內容不正確。");
    const { user } = await requireStudyEditor(request, params.ref);
    return transaction(app.db, async client => {
      const { study } = await lockedAccess(client, params.ref, user);
      const stage = (await client.query<{ position: number }>("SELECT position FROM study_stages WHERE id=$1 AND study_id=$2", [params.stageId, study.id])).rows[0];
      if (!stage) throw notFound("階段不存在。");
      if (!input.completed) {
        await client.query("UPDATE study_stages SET completed_at=NULL WHERE id=$1", [params.stageId]);
      } else {
        await client.query("UPDATE study_stages SET completed_at=COALESCE(completed_at,now()),started_at=COALESCE(started_at,now()) WHERE id=$1", [params.stageId]);
        if (study.current_stage_id === params.stageId) {
          const next = (await client.query<{ id: string }>(
            "SELECT id FROM study_stages WHERE study_id=$1 AND position>$2 ORDER BY position LIMIT 1",
            [study.id, stage.position],
          )).rows[0];
          if (next) await setCurrentStage(client, study, user, next.id);
        }
      }
      await client.query("UPDATE studies SET activity_at=now() WHERE id=$1", [study.id]);
      const current = (await client.query<{ current_stage_id: string | null }>("SELECT current_stage_id FROM studies WHERE id=$1", [study.id])).rows[0]!;
      return { stages: await listStages(client, study.id), current_stage_id: current.current_stage_id };
    });
  });

  app.delete("/studies/:ref/stages/:stageId", async request => {
    const params = parse(stageParams, request.params, "階段不存在。");
    const { user } = await requireStudyEditor(request, params.ref);
    return transaction(app.db, async client => {
      const { study } = await lockedAccess(client, params.ref, user);
      if (study.current_stage_id === params.stageId) throw conflict("無法刪除目前階段；請先切換到其他階段。");
      const removed = await client.query("DELETE FROM study_stages WHERE id=$1 AND study_id=$2", [params.stageId, study.id]);
      if (!removed.rowCount) throw notFound("階段不存在。");
      await client.query(
        `UPDATE study_stages g SET position=o.rn FROM (SELECT id,(row_number() OVER (ORDER BY position))-1 AS rn FROM study_stages WHERE study_id=$1) o
          WHERE g.id=o.id AND g.position<>o.rn`,
        [study.id],
      );
      return { stages: await listStages(client, study.id) };
    });
  });

  // ───────────── Milestones ─────────────

  app.get("/studies/:ref/milestones", async (request, reply) => {
    const params = parse(ref, request.params, STUDY_MISSING);
    const { access } = await requireStudyReader(request, params.ref);
    return reply.header("Cache-Control", "no-store").send({ milestones: await listMilestones(app.db, access.study.id) });
  });

  app.post("/studies/:ref/milestones", async (request, reply) => {
    const params = parse(ref, request.params, STUDY_MISSING);
    const input = parse(milestoneInput, request.body, "請確認里程碑名稱（1–200 字）與日期。");
    const { user } = await requireStudyEditor(request, params.ref);
    const milestone = await transaction(app.db, async client => {
      const { study } = await lockedAccess(client, params.ref, user);
      await assertStage(client, study.id, input.stage_id);
      const id = (await client.query<{ id: string }>(
        "INSERT INTO milestones(study_id,stage_id,title,due_on,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id",
        [study.id, input.stage_id ?? null, input.title, input.due_on ?? null, user.id],
      )).rows[0]!.id;
      await client.query("UPDATE studies SET activity_at=now() WHERE id=$1", [study.id]);
      return getMilestone(client, study.id, id);
    });
    return reply.code(201).send({ milestone });
  });

  app.patch("/studies/:ref/milestones/:milestoneId", async request => {
    const params = parse(milestoneParams, request.params, "里程碑不存在。");
    const input = parse(milestonePatch, request.body, "請確認里程碑名稱與日期。");
    const { user } = await requireStudyEditor(request, params.ref);
    return transaction(app.db, async client => {
      const { study } = await lockedAccess(client, params.ref, user);
      const current = (await client.query<{ done_at: string | null; title: string }>("SELECT done_at,title FROM milestones WHERE id=$1 AND study_id=$2 FOR UPDATE", [params.milestoneId, study.id])).rows[0];
      if (!current) throw notFound("里程碑不存在。");
      if (input.stage_id !== undefined) await assertStage(client, study.id, input.stage_id);
      await client.query(
        `UPDATE milestones SET title=COALESCE($3,title),
                due_on=CASE WHEN $4::boolean THEN $5::date ELSE due_on END,
                stage_id=CASE WHEN $6::boolean THEN $7::uuid ELSE stage_id END,
                done_at=CASE WHEN $8::boolean IS NULL THEN done_at WHEN $8 THEN COALESCE(done_at,now()) ELSE NULL END,
                done_by=CASE WHEN $8::boolean IS NULL THEN done_by WHEN $8 THEN COALESCE(done_by,$9) ELSE NULL END,
                updated_at=now()
          WHERE id=$1 AND study_id=$2`,
        [params.milestoneId, study.id, input.title ?? null, input.due_on !== undefined, input.due_on ?? null,
          input.stage_id !== undefined, input.stage_id ?? null, input.done ?? null, user.id],
      );
      if (input.done && !current.done_at) {
        await recordActivity(client, { studyId: study.id, actorId: user.id, kind: "milestone_done", title: input.title ?? current.title, url: studyUrl(study.slug), targetType: "milestone", targetId: params.milestoneId });
      } else {
        await client.query("UPDATE studies SET activity_at=now() WHERE id=$1", [study.id]);
      }
      return { milestone: await getMilestone(client, study.id, params.milestoneId) };
    });
  });

  app.delete("/studies/:ref/milestones/:milestoneId", async request => {
    const params = parse(milestoneParams, request.params, "里程碑不存在。");
    const { access } = await requireStudyEditor(request, params.ref);
    const removed = await app.db.query("DELETE FROM milestones WHERE id=$1 AND study_id=$2", [params.milestoneId, access.study.id]);
    if (!removed.rowCount) throw notFound("里程碑不存在。");
    return { ok: true };
  });

  // ───────────── Tasks ─────────────

  app.get("/studies/:ref/tasks", async (request, reply) => {
    const params = parse(ref, request.params, STUDY_MISSING);
    const query = parse(taskListQuery, request.query, "篩選條件不正確。");
    const { user, access } = await requireStudyReader(request, params.ref);
    const assignee = userFilter(query.assignee, user);
    const statusFilter = query.status ?? "all";
    const rows = (await app.db.query<Task>(
      `${TASK_SELECT}
        WHERE t.study_id=$1 AND ($2='all' OR t.status=$2)
          AND (CASE WHEN $3::text IS NULL THEN true WHEN $3='none' THEN t.assignee_id IS NULL ELSE t.assignee_id::text=$3 END)
        ORDER BY CASE t.status WHEN 'open' THEN 0 WHEN 'done' THEN 1 ELSE 2 END, t.due_on NULLS LAST, t.created_at DESC
        LIMIT 1000`,
      [access.study.id, statusFilter, assignee ?? null],
    )).rows;
    return reply.header("Cache-Control", "no-store").send({ tasks: rows, permissions: permissionsOf(access) });
  });

  app.post("/studies/:ref/tasks", async (request, reply) => {
    const params = parse(ref, request.params, STUDY_MISSING);
    const input = parse(taskCreateInput, request.body, "請確認待辦標題（1–300 字）、負責人與日期。");
    const { user } = await requireStudyEditor(request, params.ref);
    const { task, after } = await transaction(app.db, async client => {
      const { study } = await lockedAccess(client, params.ref, user);
      return createTask(client, app.notifier, study, user, input);
    });
    await runAfter([after], request.log);
    return reply.code(201).send({ task });
  });

  app.get("/studies/:ref/tasks/:taskId", async (request, reply) => {
    const params = parse(taskParams, request.params, "待辦不存在。");
    const { access } = await requireStudyReader(request, params.ref);
    const task = await getTask(app.db, access.study.id, params.taskId);
    if (!task) throw notFound("待辦不存在。");
    return reply.header("Cache-Control", "no-store").send({ task });
  });

  app.patch("/studies/:ref/tasks/:taskId", async request => {
    const params = parse(taskParams, request.params, "待辦不存在。");
    const input = parse(taskPatchInput, request.body, "請確認待辦標題、負責人與日期。");
    const { user } = await requireStudyEditor(request, params.ref);
    const { task, after } = await transaction(app.db, async client => {
      const { study } = await lockedAccess(client, params.ref, user);
      return updateTask(client, app.notifier, study, user, params.taskId, input);
    });
    await runAfter([after], request.log);
    return { task };
  });

  app.delete("/studies/:ref/tasks/:taskId", async request => {
    const params = parse(taskParams, request.params, "待辦不存在。");
    const { access } = await requireStudyEditor(request, params.ref);
    const removed = await app.db.query("DELETE FROM tasks WHERE id=$1 AND study_id=$2", [params.taskId, access.study.id]);
    if (!removed.rowCount) throw notFound("待辦不存在。");
    return { ok: true };
  });

  /** Tasks across studies (default: mine, open), soonest due first. Each carries its study. */
  app.get("/tasks", async (request, reply) => {
    const user = await requireUser(request);
    const query = parse(myTasksQuery, request.query, "篩選條件不正確。");
    const assignee = userFilter(query.assignee ?? "me", user);
    const statusFilter = query.status ?? "open";
    let studyId: string | null = null;
    if (query.study) studyId = (await loadStudyAccess(app.db, query.study, user)).study.id;
    const rows = (await app.db.query<Task & { study: { id: string; slug: string; title: string } }>(
      `${TASK_SELECT.replace("FROM tasks t", "FROM tasks t JOIN studies st ON st.id=t.study_id").replace(
        "t.created_at,t.updated_at",
        "t.created_at,t.updated_at,json_build_object('id',st.id,'slug',st.slug,'title',st.title) AS study",
      )}
        WHERE ($1='all' OR t.status=$1)
          AND (CASE WHEN $2='none' THEN t.assignee_id IS NULL ELSE t.assignee_id::text=$2 END)
          AND ($3::uuid IS NULL OR t.study_id=$3)
        ORDER BY t.due_on NULLS LAST, t.created_at DESC
        LIMIT $4`,
      [statusFilter, assignee ?? user.id, studyId, query.limit ?? 100],
    )).rows;
    return reply.header("Cache-Control", "no-store").send({ tasks: rows });
  });
};

async function assertStage(client: Queryable, studyId: string, stageId: string | null | undefined) {
  if (!stageId) return;
  const found = await client.query("SELECT 1 FROM study_stages WHERE id=$1 AND study_id=$2", [stageId, studyId]);
  if (!found.rowCount) throw badRequest("階段不存在。");
}

async function getMilestone(client: Queryable, studyId: string, id: string): Promise<Milestone> {
  return (await client.query<Milestone>(`${MILESTONE_SELECT} WHERE m.id=$1 AND m.study_id=$2`, [id, studyId])).rows[0]!;
}

async function setCurrentStage(client: Queryable, study: Study, user: CurrentUser, stageId: string) {
  const stage = (await client.query<{ position: number; name: string }>("SELECT position,name FROM study_stages WHERE id=$1 AND study_id=$2", [stageId, study.id])).rows[0];
  if (!stage) throw notFound("階段不存在。");
  const previous = study.current_stage_id
    ? (await client.query<{ name: string }>("SELECT name FROM study_stages WHERE id=$1", [study.current_stage_id])).rows[0]?.name ?? null
    : null;
  await client.query("UPDATE study_stages SET completed_at=COALESCE(completed_at,now()),started_at=COALESCE(started_at,now()) WHERE study_id=$1 AND position<$2", [study.id, stage.position]);
  await client.query("UPDATE study_stages SET completed_at=NULL WHERE study_id=$1 AND position>$2", [study.id, stage.position]);
  await client.query("UPDATE study_stages SET started_at=COALESCE(started_at,now()),completed_at=NULL WHERE id=$1", [stageId]);
  if (study.current_stage_id !== stageId) {
    await client.query("UPDATE studies SET current_stage_id=$2,updated_at=now() WHERE id=$1", [study.id, stageId]);
    await recordActivity(client, {
      studyId: study.id, actorId: user.id, kind: "stage_changed", title: stage.name, url: studyUrl(study.slug),
      targetType: "stage", targetId: stageId, metadata: { from: previous, to: stage.name },
    });
    study.current_stage_id = stageId;
  }
}

export default studies;
