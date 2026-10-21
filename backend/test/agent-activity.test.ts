/**
 * Live Agent overview (`GET /api/workflows/active`) and the admin 「AI 用量」 aggregates (`GET /api/admin/ai/usage`):
 * ownership, needs-you states, superseded / answered runs, admin-only access, numbers only.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, hasTestDb, ORIGIN, type TestContext } from "./helpers.js";

const run = hasTestDb ? describe : describe.skip;

run("agent activity + AI usage", () => {
  let t: TestContext;
  let alice: { id: string; cookie: string };
  let bob: { id: string; cookie: string };
  let admin: { id: string; cookie: string };
  const get = (url: string, cookie?: string) => t.app.inject({ method: "GET", url, headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) } });

  beforeAll(async () => {
    t = await createTestContext();
    alice = await t.login("student", "alice-activity");
    bob = await t.login("student", "bob-activity");
    admin = await t.login("admin", "admin-activity");
  });
  afterAll(async () => t?.close());

  async function conversation(userId: string, title: string) {
    return (await t.db.query<{ id: string }>("INSERT INTO conversations(user_id,title) VALUES($1,$2) RETURNING id", [userId, title])).rows[0]!.id;
  }
  /** A run held by a fake lease so the runtime ticker never resumes it during the test. */
  async function agentRun(conv: string, userId: string, status: string, extra: { stop_reason?: string; finished?: boolean; startedAgo?: string } = {}) {
    return (await t.db.query<{ id: string }>(
      `INSERT INTO agent_runs(conversation_id,user_id,status,step,stop_reason,lease_owner,lease_expires_at,started_at,finished_at,tokens_in,tokens_out)
       VALUES($1,$2,$3,2,$4,'test',now()+interval '1 hour',now()-$5::interval,$6,1000,200) RETURNING id`,
      [conv, userId, status, extra.stop_reason ?? null, extra.startedAgo ?? "1 minute", extra.finished ? new Date() : null],
    )).rows[0]!.id;
  }
  async function message(conv: string, runId: string | null, role: string, text = "") {
    return (await t.db.query<{ id: string }>("INSERT INTO agent_messages(conversation_id,run_id,role,text) VALUES($1,$2,$3,$4) RETURNING id", [conv, runId, role, text])).rows[0]!.id;
  }
  async function toolCall(conv: string, runId: string, messageId: string, position: number, tool: string, status: string, args: object = {}, summary = "") {
    return (await t.db.query<{ id: string }>(
      `INSERT INTO tool_calls(run_id,conversation_id,message_id,step,position,provider_call_id,tool,args,risk,status,summary) VALUES($1,$2,$3,1,$4,$5,$6,$7,'read',$8,$9) RETURNING id`,
      [runId, conv, messageId, position, randomUUID(), tool, JSON.stringify(args), status, summary],
    )).rows[0]!.id;
  }

  it("lists my active workflow and assistant runs with needs-you states, never other users' runs", async () => {
    expect((await get("/api/workflows/active")).statusCode).toBe(401);

    // Workflow running with a sub-agent activity line + one awaiting plan approval; bob's run is not mine.
    const wf = (await t.db.query<{ id: string }>(
      `INSERT INTO workflow_runs(user_id,playbook,title,request,objective,status,budget,usage,artifacts)
       VALUES($1,'generic','文獻回顧','寫文獻回顧','整理三篇論文','running',
              '{"max_steps":30,"max_calls":60,"max_tokens":800000,"max_minutes":40,"max_fix_rounds":2,"concurrency":3}',
              '{"steps":3,"calls":30,"tokens_in":1000,"tokens_out":500,"active_ms":60000,"fix_rounds":0}',
              '[{"kind":"note","id":"${randomUUID()}","url":"/notes/x","title":"草稿","role":"draft"}]') RETURNING id`,
      [alice.id],
    )).rows[0]!.id;
    await t.db.query("INSERT INTO workflow_steps(run_id,key,position,role,title,status) VALUES($1,'a',0,'researcher','讀論文','passed'),($1,'b',1,'writer','撰寫','running'),($1,'c',2,'verifier','驗收','pending')", [wf]);
    await t.db.query(`INSERT INTO workflow_events(run_id,type,data) VALUES($1,'activity','{"step_key":"b","role":"writer","text":"撰寫 §2 方法比較"}')`, [wf]);
    const planConv = await conversation(alice.id, "交給 Agent");
    const wfPlan = (await t.db.query<{ id: string }>("INSERT INTO workflow_runs(user_id,playbook,title,request,status,conversation_id) VALUES($1,'generic','等確認','x','awaiting_plan_approval',$2) RETURNING id", [alice.id, planConv])).rows[0]!.id;
    await t.db.query("INSERT INTO workflow_runs(user_id,playbook,title,request,status) VALUES($1,'generic','已完成','x','done')", [alice.id]);
    await t.db.query("INSERT INTO workflow_runs(user_id,playbook,title,request,status) VALUES($1,'generic','別人的','x','running')", [bob.id]);

    // Assistant: one running with a plan, one waiting for approval, one ended on an unanswered card,
    // one ended on a card that was answered by a later message, one superseded by a newer finished run.
    const c1 = await conversation(alice.id, "讀論文");
    const r1 = await agentRun(c1, alice.id, "running");
    await message(c1, null, "user", "幫我讀");
    const m1 = await message(c1, r1, "assistant", "我先列計畫");
    await toolCall(c1, r1, m1, 0, "update_plan", "done", { plan: [{ step: "讀目錄", status: "completed" }, { step: "讀方法", status: "in_progress" }, { step: "寫筆記", status: "pending" }] });
    await toolCall(c1, r1, m1, 1, "read_paper", "running", {}, "閱讀論文 §3");

    const c2 = await conversation(alice.id, "建立待辦");
    const r2 = await agentRun(c2, alice.id, "awaiting_approval");
    await message(c2, null, "user", "建立待辦");
    const m2 = await message(c2, r2, "assistant");
    const consent = await toolCall(c2, r2, m2, 0, "create_task", "pending_approval", {}, "建立待辦〈讀論文〉");

    const c3 = await conversation(alice.id, "問我問題");
    const r3 = await agentRun(c3, alice.id, "done", { stop_reason: "awaiting_input", finished: true });
    await message(c3, null, "user", "訪談我");
    const m3 = await message(c3, r3, "assistant", "請回答");
    const ask = await toolCall(c3, r3, m3, 0, "ask_user", "done", { questions: [{ id: "q1", question: "哪一篇？", options: [] }] });

    const c4 = await conversation(alice.id, "已回答");
    const r4 = await agentRun(c4, alice.id, "done", { stop_reason: "awaiting_input", finished: true });
    await message(c4, r4, "assistant", "請回答");
    await message(c4, null, "user", "我直接回覆");

    const c5 = await conversation(alice.id, "被取代");
    await agentRun(c5, alice.id, "awaiting_llm", { startedAgo: "10 minutes" });
    await agentRun(c5, alice.id, "done", { finished: true });

    const res = await get("/api/workflows/active", alice.cookie);
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json() as { runs: Record<string, any>[]; count: number; needs_you: number };
    const titles = body.runs.map((r) => r.title).sort();
    expect(titles).toEqual(["問我問題", "建立待辦", "文獻回顧", "等確認", "讀論文"].sort());
    expect(body.count).toBe(5);
    expect(body.needs_you).toBe(3);
    // needs-you first
    expect(body.runs.slice(0, 3).every((r) => r.needs_you)).toBe(true);

    const w = body.runs.find((r) => r.id === wf)!;
    expect(w).toMatchObject({ kind: "workflow", status: "running", needs_you: false, progress: { done: 1, total: 3 }, current: { role: "writer", text: "撰寫 §2 方法比較" }, budget_pct: 50, tokens: 1500 });
    expect(w.artifacts).toHaveLength(1);
    const a1 = body.runs.find((r) => r.id === r1)!;
    expect(a1).toMatchObject({ kind: "assistant", status: "running", conversation_id: c1, plan: { done: 1, total: 3, current: "讀方法" }, current: { role: "read_paper", text: "閱讀論文 §3" }, step: { step: 3, max: 25 }, tokens: 1200 });
    expect(body.runs.find((r) => r.id === r2)).toMatchObject({ status: "awaiting_approval", needs_you: true, current: { text: "建立待辦〈讀論文〉" } });
    expect(body.runs.find((r) => r.id === r3)).toMatchObject({ status: "awaiting_input", needs_you: true });

    // Deep links to the exact card that waits for the user.
    expect(w).toMatchObject({ action: null, focus: `workflow:${wf}`, href: `/assistant/workflows?run=${wf}` });
    expect(body.runs.find((r) => r.id === wfPlan)).toMatchObject({ action: "approve_plan", focus: `workflow:${wfPlan}`, href: `/assistant/${planConv}?focus=workflow:${wfPlan}` });
    expect(body.runs.find((r) => r.id === r2)).toMatchObject({ action: "review", focus: `toolcall:${consent}`, href: `/assistant/${c2}?focus=toolcall:${consent}` });
    expect(body.runs.find((r) => r.id === r3)).toMatchObject({ action: "answer", focus: `toolcall:${ask}`, href: `/assistant/${c3}?focus=toolcall:${ask}` });
    expect(a1).toMatchObject({ action: null, focus: null, href: `/assistant/${c1}` });

    // Bob sees only his own run; an admin account has no workspace.
    const bobRuns = (await get("/api/workflows/active", bob.cookie)).json() as { runs: { title: string }[] };
    expect(bobRuns.runs.map((r) => r.title)).toEqual(["別人的"]);
    const adminRes = await get("/api/workflows/active", admin.cookie);
    if (adminRes.statusCode === 200) expect(adminRes.json()).toMatchObject({ runs: [], count: 0 });
    else expect(adminRes.statusCode).toBe(403);
  });

  it("aggregates AI usage for admins only, without content", async () => {
    const at = new Date();
    const old = new Date(Date.now() - 20 * 86_400_000);
    const rows: [string, boolean, string | null, string, number, number, boolean, string | null, Date, boolean][] = [
      // call_id, final, user, role, in, out, ok, model, started_at, probe
      [randomUUID(), true, alice.id, "assistant", 1000, 100, true, "glm-5.3-flash", at, false],
      [randomUUID(), true, alice.id, "assistant", 2000, 200, false, "glm-5.3-flash", at, false],
      [randomUUID(), true, bob.id, "writing", 500, 50, true, "glm-5-turbo", at, false],
      [randomUUID(), true, null, "embedding", 300, 0, true, "embed-1", at, false],
      [randomUUID(), true, alice.id, "assistant", 9999, 9999, true, "glm-5.3-flash", at, true], // health probe: excluded
      [randomUUID(), true, bob.id, "assistant", 7000, 700, true, "glm-5.3-flash", old, false], // older than 7 days
    ];
    for (const [callId, final, userId, role, tin, tout, ok, model, started, probe] of rows) {
      await t.db.query(
        `INSERT INTO ai_call_log(call_id,final,role,capability,provider_kind,model,started_at,tokens_in,tokens_out,ok,user_id,probe)
         VALUES($1,$2,$3,'chat','openai_compat',$4,$5,$6,$7,$8,$9,$10)`,
        [callId, final, role, model, started, tin, tout, ok, userId, probe],
      );
    }

    expect((await get("/api/admin/ai/usage")).statusCode).toBe(401);
    expect((await get("/api/admin/ai/usage", alice.cookie)).statusCode).toBe(403);
    expect((await get("/api/admin/ai/usage?days=3", admin.cookie)).statusCode).toBe(400);

    const week = (await get("/api/admin/ai/usage?days=7", admin.cookie)).json() as Record<string, any>;
    expect(week.days).toBe(7);
    expect(week.totals).toMatchObject({ calls: 4, errors: 1, tokens_in: 3800, tokens_out: 350, users: 2 });
    expect(week.by_role.find((r: any) => r.role === "assistant")).toMatchObject({ calls: 2, tokens_in: 3000 });
    expect(week.by_model[0]).toMatchObject({ model: "glm-5.3-flash", provider_kind: "openai_compat", calls: 2 });
    expect(week.by_account_role.map((r: any) => r.account_role).sort()).toEqual(["student", "system"]);
    expect(week.top_users[0]).toMatchObject({ user: { id: alice.id, name: "alice-activity" }, tokens_in: 3000, tokens_out: 300 });
    expect(week.by_user.some((u: any) => u.user === null)).toBe(true);
    // Workflow runs created in the window (from the previous test), by status.
    expect(week.workflows.find((w: any) => w.status === "running")).toMatchObject({ runs: 2, tokens: 1500 });
    // Numbers only: no prompt / text fields anywhere.
    expect(JSON.stringify(week)).not.toMatch(/"(text|content|prompt|request|objective)"/);

    const month = (await get("/api/admin/ai/usage?days=30", admin.cookie)).json() as Record<string, any>;
    expect(month.totals).toMatchObject({ calls: 5, tokens_in: 10800 });
  });
});
