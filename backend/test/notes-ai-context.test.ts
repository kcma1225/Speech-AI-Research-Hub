/** 「AI 草擬」 study context: recent notes, open tasks, meeting feedback and papers reach the prompt (mock model), bounded. */
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aiFor } from "../src/ai/platform/index.js";
import { draftMessages } from "../src/lib/notes/ai.js";
import { formatNoteDraftContext, NOTE_CONTEXT_MAX_CHARS } from "../src/lib/notes/ai-context.js";
import { addPaperToStudy, insertPaper } from "../src/lib/library/store.js";
import { createTestContext, hasTestDb, ORIGIN, type TestContext } from "./helpers.js";
import { insertStudy } from "./study-fixtures.js";

process.env.PROVIDER_TOKEN_KEY ??= randomBytes(32).toString("base64");

describe("note draft context (unit)", () => {
  it("formats every part and stays within the budget", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ title: `待辦 ${i}`, due_on: null, assignee: "Alice" }));
    const text = formatNoteDraftContext({ notes: [{ title: "週記", date: "2026-10-14", kind: "research", author: "Alice", excerpt: "跑了 baseline" }], tasks: many, feedback: [], papers: [] });
    expect(text).toContain("### 最近的筆記");
    expect(text).toContain("### 未完成的待辦");
    expect(text.length).toBeLessThanOrEqual(NOTE_CONTEXT_MAX_CHARS + 1);
    expect(formatNoteDraftContext({ notes: [], tasks: [], feedback: [], papers: [] })).toBe("");
  });

  it("the draft prompt fences the context and forbids invented next-step sections", () => {
    const msgs = draftMessages({ study: { title: "S", summary_md: "" }, note: { title: "實驗", content: "", event_date: null }, template: null, related: "### 未完成的待辦\n- 補 whisper" });
    expect(String(msgs[0]!.content)).toContain("不要自行加入");
    expect(String(msgs[1]!.content)).toContain('<data name="study_context">');
    expect(String(draftMessages({ study: { title: "S", summary_md: "" }, note: { title: "x", content: "", event_date: null }, template: null }).at(-1)!.content)).not.toContain("study_context");
  });
});

describe.skipIf(!hasTestDb)("note AI draft with study context", () => {
  let t: TestContext;
  let alice: { id: string; cookie: string };
  let owner: { id: string; cookie: string };
  let noteId = "";
  const post = (who: { cookie: string }, url: string, payload: object = {}) => t.app.inject({ method: "POST", url, headers: { origin: ORIGIN, cookie: who.cookie }, payload });

  beforeAll(async () => {
    t = await createTestContext();
    alice = await t.login("student", "Alice");
    owner = await t.ownerCookie();
    const study = await insertStudy(t.db, alice.id, "串流語音辨識");
    await post(alice, `/api/studies/${study.slug}/notes`, { title: "週記 10/14", content_md: "zipformer baseline CER 6.1%，下週試 SpecAugment。\n", event_date: "2026-10-14" });
    noteId = (await post(alice, `/api/studies/${study.slug}/notes`, { title: "實驗紀錄 10/21", content_md: "" })).json().note.id;
    await post(alice, `/api/studies/${study.slug}/tasks`, { title: "補 whisper-small 對照組" });
    const meeting = (await t.db.query<{ id: string }>("INSERT INTO meetings(title,held_at,created_by) VALUES('週會',now() - interval '2 days',$1) RETURNING id", [alice.id])).rows[0]!.id;
    await t.db.query("INSERT INTO meeting_studies(meeting_id,study_id) VALUES($1,$2)", [meeting, study.id]);
    await t.db.query("INSERT INTO meeting_feedback(meeting_id,author_id,body_md) VALUES($1,$2,'CER 表格要附信賴區間')", [meeting, alice.id]);
    const paper = await insertPaper(t.db, { type: "paper-conference", title: "Zipformer: A faster and better encoder", authors: [{ family: "Yao", given: "Zengwei" }], year: 2024, venue: "ICLR" }, alice.id);
    await addPaperToStudy(t.db, { studyId: study.id, paper, userId: alice.id, citeKey: "yao2024zipformer" });
  });
  afterAll(async () => {
    await aiFor(t.app).logger.flush().catch(() => {});
    await t?.close();
  });

  it("sends recent notes, open tasks, meeting feedback and papers to the writing model", async () => {
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
        res.write(`data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "## 目的\n比較 SpecAugment。" }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const send = (url: string, payload: object, method: "POST" | "PUT" = "POST") => t.app.inject({ method, url, headers: { origin: ORIGIN, cookie: owner.cookie }, payload });
    const p = await send("/api/admin/ai/providers", { family: "llm", kind: "openai-compatible", name: "mock chat", config: { baseUrl: `http://127.0.0.1:${port}/v1` }, secrets: { apiKey: "x" } });
    expect(p.statusCode, p.body).toBe(201);
    const route = await send("/api/admin/ai/routes", { name: "寫作（mock）", capability: "chat", strategy: "single", members: [{ provider_id: p.json().provider.id, model: "mock" }] });
    expect((await send("/api/admin/ai/roles/writing", { route_id: route.json().route.id }, "PUT")).statusCode).toBe(200);
    aiFor(t.app).invalidate();
    const r = await post(alice, `/api/notes/${noteId}/ai/draft`, {});
    server.close();
    expect(r.body).toContain("event: suggestion");
    const prompt = JSON.stringify(bodies[0].messages);
    for (const needle of ["週記 10/14", "CER 6.1%", "補 whisper-small 對照組", "CER 表格要附信賴區間", "yao2024zipformer", "study_context"]) expect(prompt, needle).toContain(needle);
    // The note being drafted is not listed as its own context.
    expect(prompt.match(/實驗紀錄 10\/21/g)?.length).toBe(1);
  });
});
