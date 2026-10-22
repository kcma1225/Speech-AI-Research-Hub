/**
 * Deleting a conversation with Agent work still running: 409 `active_agents` (with `/activity` listing it) unless the
 * caller confirms `stop_agents=1`; then its workflows are stopped and deleted, and their jobs cancelled.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkflow } from "../src/workflows/service.js";
import { createTestContext, hasTestDb, hasTestS3, ORIGIN, type TestContext } from "./helpers.js";
import { insertStudy } from "./study-fixtures.js";
import { setWorkflowAvailability } from "../src/routes/workflows.js";

process.env.PROVIDER_TOKEN_KEY ??= randomBytes(32).toString("base64");
const run = hasTestDb && hasTestS3 ? describe : describe.skip;

run("conversation delete with running agents", () => {
  let t: TestContext;
  let alice: { id: string; cookie: string };
  let study: { id: string };
  const asUser = async (id: string) => {
    const { toCurrentUser, CURRENT_USER_COLUMNS } = await import("../src/lib/auth.js");
    return toCurrentUser((await t.db.query(`SELECT ${CURRENT_USER_COLUMNS} FROM users u WHERE u.id=$1`, [id])).rows[0]);
  };
  const req = (method: "GET" | "POST" | "DELETE", url: string, payload?: object) =>
    t.app.inject({ method, url, headers: { origin: ORIGIN, cookie: alice.cookie }, ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    t = await createTestContext();
    alice = await t.login("student", "alice-del");
    study = await insertStudy(t.db, alice.id, "刪除對話測試");
    setWorkflowAvailability(async () => true);
  });
  afterAll(async () => t?.close());

  it("warns, then stops and deletes the conversation's workflows", async () => {
    const conv = (await req("POST", "/api/agent/conversations", { title: "簡報" })).json().conversation.id as string;
    const wf = await createWorkflow(t.app, await asUser(alice.id), { request: "幫我做一份進度報告簡報", playbook: "slides", conversationId: conv, context: { studyId: study.id } });
    const done = await createWorkflow(t.app, await asUser(alice.id), { request: "舊的簡報", playbook: "slides", conversationId: conv, context: { studyId: study.id } });
    await t.db.query("UPDATE workflow_runs SET status='done' WHERE id=$1", [done.id]);

    const activity = (await req("GET", `/api/agent/conversations/${conv}/activity`)).json();
    expect(activity.assistant).toBe(false);
    expect(activity.workflows.map((w: { id: string }) => w.id)).toEqual([wf.id]);

    const refused = await req("DELETE", `/api/agent/conversations/${conv}`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("active_agents");
    expect((await t.db.query("SELECT 1 FROM conversations WHERE id=$1", [conv])).rowCount).toBe(1);

    expect((await req("DELETE", `/api/agent/conversations/${conv}?stop_agents=1`)).statusCode).toBe(200);
    expect((await t.db.query("SELECT 1 FROM conversations WHERE id=$1", [conv])).rowCount).toBe(0);
    expect((await t.db.query("SELECT 1 FROM workflow_runs WHERE id = ANY($1::uuid[])", [[wf.id, done.id]])).rowCount).toBe(0);
    const job = (await t.db.query("SELECT status, cancel_requested FROM jobs WHERE id=$1", [wf.job_id])).rows[0];
    expect(job.status === "cancelled" || job.cancel_requested === true).toBe(true);
  });

  it("a conversation with nothing running deletes without confirmation", async () => {
    const conv = (await req("POST", "/api/agent/conversations", { title: "閒聊" })).json().conversation.id as string;
    expect((await req("GET", `/api/agent/conversations/${conv}/activity`)).json()).toEqual({ assistant: false, workflows: [], goals: [] });
    expect((await req("DELETE", `/api/agent/conversations/${conv}`)).statusCode).toBe(200);
  });
});
