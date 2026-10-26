/**
 * The chat and the workflows running in the same conversation (docs/architecture.md → Workflows → Chat integration →
 * Steering): start_workflow refuses a duplicate for a deliverable an active run already makes; steer_workflow sends the
 * user's own words as guidance / pauses; answer_workflow and POST /workflows/:id/answer {text} answer what an
 * `awaiting_input` run waits on; the assistant's context names the active runs.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAgentTool } from "../src/agent/tools/registry.js";
import { conversationWorkflowsBlock } from "../src/workflows/chat-steer.js";
import { getRun } from "../src/workflows/store.js";
import { createTestContext, hasTestDb, ORIGIN, type TestContext } from "./helpers.js";
import { insertStudy } from "./study-fixtures.js";
import { setWorkflowAvailability } from "../src/routes/workflows.js";
import "../src/workflows/playbooks/index.js";
import "../src/workflows/agent-tools.js";

describe.skipIf(!hasTestDb)("chat ↔ active workflows", () => {
  let t: TestContext;
  let user: { id: string; cookie: string };
  let study: { id: string; slug: string };
  const asUser = async () => {
    const { toCurrentUser, CURRENT_USER_COLUMNS } = await import("../src/lib/auth.js");
    return toCurrentUser((await t.db.query(`SELECT ${CURRENT_USER_COLUMNS} FROM users u WHERE u.id=$1`, [user.id])).rows[0]);
  };
  const ctxOf = async (conv: string) => ({ app: t.app, db: t.db, user: await asUser(), source: "agent" as const, conversationId: conv, runId: null, autopilot: false, signal: new AbortController().signal });
  const say = (conv: string, text: string) => t.db.query("INSERT INTO agent_messages(conversation_id,role,content,text,page_context) VALUES($1,'user',$2,$3,$4)", [conv, JSON.stringify([{ type: "text", text }]), text, JSON.stringify({ path: `/studies/${study.slug}`, studyId: study.id })]);
  const tool = (name: string) => getAgentTool(name)!;
  const run = async (name: string, args: Record<string, unknown>, conv: string) => tool(name).execute(tool(name).input.parse(args) as never, (await ctxOf(conv)) as never);

  beforeAll(async () => {
    t = await createTestContext();
    user = await t.login("student", "Steer");
    study = await insertStudy(t.db, user.id, "串流 ASR 熱詞");
    setWorkflowAvailability(async () => true);
  });
  afterAll(async () => {
    await t?.close();
  });

  it("refuses a second workflow for the same deliverable; separate: true or 「另外再做一份」 starts one", async () => {
    const conv = (await t.db.query<{ id: string }>("INSERT INTO conversations(user_id,mode,context,study_id) VALUES($1,'chat',$2,$3) RETURNING id", [user.id, JSON.stringify({ studyId: study.id }), study.id])).rows[0]!.id;
    await say(conv, "幫我做一份這週的進度報告簡報");
    const first = await run("start_workflow", { request: "做一份這週的進度報告簡報", study: study.slug }, conv);
    const id = (first.data as { workflow_id: string }).workflow_id;
    expect(id).toBeTruthy();
    await say(conv, "改成 8 頁");
    const dup = await run("start_workflow", { request: "做一份 8 頁的進度報告簡報", study: study.slug, pages: 8 }, conv);
    expect(dup.data).toMatchObject({ status: "duplicate", existing_workflow_id: id, reason: "same_kind" });
    expect(String(dup.text)).toContain("steer_workflow");
    expect((await t.db.query("SELECT 1 FROM workflow_runs WHERE conversation_id=$1", [conv])).rowCount).toBe(1);

    // The same deck as an active run's artifact → same_target.
    const deck = "3f1c2b8e-1111-4a2b-8c3d-000000000001";
    await t.db.query("UPDATE workflow_runs SET artifacts=$2 WHERE id=$1", [id, JSON.stringify([{ kind: "deck", id: deck, title: "週報", url: "/x", role: "draft" }])]);
    expect(await import("../src/workflows/chat-steer.js").then((m) => m.duplicateActiveWorkflow(t.db, conv, user.id, { request: "改講稿", deck_id: deck }, ["改講稿"]))).toMatchObject({ id, reason: "same_target" });

    // The user explicitly wants another one.
    await say(conv, "另外再做一份英文版的簡報");
    const other = await run("start_workflow", { request: "另一份英文版進度報告簡報", study: study.slug }, conv);
    expect((other.data as { workflow_id?: string }).workflow_id).toBeTruthy();
    const third = await run("start_workflow", { request: "再一份進度報告", study: study.slug, separate: true }, conv);
    expect((third.data as { workflow_id?: string }).workflow_id).toBeTruthy();
  });

  it("steer_workflow: the user's own words become guidance; a paraphrase is refused; 暫停 pauses", async () => {
    const conv = (await t.db.query<{ id: string }>("INSERT INTO conversations(user_id,mode,context,study_id) VALUES($1,'chat',$2,$3) RETURNING id", [user.id, JSON.stringify({ studyId: study.id }), study.id])).rows[0]!.id;
    await say(conv, "幫我做一份進度報告簡報");
    const id = ((await run("start_workflow", { request: "進度報告簡報", study: study.slug }, conv)).data as { workflow_id: string }).workflow_id;
    await t.db.query("UPDATE workflow_runs SET status='running' WHERE id=$1", [id]);
    await say(conv, "改成 8 頁，講稿用中文");
    await expect(run("steer_workflow", { action: "guidance", text: "請把整份簡報重寫成學術風格並加上結論頁" }, conv)).rejects.toMatchObject({ status: 400 });
    const out = await run("steer_workflow", { action: "guidance", text: "改成 8 頁，講稿用中文" }, conv);
    expect(out.data).toMatchObject({ workflow_id: id, action: "guidance" });
    expect((await getRun(t.db, id))!.guidance.map((g) => g.text)).toContain("改成 8 頁，講稿用中文");
    await say(conv, "先停一下");
    await run("steer_workflow", { action: "pause" }, conv);
    expect((await t.db.query<{ pause_requested: boolean }>("SELECT pause_requested FROM workflow_runs WHERE id=$1", [id])).rows[0]!.pause_requested).toBe(true);

    // The assistant's context names the run and, once it waits, its question.
    await t.db.query("UPDATE workflow_runs SET status='awaiting_input', question='要放在哪個研究？' WHERE id=$1", [id]);
    const block = await conversationWorkflowsBlock(t.db, conv, user.id);
    expect(block).toContain(id);
    expect(block).toContain("等使用者回答");
    expect(block).toContain("要放在哪個研究？");
    expect(block).toContain("steer_workflow");
  });

  it("answer_workflow and POST /workflows/:id/answer {text}: a plan question gets guidance, a card its free-text question", async () => {
    const conv = (await t.db.query<{ id: string }>("INSERT INTO conversations(user_id,mode,context,study_id) VALUES($1,'chat',$2,$3) RETURNING id", [user.id, JSON.stringify({ studyId: study.id }), study.id])).rows[0]!.id;
    await say(conv, "幫我寫一份閱讀筆記");
    const id = ((await run("start_workflow", { request: "閱讀筆記", study: study.slug }, conv)).data as { workflow_id: string }).workflow_id;
    // 1. A plan-phase question (no card): the reply becomes guidance and the run plans again.
    await t.db.query("UPDATE workflow_runs SET status='awaiting_input', question='要讀哪一篇？', state=state || '{\"plan_question\":\"要讀哪一篇？\"}' WHERE id=$1", [id]);
    await say(conv, "就讀 Contextual Adapters 那篇");
    await expect(run("answer_workflow", { text: "幫使用者決定讀第一篇" }, conv)).rejects.toMatchObject({ status: 400 });
    const a = await run("answer_workflow", { text: "就讀 Contextual Adapters 那篇" }, conv);
    expect(a.data).toMatchObject({ workflow_id: id, answered: true });
    let r = (await getRun(t.db, id))!;
    expect(r.status).toBe("planning");
    expect(r.guidance.at(-1)!.text).toBe("就讀 Contextual Adapters 那篇");
    // Not waiting any more → refused.
    await expect(run("answer_workflow", { workflow_id: id, text: "就讀 Contextual Adapters 那篇" }, conv)).rejects.toMatchObject({ status: 400 });

    // 2. A pending card with a text question + an optional choice: the composer's {text} answers the text question.
    const card = { id: "c1", title: "補充資料", questions: [{ id: "q1", prompt: "要強調哪個部分？", type: "long_text" }, { id: "q2", prompt: "語言？", type: "single_choice", options: [{ value: "zh", label: "中文" }, { value: "en", label: "English" }] }], step_key: null, purpose: "input", ai_suggested: false, asked_at: new Date().toISOString() };
    await t.db.query("UPDATE workflow_runs SET status='awaiting_input', question='補充資料', state=state || $2::jsonb WHERE id=$1", [id, JSON.stringify({ asks: { c1: card }, ask_pending: "c1" })]);
    const res = await t.app.inject({ method: "POST", url: `/api/workflows/${id}/answer`, headers: { origin: ORIGIN, cookie: user.cookie }, payload: { text: "方法比較的部分" } });
    expect(res.statusCode, res.body).toBe(200);
    r = (await getRun(t.db, id))!;
    const asks = r.state!.asks as Record<string, { answers?: { id: string; value?: unknown; skipped?: boolean }[] }>;
    expect(asks.c1!.answers).toEqual([{ id: "q1", value: "方法比較的部分" }, { id: "q2", value: null, skipped: true }]);
    expect(r.status).toBe("planning");

    // 3. A choice-only card: 409 card_only (answer on the card).
    const only = { ...card, id: "c2", questions: [card.questions[1]] };
    await t.db.query("UPDATE workflow_runs SET status='awaiting_input', question='語言', state=state || $2::jsonb WHERE id=$1", [id, JSON.stringify({ asks: { ...asks, c2: only }, ask_pending: "c2" })]);
    const refused = await t.app.inject({ method: "POST", url: `/api/workflows/${id}/answer`, headers: { origin: ORIGIN, cookie: user.cookie }, payload: { text: "中文吧" } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: "card_only" });
  });
});
