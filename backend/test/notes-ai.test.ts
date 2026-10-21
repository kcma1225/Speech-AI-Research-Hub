/**
 * Note AI actions (role `writing`) → suggestions over SSE. The unavailable path always runs; the live path runs only
 * with TEST_LLM_BASE_URL / TEST_LLM_API_KEY (cheapest model glm/glm-5.3-flash, tiny outputs).
 */
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aiFor } from "../src/ai/platform/index.js";
import { createTestContext, hasTestDb, ORIGIN, type TestContext } from "./helpers.js";
import { insertStudy } from "./study-fixtures.js";

process.env.PROVIDER_TOKEN_KEY ??= randomBytes(32).toString("base64");
const llmBase = process.env.TEST_LLM_BASE_URL;
const llmKey = process.env.TEST_LLM_API_KEY;

/** Parses an SSE body into [{event, data}]. */
const events = (body: string) =>
  body
    .split("\n\n")
    .map((block) => {
      const event = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      return event ? { event, data: data ? JSON.parse(data) : null } : null;
    })
    .filter((x): x is { event: string; data: any } => !!x);

describe.skipIf(!hasTestDb)("note AI actions", () => {
  let t: TestContext;
  let alice: { id: string; cookie: string };
  let owner: { id: string; cookie: string };
  let noteId = "";
  const post = (who: { cookie: string }, url: string, payload: object = {}) => t.app.inject({ method: "POST", url, headers: { origin: ORIGIN, cookie: who.cookie }, payload });

  beforeAll(async () => {
    t = await createTestContext();
    alice = await t.login("student", "Alice");
    owner = await t.ownerCookie();
    const study = await insertStudy(t.db, alice.id, "語音情緒辨識");
    await t.db.query("UPDATE studies SET summary_md='以自監督語音特徵做中文情緒辨識。' WHERE id=$1", [study.id]);
    noteId = (await post(alice, `/api/studies/${study.slug}/notes`, { title: "週記", content_md: "今天跑了 baseline 實驗 準確率大概七成 下週要試 wav2vec2\n" })).json().note.id;
  });
  afterAll(async () => {
    await aiFor(t.app).logger.flush().catch(() => {});
    await t?.close();
  });

  it("reports 「維護中」 as an SSE error when the writing role has no route", async () => {
    const r = await post(alice, `/api/notes/${noteId}/ai/rewrite`, { from: 0, to: 13, before: "今天跑了 baseline", mode: "rewrite" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/event-stream");
    const ev = events(r.body);
    const err = ev.find((e) => e.event === "error");
    expect(err?.data).toMatchObject({ code: "llm_unavailable" });
    expect(err?.data.error).toContain("尚未設定");
    expect(ev.at(-1)?.event).toBe("done");
  });

  it("validates the selection before calling the model", async () => {
    expect((await post(alice, `/api/notes/${noteId}/ai/rewrite`, { from: 0, to: 4, before: "不一樣" })).statusCode).toBe(409);
    expect((await post(alice, `/api/notes/${noteId}/ai/rewrite`, { from: 3, to: 3, before: "" })).statusCode).toBe(400);
  });

  it("transcribes a voice clip through the asr role (mock OpenAI-compatible endpoint)", async () => {
    let received = 0;
    const server = createServer((req, res) => {
      let bytes = 0;
      req.on("data", (c: Buffer) => (bytes += c.length));
      req.on("end", () => {
        received = bytes;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ text: "今天的實驗結果不錯", language: "zh", duration: 2.1, segments: [{ start: 0, end: 1, text: "今天的實驗" }, { start: 1, end: 2.1, text: "结果不错" }] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const send = (url: string, payload: object, method: "POST" | "PUT" = "POST") => t.app.inject({ method, url, headers: { origin: ORIGIN, cookie: owner.cookie }, payload });
    const p = await send("/api/admin/ai/providers", { family: "asr", kind: "speaches", name: "mock asr", config: { base_url: `http://127.0.0.1:${port}` } });
    expect(p.statusCode, p.body).toBe(201);
    const route = await send("/api/admin/ai/routes", { name: "語音（測試）", capability: "asr", strategy: "single", members: [{ provider_id: p.json().provider.id, model: "Systran/faster-whisper-large-v3", params: { convert_script: "s2twp" } }] });
    expect(route.statusCode, route.body).toBe(201);
    expect((await send("/api/admin/ai/roles/asr", { route_id: route.json().route.id }, "PUT")).statusCode).toBe(200);
    aiFor(t.app).invalidate();
    const boundary = "----hubtest";
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="durationSec"\r\n\r\n2.1\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="voice.webm"\r\nContent-Type: audio/webm\r\n\r\n`),
      randomBytes(4096),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const r = await t.app.inject({ method: "POST", url: `/api/notes/${noteId}/transcribe`, headers: { origin: ORIGIN, cookie: alice.cookie, "content-type": `multipart/form-data; boundary=${boundary}` }, payload: body });
    server.close();
    expect(r.statusCode).toBe(200);
    expect(received).toBeGreaterThan(4096);
    expect(r.json()).toMatchObject({ text: "今天的實驗結果不錯" });
    const prof = await t.login("professor", "P");
    const denied = await t.app.inject({ method: "POST", url: `/api/notes/${noteId}/transcribe`, headers: { origin: ORIGIN, cookie: prof.cookie, "content-type": `multipart/form-data; boundary=${boundary}` }, payload: body });
    expect(denied.statusCode).toBe(403);
  });

  it("asks for low reasoning and a budget large enough for reasoning models (regression: 接續 returned nothing)", async () => {
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
        res.write(`data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "下一步：補 whisper 對照。" }, finish_reason: null }] })}\n\n`);
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
    expect(route.statusCode, route.body).toBe(201);
    expect((await send("/api/admin/ai/roles/writing", { route_id: route.json().route.id }, "PUT")).statusCode).toBe(200);
    aiFor(t.app).invalidate();
    const ev = events((await post(alice, `/api/notes/${noteId}/ai/continue`, { at: 0 })).body);
    server.close();
    expect(ev.find((e) => e.event === "error")).toBeUndefined();
    expect(ev.some((e) => e.event === "suggestion")).toBe(true);
    expect(bodies[0].reasoning_effort).toBe("low");
    expect(bodies[0].max_tokens ?? bodies[0].max_completion_tokens).toBeGreaterThanOrEqual(2000);
  });

  it.skipIf(!(llmBase && llmKey))("rewrites a selection into bullets and continues writing (live, cheapest model)", async () => {
    const send = (url: string, payload: object, method: "POST" | "PUT" = "POST") => t.app.inject({ method, url, headers: { origin: ORIGIN, cookie: owner.cookie }, payload });
    const p = (await send("/api/admin/ai/providers", { family: "llm", kind: "openai-compatible", name: "test gateway", config: { baseUrl: llmBase, timeoutMs: 60_000 }, secrets: { apiKey: llmKey } })).json();
    const route = (await send("/api/admin/ai/routes", { name: "寫作（測試）", capability: "chat", strategy: "fallback", members: [{ provider_id: p.provider.id, model: "glm/glm-5.3-flash" }, { provider_id: p.provider.id, model: "glm/glm-5-turbo" }] })).json();
    expect((await send("/api/admin/ai/roles/writing", { route_id: route.route.id }, "PUT")).statusCode).toBe(200);
    aiFor(t.app).invalidate();

    const text = "今天跑了 baseline 實驗 準確率大概七成 下週要試 wav2vec2\n";
    const r = await post(alice, `/api/notes/${noteId}/ai/rewrite`, { from: 0, to: text.length, before: text, mode: "bullets" });
    const ev = events(r.body);
    expect(ev.find((e) => e.event === "error")).toBeUndefined();
    expect(ev.some((e) => e.event === "delta")).toBe(true);
    const s = ev.find((e) => e.event === "suggestion")!.data.suggestion;
    expect(s).toMatchObject({ source: "ai", title: "AI 整理成條列", pending: 1 });
    expect(s.hunks[0].before).toBe(text);
    expect(s.hunks[0].after).toMatch(/^\s*[-*]/m);

    const c = events((await post(alice, `/api/notes/${noteId}/ai/continue`, { at: text.length, instruction: "只寫一句話" })).body);
    const s2 = c.find((e) => e.event === "suggestion")?.data.suggestion;
    expect(s2?.hunks[0]).toMatchObject({ before: "", from: text.length });
  });
});
