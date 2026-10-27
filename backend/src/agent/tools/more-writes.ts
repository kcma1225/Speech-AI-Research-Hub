/**
 * Agent tools added by the AI-capability audit (so the assistant stops giving up or hand-duplicating work):
 * milestones, study reading list entries, LaTeX sections/settings, meeting drafts + feedback, note history.
 * Every tool goes through the module's domain helpers with the caller's permissions (docs/architecture.md "Agent").
 */
import { diffLines } from "diff";
import { z } from "zod";
import { transaction } from "../../db.js";
import { ADMIN_WORKSPACE_FORBIDDEN } from "../../lib/auth.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/http.js";
import { LATEX_COMPILERS } from "../../lib/latex/contract.js";
import { nextSectionName } from "../../lib/latex/templates.js";
import { addSectionFile } from "../../lib/latex-projects/service.js";
import { bibFileOf, findFile, findFileByPath, findProject, latexDocName, latexUrl, listFiles, type ProjectRow } from "../../lib/latex-projects/store.js";
import { READING_STATUSES, tagsSchema } from "../../lib/library/schema.js";
import { confirmDraft, patchDraft } from "../../lib/meetings/drafts.js";
import { findMeeting, meetingUrl, type DraftRow, type MeetingRow } from "../../lib/meetings/store.js";
import { taipeiDateTime } from "../../lib/meetings/time.js";
import { findNote, noteDocName, noteUrl } from "../../lib/notes/store.js";
import { loadStudyAccess, studyUrl, type StudyAccess } from "../../lib/studies/access.js";
import { recordActivity } from "../../lib/studies/activity.js";
import { updateMilestone } from "../../lib/studies/milestones.js";
import type { AfterCommit } from "../../lib/studies/tasks.js";
import { registerAgentTool, type AgentToolContext } from "./registry.js";
import { clip, dateArg, editStudy, isUuid, scrub, studyRef, studyTarget, uuidArg, withEditableStudy } from "./util.js";

/** Admin accounts are system-only: the research workspace (and so the assistant) is refused, as over HTTP. */
function workspaceUser(ctx: AgentToolContext) {
  if (ctx.user.role === "admin") throw forbidden(ADMIN_WORKSPACE_FORBIDDEN);
}

async function runAll(ctx: AgentToolContext, after: (AfterCommit | null | undefined)[]) {
  for (const fn of after) if (fn) await fn().catch((e) => ctx.app.log.warn({ err: e }, "agent tool post-commit step failed"));
}

const excerpt = (text: string, max = 40) => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
};

/** 「+3 行／−1 行」 line-diff summary of a text change. */
export function lineDiffSummary(before: string, after: string) {
  let added = 0;
  let removed = 0;
  const changes: { removed?: string; added?: string }[] = [];
  for (const part of diffLines(before, after)) {
    const lines = part.count ?? part.value.split("\n").filter(Boolean).length;
    if (part.added) {
      added += lines;
      const last = changes.at(-1);
      if (last && last.removed !== undefined && last.added === undefined) last.added = part.value;
      else changes.push({ added: part.value });
    } else if (part.removed) {
      removed += lines;
      changes.push({ removed: part.value });
    }
  }
  return { added, removed, changes, label: added || removed ? `+${added} 行／−${removed} 行` : "沒有變更" };
}

// ---------------------------------------------------------------- milestones

registerAgentTool({
  name: "update_milestone",
  title: "更新里程碑",
  titleEn: "Update milestone",
  risk: "write",
  description:
    "Update a milestone of a study the user is a member of: mark it done (done=true) or not done, rename it, change its due date (null clears it) or move it to another stage (stage_id from get_study; null = no stage). Milestone ids come from get_study / get_study_progress.",
  input: z.object({
    study: studyRef,
    milestone_id: uuidArg("Milestone"),
    title: z.string().trim().min(1).max(200).optional(),
    due_on: dateArg.nullable().optional(),
    done: z.boolean().optional(),
    stage_id: z.string().trim().max(64).nullable().optional().describe("Stage id (uuid) or null for no stage"),
  }),
  summarize: (a) => {
    const parts = [a.done === true ? "標為完成" : a.done === false ? "改回未完成" : "", a.title ? `改名為「${a.title}」` : "", a.due_on !== undefined ? `日期改為 ${a.due_on ?? "無"}` : "", a.stage_id !== undefined ? "移到其他階段" : ""].filter(Boolean);
    return `更新里程碑${parts.length ? `：${parts.join("、")}` : ""}`;
  },
  async target(a, ctx) {
    workspaceUser(ctx);
    const access = await editStudy(ctx, a.study);
    const m = isUuid(a.milestone_id) ? (await ctx.db.query<{ title: string }>("SELECT title FROM milestones WHERE id=$1 AND study_id=$2", [a.milestone_id, access.study.id])).rows[0] : null;
    if (!m) throw notFound("里程碑不存在。");
    return { ...studyTarget(access), label: `${access.study.title} · ${m.title}` };
  },
  async execute(a, ctx) {
    workspaceUser(ctx);
    if (!isUuid(a.milestone_id)) throw notFound("里程碑不存在。");
    if (a.stage_id && !isUuid(a.stage_id)) throw badRequest("階段不存在。");
    if (a.title === undefined && a.due_on === undefined && a.done === undefined && a.stage_id === undefined) throw badRequest("沒有要更新的欄位。");
    const r = await withEditableStudy(ctx, a.study, async (client, access) => ({
      ...(await updateMilestone(client, access.study, ctx.user, a.milestone_id, { title: a.title, due_on: a.due_on, done: a.done, stage_id: a.stage_id })),
      slug: access.study.slug,
    }));
    const m = r.milestone;
    return {
      data: { milestone: { id: m.id, title: m.title, due_on: m.due_on, done: !!m.done_at, stage_id: m.stage_id }, recorded_done: r.justDone },
      links: [{ label: m.title, url: studyUrl(r.slug), kind: "study" }],
    };
  },
});

// ---------------------------------------------------------------- study reading list

const NOT_IN_STUDY = "這篇文獻不在此研究的文獻庫中。";
const READING_ZH: Record<string, string> = { unread: "未讀", reading: "閱讀中", read: "已讀" };
const notesEdit = z.object({ before: z.string().min(1).max(20000).describe("Exact text currently in the notes"), after: z.string().max(20000) });

type StudyPaperInfo = { title: string; notes_md: string; reading_status: string; tags: string[] };

async function studyPaper(ctx: AgentToolContext, studyId: string, paperId: string) {
  if (!isUuid(paperId)) throw notFound(NOT_IN_STUDY);
  const row = (await ctx.db.query<StudyPaperInfo>(
    "SELECT p.title, sp.notes_md, sp.reading_status, sp.tags FROM study_papers sp JOIN papers p ON p.id=sp.paper_id WHERE sp.study_id=$1 AND sp.paper_id=$2",
    [studyId, paperId],
  )).rows[0];
  if (!row) throw notFound(NOT_IN_STUDY);
  return row;
}

/** New notes text from `notes_md` (full) or exact `edits`; null when the call does not touch the notes. */
function nextNotes(current: string, a: { notes_md?: string; edits?: { before: string; after: string }[] }) {
  if (a.notes_md !== undefined && a.edits?.length) throw badRequest("notes_md 與 edits 只能擇一。");
  if (a.notes_md !== undefined) return a.notes_md;
  if (!a.edits?.length) return null;
  let text = current;
  for (const e of a.edits) {
    const first = text.indexOf(e.before);
    if (first === -1) throw conflict("閱讀筆記裡找不到要修改的原文，請先用 get_paper 讀取最新內容。");
    if (text.indexOf(e.before, first + 1) !== -1) throw conflict("要修改的原文在閱讀筆記中出現不只一次，請多帶一點前後文。");
    text = text.slice(0, first) + e.after + text.slice(first + e.before.length);
  }
  return text;
}

registerAgentTool({
  name: "update_study_paper",
  title: "更新文獻閱讀狀態與筆記",
  titleEn: "Update study paper",
  risk: "write",
  description:
    "Update a paper in a study's reading list (study members only): reading_status unread|reading|read, tags (replaces the list), and the reading notes — either the full new Markdown (notes_md) or exact replacements (edits: [{before, after}], before must occur once). Reading notes are the user's own text: changing them shows the user a consent card with the change (under autopilot it is applied and can be undone). Read the current notes with get_paper first.",
  input: z.object({
    study: studyRef,
    paper_id: uuidArg("Paper"),
    reading_status: z.enum(READING_STATUSES).optional(),
    tags: tagsSchema.optional(),
    notes_md: z.string().max(200_000).optional().describe("Full new reading notes (Markdown)"),
    edits: z.array(notesEdit).min(1).max(20).optional().describe("Exact replacements inside the reading notes"),
  }),
  // The user's own notes never change without them seeing the change.
  requireCard: (a) => a.notes_md !== undefined || !!a.edits?.length,
  summarize: (a) => {
    const parts = [a.reading_status ? `標為${READING_ZH[a.reading_status]}` : "", a.tags ? `標籤改為 ${a.tags.join("、") || "（無）"}` : "", a.notes_md !== undefined ? `改寫閱讀筆記：「${excerpt(a.notes_md)}」` : a.edits?.length ? `修改閱讀筆記 ${a.edits.length} 處` : ""].filter(Boolean);
    return `更新研究文獻${parts.length ? `：${parts.join("、")}` : ""}`;
  },
  async target(a, ctx) {
    workspaceUser(ctx);
    const access = await editStudy(ctx, a.study);
    const p = await studyPaper(ctx, access.study.id, a.paper_id);
    const next = nextNotes(p.notes_md, a);
    const diff = next === null ? "" : ` · 閱讀筆記 ${lineDiffSummary(p.notes_md, next).label}`;
    return { ...studyTarget(access), label: `${access.study.title} · ${clip(p.title, 60)}${diff}`, url: studyUrl(access.study.slug, "papers") };
  },
  async execute(a, ctx) {
    workspaceUser(ctx);
    if (a.reading_status === undefined && a.tags === undefined && a.notes_md === undefined && !a.edits?.length) throw badRequest("沒有要更新的欄位。");
    const r = await withEditableStudy(ctx, a.study, async (client, access) => {
      const current = (await client.query<StudyPaperInfo>(
        "SELECT p.title, sp.notes_md, sp.reading_status, sp.tags FROM study_papers sp JOIN papers p ON p.id=sp.paper_id WHERE sp.study_id=$1 AND sp.paper_id=$2 FOR UPDATE OF sp",
        [access.study.id, isUuid(a.paper_id) ? a.paper_id : "00000000-0000-0000-0000-000000000000"],
      )).rows[0];
      if (!current) throw notFound(NOT_IN_STUDY);
      const notes = nextNotes(current.notes_md, a);
      // Same columns as PATCH /studies/:ref/papers/:paperId.
      const sets = ["updated_at=now()"];
      const params: unknown[] = [access.study.id, a.paper_id];
      const add = (sql: string, v: unknown) => sets.push(`${sql}=$${params.push(v)}`);
      if (a.reading_status) add("reading_status", a.reading_status);
      if (a.tags) add("tags", a.tags);
      if (notes !== null) {
        add("notes_md", notes);
        add("notes_updated_by", ctx.user.id);
        sets.push("notes_updated_at=now()");
      }
      await client.query(`UPDATE study_papers SET ${sets.join(",")} WHERE study_id=$1 AND paper_id=$2`, params);
      if (a.reading_status === "read" && current.reading_status !== "read") {
        await recordActivity(client, { studyId: access.study.id, actorId: ctx.user.id, kind: "paper_read", title: current.title, url: studyUrl(access.study.slug, "papers"), targetType: "paper", targetId: a.paper_id });
      }
      return { title: current.title, slug: access.study.slug, studyId: access.study.id, before: current.notes_md, notes, notesDiff: notes === null ? null : lineDiffSummary(current.notes_md, notes).label };
    });
    return {
      // Autopilot ran it without a card: 「復原」 puts the previous reading notes back (only while unchanged).
      ...(r.notes !== null && r.notes !== r.before ? { undo: { kind: "paper_notes" as const, studyId: r.studyId, paperId: a.paper_id, before: r.before, after: r.notes } } : {}),
      data: { paper: { id: a.paper_id, title: r.title }, reading_status: a.reading_status, reading_status_label: a.reading_status ? READING_ZH[a.reading_status] : undefined, tags: a.tags, notes: r.notesDiff },
      links: [{ label: r.title, url: studyUrl(r.slug, "papers"), kind: "paper" }],
    };
  },
});

// ---------------------------------------------------------------- LaTeX

const latexDeps = (ctx: AgentToolContext) => ({ db: ctx.db, storage: ctx.app.storage, collab: ctx.app.collab ?? null });
const COMPILER_ZH: Record<string, string> = { pdflatex: "pdfLaTeX", xelatex: "XeLaTeX", lualatex: "LuaLaTeX" };

async function editableProject(ctx: AgentToolContext, projectId: string): Promise<{ project: ProjectRow; access: StudyAccess }> {
  workspaceUser(ctx);
  const project = isUuid(projectId) ? await findProject(ctx.db, projectId) : null;
  if (!project) throw notFound("LaTeX 專案不存在。");
  const access = await loadStudyAccess(ctx.db, project.study_id, ctx.user);
  if (!access.canEdit) throw forbidden(`你不是〈${access.study.title}〉的成員，不能修改這個 LaTeX 專案。`);
  return { project, access };
}

const projectTarget = (project: ProjectRow, access: StudyAccess) => ({ ...studyTarget(access), label: `${access.study.title} · ${project.title}`, url: latexUrl(access.study.slug, project.id) });

registerAgentTool({
  name: "latex_add_section",
  title: "新增 LaTeX 章節",
  titleEn: "Add LaTeX section",
  risk: "write",
  description:
    "Add a section (chapter) to a LaTeX project: creates sections/<name>.tex with the heading and inserts its \\input into the root file, after the section `after` (file id or path; default: after the last section). Then use latex_suggest_edit to fill it.",
  input: z.object({
    project_id: uuidArg("LaTeX project"),
    title: z.string().trim().min(1).max(200).describe("Section heading, e.g. 相關研究"),
    name: z.string().trim().max(64).optional().describe("File name without .tex (letters, digits, - and _), e.g. related-work"),
    after: z.string().trim().max(255).optional().describe("Section file id or path to insert after"),
  }),
  summarize: (a) => `新增章節「${a.title}」`,
  target: async (a, ctx) => {
    const { project, access } = await editableProject(ctx, a.project_id);
    return projectTarget(project, access);
  },
  async execute(a, ctx) {
    const { project, access } = await editableProject(ctx, a.project_id);
    let afterId: string | null = null;
    if (a.after) {
      const file = isUuid(a.after) ? await findFile(ctx.db, project.id, a.after) : await findFileByPath(ctx.db, project.id, a.after);
      if (!file) throw notFound("找不到要接在後面的章節，請先用 latex_list_projects 查看檔案清單。");
      afterId = file.id;
    }
    const files = await listFiles(ctx.db, project.id);
    const name = a.name || nextSectionName(files.map((f) => f.path).filter((p) => p.startsWith("sections/")));
    const fileId = await addSectionFile(latexDeps(ctx), project, { title: a.title, name, afterFileId: afterId, actorId: ctx.user.id });
    const file = (await findFile(ctx.db, project.id, fileId))!;
    return {
      data: { file: { id: file.id, path: file.path, role: file.role }, project: { id: project.id, title: project.title } },
      links: [{ label: file.path, url: latexUrl(access.study.slug, project.id, file.id) }],
    };
  },
});

registerAgentTool({
  name: "latex_update_project",
  title: "修改 LaTeX 專案設定",
  titleEn: "Update LaTeX project settings",
  risk: "write",
  description:
    "Change a LaTeX project's settings: compiler (pdflatex|xelatex|lualatex — use xelatex for Chinese text / ctex / xeCJK / fontspec when pdflatex fails), title, bib_mode (auto = refs.bib generated from the study library before each compile; manual = the user edits the .bib file).",
  input: z.object({
    project_id: uuidArg("LaTeX project"),
    compiler: z.enum(LATEX_COMPILERS).optional(),
    title: z.string().trim().min(1).max(200).optional(),
    bib_mode: z.enum(["auto", "manual"]).optional(),
  }),
  summarize: (a) => {
    const parts = [a.compiler ? `編譯器改為 ${COMPILER_ZH[a.compiler]}` : "", a.title ? `名稱改為「${a.title}」` : "", a.bib_mode ? `參考文獻改為${a.bib_mode === "auto" ? "自動（由文獻庫產生）" : "手動"}` : ""].filter(Boolean);
    return `修改 LaTeX 專案設定${parts.length ? `：${parts.join("、")}` : ""}`;
  },
  target: async (a, ctx) => {
    const { project, access } = await editableProject(ctx, a.project_id);
    return projectTarget(project, access);
  },
  async execute(a, ctx) {
    const { project } = await editableProject(ctx, a.project_id);
    if (!a.compiler && !a.title && !a.bib_mode) throw badRequest("沒有要更新的設定。");
    // Same as PATCH /latex/:id for these fields.
    await ctx.db.query(
      "UPDATE latex_projects SET title=coalesce($2,title), compiler=coalesce($3,compiler), bib_mode=coalesce($4,bib_mode), updated_at=now(), updated_by=$5 WHERE id=$1",
      [project.id, a.title ?? null, a.compiler ?? null, a.bib_mode ?? null, ctx.user.id],
    );
    const fresh = (await findProject(ctx.db, project.id))!;
    const collab = ctx.app.collab;
    if (collab) {
      // The bib file's read-only state follows bib_mode: reconnect its editors; open editors refetch the settings.
      if (a.bib_mode !== undefined) {
        const bib = await findFileByPath(ctx.db, project.id, bibFileOf(fresh));
        if (bib) collab.closeDocument(latexDocName(project.id, bib.id));
      }
      for (const f of await listFiles(ctx.db, project.id)) if (f.kind === "text") collab.broadcast(latexDocName(project.id, f.id), { type: "latex_meta" });
    }
    return {
      data: { project: { id: fresh.id, title: fresh.title, compiler: fresh.compiler, compiler_label: COMPILER_ZH[fresh.compiler], bib_mode: fresh.bib_mode }, hint: a.compiler ? "設定已更新；需要時呼叫 latex_compile 重新編譯。" : undefined },
    };
  },
});

// ---------------------------------------------------------------- meetings

const meetingArg = z.string().trim().min(1).max(64).describe("Meeting id (uuid), e.g. from list_meetings");
const DRAFT_FORBIDDEN = "只有該研究的成員可以處理這份草稿。";

async function meetingOr404(ctx: AgentToolContext, id: string): Promise<MeetingRow> {
  const meeting = isUuid(id) ? await findMeeting(ctx.db, id) : null;
  if (!meeting) throw notFound("會議不存在。");
  return meeting;
}

/** The meeting, the study's draft and the caller's access; 403 unless an owner/member of THAT study (never advisors). */
async function draftFor(ctx: AgentToolContext, meetingId: string, studyRefArg: string) {
  workspaceUser(ctx);
  const meeting = await meetingOr404(ctx, meetingId);
  const access = await loadStudyAccess(ctx.db, studyRefArg, ctx.user);
  const draft = (await ctx.db.query<DraftRow>("SELECT * FROM meeting_study_drafts WHERE meeting_id=$1 AND study_id=$2", [meeting.id, access.study.id])).rows[0];
  if (!draft) throw notFound(`會議「${meeting.title}」沒有〈${access.study.title}〉的草稿（可能還沒分析）。`);
  if (!access.canEdit) throw forbidden(DRAFT_FORBIDDEN);
  return { meeting, access, draft };
}

const assigneeArg = z.string().max(64).nullable().optional().describe("'me', a study member's user id (uuid), or null");
const proposedTask = z.object({ title: z.string().trim().min(1).max(300), detail: z.string().max(4000).optional(), assignee: assigneeArg, due: dateArg.nullable().optional() });

const textEdits = z.array(z.object({ before: z.string().min(1).max(20000).describe("Exact current text (must appear once)"), after: z.string().max(20000) })).max(30);
const taskEdit = z.object({
  op: z.enum(["add", "update", "remove"]),
  index: z.number().int().min(1).max(50).optional().describe("1-based position in the current proposed_tasks"),
  match: z.string().trim().min(1).max(300).optional().describe("Current task title (or a unique part of it)"),
  task: proposedTask.partial().optional().describe("add: the new task (title required); update: only the fields to change"),
});

type DraftTask = { id?: string; title: string; detail: string; assignee_id: string | null; due: string | null };
const squashTitle = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");

/** The task an edit points at (by 1-based index or by title); 400 when it is missing or ambiguous. */
function taskIndex(tasks: DraftTask[], e: { index?: number; match?: string }): number {
  if (e.index !== undefined) {
    if (!tasks[e.index - 1]) throw badRequest(`草稿沒有第 ${e.index} 項待辦（目前共 ${tasks.length} 項）。`);
    if (e.match && !squashTitle(tasks[e.index - 1]!.title).includes(squashTitle(e.match))) throw conflict(`第 ${e.index} 項待辦是「${tasks[e.index - 1]!.title}」，不是「${e.match}」；請先用 get_meeting 讀取最新草稿。`);
    return e.index - 1;
  }
  if (!e.match) throw badRequest("請用 index 或 match 指定要修改的待辦。");
  const k = squashTitle(e.match);
  const exact = tasks.findIndex((t) => squashTitle(t.title) === k);
  if (exact >= 0) return exact;
  const hits = tasks.map((t, i) => ({ t, i })).filter((x) => squashTitle(x.t.title).includes(k));
  if (hits.length === 1) return hits[0]!.i;
  throw badRequest(hits.length ? `「${e.match}」符合多項待辦，請改用 index。` : `草稿裡沒有「${e.match}」這項待辦。`);
}

/** Applies targeted task edits; every task the edits do not name is kept exactly as it was. */
export function applyTaskEdits(tasks: DraftTask[], edits: z.infer<typeof taskEdit>[], assignee: (v: string | null | undefined) => string | null): { tasks: DraftTask[]; removed: string[] } {
  const out = tasks.map((t) => ({ ...t }));
  const drop = new Set<number>();
  const added: DraftTask[] = [];
  for (const e of edits) {
    if (e.op === "add") {
      if (!e.task?.title) throw badRequest("新增待辦需要 title。");
      added.push({ title: e.task.title, detail: e.task.detail ?? "", due: e.task.due ?? null, assignee_id: assignee(e.task.assignee) });
      continue;
    }
    const i = taskIndex(tasks, e);
    if (e.op === "remove") drop.add(i);
    else {
      if (!e.task) throw badRequest("修改待辦需要 task（要改的欄位）。");
      const t = out[i]!;
      if (e.task.title !== undefined) t.title = e.task.title;
      if (e.task.detail !== undefined) t.detail = e.task.detail;
      if (e.task.due !== undefined) t.due = e.task.due;
      if (e.task.assignee !== undefined) t.assignee_id = assignee(e.task.assignee);
    }
  }
  return { tasks: [...out.filter((_, i) => !drop.has(i)), ...added], removed: [...drop].map((i) => tasks[i]!.title) };
}

/** Current tasks a full replacement list leaves out (matched by title). */
export function droppedTasks(current: { title: string }[], next: { title: string }[]): string[] {
  const keep = new Set(next.map((t) => squashTitle(t.title)));
  return current.filter((t) => !keep.has(squashTitle(t.title))).map((t) => t.title);
}

function applyTextEdits(current: string, edits: { before: string; after: string }[], label: string): string {
  let text = current;
  for (const e of edits) {
    const first = text.indexOf(e.before);
    if (first === -1) throw conflict(`草稿的${label}裡找不到要修改的原文：「${clip(e.before, 40)}」，請先用 get_meeting 讀取最新草稿。`);
    if (text.indexOf(e.before, first + 1) !== -1) throw conflict(`要修改的原文在草稿的${label}中出現不只一次，請多帶一點前後文。`);
    text = text.slice(0, first) + e.after + text.slice(first + e.before.length);
  }
  return text;
}

registerAgentTool({
  name: "suggest_meeting_draft_edit",
  title: "修改會議草稿",
  titleEn: "Edit meeting draft",
  risk: "write",
  description:
    "Edit the pending AI draft of one study in a meeting (members of that study only; advisors cannot). Targeted forms (use these for any change to part of the draft): `summary_edits` / `feedback_edits` (exact `before` passages and their replacement) and `task_edits` (add a task, update or remove one by its 1-based `index` in the current list or by `match` = its title); every task not named is kept as it is. Whole-field forms: summary_md / feedback_md (full new text) and proposed_tasks (the whole new list): a list that leaves out current tasks is refused — remove tasks with task_edits op=remove, or list them in `remove_tasks` when the user asked to drop them. Nothing is written to the study until the user confirms the draft (confirm_meeting_draft or the meeting page). Use this instead of creating tasks from meeting content by hand.",
  input: z.object({
    meeting_id: meetingArg,
    study: studyRef,
    summary_md: z.string().max(30000).optional(),
    feedback_md: z.string().max(30000).optional(),
    summary_edits: textEdits.optional(),
    feedback_edits: textEdits.optional(),
    proposed_tasks: z.array(proposedTask).max(50).optional(),
    task_edits: z.array(taskEdit).max(30).optional(),
    remove_tasks: z.array(z.string().trim().min(1).max(300)).max(50).optional().describe("With proposed_tasks: titles of current tasks the user asked to remove"),
  }),
  summarize: (a) => {
    const parts = [
      a.summary_md !== undefined || a.summary_edits?.length ? "摘要" : "",
      a.feedback_md !== undefined || a.feedback_edits?.length ? "回饋" : "",
      a.proposed_tasks ? `待辦（${a.proposed_tasks.length} 項）` : "",
      a.task_edits?.length ? `待辦（${a.task_edits.length} 處修改）` : "",
    ].filter(Boolean);
    return `修改會議草稿${parts.length ? `的${parts.join("、")}` : ""}`;
  },
  async target(a, ctx) {
    const { meeting, access, draft } = await draftFor(ctx, a.meeting_id, a.study);
    if (draft.status !== "pending") throw conflict("這份草稿已經處理過了。");
    return { ...studyTarget(access), label: `${access.study.title} · ${meeting.title}`, url: meetingUrl(meeting.id) };
  },
  async execute(a, ctx) {
    const { meeting, draft } = await draftFor(ctx, a.meeting_id, a.study);
    if (a.summary_md === undefined && a.feedback_md === undefined && !a.summary_edits?.length && !a.feedback_edits?.length && !a.proposed_tasks && !a.task_edits?.length) throw badRequest("沒有要修改的內容。");
    if (a.summary_md !== undefined && a.summary_edits?.length) throw badRequest("summary_md 與 summary_edits 只能擇一。");
    if (a.feedback_md !== undefined && a.feedback_edits?.length) throw badRequest("feedback_md 與 feedback_edits 只能擇一。");
    if (a.proposed_tasks && a.task_edits?.length) throw badRequest("proposed_tasks 與 task_edits 只能擇一。");
    const assignee = (v: string | null | undefined) => (v === "me" ? ctx.user.id : v && isUuid(v) ? v : v ? (() => { throw badRequest("負責人必須是研究成員的帳號 id。"); })() : null);
    const current = draft.proposed_tasks as DraftTask[];
    let tasks: DraftTask[] | undefined;
    let removed: string[] = [];
    if (a.proposed_tasks) {
      tasks = a.proposed_tasks.map((t) => ({ title: t.title, detail: t.detail ?? "", due: t.due ?? null, assignee_id: assignee(t.assignee) }));
      const asked = new Set((a.remove_tasks ?? []).map(squashTitle));
      const dropped = droppedTasks(current, tasks);
      const silent = dropped.filter((t) => !asked.has(squashTitle(t)));
      if (silent.length) {
        throw badRequest(`這份待辦清單少了草稿原有的 ${silent.length} 項：${silent.map((t) => `「${clip(t, 40)}」`).join("、")}。只改部分待辦請用 task_edits；使用者要求刪除時，用 task_edits 的 remove 或把標題列在 remove_tasks。`);
      }
      removed = dropped;
    } else if (a.task_edits?.length) {
      const r = applyTaskEdits(current, a.task_edits, assignee);
      tasks = r.tasks;
      removed = r.removed;
    }
    const summary = a.summary_edits?.length ? applyTextEdits(draft.summary_md, a.summary_edits, "摘要") : a.summary_md;
    const feedback = a.feedback_edits?.length ? applyTextEdits(draft.feedback_md, a.feedback_edits, "回饋") : a.feedback_md;
    await transaction(ctx.db, (client) => patchDraft(client, meeting.id, draft.id, ctx.user, { summary_md: summary, feedback_md: feedback, proposed_tasks: tasks }));
    const fresh = (await ctx.db.query<DraftRow>("SELECT * FROM meeting_study_drafts WHERE id=$1", [draft.id])).rows[0]!;
    const changes = {
      ...(summary !== undefined ? { summary: lineDiffSummary(draft.summary_md, summary).label } : {}),
      ...(feedback !== undefined ? { feedback: lineDiffSummary(draft.feedback_md, feedback).label } : {}),
      ...(tasks ? { tasks: { before: current.length, after: tasks.length, removed } } : {}),
    };
    return {
      data: { draft: { id: fresh.id, status: fresh.status, summary_md: clip(fresh.summary_md, 1500), feedback_md: clip(fresh.feedback_md, 1500), proposed_tasks: fresh.proposed_tasks.map((t, i) => ({ index: i + 1, title: t.title, due: t.due, assignee_id: t.assignee_id })) }, changes, next: "草稿已更新，尚未寫入研究；使用者確認後才會建立會議筆記與待辦。" },
      links: [{ label: meeting.title, url: meetingUrl(meeting.id), kind: "meeting" }],
    };
  },
});

registerAgentTool({
  name: "confirm_meeting_draft",
  title: "確認會議草稿",
  titleEn: "Confirm meeting draft",
  risk: "write",
  grantable: false,
  requireCard: () => true,
  description:
    "Confirm the pending draft of one study in a meeting (members of that study only; advisors/professors cannot): writes the 會議筆記 note and creates the proposed tasks in the study, exactly like 「確認」 on the meeting page. Asks the user (autopilot confirms it directly). Edit the draft first with suggest_meeting_draft_edit if needed; never create the same tasks by hand.",
  input: z.object({ meeting_id: meetingArg, study: studyRef, note_title: z.string().trim().min(1).max(200).optional() }),
  summarize: () => "確認會議草稿：寫入會議筆記並建立草稿中的待辦",
  async target(a, ctx) {
    const { meeting, access, draft } = await draftFor(ctx, a.meeting_id, a.study);
    if (draft.status !== "pending") throw conflict("這份草稿已經處理過了。");
    return { ...studyTarget(access), label: `${access.study.title} · ${meeting.title} · ${draft.proposed_tasks.length} 項待辦`, url: meetingUrl(meeting.id) };
  },
  async execute(a, ctx) {
    const { meeting, draft } = await draftFor(ctx, a.meeting_id, a.study);
    const result = await transaction(ctx.db, async (client) => {
      const locked = (await findMeeting(client, meeting.id, true)) ?? (() => { throw notFound("會議不存在。"); })();
      return confirmDraft(client, ctx.app.notifier, locked, draft.id, ctx.user, a.note_title ? { note_title: a.note_title } : {});
    });
    await runAll(ctx, result.after);
    return {
      data: { confirmed: true, note_id: result.noteId, note_url: result.noteUrl, task_count: result.taskIds.length, task_ids: result.taskIds },
      links: [{ label: "會議筆記", url: result.noteUrl, kind: "note" }, { label: meeting.title, url: meetingUrl(meeting.id), kind: "meeting" }],
    };
  },
});

registerAgentTool({
  name: "add_meeting_feedback",
  title: "新增會議回饋",
  titleEn: "Add meeting feedback",
  risk: "write",
  description: "Add a feedback entry (Markdown) to a meeting as the user — professors and students may both give feedback. It is used by the meeting's AI analysis and shown on the meeting page.",
  input: z.object({ meeting_id: meetingArg, text: z.string().trim().min(1).max(50000) }),
  summarize: (a) => `新增會議回饋：「${excerpt(a.text, 60)}」`,
  async target(a, ctx) {
    workspaceUser(ctx);
    const meeting = await meetingOr404(ctx, a.meeting_id);
    const study = (await ctx.db.query<{ id: string; slug: string }>("SELECT s.id,s.slug FROM meeting_studies ms JOIN studies s ON s.id=ms.study_id WHERE ms.meeting_id=$1 ORDER BY ms.position LIMIT 1", [meeting.id])).rows[0];
    return { studyId: study?.id ?? null, studySlug: study?.slug, label: `會議〈${meeting.title}〉${taipeiDateTime(meeting.held_at)}`, url: meetingUrl(meeting.id) };
  },
  async execute(a, ctx) {
    workspaceUser(ctx);
    const meeting = await meetingOr404(ctx, a.meeting_id);
    // POST /meetings/:id/feedback: everyone signed in may add feedback.
    const id = (await ctx.db.query<{ id: string }>("INSERT INTO meeting_feedback(meeting_id,author_id,body_md) VALUES($1,$2,$3) RETURNING id", [meeting.id, ctx.user.id, a.text])).rows[0]!.id;
    return { data: { feedback_id: id, meeting: { id: meeting.id, title: meeting.title } }, links: [{ label: meeting.title, url: meetingUrl(meeting.id), kind: "meeting" }] };
  },
});

// ---------------------------------------------------------------- note history

const VERSION_KIND_ZH: Record<string, string> = { initial: "建立", auto: "自動儲存", manual: "手動版本", suggestion: "接受建議", autopilot: "自動駕駛", restore: "還原" };

registerAgentTool({
  name: "get_note_history",
  title: "查看筆記版本紀錄",
  titleEn: "Note history",
  risk: "read",
  description:
    "Version history of a note: versions (newest first) with number, date (Asia/Taipei), author, kind and size, optionally only since a date. With `version`, also a diff summary of that version against the version before it (or against `compare_to`): added/removed line counts and the changed passages. Use it for 「我上週改了什麼」.",
  input: z.object({
    note_id: uuidArg("Note"),
    since: dateArg.optional().describe("Only versions on/after this date"),
    version: z.number().int().min(1).optional().describe("Version number to diff"),
    compare_to: z.union([z.number().int().min(1), z.literal("current")]).optional().describe("Version number or 'current' (default: the previous version)"),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  summarize: (a) => (a.version ? `查看筆記第 ${a.version} 版的變更` : "查看筆記版本紀錄"),
  async execute(a, ctx) {
    workspaceUser(ctx);
    const note = isUuid(a.note_id) ? await findNote(ctx.db, a.note_id) : null;
    if (!note) throw notFound("筆記不存在。");
    const access = await loadStudyAccess(ctx.db, note.study_id, ctx.user);
    const versions = (await ctx.db.query<{ version: number; kind: string; label: string; author: string; actor_id: string | null; actor_name: string | null; at: string; size: number }>(
      `SELECT v.version,v.kind,v.label,v.author,v.actor_id,u.name AS actor_name,to_char(v.created_at AT TIME ZONE 'Asia/Taipei','YYYY-MM-DD HH24:MI') AS at,length(v.content_md) AS size
         FROM note_versions v LEFT JOIN users u ON u.id=v.actor_id
        WHERE v.note_id=$1 AND ($2::date IS NULL OR (v.created_at AT TIME ZONE 'Asia/Taipei')::date >= $2::date)
        ORDER BY v.version DESC LIMIT $3`,
      [note.id, a.since ?? null, a.limit ?? 30],
    )).rows;
    let diff: unknown = undefined;
    if (a.version) {
      const text = async (v: number) => (await ctx.db.query<{ content_md: string }>("SELECT content_md FROM note_versions WHERE note_id=$1 AND version=$2", [note.id, v])).rows[0]?.content_md ?? null;
      const chosen = await text(a.version);
      if (chosen === null) throw notFound(`筆記沒有第 ${a.version} 版。`);
      if (a.compare_to === "current") {
        const live = ctx.app.collab ? await ctx.app.collab.readDoc(noteDocName(note.id), (doc) => doc.getText("content").toString()) : null;
        diff = summarizeDiff(chosen, live ?? note.content_md, `第 ${a.version} 版 → 目前內容`);
      } else {
        const prev = a.compare_to ?? (await ctx.db.query<{ v: number | null }>("SELECT max(version) AS v FROM note_versions WHERE note_id=$1 AND version<$2", [note.id, a.version])).rows[0]?.v ?? null;
        const base = prev ? await text(prev) : "";
        if (base === null) throw notFound(`筆記沒有第 ${prev} 版。`);
        diff = summarizeDiff(base, chosen, `${prev ? `第 ${prev} 版` : "空白"} → 第 ${a.version} 版`);
      }
    }
    return {
      data: {
        note: { id: note.id, title: note.title, url: noteUrl(access.study.slug, note.id) },
        versions: versions.map((v) => ({ version: v.version, at: v.at, author: v.author === "ai" ? `AI（${v.actor_name ?? "—"}）` : v.actor_name, kind: VERSION_KIND_ZH[v.kind] ?? v.kind, label: v.label || undefined, size: v.size })),
        ...(diff ? { diff } : {}),
      },
      untrusted: note.created_by !== ctx.user.id || versions.some((v) => v.actor_id && v.actor_id !== ctx.user.id),
      source: `筆記〈${note.title}〉的版本紀錄`,
      links: [{ label: note.title, url: noteUrl(access.study.slug, note.id), kind: "note" }],
    };
  },
});

function summarizeDiff(before: string, after: string, range: string) {
  const d = lineDiffSummary(before, after);
  return {
    range,
    summary: d.label,
    changes: d.changes.slice(0, 8).map((c) => ({ ...(c.removed ? { removed: clip(scrub(c.removed.trim()), 400) } : {}), ...(c.added ? { added: clip(scrub(c.added.trim()), 400) } : {}) })),
    more_changes: Math.max(0, d.changes.length - 8),
  };
}
