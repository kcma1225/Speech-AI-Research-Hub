/**
 * The attachment flow end to end (production 301b6e1a): a Deep-Research markdown file uploaded into the chat and
 * 「以此做成…簡報」 must reach the workflow as a reference (`inputs.materials`), be read with the owner's permissions (an
 * upload taints the run), route to a material deck (no online search, no imported papers), give the outline the listed
 * parts and the material, drop a planned cover page, and land in the deck. Also: start_workflow picks the turn's
 * attachments up when the assistant forgot `attachment_ids`, refuses someone else's upload, a pasted turn becomes a
 * `message` ref, and the start message never asks for a confirmation autopilot does not need.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ChatResult } from "../src/ai/types.js";
import { runWorkflow } from "../src/workflows/engine.js";
import { approveWorkflow } from "../src/workflows/service.js";
import { getRun } from "../src/workflows/store.js";
import { collectUserWords } from "../src/workflows/brief.js";
import { getAgentTool } from "../src/agent/tools/registry.js";
import type { ModelPort, Requirement } from "../src/workflows/types.js";
import { createTestContext, hasTestDb, hasTestS3, ORIGIN, type TestContext } from "./helpers.js";
import { insertStudy } from "./study-fixtures.js";
import { multipart } from "./slides-fixtures.js";
import { setWorkflowAvailability } from "../src/routes/workflows.js";
import { DEEP_RESEARCH_MD, MATERIAL_FILE, MATERIAL_REQUEST, MATERIAL_SECTIONS, PASTED_NOTES } from "../scripts/eval/material-fixture.js";
import "../src/workflows/agent-tools.js";

process.env.PROVIDER_TOKEN_KEY ??= randomBytes(32).toString("base64");
const run = hasTestDb && hasTestS3 ? describe : describe.skip;

type Req = { messages: { role: string; content: unknown }[] };
type Reply = string | ((req: Req) => string);
const result = (text: string): ChatResult => ({ text, reasoning: "", toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 50 }, message: { role: "assistant", content: text } });
const textOf = (req: Req, role?: string) => req.messages.filter((m) => !role || m.role === role).map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");

function mockModel() {
  const defaults = new Map<string, Reply>();
  const log: { purpose: string; prompt: string }[] = [];
  const port: ModelPort = {
    async chat(_role, req, ctx) {
      log.push({ purpose: ctx.purpose, prompt: textOf(req as Req) });
      const reply = defaults.get(ctx.purpose) ?? defaults.get("*") ?? "{}";
      return result(typeof reply === "function" ? reply(req as Req) : reply);
    },
    available: async () => true,
    vision: async () => false,
  };
  return { port, log, set: (p: string, r: Reply) => defaults.set(p, r), prompts: (p: string) => log.filter((l) => l.purpose === p).map((l) => l.prompt), count: (p: string) => log.filter((l) => l.purpose === p).length };
}

const PASS = '{"verdict":"pass","issues":[]}';
const allPass = (req: Req) => JSON.stringify({ results: [...textOf(req, "user").matchAll(/- \[([a-z0-9_]+)\]/g)].map((m) => ({ id: m[1], pass: true, evidence: "MedReg-TW", reason: "ok" })) });
const askedPages = (req: Req) => {
  const block = /<data name="your_pages"[^>]*>\n([\s\S]*?)\n<\/data>/.exec(textOf(req, "user"))?.[1] ?? "";
  return [...block.matchAll(/^\d+\. (.+?)(?:（學生自填）)?(?:（介紹：.+?）)?(?:（版型 [A-Z]）)?$/gm)].map((x) => x[1]!);
};
/** A writer that uses the material it is given (the fixture's names and numbers) and labels facts / inferences. */
const writer = (req: Req) => {
  const material = textOf(req, "user").includes("MedReg-TW");
  return askedPages(req).map((title) => `## ${title}\n\n- 【事實】${material ? "MedReg-TW 1,240 句、38 個門診科別" : "研究資料"}\n- 【推論】方向 A 成本最低\n- 【待驗證】recall ≥ 75%\n\n| 項目 | 內容 |\n|---|---|\n| 資料 | ${material ? "MedReg-TW" : "—"} |\n\n::: {.notes}\n這一頁說明${title}，內容來自使用者提供的 deep research 結果，報告時大約一分鐘，重點放在已知事實與待驗證的構想。\n:::`).join("\n\n");
};

run("workflow material (attachments → material deck)", () => {
  let t: TestContext;
  let alice: { id: string; cookie: string };
  let bob: { id: string; cookie: string };
  let study: { id: string; slug: string };
  let m: ReturnType<typeof mockModel>;
  let stop = false;
  let worker: Promise<void>;
  const deps = () => ({ db: t.db, storage: t.storage, app: t.app, model: m.port, log: t.app.log, signal: new AbortController().signal, jobId: null, previewWaitMs: 15_000 });
  const asUser = async (id: string) => {
    const { toCurrentUser, CURRENT_USER_COLUMNS } = await import("../src/lib/auth.js");
    return toCurrentUser((await t.db.query(`SELECT ${CURRENT_USER_COLUMNS} FROM users u WHERE u.id=$1`, [id])).rows[0]);
  };
  const post = (who: { cookie: string }, url: string, payload: object) => t.app.inject({ method: "POST", url, headers: { origin: ORIGIN, cookie: who.cookie }, payload });
  const newConversation = async (who: { cookie: string }, autopilot = false) => (await post(who, "/api/agent/conversations", { autopilot, context: { studyId: study.id } })).json().conversation.id as string;
  const upload = async (who: { cookie: string }, conv: string, filename: string, data: string) => {
    const body = multipart({}, { filename, data: Buffer.from(data, "utf8") });
    const r = await t.app.inject({ method: "POST", url: `/api/agent/conversations/${conv}/uploads`, headers: { origin: ORIGIN, cookie: who.cookie, ...body.headers }, payload: body.payload });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().attachment.id as string;
  };
  const qmdOf = async (deckId: string) => (await t.db.query<{ content: string }>("SELECT s.content FROM deck_sources s JOIN deck_source_trees tr ON tr.deck_id=s.deck_id AND s.path=tr.entry WHERE s.deck_id=$1", [deckId])).rows[0]!.content;

  beforeAll(async () => {
    t = await createTestContext();
    alice = await t.login("student", "alice-mat");
    bob = await t.login("student", "bob-mat");
    study = await insertStudy(t.db, alice.id, "醫院掛號語音");
    setWorkflowAvailability(async () => true);
    // Fake worker: completes preview renders with clean screenshot metrics.
    worker = (async () => {
      while (!stop) {
        const jobs = (await t.db.query<{ id: string; payload: { previewId: string; deckId: string; shots?: boolean } }>("SELECT id, payload FROM jobs WHERE kind='slide_preview' AND status='queued'")).rows;
        for (const j of jobs) {
          const pv = (await t.db.query<{ output_prefix: string }>("UPDATE deck_previews SET status='ready', entry_html='index.html', finished_at=now() WHERE id=$1 RETURNING output_prefix", [j.payload.previewId])).rows[0];
          if (!j.payload.shots || !pv) {
            await t.db.query("UPDATE jobs SET status='succeeded', finished_at=now() WHERE id=$1", [j.id]);
            continue;
          }
          const qmd = (await t.db.query<{ content: string }>("SELECT content FROM deck_sources WHERE deck_id=$1 AND path='index.qmd'", [j.payload.deckId])).rows[0]?.content ?? "";
          const titles = ["", ...[...qmd.matchAll(/^## (.+)$/gm)].map((x) => x[1]!.trim())];
          const metrics = { words: 20, bullets: 2, minFont: 22, maxFont: 40, overflowY: 0, overflowX: 0, visuals: 1, tables: 1, diagrams: 0, diagramErrors: 0, rawDiagramCode: 0, codeBlocks: 0, emptyBand: 0.1 };
          await t.storage.put(`${pv.output_prefix}_hub/shots.json`, Buffer.from(JSON.stringify({ version: 1, width: 1280, height: 800, total: titles.length, truncated: false, pages: titles.map((title, i) => ({ index: i + 1, h: i, title, metrics })) })), "application/json");
          await t.db.query("UPDATE jobs SET result=$2, status='succeeded', finished_at=now() WHERE id=$1", [j.id, JSON.stringify({ shots: { count: titles.length } })]);
        }
        await new Promise((r) => setTimeout(r, 150));
      }
    })();
  });
  afterAll(async () => {
    stop = true;
    await worker;
    await t?.close();
  });
  beforeEach(() => {
    m = mockModel();
    m.set("requirements", '{"requirements":[]}');
    m.set("verify", PASS);
    m.set("verify_final", allPass);
    m.set("write_slides", writer);
    m.set("speaker_notes", '{"notes":[]}');
  });

  it("「交給 Agent」 with an attached Deep-Research file: a material deck from the file, the listed parts each a page, no cover repeat", async () => {
    const conv = await newConversation(alice);
    const fileId = await upload(alice, conv, MATERIAL_FILE, DEEP_RESEARCH_MD);
    const cover = "Deep Research：醫院掛號電話的串流語音辨識——門診科別與醫師姓名的熱詞偏置";
    // The planner adds a cover page (the production duplicate) before ten content pages, the listed parts among them.
    const pages = [cover, ...MATERIAL_SECTIONS, "已知事實與合理推論", "待驗證構想", "時程"];
    m.set("outline", JSON.stringify({ pages: pages.map((title, i) => ({ title, points: ["來自 deep research 結果的重點"], layout: "T", ...(i === 0 ? { kind: "title" } : {}) })) }));
    const res = await post(alice, "/api/workflows", { request: MATERIAL_REQUEST, conversation_id: conv, context: { studyId: study.id }, attachments: [{ kind: "upload", id: fileId }] });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().workflow.id as string;
    const created = (await getRun(t.db, id))!;
    // A reference, not a copy; the chip is on the user message.
    expect(created.inputs.materials).toEqual([{ kind: "upload", id: fileId, title: MATERIAL_FILE }]);
    expect(JSON.stringify(created.inputs)).not.toContain("MedReg-TW");
    expect((created.state.route as { deck?: string }).deck).toBe("material");
    const msg = (await t.db.query<{ attachments: { kind: string; id: string }[] }>("SELECT attachments FROM agent_messages WHERE conversation_id=$1 AND role='user'", [conv])).rows[0]!;
    expect(msg.attachments.map((a) => [a.kind, a.id])).toEqual([["upload", fileId]]);

    expect((await runWorkflow(deps(), id)).status).toBe("awaiting_plan_approval");
    const planned = (await getRun(t.db, id))!;
    // Read with the owner's permissions; an upload is untrusted data and taints the run.
    expect((planned.state.material as { read_at?: string; titles?: string[] }).titles).toEqual([MATERIAL_FILE]);
    expect(planned.tainted).toBe(true);
    expect(planned.taint_sources).toContain(`上傳的檔案〈${MATERIAL_FILE}〉`);
    // No topic survey: no decomposition / search / paper picks, no import write.
    expect(m.count("topic_plan") + m.count("topic_select")).toBe(0);
    expect(planned.plan!.writes.map((w) => w.kind)).toEqual(["deck"]);
    expect(planned.plan!.notes).toContain("主要材料");
    // The outline saw the material and the listed parts; the planned cover page was dropped.
    const outlinePrompt = m.prompts("outline")[0]!;
    expect(outlinePrompt).toContain("MedReg-TW");
    expect(outlinePrompt).toContain("「需要教授決策的問題」");
    expect(planned.plan!.outline!.map((o) => o.title)).toEqual(pages.slice(1));
    // The user's asks: the parts (checked page by page), the distinction (judged), the material, the professor.
    const reqs = planned.plan!.requirements as Requirement[];
    expect(reqs.find((r) => r.type === "include_topics")!.params!.sections).toBe(true);
    expect(reqs.some((r) => /清楚區分/.test(r.text))).toBe(true);
    expect(reqs.some((r) => /主要材料/.test(r.text))).toBe(true);
    expect(planned.criteria.some((c) => c.check?.id === "req_sections")).toBe(true);
    expect(planned.criteria.find((c) => c.id === "pages")!.check!.params!.no_cover_repeat).toBe(true);

    await approveWorkflow(t.app, await asUser(alice.id), id, {});
    const out = await runWorkflow(deps(), id);
    const done = (await getRun(t.db, id))!;
    expect(out.status, JSON.stringify(done.report?.issues)).toBe("done");
    // Writers got the material; the deck carries it; its first page is content, not the cover again.
    expect(m.prompts("write_slides").every((p) => p.includes("使用者提供的資料"))).toBe(true);
    const qmd = await qmdOf(done.artifacts.find((a) => a.kind === "deck")!.id);
    expect(qmd).toContain("MedReg-TW");
    expect(/^## (.+)$/m.exec(qmd)![1]).toBe("研究背景");
    expect(done.criteria.find((c) => c.check?.id === "req_sections")!.status).toBe("pass");
  });

  it("start_workflow: the turn's attachment is picked up when the assistant forgot attachment_ids; someone else's upload is refused; autopilot message", async () => {
    const conv = await newConversation(alice, true);
    const fileId = await upload(alice, conv, MATERIAL_FILE, DEEP_RESEARCH_MD);
    const bobConv = await newConversation(bob);
    const bobFile = await upload(bob, bobConv, "bob.md", "# Bob 的資料\n\n不屬於 alice 的內容。\n");
    const words = "我已經有一個deep research的結果 幫我以此做成能像教授報告的簡報";
    await t.db.query("INSERT INTO agent_messages(conversation_id,role,content,text,attachments) VALUES($1,'user',$2,$3,$4)", [conv, JSON.stringify([{ type: "text", text: words }]), words, JSON.stringify([{ kind: "upload", id: fileId, title: MATERIAL_FILE, study: null, url: null, upload_kind: "document" }])]);
    const tool = getAgentTool("start_workflow")!;
    const ctx = { app: t.app, db: t.db, user: await asUser(alice.id), source: "agent" as const, conversationId: conv, runId: null, autopilot: true };
    const res = await tool.execute(tool.input.parse({ request: "用附件做給教授的報告簡報", study: study.id, attachment_ids: [bobFile] }), ctx);
    const data = res.data as { workflow_id: string };
    const r = (await getRun(t.db, data.workflow_id))!;
    expect(r.inputs.materials).toEqual([{ kind: "upload", id: fileId, title: MATERIAL_FILE }]);
    expect(JSON.stringify(r.inputs)).not.toContain(bobFile);
    const message = JSON.parse(res.text!).message as string;
    expect(message).toContain("不要請使用者確認計畫");
    expect(message).toContain(`〈${MATERIAL_FILE}〉`);
    await t.db.query("UPDATE workflow_runs SET status='cancelled' WHERE id=$1", [r.id]);
  });

  it("「用我上傳的 PDF」 without an attachment on the turn: the conversation's newest uploaded document", async () => {
    const conv = await newConversation(alice);
    const fileId = await upload(alice, conv, "notes.md", "# 實驗紀錄\n\nMedReg-TW recall 61.3%。\n");
    const words = "用我上傳的檔案做成簡報";
    await t.db.query("INSERT INTO agent_messages(conversation_id,role,content,text) VALUES($1,'user',$2,$3)", [conv, JSON.stringify([{ type: "text", text: words }]), words]);
    const tool = getAgentTool("start_workflow")!;
    const res = await tool.execute(tool.input.parse({ request: "用上傳的檔案做簡報", study: study.id }), { app: t.app, db: t.db, user: await asUser(alice.id), source: "agent" as const, conversationId: conv, runId: null, autopilot: false });
    const r = (await getRun(t.db, (res.data as { workflow_id: string }).workflow_id))!;
    expect(r.inputs.materials).toEqual([{ kind: "upload", id: fileId, title: "notes.md" }]);
    expect(JSON.parse(res.text!).message).toContain("計畫準備好時請他確認");
    await t.db.query("UPDATE workflow_runs SET status='cancelled' WHERE id=$1", [r.id]);
  });

  it("pasted notes: a message ref; the Brief's words are only the request part", async () => {
    const conv = await newConversation(alice);
    await t.db.query("INSERT INTO agent_messages(conversation_id,role,content,text) VALUES($1,'user',$2,$3)", [conv, JSON.stringify([{ type: "text", text: PASTED_NOTES }]), PASTED_NOTES]);
    expect(await collectUserWords(t.db, conv)).toEqual(["下面是我這兩週的實驗筆記： 幫我把上面的筆記做成簡報"]);
    const tool = getAgentTool("start_workflow")!;
    const res = await tool.execute(tool.input.parse({ request: "把貼上的實驗筆記做成簡報", study: study.id }), { app: t.app, db: t.db, user: await asUser(alice.id), source: "agent" as const, conversationId: conv, runId: null, autopilot: false });
    const r = (await getRun(t.db, (res.data as { workflow_id: string }).workflow_id))!;
    const mats = r.inputs.materials as { kind: string; id: string }[];
    expect(mats.map((x) => x.kind)).toEqual(["message"]);
    expect((r.state.route as { deck?: string }).deck).toBe("material");
    await t.db.query("UPDATE workflow_runs SET status='cancelled' WHERE id=$1", [r.id]);
  });
});
