import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LightMyRequestResponse } from "fastify";
import { computeHunks, locate } from "../src/lib/suggestions/diff.js";
import { applySuggestionNow } from "../src/lib/suggestions/service.js";
import { connect, listen, waitFor, type TestClient } from "./collab-fixtures.js";
import { createTestContext, hasTestDb, ORIGIN, type TestContext } from "./helpers.js";
import { addStudyMember, insertStudy } from "./study-fixtures.js";

describe("suggestion hunks (unit)", () => {
  it("groups changed lines into hunks with base offsets", () => {
    const base = "第一段。\n\n第二段。\n\n第三段。\n";
    const next = "第一段。\n\n第二段改寫。\n\n第三段。\n新的第四段。\n";
    const hunks = computeHunks(base, next);
    expect(hunks).toEqual([
      { from: 6, to: 11, before: "第二段。\n", after: "第二段改寫。\n" },
      { from: base.length, to: base.length, before: "", after: "新的第四段。\n" },
    ]);
    // Applying from the end reproduces the proposal.
    let text = base;
    for (const h of [...hunks].reverse()) text = text.slice(0, h.from) + h.after + text.slice(h.to);
    expect(text).toBe(next);
    expect(computeHunks("a\n", "a\n")).toEqual([]);
  });

  it("locates moved text for plain-text targets, refuses ambiguous ones", () => {
    const h = { from: 0, to: 3, before: "abc", after: "x" };
    expect(locate("abc def", h)).toEqual({ from: 0, to: 3 });
    expect(locate("zz abc def", h)).toEqual({ from: 3, to: 6 });
    expect(locate("abc abc", { ...h, from: 1, to: 4 })).toBeNull();
    expect(locate("nothing", h)).toBeNull();
  });
});

describe.skipIf(!hasTestDb)("suggestions API", () => {
  let t: TestContext;
  let alice: { id: string; cookie: string };
  let bob: { id: string; cookie: string };
  let prof: { id: string; cookie: string };
  let study: { id: string; slug: string };
  let noteId = "";
  let base = "";
  let client: TestClient;
  const doc = () => `note:${noteId}`;
  const json = (r: LightMyRequestResponse) => r.json() as Record<string, any>;
  const send = (who: { cookie: string }, url: string, payload?: object) => t.app.inject({ method: "POST", url, headers: { origin: ORIGIN, cookie: who.cookie }, payload: payload ?? {} });
  const get = (who: { cookie: string }, url: string) => t.app.inject({ method: "GET", url, headers: { cookie: who.cookie } });
  const live = () => t.app.collab.readDoc(doc(), (d) => d.getText("content").toString()) as Promise<string>;
  const original = "# 標題\n\n第一段文字。\n\n第二段文字。\n\n第三段文字。\n\n第四段。\n";

  beforeAll(async () => {
    t = await createTestContext();
    alice = await t.login("student", "Alice");
    bob = await t.login("student", "Bob");
    prof = await t.login("professor", "Prof");
    study = await insertStudy(t.db, alice.id);
    await addStudyMember(t.db, study.id, bob.id);
    await addStudyMember(t.db, study.id, prof.id, "advisor");
    noteId = json(await send(alice, `/api/studies/${study.slug}/notes`, { title: "建議測試", content_md: original })).note.id;
    base = await listen(t.app);
    client = connect(base, doc(), bob.cookie);
    await client.authed;
    await waitFor(() => client.provider.isSynced);
  });
  afterAll(async () => {
    client?.destroy();
    await t?.close();
  });

  let sid = "";

  it("creates a suggestion from a full proposed text, anchored, and notifies connected editors", async () => {
    const messages: string[] = [];
    client.provider.on("stateless", ({ payload }: { payload: string }) => messages.push(payload));
    const proposed = "# 標題\n\n第一段文字（改）。\n\n第二段文字。\n\n第三段文字（改）。\n\n第四段。\n結論。\n";
    expect((await send(prof, "/api/suggestions", { target_type: "note", target_id: noteId, proposed_text: proposed })).statusCode).toBe(403);
    const r = await send(alice, "/api/suggestions", { target_type: "note", target_id: noteId, proposed_text: proposed, title: "AI 改寫" });
    expect(r.statusCode).toBe(201);
    const s = json(r).suggestion;
    sid = s.id;
    expect(s).toMatchObject({ status: "pending", pending: 3, stale: 0, title: "AI 改寫", source: "user", creator_name: "Alice", url: `/studies/${study.slug}/notes/${noteId}` });
    expect(s.hunks.map((h: any) => h.before)).toEqual(["第一段文字。\n", "第三段文字。\n", ""]);
    expect(s.hunks.every((h: any) => typeof h.start === "string" && typeof h.end === "string")).toBe(true);
    await waitFor(() => messages.some((m) => m.includes(sid)), 5000, "stateless");
    expect((await send(alice, "/api/suggestions", { target_type: "note", target_id: noteId, proposed_text: original })).statusCode).toBe(400);
    const list = json(await get(prof, `/api/suggestions?target_type=note&target_id=${noteId}`));
    expect(list.suggestions).toHaveLength(1);
    expect(list.permissions.review).toBe(false);
  });

  it("anchors follow concurrent edits; a changed paragraph becomes stale", async () => {
    // Another editor types before the first hunk and rewrites the third paragraph.
    client.text.insert(0, "前言。\n\n");
    const third = client.text.toString().indexOf("第三段文字。");
    client.text.delete(third, 2);
    client.text.insert(third, "第3");
    await client.synced();
    await waitFor(async () => (await live()).startsWith("前言"), 5000, "edits reach server");
    const s = json(await get(alice, `/api/suggestions/${sid}`)).suggestion;
    const [h1, h3, h4] = s.hunks;
    expect(h1.state).toBe("pending");
    const text = await live();
    expect(text.slice(h1.current.from, h1.current.to)).toBe("第一段文字。\n");
    expect(h3.state).toBe("stale");
    expect(h4.state).toBe("pending");
    expect(h4.current.from).toBe(text.length);
    expect(s).toMatchObject({ pending: 2, stale: 1 });
  });

  it("accepts one hunk in the live document (clients see it) and records a version", async () => {
    const h1 = json(await get(alice, `/api/suggestions/${sid}`)).suggestion.hunks[0];
    expect((await send(prof, `/api/suggestions/${sid}/hunks/${h1.id}/accept`)).statusCode).toBe(403);
    const r = await send(bob, `/api/suggestions/${sid}/hunks/${h1.id}/accept`);
    expect(r.statusCode).toBe(200);
    expect(json(r)).toMatchObject({ applied: 1, skipped: 0 });
    await waitFor(() => client.text.toString().includes("第一段文字（改）。"), 5000, "client sees accept");
    expect(client.text.toString()).toBe("前言。\n\n# 標題\n\n第一段文字（改）。\n\n第二段文字。\n\n第3段文字。\n\n第四段。\n");
    expect((await send(bob, `/api/suggestions/${sid}/hunks/${h1.id}/accept`)).statusCode).toBe(409);
    const versions = (await t.db.query("SELECT kind,label,author FROM note_versions WHERE note_id=$1 ORDER BY version DESC LIMIT 1", [noteId])).rows[0];
    expect(versions).toMatchObject({ kind: "suggestion", label: "接受建議 · 1 處", author: "user" });
    const note = (await t.db.query("SELECT content_md FROM notes WHERE id=$1", [noteId])).rows[0];
    expect(note.content_md).toContain("第一段文字（改）。");
  });

  it("refuses a stale hunk; accept-all skips it; reject finishes the suggestion", async () => {
    const s = json(await get(alice, `/api/suggestions/${sid}`)).suggestion;
    const stale = s.hunks.find((h: any) => h.state === "stale");
    expect((await send(bob, `/api/suggestions/${sid}/hunks/${stale.id}/accept`)).statusCode).toBe(409);
    const all = json(await send(bob, `/api/suggestions/${sid}/accept-all`));
    expect(all).toMatchObject({ applied: 1, skipped: 1 });
    expect(all.suggestion.status).toBe("pending");
    expect(await live()).toBe("前言。\n\n# 標題\n\n第一段文字（改）。\n\n第二段文字。\n\n第3段文字。\n\n第四段。\n結論。\n");
    const done = json(await send(bob, `/api/suggestions/${sid}/hunks/${stale.id}/reject`));
    expect(done.suggestion.status).toBe("partial");
    expect(json(await get(alice, `/api/suggestions?target_type=note&target_id=${noteId}`)).suggestions).toHaveLength(0);
    expect(json(await get(alice, `/api/suggestions?target_type=note&target_id=${noteId}&status=all`)).suggestions).toHaveLength(1);
  });

  it("explicit hunks (selection rewrite) check the selected text; reject-all", async () => {
    const text = await live();
    const from = text.indexOf("第二段文字。");
    const bad = await send(alice, "/api/suggestions", { target_type: "note", target_id: noteId, hunks: [{ from, to: from + 6, before: "不對的文字", after: "x" }] });
    expect(bad.statusCode).toBe(409);
    const ok = json(await send(alice, "/api/suggestions", { target_type: "note", target_id: noteId, hunks: [{ from, to: from + 6, before: "第二段文字。", after: "第二段重寫。" }] }));
    const r = json(await send(alice, `/api/suggestions/${ok.suggestion.id}/reject-all`));
    expect(r.suggestion.status).toBe("rejected");
    expect(await live()).toBe(text);
  });

  it("autopilot applies at once with an autopilot version", async () => {
    const user = (await t.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: alice.cookie } })).json().user;
    const text = await live();
    const r = await applySuggestionNow({ db: t.db, collab: t.app.collab }, { targetType: "note", targetId: noteId, proposedText: `${text}自動加入。\n`, title: "agent", actorId: alice.id, user });
    expect(r.applied).toBe(1);
    expect(r.suggestion).toMatchObject({ status: "applied", source: "autopilot" });
    await waitFor(() => client.text.toString().endsWith("自動加入。\n"), 5000);
    const v = (await t.db.query("SELECT kind,label,author FROM note_versions WHERE note_id=$1 ORDER BY version DESC LIMIT 1", [noteId])).rows[0];
    expect(v).toMatchObject({ kind: "autopilot", label: "自動駕駛套用建議 · 1 處", author: "ai" });
  });

  it("works on plain-text targets (study summary)", async () => {
    await t.db.query("UPDATE studies SET summary_md=$2 WHERE id=$1", [study.id, "問題：情緒辨識\n方法：待定\n"]);
    const r = await send(alice, "/api/suggestions", { target_type: "study_summary", target_id: study.id, proposed_text: "問題：情緒辨識\n方法：SSL 特徵 + 微調\n" });
    expect(r.statusCode).toBe(201);
    const s = json(r).suggestion;
    expect(s.doc_name).toBeNull();
    // The summary is edited above the hunk meanwhile: the hunk is relocated by its text.
    await t.db.query("UPDATE studies SET summary_md=$2 WHERE id=$1", [study.id, "背景：…\n問題：情緒辨識\n方法：待定\n"]);
    const a = json(await send(bob, `/api/suggestions/${s.id}/accept-all`));
    expect(a.applied).toBe(1);
    expect((await t.db.query("SELECT summary_md FROM studies WHERE id=$1", [study.id])).rows[0].summary_md).toBe("背景：…\n問題：情緒辨識\n方法：SSL 特徵 + 微調\n");
    expect((await send(prof, "/api/suggestions", { target_type: "study_summary", target_id: study.id, proposed_text: "x" })).statusCode).toBe(403);
  });
});
