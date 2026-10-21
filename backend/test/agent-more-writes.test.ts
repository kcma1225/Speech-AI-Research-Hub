/**
 * Agent tools added by the AI-capability audit: update_milestone, update_study_paper, latex_add_section,
 * latex_update_project, suggest_meeting_draft_edit, confirm_meeting_draft, add_meeting_feedback, get_note_history —
 * schema, consent-card target, permissions (non-member / professor-advisor / admin refused), effects; plus the
 * runtime rule that confirm_meeting_draft and reading-note rewrites ask even under autopilot.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ChatEvent } from "../src/ai/types.js";
import type { RoleChatRequest } from "../src/ai/platform/index.js";
import { agentFor, type ModelCall } from "../src/agent/runtime.js";
import { getAgentTool, isGrantable, isMcpTool } from "../src/agent/tools/index.js";
import { lineDiffSummary } from "../src/agent/tools/more-writes.js";
import { addPaperToStudy, insertPaper } from "../src/lib/library/store.js";
import { createTestContext, hasTestDb, hasTestS3, ORIGIN, type TestContext } from "./helpers.js";
import { addStudyMember, insertStudy } from "./study-fixtures.js";

let ids = 0;
const calls = (...list: [string, unknown][]): ChatEvent[] => [
  ...list.flatMap(([name, input]) => {
    const id = `call_${++ids}`;
    return [{ type: "tool_call_start", index: 0, id, name } as ChatEvent, { type: "tool_call_end", index: 0, id, name, input, argsJson: JSON.stringify(input) } as ChatEvent];
  }),
  { type: "done", stopReason: "tool_use" },
];
const say = (text: string): ChatEvent[] => [{ type: "text_delta", text }, { type: "done", stopReason: "end_turn" }];

describe("audit tools: static contract", () => {
  it("risk classes, cards, grants and MCP exposure", () => {
    for (const name of ["update_milestone", "update_study_paper", "latex_add_section", "latex_update_project", "suggest_meeting_draft_edit", "confirm_meeting_draft", "add_meeting_feedback"]) {
      expect(getAgentTool(name)?.risk, name).toBe("write");
      expect(isMcpTool(getAgentTool(name)!), name).toBe(false);
    }
    expect(getAgentTool("get_note_history")?.risk).toBe("read");
    const confirm = getAgentTool("confirm_meeting_draft")!;
    expect(confirm.requireCard?.({} as never)).toBe(true);
    expect(isGrantable(confirm)).toBe(false);
    const paper = getAgentTool("update_study_paper")!;
    expect(paper.requireCard?.({ study: "s", paper_id: "p", reading_status: "read" } as never)).toBe(false);
    expect(paper.requireCard?.({ study: "s", paper_id: "p", notes_md: "x" } as never)).toBe(true);
    expect(paper.requireCard?.({ study: "s", paper_id: "p", edits: [{ before: "a", after: "b" }] } as never)).toBe(true);
  });

  it("schemas reject bad input", () => {
    expect(getAgentTool("update_milestone")!.input.safeParse({ study: "s", milestone_id: "m", due_on: "2026/10/01" }).success).toBe(false);
    expect(getAgentTool("update_study_paper")!.input.safeParse({ study: "s", paper_id: "p", reading_status: "done" }).success).toBe(false);
    expect(getAgentTool("latex_update_project")!.input.safeParse({ project_id: "p", compiler: "tectonic" }).success).toBe(false);
    expect(getAgentTool("add_meeting_feedback")!.input.safeParse({ meeting_id: "m", text: "  " }).success).toBe(false);
    expect(getAgentTool("get_note_history")!.input.safeParse({ note_id: "n", compare_to: "previous" }).success).toBe(false);
  });

  it("summaries are zh and line diffs are counted", () => {
    expect(getAgentTool("update_milestone")!.summarize({ study: "s", milestone_id: "m", done: true } as never)).toBe("更新里程碑：標為完成");
    expect(getAgentTool("latex_update_project")!.summarize({ project_id: "p", compiler: "xelatex" } as never)).toContain("XeLaTeX");
    expect(lineDiffSummary("a\nb\n", "a\nc\nd\n").label).toBe("+2 行／−1 行");
  });
});

describe.skipIf(!hasTestDb || !hasTestS3)("audit tools", () => {
  let t: TestContext;
  let alice: { id: string; cookie: string };
  let bob: { id: string; cookie: string };
  let prof: { id: string; cookie: string };
  let study: { id: string; slug: string };
  let milestoneId: string;
  let paperId: string;
  let meetingId: string;
  let projectId: string;
  let noteId: string;
  const ctxOf = (id: string, role = "student", extra: object = {}) => ({ app: t.app, db: t.db, user: { id, name: "x", username: "x", role, is_admin: role === "admin", is_owner: false }, source: "agent", conversationId: null, runId: null, autopilot: false, ...extra }) as any;
  const tool = (name: string) => getAgentTool(name)!;
  const run = (name: string, args: object, who = alice.id, role = "student") => tool(name).execute(tool(name).input.parse(args) as never, ctxOf(who, role));
  const target = (name: string, args: object, who = alice.id, role = "student") => tool(name).target!(tool(name).input.parse(args) as never, ctxOf(who, role));
  const post = (who: { cookie: string }, url: string, payload: object = {}) => t.app.inject({ method: "POST", url, headers: { origin: ORIGIN, cookie: who.cookie }, payload });
  const patch = (who: { cookie: string }, url: string, payload: object) => t.app.inject({ method: "PATCH", url, headers: { origin: ORIGIN, cookie: who.cookie }, payload });
  const get = (who: { cookie: string }, url: string) => t.app.inject({ method: "GET", url, headers: { cookie: who.cookie } });

  async function freshDraft(tasks = [{ id: "t1", title: "補 whisper 對照", detail: "", assignee_id: null, due: null }]) {
    await t.db.query("DELETE FROM meeting_study_drafts WHERE meeting_id=$1", [meetingId]);
    return (await t.db.query<{ id: string }>(
      "INSERT INTO meeting_study_drafts(meeting_id,study_id,summary_md,feedback_md,proposed_tasks) VALUES($1,$2,'討論 baseline','老師：要加信賴區間',$3) RETURNING id",
      [meetingId, study.id, JSON.stringify(tasks)],
    )).rows[0]!.id;
  }

  beforeAll(async () => {
    t = await createTestContext();
    alice = await t.login("student", "Alice");
    bob = await t.login("student", "Bob");
    prof = await t.login("professor", "Prof");
    study = await insertStudy(t.db, alice.id, "串流語音辨識");
    await addStudyMember(t.db, study.id, prof.id, "advisor");
    await t.db.query("INSERT INTO study_stages(study_id,position,name) VALUES($1,0,'實驗')", [study.id]);
    milestoneId = (await t.db.query<{ id: string }>("INSERT INTO milestones(study_id,title,created_by) VALUES($1,'完成 baseline',$2) RETURNING id", [study.id, alice.id])).rows[0]!.id;
    const paper = await insertPaper(t.db, { type: "paper-conference", title: "Connectionist Temporal Classification", authors: [{ family: "Graves", given: "Alex" }], year: 2006, venue: "ICML" }, alice.id);
    paperId = paper.id;
    await addPaperToStudy(t.db, { studyId: study.id, paper, userId: alice.id, citeKey: "graves2006ctc" });
    await t.db.query("UPDATE study_papers SET notes_md='CTC 不需要對齊。\n' WHERE paper_id=$1", [paperId]);
    meetingId = (await t.db.query<{ id: string }>("INSERT INTO meetings(title,held_at,created_by) VALUES('週會',now() - interval '1 day',$1) RETURNING id", [alice.id])).rows[0]!.id;
    await t.db.query("INSERT INTO meeting_studies(meeting_id,study_id) VALUES($1,$2)", [meetingId, study.id]);
    const p = await post(alice, `/api/studies/${study.slug}/latex`, { title: "論文", kind: "paper", template: "zh-thesis" });
    expect(p.statusCode, p.body).toBe(201);
    projectId = p.json().project.id;
    const n = await post(alice, `/api/studies/${study.slug}/notes`, { title: "實驗紀錄", content_md: "準確率 70%\n" });
    noteId = n.json().note.id;
    await t.db.query("INSERT INTO note_versions(note_id,version,kind,content_md,actor_id) VALUES($1,2,'auto','準確率 72%\n加了 SpecAugment\n',$2)", [noteId, alice.id]);
  });
  afterAll(async () => {
    await agentFor(t.app).settle();
    await t?.close();
  });

  it("update_milestone marks done once (activity), and refuses non-members, advisors and admins", async () => {
    expect(await target("update_milestone", { study: study.slug, milestone_id: milestoneId, done: true })).toMatchObject({ studyId: study.id, label: "串流語音辨識 · 完成 baseline", url: `/studies/${study.slug}` });
    const r = (await run("update_milestone", { study: study.slug, milestone_id: milestoneId, done: true })) as { data: any };
    expect(r.data).toMatchObject({ milestone: { done: true }, recorded_done: true });
    await run("update_milestone", { study: study.slug, milestone_id: milestoneId, done: true, due_on: "2026-12-01" });
    const acts = await t.db.query("SELECT 1 FROM study_activity WHERE study_id=$1 AND kind='milestone_done'", [study.id]);
    expect(acts.rowCount).toBe(1);
    for (const [who, role] of [[bob.id, "student"], [prof.id, "professor"], [alice.id, "admin"]] as const) {
      await expect(run("update_milestone", { study: study.slug, milestone_id: milestoneId, done: false }, who, role)).rejects.toMatchObject({ status: 403 });
      await expect(target("update_milestone", { study: study.slug, milestone_id: milestoneId, done: false }, who, role)).rejects.toMatchObject({ status: 403 });
    }
    await expect(run("update_milestone", { study: study.slug, milestone_id: "00000000-0000-0000-0000-000000000000", done: true })).rejects.toMatchObject({ status: 404 });
  });

  it("update_study_paper: status + tags, notes via edits with a diff in the card label; members only", async () => {
    const label = (await target("update_study_paper", { study: study.slug, paper_id: paperId, edits: [{ before: "不需要對齊", after: "不需要逐幀對齊" }] }))!.label;
    expect(label).toContain("Connectionist Temporal Classification");
    expect(label).toContain("閱讀筆記 +1 行／−1 行");
    const r = (await run("update_study_paper", { study: study.slug, paper_id: paperId, reading_status: "read", tags: ["ctc"], edits: [{ before: "不需要對齊", after: "不需要逐幀對齊" }] })) as { data: any };
    expect(r.data).toMatchObject({ reading_status: "read", reading_status_label: "已讀", notes: "+1 行／−1 行" });
    const row = (await t.db.query("SELECT notes_md,reading_status,tags,notes_updated_by FROM study_papers WHERE paper_id=$1", [paperId])).rows[0];
    expect(row).toMatchObject({ notes_md: "CTC 不需要逐幀對齊。\n", reading_status: "read", tags: ["ctc"], notes_updated_by: alice.id });
    expect((await t.db.query("SELECT 1 FROM study_activity WHERE kind='paper_read' AND target_id=$1", [paperId])).rowCount).toBe(1);
    await expect(run("update_study_paper", { study: study.slug, paper_id: paperId, edits: [{ before: "找不到", after: "x" }] })).rejects.toMatchObject({ status: 409 });
    await expect(run("update_study_paper", { study: study.slug, paper_id: paperId, reading_status: "unread" }, prof.id, "professor")).rejects.toMatchObject({ status: 403 });
    await expect(run("update_study_paper", { study: study.slug, paper_id: paperId, reading_status: "unread" }, bob.id)).rejects.toMatchObject({ status: 403 });
  });

  it("latex_add_section creates the file and its \\input; latex_update_project switches the compiler", async () => {
    const tg = await target("latex_add_section", { project_id: projectId, title: "相關研究" });
    expect(tg).toMatchObject({ studyId: study.id, label: "串流語音辨識 · 論文" });
    const r = (await run("latex_add_section", { project_id: projectId, title: "消融實驗", name: "zz-ablation" })) as { data: any };
    expect(r.data.file.path).toBe("sections/zz-ablation.tex");
    const detail = (await get(alice, `/api/latex/${projectId}`)).json();
    expect(detail.sections.map((s: { path: string }) => s.path)).toContain("sections/zz-ablation.tex");
    const u = (await run("latex_update_project", { project_id: projectId, compiler: "pdflatex" })) as { data: any };
    expect(u.data.project).toMatchObject({ compiler: "pdflatex", compiler_label: "pdfLaTeX" });
    await run("latex_update_project", { project_id: projectId, compiler: "xelatex", bib_mode: "manual" });
    expect((await t.db.query("SELECT compiler,bib_mode FROM latex_projects WHERE id=$1", [projectId])).rows[0]).toEqual({ compiler: "xelatex", bib_mode: "manual" });
    for (const [who, role] of [[bob.id, "student"], [prof.id, "professor"], [alice.id, "admin"]] as const) {
      await expect(run("latex_update_project", { project_id: projectId, compiler: "lualatex" }, who, role)).rejects.toMatchObject({ status: 403 });
      await expect(run("latex_add_section", { project_id: projectId, title: "x" }, who, role)).rejects.toMatchObject({ status: 403 });
    }
  });

  it("suggest_meeting_draft_edit edits the pending draft; confirm_meeting_draft writes the note and tasks once; advisors refused", async () => {
    const draftId = await freshDraft();
    const e = (await run("suggest_meeting_draft_edit", { meeting_id: meetingId, study: study.slug, feedback_md: "老師：CER 表格要附信賴區間", proposed_tasks: [{ title: "補 whisper 對照", assignee: "me", due: "2026-11-01" }, { title: "畫 CER 表格" }] })) as { data: any };
    expect(e.data.draft.proposed_tasks).toHaveLength(2);
    expect((await t.db.query("SELECT origin,edited_by FROM meeting_study_drafts WHERE id=$1", [draftId])).rows[0]).toEqual({ origin: "edited", edited_by: alice.id });
    await expect(run("suggest_meeting_draft_edit", { meeting_id: meetingId, study: study.slug, summary_md: "x" }, prof.id, "professor")).rejects.toMatchObject({ status: 403 });
    await expect(run("suggest_meeting_draft_edit", { meeting_id: meetingId, study: study.slug, proposed_tasks: [{ title: "x", assignee: bob.id }] })).rejects.toMatchObject({ status: 400 });

    expect(await target("confirm_meeting_draft", { meeting_id: meetingId, study: study.slug })).toMatchObject({ studyId: study.id, label: "串流語音辨識 · 週會 · 2 項待辦", url: `/meetings/${meetingId}` });
    for (const [who, role] of [[prof.id, "professor"], [bob.id, "student"], [alice.id, "admin"]] as const) {
      await expect(run("confirm_meeting_draft", { meeting_id: meetingId, study: study.slug }, who, role)).rejects.toMatchObject({ status: 403 });
    }
    const c = (await run("confirm_meeting_draft", { meeting_id: meetingId, study: study.slug })) as { data: any };
    expect(c.data).toMatchObject({ confirmed: true, task_count: 2 });
    const tasks = (await t.db.query("SELECT title,source,source_ref FROM tasks WHERE study_id=$1 AND source='meeting' ORDER BY title", [study.id])).rows;
    expect(tasks.map((x) => x.title)).toEqual(["畫 CER 表格", "補 whisper 對照"]);
    const note = (await t.db.query("SELECT content_md FROM notes WHERE id=$1", [c.data.note_id])).rows[0];
    expect(note.content_md).toContain("信賴區間");
    await expect(run("confirm_meeting_draft", { meeting_id: meetingId, study: study.slug })).rejects.toMatchObject({ status: 409 });
    await expect(target("confirm_meeting_draft", { meeting_id: meetingId, study: study.slug })).rejects.toMatchObject({ status: 409 });
  });

  it("add_meeting_feedback: professors and members may add, admins refused", async () => {
    const r = (await run("add_meeting_feedback", { meeting_id: meetingId, text: "下次請比較 streaming latency" }, prof.id, "professor")) as { data: any };
    expect(r.data.feedback_id).toBeTruthy();
    expect((await t.db.query("SELECT author_id,body_md FROM meeting_feedback WHERE id=$1", [r.data.feedback_id])).rows[0]).toEqual({ author_id: prof.id, body_md: "下次請比較 streaming latency" });
    expect(await target("add_meeting_feedback", { meeting_id: meetingId, text: "x" })).toMatchObject({ studyId: study.id, url: `/meetings/${meetingId}` });
    await expect(run("add_meeting_feedback", { meeting_id: meetingId, text: "x" }, alice.id, "admin")).rejects.toMatchObject({ status: 403 });
    await expect(run("add_meeting_feedback", { meeting_id: "00000000-0000-0000-0000-000000000000", text: "x" })).rejects.toMatchObject({ status: 404 });
  });

  it("get_note_history lists versions with authors and diffs a chosen version", async () => {
    const r = (await run("get_note_history", { note_id: noteId, version: 2 }, bob.id)) as { data: any; untrusted?: boolean };
    expect(r.data.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(r.data.versions[0]).toMatchObject({ author: "Alice", kind: "自動儲存" });
    expect(r.data.diff).toMatchObject({ range: "第 1 版 → 第 2 版", summary: "+2 行／−1 行" });
    expect(r.data.diff.changes[0]).toMatchObject({ removed: "準確率 70%", added: expect.stringContaining("SpecAugment") });
    expect(r.untrusted).toBe(true); // bob reads alice's note
    const since = (await run("get_note_history", { note_id: noteId, since: "2999-01-01" })) as { data: any; untrusted?: boolean };
    expect(since.data.versions).toEqual([]);
    expect(since.untrusted).toBe(false);
    await expect(run("get_note_history", { note_id: noteId, version: 9 })).rejects.toMatchObject({ status: 404 });
    await expect(run("get_note_history", { note_id: noteId }, alice.id, "admin")).rejects.toMatchObject({ status: 403 });
  });

  describe("runtime", () => {
    let script: ChatEvent[][] = [];
    const model: ModelCall = async function* (_req: RoleChatRequest) {
      for (const e of script.shift() ?? say("好")) yield e;
    };
    beforeEach(() => {
      const rt = agentFor(t.app);
      rt.options.model = model;
      rt.options.fast = async () => "測試";
      script = [];
    });

    it("under autopilot, update_milestone runs but confirm_meeting_draft and reading-note rewrites ask with a write card", async () => {
      await freshDraft();
      const conv = (await post(alice, "/api/agent/conversations", {})).json().conversation.id;
      expect((await patch(alice, `/api/agent/conversations/${conv}`, { autopilot: true })).statusCode).toBe(200);
      script = [
        calls(
          ["update_milestone", { study: study.slug, milestone_id: milestoneId, title: "完成 baseline（v2）" }],
          ["confirm_meeting_draft", { meeting_id: meetingId, study: study.slug }],
          ["update_study_paper", { study: study.slug, paper_id: paperId, notes_md: "全部改寫\n" }],
          ["update_study_paper", { study: study.slug, paper_id: paperId, reading_status: "reading" }],
        ),
      ];
      expect((await post(alice, `/api/agent/conversations/${conv}/messages`, { text: "里程碑改名、確認會議草稿、改閱讀筆記" })).statusCode).toBe(202);
      await agentFor(t.app).settle();
      const s = (await get(alice, `/api/agent/conversations/${conv}`)).json();
      const byTool = (name: string, i = 0) => s.toolCalls.filter((c: { tool: string }) => c.tool === name)[i];
      expect(byTool("update_milestone")).toMatchObject({ status: "done", approved_via: "autopilot" });
      expect(byTool("confirm_meeting_draft")).toMatchObject({ status: "pending_approval", approval_reason: "write", grantable: false, always_ask: false });
      expect(byTool("update_study_paper", 0)).toMatchObject({ status: "pending_approval", approval_reason: "write" });
      expect(byTool("update_study_paper", 1)).toMatchObject({ status: "done", approved_via: "autopilot" });
      // A conversation grant is never stored for the confirm tool.
      script = [say("好")];
      await post(alice, `/api/agent/tool-calls/${byTool("confirm_meeting_draft").id}/decision`, { decision: "approve_conversation" });
      await post(alice, `/api/agent/tool-calls/${byTool("update_study_paper", 0).id}/decision`, { decision: "deny" });
      await agentFor(t.app).settle();
      const after = (await get(alice, `/api/agent/conversations/${conv}`)).json();
      expect(after.grants).toEqual([]);
      expect(after.toolCalls.find((c: { tool: string }) => c.tool === "confirm_meeting_draft")).toMatchObject({ status: "done" });
      expect((await t.db.query("SELECT status FROM meeting_study_drafts WHERE meeting_id=$1", [meetingId])).rows[0].status).toBe("confirmed");
      expect((await t.db.query("SELECT notes_md FROM study_papers WHERE paper_id=$1", [paperId])).rows[0].notes_md).not.toBe("全部改寫\n");
    });
  });
});
