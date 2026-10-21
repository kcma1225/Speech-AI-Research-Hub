/** AI layout review (「AI 檢查排版」): slides preview shots + version pages, LaTeX client pages, suggestions, gating. */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LightMyRequestResponse } from "fastify";
import { aiFor } from "../src/ai/platform/index.js";
import { parseReview, sniffImage } from "../src/lib/vision/review.js";
import { visualSelfFix } from "../src/lib/vision/slides.js";
import { createTestContext, hasTestDb, hasTestS3, ORIGIN, type TestContext } from "./helpers.js";
import { MockServer, sse } from "./ai-providers-mock.js";
import { userSession } from "./slides-fixtures.js";
import { addStudyMember, insertStudy } from "./study-fixtures.js";

process.env.PROVIDER_TOKEN_KEY ??= randomBytes(32).toString("base64");

// Minimal WebP (RIFF....WEBP) and PNG headers: the review only sniffs magic bytes.
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x20, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(24, 7)]);
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(32, 1)]);

describe("review parsing", () => {
  const files = [{ id: "f1", path: "index.qmd", text: "---\ntitle: x\n---\n\n## 問題定義\n\n- a\n- b\n" }];
  it("keeps verified fixes only and normalises fields", () => {
    const r = parseReview(
      '```json\n{"summary":"還不錯","issues":[' +
        '{"page":2,"severity":"high","category":"overflow","title":"表格超出","detail":"右側被裁切","suggestion":"拆頁","file":"index.qmd","line":99,"find":"## 問題定義","replace":"## 問題定義 {.smaller}"},' +
        '{"page":9,"severity":"weird","category":"nope","title":"不存在的頁","detail":"x","find":"不在原始碼","replace":"y"}]}\n```\ndata: [DONE]',
      { pages: [1, 2], categories: ["overflow", "other"], files },
    );
    expect(r.summary).toBe("還不錯");
    expect(r.issues[0]).toMatchObject({ page: 2, severity: "high", category: "overflow", path: "index.qmd", line: 5, fix: { file_id: "f1", line: 5 } });
    expect(r.issues[1]).toMatchObject({ page: null, severity: "medium", category: "other", fix: null, path: null });
  });
  it("falls back to the raw text when the reply is not JSON", () => {
    expect(parseReview("版面整體清楚。", { pages: [1], categories: ["other"], files }).summary).toBe("版面整體清楚。");
  });
  it("sniffs image types", () => {
    expect(sniffImage(PNG)).toBe("image/png");
    expect(sniffImage(WEBP)).toBe("image/webp");
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImage(Buffer.from("<svg"))).toBeNull();
  });
});

const run = hasTestDb && hasTestS3 ? describe : describe.skip;

run("layout review endpoints", () => {
  let t: TestContext;
  let admin: { id: string; cookie: string };
  let member: { id: string; cookie: string };
  let outsider: { id: string; cookie: string };
  let study: { id: string; slug: string };
  const S = new MockServer();
  let reply = "{}";
  const json = (r: LightMyRequestResponse) => r.json() as Record<string, any>;
  const send = (who: { cookie: string }, method: "POST" | "PUT", url: string, payload: object = {}) => t.app.inject({ method, url, headers: { origin: ORIGIN, cookie: who.cookie }, payload });
  const get = (who: { cookie: string }, url: string) => t.app.inject({ method: "GET", url, headers: { cookie: who.cookie } });
  const ids = {} as Record<"deck" | "p" | "seer" | "text", string>;

  beforeAll(async () => {
    await S.start();
    S.on("GET", "/v1/models", { body: { data: [{ id: "text-only", capabilities: { vision: false } }, { id: "seer", capabilities: { vision: true } }] } });
    S.on("POST", "/v1/chat/completions", () => ({ chunks: sse([{ choices: [{ index: 0, delta: { role: "assistant", content: reply } }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }]) }));
    t = await createTestContext();
    admin = await t.ownerCookie();
    member = await userSession(t.db, "student", "林雅婷");
    outsider = await userSession(t.db, "student", "路人");
    study = await insertStudy(t.db, member.id, "QA 視覺研究");
    const prof = await userSession(t.db, "professor", "王教授");
    await addStudyMember(t.db, study.id, prof.id, "advisor");
    const p = await send(admin, "POST", "/api/admin/ai/providers", { family: "llm", kind: "openai-compatible", name: "閘道", config: { baseUrl: `${S.url}/v1` }, secrets: { apiKey: "k" } });
    ids.p = json(p).provider.id;
    await send(admin, "POST", `/api/admin/ai/providers/${ids.p}/test`, {});
    ids.text = json(await send(admin, "POST", "/api/admin/ai/routes", { name: "純文字", capability: "chat", strategy: "single", members: [{ provider_id: ids.p, model: "text-only" }] })).route.id;
    ids.seer = json(await send(admin, "POST", "/api/admin/ai/routes", { name: "視覺", capability: "chat", strategy: "single", members: [{ provider_id: ids.p, model: "seer" }] })).route.id;
  });
  afterAll(async () => {
    await aiFor(t.app)?.logger.flush();
    await t?.close();
    await S.stop();
  });

  const bind = async (role: string, routeId: string) => {
    expect((await send(admin, "PUT", `/api/admin/ai/roles/${role}`, { route_id: routeId })).statusCode).toBe(200);
  };

  it("slides: 422 without vision; capture queues a preview job with shots", async () => {
    const deck = await send(member, "POST", "/api/slides", { studyId: study.slug, title: "QA 第 1 週", kind: "progress" });
    ids.deck = json(deck).id;
    await bind("slides", ids.text);
    const no = await send(member, "POST", `/api/slides/${ids.deck}/ai/layout-review/capture`);
    expect(no.statusCode).toBe(422);
    expect(json(no).code).toBe("vision_unavailable");
    expect(json(await get(member, "/api/ai/status")).roles.slides.vision).toBe(false);

    await bind("slides", ids.seer);
    expect(json(await get(member, "/api/ai/status")).roles.slides.vision).toBe(true);
    expect((await send(outsider, "POST", `/api/slides/${ids.deck}/ai/layout-review/capture`)).statusCode).toBe(403);
    expect(json(await get(member, `/api/slides/${ids.deck}/ai/layout-review/capture`)).capture.state).toBe("none");
    const cap = await send(member, "POST", `/api/slides/${ids.deck}/ai/layout-review/capture`);
    expect(cap.statusCode).toBe(202);
    expect(json(cap).capture.state).toBe("capturing");
    const job = (await t.db.query("SELECT id, payload FROM jobs WHERE kind='slide_preview' AND payload->>'deckId'=$1 ORDER BY created_at DESC LIMIT 1", [ids.deck])).rows[0];
    expect(job.payload.shots).toBe(true);
    // A second request reuses the queued shot preview.
    expect((await send(member, "POST", `/api/slides/${ids.deck}/ai/layout-review/capture`)).statusCode).toBe(200);
    // A plain preview request reuses it too (it already has shots).
    expect(json(await send(member, "POST", `/api/slides/${ids.deck}/source/preview`)).preview.latest.id).toBe(json(cap).capture.preview_id);
    expect((await send(member, "POST", `/api/slides/${ids.deck}/ai/layout-review`, { source: "preview" })).statusCode).toBe(409);

    // Play the worker: output, two shots, manifest, result.
    const prefix = job.payload.outputPrefix as string;
    await t.storage.put(`${prefix}index.html`, "<html></html>", "text/html");
    await t.storage.put(`${prefix}_hub/shots/1.webp`, WEBP, "image/webp");
    await t.storage.put(`${prefix}_hub/shots/2.webp`, WEBP, "image/webp");
    await t.storage.put(`${prefix}_hub/shots.json`, JSON.stringify({ version: 1, width: 1280, height: 800, total: 2, truncated: false, pages: [{ index: 1, h: 0, title: "標題" }, { index: 2, h: 1, title: "問題定義" }] }), "application/json");
    await t.db.query("UPDATE jobs SET status='succeeded',progress=100,finished_at=now(),result=$2 WHERE id=$1", [
      job.id,
      JSON.stringify({ entryHtml: "index.html", fileCount: 1, quartoVersion: "1.x", shots: { count: 2, total: 2, width: 1280, height: 800, truncated: false } }),
    ]);
    await t.finalizer.drain();
    expect(json(await get(member, `/api/slides/${ids.deck}/ai/layout-review/capture`)).capture).toMatchObject({ state: "ready", count: 2 });
    const img = await get(member, `/api/slides/${ids.deck}/ai/layout-review/shots/2`);
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toBe("image/webp");
  });

  it("slides: reviews the shots with the source and turns a fix into a deck_source suggestion", async () => {
    reply = JSON.stringify({
      summary: "第 2 頁太擠。",
      issues: [{ page: 2, severity: "high", category: "crowding", title: "條列太多", detail: "八個條列", suggestion: "縮小字", file: "index.qmd", line: 1, find: "## 問題定義", replace: "## 問題定義 {.smaller}" }],
    });
    S.requests.length = 0;
    const r = await send(member, "POST", `/api/slides/${ids.deck}/ai/layout-review`, { source: "preview" });
    expect(r.statusCode).toBe(200);
    const review = json(r).review;
    expect(review.pages).toEqual([1, 2]);
    expect(review.issues[0]).toMatchObject({ page: 2, category: "crowding", path: "index.qmd", fix: { find: "## 問題定義" } });
    const sent = S.requests.find((q) => q.path === "/v1/chat/completions")!.json;
    expect(sent.model).toBe("seer");
    const parts = sent.messages[1].content as Array<{ type: string; image_url?: { url: string } }>;
    expect(parts.filter((p) => p.type === "image_url").map((p) => p.image_url!.url.slice(0, 23))).toEqual(["data:image/webp;base64,", "data:image/webp;base64,"]);
    expect(JSON.stringify(sent.messages)).toContain("問題定義");

    const fix = review.issues[0].fix;
    const s = await send(member, "POST", `/api/slides/${ids.deck}/ai/layout-review/suggest`, { file_id: fix.file_id, find: fix.find, replace: fix.replace, title: "條列太多" });
    expect(s.statusCode).toBe(201);
    expect(json(s).suggestion).toMatchObject({ target_type: "deck_source", source: "ai" });
    const stale = await send(member, "POST", `/api/slides/${ids.deck}/ai/layout-review/suggest`, { file_id: fix.file_id, find: "不存在的文字", replace: "x" });
    expect(stale.statusCode).toBe(409);
    expect((await send(outsider, "POST", `/api/slides/${ids.deck}/ai/layout-review`, { source: "preview" })).statusCode).toBe(403);
  });

  it("slides: the AI draft's visual self-check applies verified overflow fixes only", async () => {
    const cap = json(await get(member, `/api/slides/${ids.deck}/ai/layout-review/capture`)).capture;
    reply = JSON.stringify({
      summary: "x",
      issues: [
        { page: 2, severity: "high", category: "overflow", title: "超出", detail: "d", find: "## 卡住", replace: "## 卡住 {.smaller}" },
        { page: 2, severity: "high", category: "contrast", title: "對比", detail: "d", find: "## 對帳", replace: "## 對帳 {.x}" },
      ],
    });
    const deck = { id: ids.deck, kind: "progress" as const, title: "QA 第 1 週" };
    const out = await visualSelfFix(aiFor(t.app), t.db, t.storage, deck, cap.preview_id, { userId: member.id });
    expect(out?.applied).toBe(1);
    expect(out?.text).toContain("## 卡住 {.smaller}");
    expect(out?.text).not.toContain("{.x}");
  });

  it("latex: validates client images, maps SyncTeX ranges to source and verifies fixes", async () => {
    await bind("writing", ids.seer);
    const created = await send(member, "POST", `/api/studies/${study.slug}/latex`, { title: "QA 論文", template: "article-en" });
    expect(created.statusCode).toBe(201);
    const projectId = json(created).project.id as string;
    const detail = json(await get(member, `/api/latex/${projectId}`));
    const section = detail.files.find((f: { path: string }) => f.path.startsWith("sections/"));
    const text = (await get(member, `/api/latex/${projectId}/files/${section.id}/raw`)).body;
    const line = text.split("\n").find((l: string) => l.trim().length > 8)!;
    const compileId = (await t.db.query(
      "INSERT INTO latex_compiles(project_id,status,compiler,root_file,manifest_key,output_prefix,result) VALUES($1,'success','pdflatex','main.tex','m','latex/x/',$2) RETURNING id",
      [projectId, JSON.stringify({ errors: [], warnings: [{ severity: "badbox", source: "latex", file: section.path, line: 3, message: "Overfull \\hbox (12.3pt too wide) in paragraph at lines 3--4" }] })],
    )).rows[0].id;

    const bad = await send(member, "POST", `/api/latex/${projectId}/ai/layout-review`, { compile_id: compileId, pages: [{ page: 1, image: `data:image/png;base64,${Buffer.from("<svg>").toString("base64")}` }] });
    expect(bad.statusCode).toBe(400);
    expect((await send(member, "POST", `/api/latex/${projectId}/ai/layout-review`, { compile_id: compileId, pages: Array.from({ length: 7 }, (_, i) => ({ page: i + 1, image: PNG.toString("base64") })) })).statusCode).toBe(400);

    reply = JSON.stringify({ summary: "有一行超出版心。", issues: [{ page: 1, severity: "high", category: "overfull", title: "超出版心", detail: "第一段", suggestion: "斷行", file: section.path, line: 3, find: line, replace: `${line} % fixed` }] });
    S.requests.length = 0;
    const r = await send(member, "POST", `/api/latex/${projectId}/ai/layout-review`, {
      compile_id: compileId,
      pages: [{ page: 1, image: `data:image/png;base64,${PNG.toString("base64")}`, sources: [{ path: section.path, from: 1, to: 5 }] }],
    });
    expect(r.statusCode).toBe(200);
    const issue = json(r).review.issues[0];
    expect(issue).toMatchObject({ category: "overfull", path: section.path, fix: { file_id: section.id, find: line } });
    const prompt = JSON.stringify(S.requests.find((q) => q.path === "/v1/chat/completions")!.json.messages);
    expect(prompt).toContain("Overfull");
    expect(prompt).toContain("已載入的套件");
    expect(prompt).toContain(`${section.path} 第 1–5 行`);
    const s = await send(member, "POST", `/api/latex/${projectId}/ai/layout-review/suggest`, { file_id: issue.fix.file_id, find: issue.fix.find, replace: issue.fix.replace });
    expect(s.statusCode).toBe(201);
    expect(json(s).suggestion.target_type).toBe("latex_file");
    expect((await send(outsider, "POST", `/api/latex/${projectId}/ai/layout-review`, { compile_id: compileId, pages: [{ page: 1, image: PNG.toString("base64") }] })).statusCode).toBe(403);

    await bind("writing", ids.text);
    const nv = await send(member, "POST", `/api/latex/${projectId}/ai/layout-review`, { compile_id: compileId, pages: [{ page: 1, image: PNG.toString("base64") }] });
    expect(nv.statusCode).toBe(422);
    expect(json(nv).code).toBe("vision_unavailable");
  });
});
