/**
 * Part-scoped note edits end to end (DB): get_note outline + section reads, the suggest_note_edit guards (full text
 * refused unless the whole note was read and the user asked for a whole rewrite; hunks outside the named parts refused),
 * 「AI 草擬」 rewriting only the named section (mock chat endpoint) and refusing to regenerate a long note whole, and
 * suggest_meeting_draft_edit task_edits / dropped-task refusal.
 */
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aiFor } from "../src/ai/platform/index.js";
import { getAgentTool } from "../src/agent/tools/index.js";
import { createTestContext, hasTestDb, ORIGIN, type TestContext } from "./helpers.js";
import { insertStudy } from "./study-fixtures.js";

process.env.PROVIDER_TOKEN_KEY ??= randomBytes(32).toString("base64");

const filler = (label: string, n: number) => Array.from({ length: n }, (_, i) => `${label}第 ${i + 1} 點：${"這是一段很長的說明文字。".repeat(12)}`).join("\n\n");
const LONG = ["# 研究筆記", "", "## 背景", "", filler("背景", 45), "", "## 結果", "", "準確率 70%。", "", filler("結果", 45), "", "## 結論", "", "SpecAugment 有幫助。", ""].join("\n");

const events = (body: string) =>
  body.split("\n\n").map((block) => {
    const event = /^event: (.+)$/m.exec(block)?.[1];
    const data = /^data: (.+)$/m.exec(block)?.[1];
    return event ? { event, data: data ? JSON.parse(data) : null } : null;
  }).filter((x): x is { event: string; data: any } => !!x);

describe.skipIf(!hasTestDb)("part-scoped note edits", () => {
  let t: TestContext;
  let alice: { id: string; cookie: string };
  let owner: { id: string; cookie: string };
  let study: { id: string; slug: string };
  let noteId = "";
  let conv = "";
  const post = (who: { cookie: string }, url: string, payload: object = {}) => t.app.inject({ method: "POST", url, headers: { origin: ORIGIN, cookie: who.cookie }, payload });
  const ctx = (extra: object = {}) => ({ app: t.app, db: t.db, user: { id: alice.id, name: "Alice", username: "alice", role: "student", is_admin: false, is_owner: false }, source: "agent", conversationId: conv, runId: null, autopilot: false, ...extra }) as any;
  const run = (name: string, args: object, extra: object = {}) => getAgentTool(name)!.execute(getAgentTool(name)!.input.parse(args) as never, ctx(extra));
  const say = (text: string) => t.db.query("INSERT INTO agent_messages(conversation_id,role,text) VALUES($1,'user',$2)", [conv, text]);

  beforeAll(async () => {
    t = await createTestContext();
    alice = await t.login("student", "Alice");
    owner = await t.ownerCookie();
    study = await insertStudy(t.db, alice.id, "語音情緒辨識");
    const r = await post(alice, `/api/studies/${study.slug}/notes`, { title: "長筆記", content_md: LONG });
    expect(r.statusCode, r.body).toBe(201);
    noteId = r.json().note.id;
    conv = (await t.db.query<{ id: string }>("INSERT INTO conversations(user_id) VALUES($1) RETURNING id", [alice.id])).rows[0]!.id;
  });
  afterAll(async () => {
    await aiFor(t.app).logger.flush().catch(() => {});
    await t?.close();
  });

  it("get_note returns the numbered outline and reads one section", async () => {
    expect(LONG.length).toBeGreaterThan(12000);
    const all = (await run("get_note", { note_id: noteId })) as { data: any };
    expect(all.data.outline.map((s: any) => `${s.n} ${s.title}`)).toEqual(["1 背景", "2 結果", "3 結論"]);
    expect(all.data.more).toContain("offset=12000");
    const sec = (await run("get_note", { note_id: noteId, section: "結論" })) as { data: any };
    expect(sec.data.section).toMatchObject({ n: "3", title: "結論" });
    expect(sec.data.content_md).toBe("## 結論\n\nSpecAugment 有幫助。\n");
    await expect(run("get_note", { note_id: noteId, section: "第九節" })).rejects.toMatchObject({ status: 404 });
  });

  it("suggest_note_edit: a partial ask on a long note is refused as full text and outside its part; edits inside pass", async () => {
    await say("把『結論』那段寫具體一點");
    const whole = LONG.replace("SpecAugment 有幫助。", "SpecAugment 讓準確率提升 2%。");
    await expect(run("suggest_note_edit", { note_id: noteId, content_md: whole })).rejects.toMatchObject({ status: 400, message: expect.stringContaining("edits") });
    await expect(run("suggest_note_edit", { note_id: noteId, edits: [{ before: "準確率 70%。", after: "準確率 71%。" }] })).rejects.toMatchObject({ status: 400, message: expect.stringContaining("第 2 節「結果」") });
    const ok = (await run("suggest_note_edit", { note_id: noteId, edits: [{ before: "SpecAugment 有幫助。", after: "SpecAugment 讓準確率提升 2%。" }] })) as { data: any };
    expect(ok.data).toMatchObject({ status: "pending_review", hunks: 1 });
  });

  it("a whole-note ask needs the whole note read first (get_note calls of the conversation)", async () => {
    await say("整篇重寫得通順一點");
    const whole = LONG.replace(/很長的說明文字/g, "很長的說明");
    await expect(run("suggest_note_edit", { note_id: noteId, content_md: whole })).rejects.toMatchObject({ status: 400, message: expect.stringContaining("還沒有讀完整篇") });
    const runId = (await t.db.query<{ id: string }>("INSERT INTO agent_runs(conversation_id,user_id) VALUES($1,$2) RETURNING id", [conv, alice.id])).rows[0]!.id;
    const msg = (await t.db.query<{ id: string }>("INSERT INTO agent_messages(conversation_id,run_id,role) VALUES($1,$2,'assistant') RETURNING id", [conv, runId])).rows[0]!.id;
    for (const [i, offset] of [0, 12000].entries()) {
      await t.db.query(
        "INSERT INTO tool_calls(run_id,conversation_id,message_id,step,position,provider_call_id,tool,args,risk,status) VALUES($1,$2,$3,0,$4,$5,'get_note',$6,'read','done')",
        [runId, conv, msg, i, `c${i}`, JSON.stringify({ note_id: noteId, offset })],
      );
    }
    await say("整篇重寫得通順一點");
    const ok = (await run("suggest_note_edit", { note_id: noteId, content_md: whole })) as { data: any };
    expect(ok.data.status).toBe("pending_review");
  });

  it("「AI 草擬」 with an instruction naming a section rewrites only that section; a long note is never regenerated whole", async () => {
    const bodies: any[] = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c));
      req.on("end", () => {
        if (!req.url?.includes("/chat/completions")) {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ data: [{ id: "mock" }] }));
        }
        bodies.push(JSON.parse(raw));
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "## 結論\n\nSpecAugment 讓準確率提升 2%。" }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const send = (url: string, payload: object, method: "POST" | "PUT" = "POST") => t.app.inject({ method, url, headers: { origin: ORIGIN, cookie: owner.cookie }, payload });
    const p = await send("/api/admin/ai/providers", { family: "llm", kind: "openai-compatible", name: "mock chat", config: { baseUrl: `http://127.0.0.1:${port}/v1` }, secrets: { apiKey: "x" } });
    const route = await send("/api/admin/ai/routes", { name: "寫作（mock）", capability: "chat", strategy: "single", members: [{ provider_id: p.json().provider.id, model: "mock" }] });
    expect((await send("/api/admin/ai/roles/writing", { route_id: route.json().route.id }, "PUT")).statusCode).toBe(200);
    aiFor(t.app).invalidate();
    try {
      const ev = events((await post(alice, `/api/notes/${noteId}/ai/draft`, { instruction: "把結論那段改得具體一點" })).body);
      expect(ev.find((e) => e.event === "error")).toBeUndefined();
      const s = ev.find((e) => e.event === "suggestion")!.data.suggestion;
      expect(s.hunks).toHaveLength(1);
      expect(s.hunks[0].before).toBe("## 結論\n\nSpecAugment 有幫助。\n");
      expect(s.hunks[0].after).toBe("## 結論\n\nSpecAugment 讓準確率提升 2%。\n");
      expect(s.title).toContain("結論");
      // The model saw only the section to rewrite (plus bounded context), not a request for the whole note.
      expect(JSON.stringify(bodies[0].messages)).not.toContain("輸出整份筆記內容");
      const whole = await post(alice, `/api/notes/${noteId}/ai/draft`, { instruction: "拿掉引用" });
      expect(whole.statusCode).toBe(400);
      expect(whole.json().error).toContain("無法一次重寫整篇");
      expect(bodies).toHaveLength(1);
    } finally {
      server.close();
    }
  });

  it("suggest_meeting_draft_edit: task_edits touch only the named task; a full list that drops tasks is refused", async () => {
    const meetingId = (await t.db.query<{ id: string }>("INSERT INTO meetings(title,held_at,created_by) VALUES('週會',now() - interval '1 day',$1) RETURNING id", [alice.id])).rows[0]!.id;
    await t.db.query("INSERT INTO meeting_studies(meeting_id,study_id) VALUES($1,$2)", [meetingId, study.id]);
    const tasks = [{ id: "t1", title: "補 whisper 對照", detail: "", assignee_id: null, due: null }, { id: "t2", title: "畫 CER 表格", detail: "", assignee_id: null, due: null }, { id: "t3", title: "整理資料集", detail: "細節", assignee_id: null, due: null }];
    const draftId = (await t.db.query<{ id: string }>("INSERT INTO meeting_study_drafts(meeting_id,study_id,summary_md,feedback_md,proposed_tasks) VALUES($1,$2,'討論 baseline。\n下週再看。','老師：要加信賴區間',$3) RETURNING id", [meetingId, study.id, JSON.stringify(tasks)])).rows[0]!.id;
    await expect(run("suggest_meeting_draft_edit", { meeting_id: meetingId, study: study.slug, proposed_tasks: [{ title: "補 whisper 對照" }, { title: "整理資料集" }] })).rejects.toMatchObject({ status: 400, message: expect.stringContaining("畫 CER 表格") });
    const r = (await run("suggest_meeting_draft_edit", { meeting_id: meetingId, study: study.slug, task_edits: [{ op: "remove", match: "CER 表格" }], summary_edits: [{ before: "下週再看。", after: "下週比較 whisper。" }] })) as { data: any };
    expect(r.data.changes.tasks).toEqual({ before: 3, after: 2, removed: ["畫 CER 表格"] });
    const row = (await t.db.query("SELECT summary_md,proposed_tasks FROM meeting_study_drafts WHERE id=$1", [draftId])).rows[0];
    expect(row.summary_md).toBe("討論 baseline。\n下週比較 whisper。");
    expect(row.proposed_tasks).toEqual([tasks[0], tasks[2]]);
    const listed = (await run("suggest_meeting_draft_edit", { meeting_id: meetingId, study: study.slug, proposed_tasks: [{ title: "補 whisper 對照" }], remove_tasks: ["整理資料集"] })) as { data: any };
    expect(listed.data.changes.tasks.removed).toEqual(["整理資料集"]);
  });
});
