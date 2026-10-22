/**
 * Routes of document import (研究簡述「從檔案匯入」, note editor) and Markdown images: permissions, Magika
 * rejections over HTTP, suggestion creation and acceptance, AI condense when the writing role is down.
 */
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aiFor } from "../src/ai/platform/index.js";
import { createTestContext, hasTestDb, hasTestS3, ORIGIN, type TestContext } from "./helpers.js";
import { multipart } from "./slides-fixtures.js";
import { addStudyMember, insertStudy } from "./study-fixtures.js";

process.env.PROVIDER_TOKEN_KEY ??= randomBytes(32).toString("base64");
const fixture = (name: string) => readFileSync(new URL(`./doc-import-fixtures/${name}`, import.meta.url));
// 1×1 transparent PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

describe.skipIf(!hasTestDb || !hasTestS3)("doc import routes", () => {
  let t: TestContext;
  let alice: { id: string; cookie: string }; // owner
  let bob: { id: string; cookie: string }; // not a member
  let prof: { id: string; cookie: string }; // advisor
  let study: { id: string; slug: string };
  const upload = (who: { cookie: string }, url: string, fields: Record<string, string>, file?: { filename: string; data: Buffer }) => {
    const body = multipart(fields, file);
    return t.app.inject({ method: "POST", url, headers: { origin: ORIGIN, cookie: who.cookie, ...body.headers }, payload: body.payload });
  };

  beforeAll(async () => {
    t = await createTestContext();
    alice = await t.login("student", "Alice");
    bob = await t.login("student", "Bob");
    prof = await t.login("professor", "Prof");
    study = await insertStudy(t.db, alice.id, "低資源語音辨識");
    await addStudyMember(t.db, study.id, prof.id, "advisor");
    await t.db.query("UPDATE studies SET summary_md='既有的研究簡述。\n' WHERE id=$1", [study.id]);
  });
  afterAll(async () => {
    await aiFor(t.app).logger.flush().catch(() => {});
    await t?.close();
  });

  it("lists the accepted formats", async () => {
    const r = await t.app.inject({ method: "GET", url: "/api/doc-import/formats", headers: { cookie: alice.cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.json().accept).toContain(".docx");
    expect(r.json().maxBytes).toBe(30 * 1024 * 1024);
  });

  it("converts a document to Markdown without storing anything", async () => {
    const r = await upload(alice, "/api/doc-import", { mode: "markdown", purpose: "study_summary" }, { filename: "sample.docx", data: fixture("sample.docx") });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().markdown).toContain("低資源語音辨識研究");
    expect(r.json().document).toMatchObject({ format: "docx", detected: { label: "docx" } });
  });

  it("rejects disguised files with 415 and a hint", async () => {
    const exe = await upload(alice, "/api/doc-import", {}, { filename: "paper.pdf", data: fixture("bad-program.pdf") });
    expect(exe.statusCode).toBe(415);
    expect(exe.json().error).toBeTruthy();
    const zip = await upload(alice, "/api/doc-import", {}, { filename: "report.docx", data: fixture("bad-archive.docx") });
    expect(zip.statusCode).toBe(415);
    expect(zip.json()).toMatchObject({ code: "content_mismatch", error: "檔案內容與副檔名不符。" });
    const html = await upload(alice, "/api/doc-import", {}, { filename: "notes.txt", data: fixture("bad-page.txt") });
    expect(html.statusCode).toBe(415);
    expect(html.json().code).toBe("content_mismatch");
    const ext = await upload(alice, "/api/doc-import", {}, { filename: "tool.exe", data: PNG });
    expect(ext.statusCode).toBe(415);
  });

  it("study summary import: only study editors, creates a suggestion that can be accepted", async () => {
    const pdf = { filename: "sample.pdf", data: fixture("sample.pdf") };
    expect((await upload(bob, `/api/studies/${study.id}/summary/import`, { mode: "markdown" }, pdf)).statusCode).toBe(403);
    expect((await upload(prof, `/api/studies/${study.id}/summary/import`, { mode: "markdown" }, pdf)).statusCode).toBe(403);
    // A non-member may not use a study as context for the stateless converter either.
    expect((await upload(bob, "/api/doc-import", { study_id: study.id }, pdf)).statusCode).toBe(403);

    const r = await upload(alice, `/api/studies/${study.slug}/summary/import`, { mode: "markdown", placement: "append" }, pdf);
    expect(r.statusCode, r.body).toBe(201);
    const suggestion = r.json().suggestion;
    expect(suggestion).toMatchObject({ target_type: "study_summary", target_id: study.id, source: "user" });
    expect(suggestion.title).toContain("sample.pdf");
    // Appending keeps the existing summary untouched: the hunks only add text.
    expect(suggestion.hunks.every((h: { before: string }) => !h.before.includes("既有的研究簡述"))).toBe(true);

    const accept = await t.app.inject({ method: "POST", url: `/api/suggestions/${suggestion.id}/accept-all`, headers: { origin: ORIGIN, cookie: alice.cookie } });
    expect(accept.statusCode, accept.body).toBe(200);
    const summary = (await t.db.query<{ summary_md: string }>("SELECT summary_md FROM studies WHERE id=$1", [study.id])).rows[0]!.summary_md;
    expect(summary.startsWith("既有的研究簡述。")).toBe(true);
    expect(summary).toContain("本研究探討低資源語言的自動語音辨識");
  });

  it("replace placement proposes the document instead of the current text", async () => {
    const r = await upload(alice, `/api/studies/${study.id}/summary/import`, { mode: "markdown", placement: "replace" }, { filename: "sample.md", data: fixture("sample.md") });
    expect(r.statusCode, r.body).toBe(201);
    const hunks = r.json().suggestion.hunks as { before: string; after: string }[];
    expect(hunks.some(h => h.before.includes("既有的研究簡述"))).toBe(true);
  });

  it("AI condense reports 「維護中」 (503) while the writing role has no route", async () => {
    const r = await upload(alice, `/api/studies/${study.id}/summary/import`, { mode: "condense", style: "bullets" /* legacy field, ignored */ }, { filename: "sample.txt", data: fixture("sample.txt") });
    expect(r.statusCode).toBe(503);
    expect(r.json().code).toBe("llm_unavailable");
  });

  it("Markdown images: editors upload (Magika-checked), everyone signed in reads", async () => {
    const scope = `study:${study.id}`;
    expect((await upload(bob, "/api/md-images", { scope }, { filename: "a.png", data: PNG })).statusCode).toBe(403);
    const fake = await upload(alice, "/api/md-images", { scope }, { filename: "a.png", data: fixture("bad-page.txt") });
    expect(fake.statusCode).toBe(415);
    expect(fake.json().hint).toBe("偵測到：HTML 網頁");
    const r = await upload(alice, "/api/md-images", { scope }, { filename: "a.png", data: PNG });
    expect(r.statusCode, r.body).toBe(201);
    const url = r.json().image.url as string;
    // The same bytes again reuse the stored image.
    const again = await upload(alice, "/api/md-images", { scope }, { filename: "b.png", data: PNG });
    expect(again.json().image.url).toBe(url);
    const get = await t.app.inject({ method: "GET", url, headers: { cookie: bob.cookie } });
    expect(get.statusCode).toBe(200);
    expect(get.headers["content-type"]).toBe("image/png");
    expect(get.headers["x-content-type-options"]).toBe("nosniff");
    expect(get.rawPayload.equals(PNG)).toBe(true);
    expect((await t.app.inject({ method: "GET", url })).statusCode).toBe(401);
    expect((await upload(alice, "/api/md-images", { scope: "study:nope" }, { filename: "a.png", data: PNG })).statusCode).toBe(400);
  });

  it("Markdown images: drafts on the new-study form are owner-only until the study claims them", async () => {
    const r = await upload(alice, "/api/md-images", { scope: "draft" }, { filename: "draft.png", data: PNG });
    expect(r.statusCode, r.body).toBe(201);
    const url = r.json().image.url as string;
    const id = url.split("/").pop()!;
    expect((await t.app.inject({ method: "GET", url, headers: { cookie: alice.cookie } })).statusCode).toBe(200);
    expect((await t.app.inject({ method: "GET", url, headers: { cookie: bob.cookie } })).statusCode).toBe(404);
    const draftKey = (await t.db.query<{ object_key: string }>("SELECT object_key FROM md_images WHERE id=$1", [id])).rows[0]!.object_key;
    expect(draftKey).toBe(`md-images/_drafts/${alice.id}/${id}.png`);
    // Bob cannot claim Alice's draft by referencing it.
    const bobStudy = await t.app.inject({ method: "POST", url: "/api/studies", headers: { origin: ORIGIN, cookie: bob.cookie }, payload: { title: "Bob 的研究", summary_md: `![x](${url})` } });
    expect(bobStudy.statusCode, bobStudy.body).toBe(201);
    expect((await t.db.query("SELECT study_id FROM md_images WHERE id=$1", [id])).rows[0].study_id).toBeNull();
    const created = await t.app.inject({ method: "POST", url: "/api/studies", headers: { origin: ORIGIN, cookie: alice.cookie }, payload: { title: "有圖片的研究", summary_md: `圖：\n\n![draft](${url})\n` } });
    expect(created.statusCode, created.body).toBe(201);
    const studyId = created.json().study.id as string;
    const row = (await t.db.query<{ study_id: string; object_key: string }>("SELECT study_id, object_key FROM md_images WHERE id=$1", [id])).rows[0]!;
    expect(row).toEqual({ study_id: studyId, object_key: `md-images/${studyId}/${id}.png` });
    expect(await t.app.storage.get(draftKey)).toBeNull();
    // Same URL, now readable by everyone signed in.
    const get = await t.app.inject({ method: "GET", url, headers: { cookie: bob.cookie } });
    expect(get.statusCode).toBe(200);
    expect(get.rawPayload.equals(PNG)).toBe(true);
  });

  it("Markdown images: stale unclaimed drafts are swept on the next draft upload", async () => {
    const r = await upload(bob, "/api/md-images", { scope: "draft" }, { filename: "old.gif", data: Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64") });
    expect(r.statusCode, r.body).toBe(201);
    const id = (r.json().image.url as string).split("/").pop()!;
    const key = (await t.db.query<{ object_key: string }>("SELECT object_key FROM md_images WHERE id=$1", [id])).rows[0]!.object_key;
    await t.db.query("UPDATE md_images SET created_at=now() - interval '2 days' WHERE id=$1", [id]);
    expect((await upload(alice, "/api/md-images", { scope: "draft" }, { filename: "new.png", data: PNG })).statusCode).toBeLessThan(300);
    expect((await t.db.query("SELECT 1 FROM md_images WHERE id=$1", [id])).rowCount).toBe(0);
    expect(await t.app.storage.get(key)).toBeNull();
  });
});
