/**
 * 「提問助手」 (POST /api/slides/:id/ask, lib/slides/ask.ts) against a mock OpenAI-compatible endpoint: in automatic mode a
 * short check (role `fast`, no deck / paper) runs first and a statement ends with `skip`; a question gets an answer from
 * role `assistant` with the deck (player page numbers, current page) and the paper in its context; the manual mode skips
 * the check; answers are rate-limited per account.
 */
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aiFor } from "../src/ai/platform/index.js";
import { clearAskCache } from "../src/lib/slides/ask.js";
import { insertPaper } from "../src/lib/library/store.js";
import { createTestContext, hasTestDb, ORIGIN, type TestContext } from "./helpers.js";
import { insertStudy } from "./study-fixtures.js";

process.env.PROVIDER_TOKEN_KEY ??= randomBytes(32).toString("base64");

const events = (body: string) =>
  body
    .split("\n\n")
    .map((block) => {
      const event = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      return event ? { event, data: data ? JSON.parse(data) : null } : null;
    })
    .filter((x): x is { event: string; data: any } => !!x);

describe.skipIf(!hasTestDb)("phone remote 提問助手", () => {
  let t: TestContext;
  let alice: { id: string; cookie: string };
  let deckId = "";
  let server: Server;
  const bodies: { system: string; user: string; model: string }[] = [];
  const ask = (payload: object, who = alice) => t.app.inject({ method: "POST", url: `/api/slides/${deckId}/ask`, headers: { origin: ORIGIN, cookie: who.cookie }, payload });

  beforeAll(async () => {
    t = await createTestContext();
    alice = await t.login("student", "Alice");
    const owner = await t.ownerCookie();
    const study = await insertStudy(t.db, alice.id, "串流 ASR");
    deckId = (await t.app.inject({ method: "POST", url: "/api/slides", headers: { origin: ORIGIN, cookie: alice.cookie }, payload: { studyId: study.slug, title: "WCTC-Biasing", kind: "paper_report" } })).json().id;
    const paper = await insertPaper(t.db, { type: "paper-conference", title: "WCTC-Biasing: Retraining-free Contextual Biasing", year: 2024, venue: "Interspeech", abstract: "We bias the encoder with a wildcard CTC keyword spotter at layer 9, without retraining.", authors: [{ family: "Lin", given: "A" }] } as never, alice.id);
    await t.db.query("UPDATE decks SET paper_id=$2 WHERE id=$1", [deckId, paper.id]);

    // Mock model: the check answers YES only for 「為什麼」; answers stream a fixed reply.
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c));
      req.on("end", () => {
        if (!req.url?.includes("/chat/completions")) {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ data: [{ id: "mock" }] }));
        }
        const body = JSON.parse(raw);
        const system = String(body.messages.find((m: { role: string }) => m.role === "system")?.content ?? "");
        const user = String(body.messages.at(-1)?.content ?? "");
        bodies.push({ system, user, model: body.model });
        const gate = system.includes("只回答 YES 或 NO");
        // 「只會想」: a reasoning model that returns no text while it may think (reasoning_effort set).
        const thinksOnly = user.includes("只會想") && body.reasoning_effort && body.reasoning_effort !== "none";
        const content = gate ? (/為什麼/.test(user.split("最新一句")[1] ?? "") ? "YES" : "NO") : thinksOnly ? "" : "> 問題：為什麼選第 9 層？\n**因為第 9 層的關鍵詞偵測最準。**\n- 依據（第 2 頁）";
        if (!body.stream) {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ id: "1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] }));
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const piece of [content.slice(0, 10), content.slice(10)]) res.write(`data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const send = (url: string, payload: object, method: "POST" | "PUT" = "POST") => t.app.inject({ method, url, headers: { origin: ORIGIN, cookie: owner.cookie }, payload });
    const p = await send("/api/admin/ai/providers", { family: "llm", kind: "openai-compatible", name: "mock chat", config: { baseUrl: `http://127.0.0.1:${port}/v1` }, secrets: { apiKey: "x" } });
    expect(p.statusCode, p.body).toBe(201);
    for (const [role, model] of [["fast", "mock-fast"], ["assistant", "mock-main"]] as const) {
      const route = await send("/api/admin/ai/routes", { name: role, capability: "chat", strategy: "single", members: [{ provider_id: p.json().provider.id, model }] });
      expect(route.statusCode, route.body).toBe(201);
      expect((await send(`/api/admin/ai/roles/${role}`, { route_id: route.json().route.id }, "PUT")).statusCode).toBe(200);
    }
    aiFor(t.app).invalidate();
    clearAskCache();
  });
  afterAll(async () => {
    server?.close();
    await aiFor(t.app).logger.flush().catch(() => {});
    await t?.close();
  });

  it("a statement in automatic mode is checked cheaply and skipped: no answer, no deck sent", async () => {
    bodies.length = 0;
    const ev = events((await ask({ heard: "接下來我們看實驗結果的部分", transcript: "大家好今天報告這篇論文", page: 3, gate: true })).body);
    expect(ev.map((e) => e.event)).toEqual(["skip", "done"]);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.model).toBe("mock-fast");
    expect(bodies[0]!.user).not.toContain("<deck>");
  });

  it("a question is answered from the deck and the paper, page marked", async () => {
    bodies.length = 0;
    const ev = events((await ask({ heard: "你為什麼選第九層做 biasing", transcript: "這裡我們在中間層插入偏置", page: 2, gate: true })).body);
    expect(ev[0]!.event).toBe("question");
    expect(ev.filter((e) => e.event === "delta").map((e) => e.data.text).join("")).toContain("第 9 層");
    expect(ev.at(-1)!.event).toBe("done");
    expect(ev.some((e) => e.event === "error")).toBe(false);
    const answer = bodies.find((b) => b.model === "mock-main")!;
    expect(answer.user).toContain("報告者現在講到第 2 頁");
    expect(answer.user).toMatch(/<deck>[\s\S]*第 1 頁/);
    expect(answer.user).toContain("wildcard CTC keyword spotter at layer 9");
    expect(answer.user).toContain("出處：Interspeech");
    expect(answer.user).toContain("你為什麼選第九層做 biasing");
  });

  it("「回答這題」 answers without the check; bad input and unknown decks are refused", async () => {
    bodies.length = 0;
    const ev = events((await ask({ heard: "這個方法的延遲多少", gate: false })).body);
    expect(ev.some((e) => e.event === "delta")).toBe(true);
    expect(bodies.map((b) => b.model)).toEqual(["mock-main"]);
    expect((await ask({ heard: "", gate: false })).statusCode).toBe(400);
    expect((await t.app.inject({ method: "POST", url: `/api/slides/00000000-0000-4000-8000-000000000000/ask`, headers: { origin: ORIGIN, cookie: alice.cookie }, payload: { heard: "x" } })).statusCode).toBe(404);
    expect((await t.app.inject({ method: "POST", url: `/api/slides/${deckId}/ask`, headers: { origin: ORIGIN }, payload: { heard: "x" } })).statusCode).toBe(401);
  });

  it("an answer that came back without text (all thinking) is retried once with thinking off", async () => {
    bodies.length = 0;
    const ev = events((await ask({ heard: "只會想的問題", gate: false })).body);
    expect(ev.filter((e) => e.event === "delta").map((e) => e.data.text).join("")).toContain("第 9 層");
    expect(ev.some((e) => e.event === "error")).toBe(false);
    expect(bodies.filter((b) => b.model === "mock-main")).toHaveLength(2);
  });

  it("limits answers per account and minute", async () => {
    const bob = await t.login("student", "Bob");
    const codes: number[] = [];
    for (let i = 0; i < 13; i++) codes.push((await ask({ heard: `問題 ${i}`, gate: false }, bob)).statusCode);
    expect(codes.slice(0, 12).every((c) => c === 200)).toBe(true);
    expect(codes[12]).toBe(429);
  });
});
