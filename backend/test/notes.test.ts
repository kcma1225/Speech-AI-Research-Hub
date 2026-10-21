import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LightMyRequestResponse } from "fastify";
import { createTestContext, hasTestDb, ORIGIN, type TestContext } from "./helpers.js";
import { addStudyMember, insertStudy } from "./study-fixtures.js";

type Session = { id: string; cookie: string };

describe.skipIf(!hasTestDb)("notes API", () => {
  let t: TestContext;
  let alice: Session; // study owner
  let bob: Session; // member
  let carol: Session; // student outsider
  let prof: Session; // advisor
  let admin: Session;
  let study: { id: string; slug: string };
  const json = (r: LightMyRequestResponse) => r.json() as Record<string, any>;
  const send = (who: Session, method: "POST" | "PATCH" | "DELETE", url: string, payload?: object) =>
    t.app.inject({ method, url, headers: { origin: ORIGIN, cookie: who.cookie }, ...(payload ? { payload } : {}) });
  const get = (who: Session | null, url: string) => t.app.inject({ method: "GET", url, headers: who ? { cookie: who.cookie } : {} });

  beforeAll(async () => {
    t = await createTestContext();
    alice = await t.login("student", "Alice");
    bob = await t.login("student", "Bob");
    carol = await t.login("student", "Carol");
    prof = await t.login("professor", "Prof");
    admin = await t.login("admin", "Admin");
    study = await insertStudy(t.db, alice.id, "語音研究");
    await addStudyMember(t.db, study.id, bob.id);
    await addStudyMember(t.db, study.id, prof.id, "advisor");
  });
  afterAll(async () => {
    await t?.close();
  });

  let templates: Record<string, any>[] = [];
  let noteId = "";

  it("lists the seeded system templates", async () => {
    const r = await get(carol, "/api/note-templates");
    expect(r.statusCode).toBe(200);
    templates = json(r).templates;
    expect(templates.map((x) => x.name)).toEqual(["研究筆記", "實驗筆記", "閱讀筆記", "會議筆記"]);
    expect(templates.find((x) => x.name === "實驗筆記")!.body_md).toContain("## 超參數");
    expect(json(r).permissions.manageSystem).toBe(false);
  });

  it("creates a note from a template (members only) with its Yjs state and first version", async () => {
    const exp = templates.find((x) => x.kind === "experiment")!;
    expect((await send(carol, "POST", `/api/studies/${study.slug}/notes`, { template_id: exp.id })).statusCode).toBe(403);
    expect((await send(prof, "POST", `/api/studies/${study.slug}/notes`, { template_id: exp.id })).statusCode).toBe(403);
    const r = await send(bob, "POST", `/api/studies/${study.slug}/notes`, { template_id: exp.id, title: "wav2vec 微調", event_date: "2026-10-20" });
    expect(r.statusCode).toBe(201);
    const note = json(r).note;
    noteId = note.id;
    expect(note).toMatchObject({ title: "wav2vec 微調", kind: "experiment", template_name: "實驗筆記", event_date: "2026-10-20", version: 1, creator_name: "Bob" });
    expect(note.content_md).toBe(exp.body_md);
    expect(json(r).url).toBe(`/studies/${study.slug}/notes/${noteId}`);
    const state = await t.db.query("SELECT length(state) AS n FROM yjs_docs WHERE name=$1", [`note:${noteId}`]);
    expect(state.rows[0].n).toBeGreaterThan(10);
    const act = await t.db.query("SELECT kind,url FROM study_activity WHERE study_id=$1 AND kind='note_created'", [study.id]);
    expect(act.rows[0].url).toBe(`/studies/${study.slug}/notes/${noteId}`);
    // Default title from the template + today.
    const r2 = await send(alice, "POST", `/api/studies/${study.slug}/notes`, { template_id: templates.find((x) => x.kind === "meeting")!.id });
    expect(json(r2).note.title).toMatch(/^會議筆記 \d{4}-\d{2}-\d{2}$/);
    // Plain note without template.
    const r3 = await send(alice, "POST", `/api/studies/${study.slug}/notes`, { title: "雜記", content_md: "關鍵字 transformer 在這裡", event_date: null });
    expect(json(r3).note).toMatchObject({ kind: "custom", template_id: null, event_date: null });
  });

  it("everyone reads; lists filter and search", async () => {
    const all = json(await get(carol, `/api/studies/${study.slug}/notes`));
    expect(all.notes).toHaveLength(3);
    expect(all.permissions.edit).toBe(false);
    expect(all.notes[0]).toHaveProperty("excerpt");
    expect(all.notes[0]).not.toHaveProperty("content_md");
    const byKind = json(await get(prof, `/api/studies/${study.slug}/notes?kind=experiment`));
    expect(byKind.notes.map((n: any) => n.id)).toEqual([noteId]);
    const mine = json(await get(bob, `/api/studies/${study.slug}/notes?author=me`));
    expect(mine.notes.map((n: any) => n.id)).toEqual([noteId]);
    const q = json(await get(carol, `/api/studies/${study.slug}/notes?q=${encodeURIComponent("TRANSFORMER")}`));
    expect(q.notes.map((n: any) => n.title)).toEqual(["雜記"]);
    expect(q.search_mode).toBe("keyword");
    const like = json(await get(carol, `/api/studies/${study.slug}/notes?q=${encodeURIComponent("%")}`));
    expect(like.notes).toHaveLength(0);
    const one = json(await get(prof, `/api/notes/${noteId}`));
    expect(one).toMatchObject({ doc_name: `note:${noteId}`, study: { slug: study.slug }, permissions: { edit: false, role: "advisor" } });
    expect((await get(null, `/api/notes/${noteId}`)).statusCode).toBe(401);
  });

  it("only editors patch metadata", async () => {
    expect((await send(prof, "PATCH", `/api/notes/${noteId}`, { title: "教授改" })).statusCode).toBe(403);
    const r = await send(alice, "PATCH", `/api/notes/${noteId}`, { title: "wav2vec2 微調", event_date: null });
    expect(r.statusCode).toBe(200);
    expect(json(r).note).toMatchObject({ title: "wav2vec2 微調", event_date: null, updater_name: "Alice" });
  });

  it("saves versions, restores through the live document and exports", async () => {
    // Change the text the way an editor would (server-side Yjs edit), then save a manual version.
    await t.app.collab.edit(`note:${noteId}`, bob.id, (_d, text) => text.insert(text.length, "\n實驗結果：WER 12.3%\n"));
    const v = await send(bob, "POST", `/api/notes/${noteId}/versions`, { label: "第一次結果" });
    expect(v.statusCode).toBe(201);
    expect(json(v).version.version).toBe(2);
    expect((await send(prof, "POST", `/api/notes/${noteId}/versions`, {})).statusCode).toBe(403);
    const list = json(await get(carol, `/api/notes/${noteId}/versions`)).versions;
    expect(list.map((x: any) => x.kind)).toEqual(["manual", "initial"]);
    expect(list[0]).toMatchObject({ label: "第一次結果", actor_name: "Bob", author: "user" });
    const initial = list[1];
    const detail = json(await get(carol, `/api/notes/${noteId}/versions/${initial.id}`)).version;
    expect(detail.content_md).not.toContain("WER");
    const restored = await send(alice, "POST", `/api/notes/${noteId}/versions/${initial.id}/restore`);
    expect(restored.statusCode).toBe(200);
    expect(json(restored).version).toMatchObject({ version: 3 });
    const live = await t.app.collab.readDoc(`note:${noteId}`, (d) => d.getText("content").toString());
    expect(live).toBe(detail.content_md);
    const after = json(await get(carol, `/api/notes/${noteId}/versions`)).versions;
    expect(after[0]).toMatchObject({ kind: "restore", label: "還原至第 1 版" });
    const exp = await get(carol, `/api/notes/${noteId}/export`);
    expect(exp.headers["content-type"]).toContain("text/markdown");
    expect(exp.headers["content-disposition"]).toContain("filename*=UTF-8''wav2vec2%20%E5%BE%AE%E8%AA%BF.md");
    expect(exp.body.startsWith("# wav2vec2 微調\n\n## 目的")).toBe(true);
  });

  it("manages templates: own user templates, system ones for admins", async () => {
    const mine = await send(carol, "POST", "/api/note-templates", { name: "我的範本", kind: "reading", body_md: "## A" });
    expect(mine.statusCode).toBe(201);
    const id = json(mine).template.id;
    expect((await send(carol, "POST", "/api/note-templates", { name: "系統", scope: "system" })).statusCode).toBe(403);
    expect(json(await get(carol, "/api/note-templates")).templates.map((x: any) => x.name)).toContain("我的範本");
    expect(json(await get(bob, "/api/note-templates")).templates.map((x: any) => x.name)).not.toContain("我的範本");
    expect((await send(bob, "PATCH", `/api/note-templates/${id}`, { name: "偷改" })).statusCode).toBe(404);
    const sys = templates[0]!;
    expect((await send(carol, "PATCH", `/api/note-templates/${sys.id}`, { name: "改系統" })).statusCode).toBe(403);
    expect(json(await send(admin, "PATCH", `/api/note-templates/${sys.id}`, { ai_prompt: "新的指示" })).template.ai_prompt).toBe("新的指示");
    const created = await send(admin, "POST", "/api/note-templates", { name: "口試筆記", scope: "system", kind: "meeting" });
    expect(json(created).template).toMatchObject({ scope: "system", owner_id: null, position: 4 });
    // Bob cannot use Carol's template for a note.
    expect((await send(bob, "POST", `/api/studies/${study.slug}/notes`, { template_id: id })).statusCode).toBe(400);
    expect((await send(carol, "DELETE", `/api/note-templates/${id}`)).statusCode).toBe(200);
  });

  it("deletes a note with its document and suggestions (editors only)", async () => {
    expect((await send(prof, "DELETE", `/api/notes/${noteId}`)).statusCode).toBe(403);
    const s = await send(bob, "POST", "/api/suggestions", { target_type: "note", target_id: noteId, proposed_text: "全新內容\n" });
    expect(s.statusCode).toBe(201);
    expect((await send(bob, "DELETE", `/api/notes/${noteId}`)).statusCode).toBe(200);
    expect((await get(bob, `/api/notes/${noteId}`)).statusCode).toBe(404);
    expect((await t.db.query("SELECT count(*)::int AS n FROM yjs_docs WHERE name=$1", [`note:${noteId}`])).rows[0].n).toBe(0);
    expect((await t.db.query("SELECT count(*)::int AS n FROM suggestions WHERE target_id=$1", [noteId])).rows[0].n).toBe(0);
  });

  it("study deletion removes note documents", async () => {
    const other = await insertStudy(t.db, alice.id, "暫時的研究");
    const r = await send(alice, "POST", `/api/studies/${other.slug}/notes`, { title: "會被刪" });
    const id = json(r).note.id;
    expect((await send(alice, "DELETE", `/api/studies/${other.slug}`)).statusCode).toBe(200);
    expect((await t.db.query("SELECT count(*)::int AS n FROM yjs_docs WHERE name=$1", [`note:${id}`])).rows[0].n).toBe(0);
  });
});
