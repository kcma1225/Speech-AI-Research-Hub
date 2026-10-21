/** Core study tools: studies, progress, stages, milestones, tasks, study summary suggestions. */
import { z } from "zod";
import { badRequest, notFound } from "../../lib/http.js";
import { STUDY_MATURITY_ZH, studyUrl } from "../../lib/studies/access.js";
import { recordActivity } from "../../lib/studies/activity.js";
import { listMembers, listMilestones, listStages, MILESTONE_SELECT, studyCards } from "../../lib/studies/queries.js";
import { createTask, getTask, TASK_SELECT, updateTask, type Task } from "../../lib/studies/tasks.js";
import { applySuggestionNow, createSuggestion } from "../../lib/suggestions/service.js";
import "../../lib/suggestions/study-summary.js";
import { markdownExcerpt } from "../../lib/text/excerpt.js";
import { registerAgentTool, type AgentToolContext } from "./registry.js";
import { clip, dateArg, editStudy, isUuid, readStudy, scrub, sharedAuthorship, studyRef, studyTarget, uuidArg, withEditableStudy } from "./util.js";

const TASK_STATUS_ZH: Record<string, string> = { open: "未完成", done: "已完成", dropped: "已放棄" };
const STUDY_STATUS_ZH: Record<string, string> = { active: "進行中", paused: "暫停", completed: "已完成", archived: "已封存" };
const ROLE_ZH: Record<string, string> = { owner: "擁有者", member: "成員", advisor: "指導教授" };

const compactTask = (t: Task) => ({
  id: t.id, title: t.title, status: t.status, status_label: TASK_STATUS_ZH[t.status] ?? t.status, due_on: t.due_on, assignee: t.assignee?.name ?? null, source: t.source,
  ...(t.detail_md ? { detail: clip(scrub(t.detail_md), 400) } : {}),
});

async function runAfter(ctx: AgentToolContext, after: (() => Promise<void>) | null) {
  if (after) await after().catch((e) => ctx.app.log.warn({ err: e }, "agent tool post-commit step failed"));
}

// ---------------------------------------------------------------- reads

registerAgentTool({
  name: "list_studies",
  title: "列出研究",
  titleEn: "List studies",
  risk: "read",
  description:
    "List studies in the lab (everyone can read every study). Use member='me' for the user's own studies, or a user id (from list_lab_members) for one person's studies (e.g. a professor asking about a student). Returns id, slug, title, status, current stage, next milestone, open task count and the user's role.",
  input: z.object({
    member: z.string().trim().max(64).optional().describe("'me', 'all' (default) or a user id (uuid): only studies that person belongs to"),
    q: z.string().max(100).optional().describe("Title or summary substring"),
    include_archived: z.boolean().optional(),
  }),
  summarize: (a) => (a.member === "me" ? "列出我的研究" : a.member && a.member !== "all" ? "列出成員的研究" : a.q ? `搜尋研究「${a.q}」` : "列出實驗室的研究"),
  async execute(a, ctx) {
    const member = !a.member || a.member === "all" ? null : a.member === "me" ? ctx.user.id : isUuid(a.member) ? a.member : (() => { throw badRequest("member 請用 me、all 或成員的帳號 id（可用 list_lab_members 查詢）。"); })();
    const cards = await studyCards(ctx.db, ctx.user.id, { memberId: member, q: a.q ?? null, status: a.include_archived ? "all" : null, limit: 50 });
    const studies = cards.slice(0, 50).map((c) => ({
      id: c.id, slug: c.slug, title: c.title, status: c.status, status_label: STUDY_STATUS_ZH[c.status] ?? c.status, my_role: c.my_role,
      my_role_label: c.my_role ? ROLE_ZH[c.my_role] ?? c.my_role : null, current_stage: c.current_stage?.name ?? null,
      next_milestone: c.next_milestone ? { title: c.next_milestone.title, due_on: c.next_milestone.due_on } : null,
      open_tasks: c.open_task_count, members: c.members.map((m) => `${m.name}（${ROLE_ZH[m.role] ?? m.role}）`), summary: clip(scrub(c.summary_excerpt ?? ""), 160),
    }));
    // Same rule as get_study (`sharedAuthorship`): text is untrusted when someone else can edit it; advisors cannot.
    const othersEdit = cards.some((c) => c.my_role !== "owner" || c.members.some((m) => m.id !== ctx.user.id && (m.role === "owner" || m.role === "member")));
    return { data: { studies }, untrusted: othersEdit };
  },
});

registerAgentTool({
  name: "get_study",
  title: "讀取研究",
  titleEn: "Read study",
  risk: "read",
  description: "Read one study: summary (Markdown), stages (with the current one), milestones, members and the user's permissions (can_edit).",
  input: z.object({ study: studyRef }),
  summarize: (a) => `讀取研究 ${a.study}`,
  async execute(a, ctx) {
    const access = await readStudy(ctx, a.study);
    const [stages, milestones, members] = await Promise.all([listStages(ctx.db, access.study.id), listMilestones(ctx.db, access.study.id), listMembers(ctx.db, access.study.id)]);
    const s = access.study;
    return {
      data: {
        study: { id: s.id, slug: s.slug, title: s.title, status: s.status, status_label: STUDY_STATUS_ZH[s.status] ?? s.status, maturity: s.maturity, maturity_label: s.maturity ? STUDY_MATURITY_ZH[s.maturity] : null, summary_md: clip(scrub(s.summary_md), 8000), url: studyUrl(s.slug) },
        stages: stages.map((g) => ({ id: g.id, name: g.name, current: g.is_current, done: !!g.completed_at, description: g.description || undefined })),
        milestones: milestones.map((m) => ({ id: m.id, title: m.title, due_on: m.due_on, done: !!m.done_at, stage_id: m.stage_id })),
        members: members.map((m) => ({ id: m.id, name: m.name, role: m.role, role_label: ROLE_ZH[m.role] ?? m.role })),
        permissions: { can_edit: access.canEdit, my_role: access.membership?.role ?? null },
      },
      untrusted: await sharedAuthorship(ctx, access),
      source: `研究〈${s.title}〉`,
    };
  },
});

registerAgentTool({
  name: "get_study_progress",
  title: "查看研究進度",
  titleEn: "Study progress",
  risk: "read",
  description:
    "Summarised progress of a study: current stage, stage list, open and done milestones, open tasks (≤20), recently done tasks, recent notes (titles + excerpts; read the full text with get_note before quoting numbers), recent meetings with the advisor's feedback, and the latest deck review comments.",
  input: z.object({ study: studyRef }),
  summarize: (a) => `查看研究 ${a.study} 的進度`,
  async execute(a, ctx) {
    const access = await readStudy(ctx, a.study);
    const id = access.study.id;
    const [stages, milestones, open, done, notes] = await Promise.all([
      listStages(ctx.db, id),
      listMilestones(ctx.db, id),
      ctx.db.query<Task>(`${TASK_SELECT} WHERE t.study_id=$1 AND t.status='open' ORDER BY t.due_on NULLS LAST, t.created_at LIMIT 20`, [id]),
      ctx.db.query<Task>(`${TASK_SELECT} WHERE t.study_id=$1 AND t.status='done' ORDER BY t.completed_at DESC NULLS LAST LIMIT 10`, [id]),
      ctx.db.query<{ id: string; title: string; event_date: string | null; content_md: string; author: string | null }>(
        `SELECT n.id,n.title,to_char(n.event_date,'YYYY-MM-DD') AS event_date,n.content_md,u.name AS author FROM notes n LEFT JOIN users u ON u.id=n.created_by
          WHERE n.study_id=$1 ORDER BY coalesce(n.event_date, n.created_at::date) DESC, n.created_at DESC LIMIT 5`,
        [id],
      ),
    ]);
    let meetings: { id: string; title: string; held_at: string | null; status: string; feedback?: string; draft_status?: string }[] = [];
    try {
      const rows = (await ctx.db.query<{ id: string; title: string; held_at: string | null; status: string; feedback_md: string | null; draft_status: string | null; direct: string | null }>(
        `SELECT m.id,m.title,to_char(m.held_at AT TIME ZONE 'Asia/Taipei','YYYY-MM-DD HH24:MI') AS held_at,m.status,d.feedback_md,d.status AS draft_status,
                (SELECT string_agg(f.body_md, E'\n') FROM meeting_feedback f WHERE f.meeting_id=m.id) AS direct
           FROM meetings m JOIN meeting_studies ms ON ms.meeting_id=m.id
           LEFT JOIN meeting_study_drafts d ON d.meeting_id=m.id AND d.study_id=ms.study_id AND d.status<>'dismissed'
          WHERE ms.study_id=$1 ORDER BY m.held_at DESC NULLS LAST LIMIT 5`,
        [id],
      )).rows;
      meetings = rows.map((m) => ({
        id: m.id, title: m.title, held_at: m.held_at, status: m.status,
        ...(m.feedback_md?.trim() || m.direct?.trim() ? { feedback: clip(scrub([m.direct, m.feedback_md].filter((x) => x?.trim()).join("\n")), 500) } : {}),
        ...(m.draft_status ? { draft_status: m.draft_status === "confirmed" ? "已確認" : "待確認" } : {}),
      }));
    } catch {
      meetings = []; // meetings module not installed (or its schema differs)
    }
    let reviews: { deck: string; page: number | null; author: string; body: string; at: string }[] = [];
    try {
      reviews = (await ctx.db.query<{ deck: string; page: number | null; author: string; body: string; at: string }>(
        `SELECT d.title AS deck,r.page,u.name AS author,r.body,to_char(r.created_at AT TIME ZONE 'Asia/Taipei','YYYY-MM-DD') AS at
           FROM slide_reviews r JOIN decks d ON d.id=r.deck_id JOIN users u ON u.id=r.author_id WHERE d.study_id=$1 ORDER BY r.created_at DESC LIMIT 5`,
        [id],
      )).rows.map((r) => ({ ...r, body: clip(scrub(r.body), 300) }));
    } catch {
      reviews = []; // slides module not installed
    }
    const current = stages.find((g) => g.is_current);
    return {
      data: {
        study: { id, slug: access.study.slug, title: access.study.title, status: access.study.status },
        current_stage: current?.name ?? null,
        stages: stages.map((g) => `${g.position + 1}. ${g.name}${g.is_current ? "（目前）" : g.completed_at ? "（完成）" : ""}`),
        milestones_open: milestones.filter((m) => !m.done_at).map((m) => ({ id: m.id, title: m.title, due_on: m.due_on })),
        milestones_done: milestones.filter((m) => m.done_at).length,
        open_tasks: open.rows.map(compactTask),
        recently_done_tasks: done.rows.map((t) => t.title),
        recent_notes: notes.rows.map((n) => ({ id: n.id, title: n.title, date: n.event_date, author: n.author, excerpt: clip(scrub(markdownExcerpt(n.content_md, 400)), 400) })),
        recent_meetings: meetings,
        recent_deck_reviews: reviews,
      },
      // Meeting feedback and review comments are other people's words.
      untrusted: meetings.some((m) => m.feedback) || reviews.length > 0 || (await sharedAuthorship(ctx, access)),
      source: `研究〈${access.study.title}〉`,
    };
  },
});

registerAgentTool({
  name: "list_tasks",
  title: "列出待辦",
  titleEn: "List tasks",
  risk: "read",
  description: "List tasks. With `study`: the study's tasks. Without: the user's own tasks across studies. Status defaults to open.",
  input: z.object({
    study: studyRef.optional(),
    status: z.enum(["open", "done", "dropped", "all"]).optional(),
    assignee: z.enum(["me", "anyone", "none"]).optional().describe("Filter by assignee (default: anyone in a study, me otherwise)"),
  }),
  summarize: (a) => (a.study ? `列出研究 ${a.study} 的待辦` : "列出我的待辦"),
  async execute(a, ctx) {
    const status = a.status ?? "open";
    const assignee = a.assignee ?? (a.study ? "anyone" : "me");
    const params: unknown[] = [status];
    let where = "($1='all' OR t.status=$1)";
    if (assignee === "me") where += ` AND t.assignee_id=$${params.push(ctx.user.id)}`;
    if (assignee === "none") where += " AND t.assignee_id IS NULL";
    let study = null;
    if (a.study) {
      const access = await readStudy(ctx, a.study);
      study = { id: access.study.id, slug: access.study.slug, title: access.study.title };
      where += ` AND t.study_id=$${params.push(access.study.id)}`;
    }
    const rows = (await ctx.db.query<Task & { study_title: string }>(
      `${TASK_SELECT.replace("FROM tasks t", "FROM tasks t JOIN studies st ON st.id=t.study_id").replace("t.created_at,t.updated_at", "t.created_at,t.updated_at,st.title AS study_title")}
        WHERE ${where} ORDER BY CASE t.status WHEN 'open' THEN 0 WHEN 'done' THEN 1 ELSE 2 END, t.due_on NULLS LAST, t.created_at DESC LIMIT 50`,
      params,
    )).rows;
    return {
      data: { study, tasks: rows.map((t) => ({ ...compactTask(t), ...(study ? {} : { study_id: t.study_id, study: t.study_title }) })) },
      untrusted: rows.some((t) => t.created_by !== ctx.user.id),
    };
  },
});

// ---------------------------------------------------------------- writes

const assigneeArg = z.string().max(64).nullable().optional().describe("'me', a member's user id (uuid), or null for unassigned");
const resolveAssignee = (v: string | null | undefined, ctx: AgentToolContext) => (v === "me" ? ctx.user.id : v === undefined ? undefined : v === null || v === "" ? null : isUuid(v) ? v : (() => { throw badRequest("負責人必須是研究成員的帳號 id。"); })());

registerAgentTool({
  name: "create_task",
  title: "建立待辦",
  titleEn: "Create task",
  risk: "write",
  description: "Create a task in a study the user is a member of. The assignee must be a study member.",
  input: z.object({
    study: studyRef,
    title: z.string().trim().min(1).max(300),
    detail_md: z.string().max(4000).optional(),
    due_on: dateArg.nullable().optional(),
    assignee: assigneeArg,
  }),
  summarize: (a) => `新增待辦「${a.title}」${a.due_on ? `，期限 ${a.due_on}` : ""}`,
  target: async (a, ctx) => studyTarget(await editStudy(ctx, a.study)),
  async execute(a, ctx) {
    const { task, after, slug } = await withEditableStudy(ctx, a.study, async (client, access) => ({
      ...(await createTask(client, ctx.app.notifier, access.study, ctx.user, {
        title: a.title, detail_md: a.detail_md, due_on: a.due_on ?? null, assignee_id: resolveAssignee(a.assignee, ctx), source: "ai", source_ref: ctx.conversationId ? `conversation:${ctx.conversationId}` : null,
      })),
      slug: access.study.slug,
    }));
    await runAfter(ctx, after);
    const stamp = (await ctx.db.query<{ stamp: string }>("SELECT updated_at::text AS stamp FROM tasks WHERE id=$1", [task.id])).rows[0]?.stamp;
    return {
      data: { task: compactTask(task) },
      links: [{ label: task.title, url: studyUrl(slug, "tasks"), kind: "task" }],
      ...(stamp ? { undo: { kind: "task" as const, id: task.id, studyId: task.study_id, stamp } } : {}),
    };
  },
});

registerAgentTool({
  name: "update_task",
  title: "更新待辦",
  titleEn: "Update task",
  risk: "write",
  description: "Update a task (title, detail, due date, status open/done/dropped, assignee) in a study the user is a member of.",
  input: z.object({
    study: studyRef,
    task_id: uuidArg("Task"),
    title: z.string().trim().min(1).max(300).optional(),
    detail_md: z.string().max(4000).optional(),
    due_on: dateArg.nullable().optional(),
    status: z.enum(["open", "done", "dropped"]).optional(),
    assignee: assigneeArg,
  }),
  summarize: (a) => {
    const parts = [a.status === "done" ? "標為完成" : a.status === "dropped" ? "標為放棄" : a.status === "open" ? "重新開啟" : "", a.title ? `改名為「${a.title}」` : "", a.due_on !== undefined ? `期限改為 ${a.due_on ?? "無"}` : ""].filter(Boolean);
    return `更新待辦${parts.length ? `：${parts.join("、")}` : ""}`;
  },
  target: async (a, ctx) => {
    const access = await editStudy(ctx, a.study);
    const task = isUuid(a.task_id) ? await getTask(ctx.db, access.study.id, a.task_id) : null;
    if (!task) throw notFound("待辦不存在。");
    return { ...studyTarget(access), label: `${access.study.title} · ${task.title}` };
  },
  async execute(a, ctx) {
    if (!isUuid(a.task_id)) throw notFound("待辦不存在。");
    const { task, after, slug } = await withEditableStudy(ctx, a.study, async (client, access) => ({
      ...(await updateTask(client, ctx.app.notifier, access.study, ctx.user, a.task_id, { title: a.title, detail_md: a.detail_md, due_on: a.due_on, status: a.status, assignee_id: resolveAssignee(a.assignee, ctx) })),
      slug: access.study.slug,
    }));
    await runAfter(ctx, after);
    const stamp = (await ctx.db.query<{ stamp: string }>("SELECT updated_at::text AS stamp FROM tasks WHERE id=$1", [task.id])).rows[0]?.stamp;
    return {
      data: { task: compactTask(task) },
      links: [{ label: task.title, url: studyUrl(slug, "tasks"), kind: "task" }],
      ...(stamp ? { undo: { kind: "task" as const, id: task.id, studyId: task.study_id, stamp } } : {}),
    };
  },
});

registerAgentTool({
  name: "add_milestone",
  title: "新增里程碑",
  titleEn: "Add milestone",
  risk: "write",
  description: "Add a milestone to a study the user is a member of, optionally under a stage (stage id or exact name).",
  input: z.object({ study: studyRef, title: z.string().trim().min(1).max(200), due_on: dateArg.nullable().optional(), stage: z.string().max(80).optional().describe("Stage id or name") }),
  summarize: (a) => `新增里程碑「${a.title}」${a.due_on ? `，${a.due_on}` : ""}`,
  target: async (a, ctx) => studyTarget(await editStudy(ctx, a.study)),
  async execute(a, ctx) {
    const milestone = await withEditableStudy(ctx, a.study, async (client, access) => {
      let stageId: string | null = null;
      if (a.stage) {
        const stage = (await client.query<{ id: string }>("SELECT id FROM study_stages WHERE study_id=$1 AND (id::text=$2 OR name=$2) ORDER BY position LIMIT 1", [access.study.id, a.stage])).rows[0];
        if (!stage) throw badRequest(`找不到階段「${a.stage}」。`);
        stageId = stage.id;
      }
      const id = (await client.query<{ id: string }>("INSERT INTO milestones(study_id,stage_id,title,due_on,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id", [access.study.id, stageId, a.title, a.due_on ?? null, ctx.user.id])).rows[0]!.id;
      await client.query("UPDATE studies SET activity_at=now() WHERE id=$1", [access.study.id]);
      return { ...(await client.query(`${MILESTONE_SELECT} WHERE m.id=$1`, [id])).rows[0], slug: access.study.slug };
    });
    return { data: { milestone: { id: milestone.id, title: milestone.title, due_on: milestone.due_on, stage_id: milestone.stage_id } }, links: [{ label: milestone.title, url: studyUrl(milestone.slug), kind: "study" }] };
  },
});

registerAgentTool({
  name: "set_stage",
  title: "切換研究階段",
  titleEn: "Set current stage",
  risk: "write",
  description: "Make a stage the current stage of a study (earlier stages become completed). Stage id or exact name.",
  input: z.object({ study: studyRef, stage: z.string().min(1).max(80).describe("Stage id or name") }),
  summarize: (a) => `把目前階段切換為「${a.stage}」`,
  target: async (a, ctx) => studyTarget(await editStudy(ctx, a.study)),
  async execute(a, ctx) {
    const res = await withEditableStudy(ctx, a.study, async (client, access) => {
      const { study } = access;
      const stage = (await client.query<{ id: string; position: number; name: string }>("SELECT id,position,name FROM study_stages WHERE study_id=$1 AND (id::text=$2 OR name=$2) ORDER BY position LIMIT 1", [study.id, a.stage])).rows[0];
      if (!stage) throw badRequest(`找不到階段「${a.stage}」。`);
      const previous = study.current_stage_id ? ((await client.query<{ name: string }>("SELECT name FROM study_stages WHERE id=$1", [study.current_stage_id])).rows[0]?.name ?? null) : null;
      // Same rules as POST /studies/:ref/stages/:id/current.
      await client.query("UPDATE study_stages SET completed_at=COALESCE(completed_at,now()),started_at=COALESCE(started_at,now()) WHERE study_id=$1 AND position<$2", [study.id, stage.position]);
      await client.query("UPDATE study_stages SET completed_at=NULL WHERE study_id=$1 AND position>$2", [study.id, stage.position]);
      await client.query("UPDATE study_stages SET started_at=COALESCE(started_at,now()),completed_at=NULL WHERE id=$1", [stage.id]);
      if (study.current_stage_id !== stage.id) {
        await client.query("UPDATE studies SET current_stage_id=$2,updated_at=now() WHERE id=$1", [study.id, stage.id]);
        await recordActivity(client, { studyId: study.id, actorId: ctx.user.id, kind: "stage_changed", title: stage.name, url: studyUrl(study.slug), targetType: "stage", targetId: stage.id, metadata: { from: previous, to: stage.name } });
      }
      return { stage: stage.name, previous, slug: study.slug };
    });
    return { data: { current_stage: res.stage, previous: res.previous }, links: [{ label: res.stage, url: studyUrl(res.slug), kind: "study" }] };
  },
});

registerAgentTool({
  name: "suggest_study_summary",
  title: "建議修改研究簡述",
  titleEn: "Suggest study summary",
  risk: "write",
  suggests: true,
  description: "Propose a new study summary (full Markdown text). It becomes a suggestion the members review paragraph by paragraph; nothing is changed directly.",
  input: z.object({ study: studyRef, summary_md: z.string().min(1).max(20000), title: z.string().max(80).optional().describe("Short label for the suggestion") }),
  summarize: (a) => `建議修改研究簡述${a.title ? `：${a.title}` : ""}`,
  target: async (a, ctx) => ({ ...studyTarget(await editStudy(ctx, a.study)), url: undefined }),
  async execute(a, ctx) {
    const access = await editStudy(ctx, a.study);
    const input = {
      targetType: "study_summary", targetId: access.study.id, proposedText: a.summary_md, title: a.title || "AI 建議的研究簡述",
      source: "ai" as const, actorId: ctx.user.id, conversationId: ctx.conversationId, user: ctx.user,
    };
    const deps = { db: ctx.db, collab: ctx.app.collab ?? null };
    if (ctx.autopilot && ctx.source === "agent") {
      const before = access.study.summary_md;
      const r = await applySuggestionNow(deps, { ...input, source: "autopilot" });
      const after = (await ctx.db.query<{ summary_md: string }>("SELECT summary_md FROM studies WHERE id=$1", [access.study.id])).rows[0]?.summary_md ?? "";
      return {
        data: { applied: r.applied, suggestion_id: r.suggestion.id },
        links: [{ label: "已自動套用到研究簡述", url: studyUrl(access.study.slug), kind: "study" }],
        undo: { kind: "text", targetType: "study_summary", targetId: access.study.id, before, after },
      };
    }
    const s = await createSuggestion(deps, input);
    return { data: { suggestion_id: s.id, hunks: s.pending, status: "pending_review" }, links: [{ label: "在研究概覽中檢視建議", url: `${studyUrl(access.study.slug)}${studyUrl(access.study.slug).includes("?") ? "&" : "?"}suggestion=${s.id}`, kind: "suggestion" }] };
  },
});

// ---------------------------------------------------------------- destructive

registerAgentTool({
  name: "delete_task",
  title: "刪除待辦",
  titleEn: "Delete task",
  risk: "destructive",
  description: "Permanently delete a task. Always asks the user.",
  input: z.object({ study: studyRef, task_id: uuidArg("Task") }),
  summarize: () => "刪除待辦",
  target: async (a, ctx) => {
    const access = await editStudy(ctx, a.study);
    const task = isUuid(a.task_id) ? await getTask(ctx.db, access.study.id, a.task_id) : null;
    if (!task) throw notFound("待辦不存在。");
    return { ...studyTarget(access), label: `${access.study.title} · ${task.title}`, url: studyUrl(access.study.slug, "tasks") };
  },
  async execute(a, ctx) {
    const access = await editStudy(ctx, a.study);
    if (!isUuid(a.task_id)) throw notFound("待辦不存在。");
    const removed = await ctx.db.query<{ title: string }>("DELETE FROM tasks WHERE id=$1 AND study_id=$2 RETURNING title", [a.task_id, access.study.id]);
    if (!removed.rowCount) throw notFound("待辦不存在。");
    return { data: { deleted: true, title: removed.rows[0]!.title } };
  },
});
