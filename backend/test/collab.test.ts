import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import * as Y from "yjs";
import { buildApp } from "../src/app.js";
import { anchorRange, replaceText, resolveRange } from "../src/collab/text.js";
import { connect, listen, tryUpgrade, waitFor, type TestClient } from "./collab-fixtures.js";
import { createTestContext, hasTestDb, ORIGIN, type TestContext } from "./helpers.js";
import { addStudyMember, insertStudy } from "./study-fixtures.js";

describe("collab text helpers (unit)", () => {
  it("replaceText keeps unchanged lines' items (anchors survive)", () => {
    const doc = new Y.Doc();
    const text = doc.getText("content");
    text.insert(0, "第一段\n第二段\n第三段\n");
    const anchors = anchorRange(text, 4, 8); // 第二段\n
    replaceText(text, "第一段改\n第二段\n新的\n第三段\n");
    expect(text.toString()).toBe("第一段改\n第二段\n新的\n第三段\n");
    const r = resolveRange(doc, anchors)!;
    expect(text.toString().slice(r.from, r.to)).toBe("第二段\n");
  });

  it("anchors follow concurrent edits from another replica", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.getText("content").insert(0, "Hello world. Second sentence.");
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const anchors = anchorRange(a.getText("content"), 13, 29); // "Second sentence."
    b.getText("content").insert(0, "前言。");
    b.getText("content").insert(b.getText("content").length, " Tail");
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    const r = resolveRange(a, anchors)!;
    expect(a.getText("content").toString().slice(r.from, r.to)).toBe("Second sentence.");
    // An empty range (insertion point) with text typed exactly there: from > to, insert at `to`.
    const ins = anchorRange(a.getText("content"), 3, 3);
    a.getText("content").insert(3, "XX");
    const r2 = resolveRange(a, ins)!;
    expect(r2.from).toBeGreaterThan(r2.to);
  });
});

describe.skipIf(!hasTestDb)("collaboration server", () => {
  let t: TestContext;
  let base = "";
  let port = 0;
  let alice: { id: string; cookie: string };
  let bob: { id: string; cookie: string };
  let prof: { id: string; cookie: string };
  let study: { id: string; slug: string };
  let noteId = "";
  let app2: FastifyInstance | null = null;
  const clients: TestClient[] = [];
  const open = (...args: Parameters<typeof connect>) => {
    const c = connect(...args);
    clients.push(c);
    return c;
  };
  const noteText = async () => (await t.db.query("SELECT content_md FROM notes WHERE id=$1", [noteId])).rows[0]?.content_md as string;

  beforeAll(async () => {
    t = await createTestContext();
    alice = await t.login("student", "Alice");
    bob = await t.login("student", "Bob");
    prof = await t.login("professor", "Prof");
    study = await insertStudy(t.db, alice.id);
    await addStudyMember(t.db, study.id, bob.id);
    await addStudyMember(t.db, study.id, prof.id, "advisor");
    const res = await t.app.inject({ method: "POST", url: `/api/studies/${study.slug}/notes`, headers: { origin: ORIGIN, cookie: alice.cookie }, payload: { title: "共編測試", content_md: "起點\n" } });
    expect(res.statusCode).toBe(201);
    noteId = res.json().note.id;
    base = await listen(t.app);
    port = Number(new URL(base).port);
  });
  afterAll(async () => {
    for (const c of clients) c.destroy();
    await app2?.close();
    await t?.close();
  });

  it("refuses upgrades without a session or from another origin", async () => {
    expect(await tryUpgrade(base, { origin: ORIGIN })).toBe(401);
    expect(await tryUpgrade(base, { origin: "https://evil.example", cookie: alice.cookie })).toBe(403);
    expect(await tryUpgrade(base, { origin: ORIGIN, cookie: alice.cookie })).toBe(101);
  });

  it("refuses unknown documents and namespaces", async () => {
    const c = open(base, "note:00000000-0000-4000-8000-000000000000", alice.cookie);
    await expect(c.authed).rejects.toThrow();
    const d = open(base, "nope:abc", alice.cookie);
    await expect(d.authed).rejects.toThrow();
  });

  it("syncs three concurrent clients; the advisor is read-only", async () => {
    const a = open(base, `note:${noteId}`, alice.cookie);
    const b = open(base, `note:${noteId}`, bob.cookie);
    const p = open(base, `note:${noteId}`, prof.cookie);
    expect(await a.authed).toBe("read-write");
    expect(await b.authed).toBe("read-write");
    expect(await p.authed).toBe("readonly");
    await Promise.all([a.synced(), b.synced(), waitFor(() => p.provider.isSynced)]);
    expect(a.text.toString()).toBe("起點\n");
    // Concurrent typing from both editors.
    for (let i = 0; i < 20; i++) {
      a.text.insert(a.text.length, `A${i} `);
      b.text.insert(0, `B${i} `);
    }
    // The read-only client edits locally; the server drops it.
    p.text.insert(0, "PROF");
    await waitFor(() => a.text.toString() === b.text.toString() && a.text.toString().includes("A19") && a.text.toString().includes("B19"), 10_000, "convergence");
    await waitFor(() => p.text.toString().includes("A19") && p.text.toString().includes("B19"), 10_000, "readonly receives");
    expect(a.text.toString()).not.toContain("PROF");
    expect(b.text.toString()).not.toContain("PROF");
    expect(a.text.toString().match(/起點/g)).toHaveLength(1);
    p.destroy();
  });

  it("server-side edits reach connected clients and are materialized", async () => {
    const a = clients.find((c) => c.provider.configuration.name === `note:${noteId}` && c.text.toString().includes("A19"))!;
    await t.app.collab.edit(`note:${noteId}`, alice.id, (_doc, text) => text.insert(text.length, "\n伺服器加的"));
    await waitFor(() => a.text.toString().endsWith("伺服器加的"), 5000, "server edit");
    await waitFor(async () => (await noteText()).endsWith("伺服器加的"), 5000, "materialized");
  });

  it("survives a server restart without duplicating text (state is never rebuilt from content_md)", async () => {
    const a = clients.find((c) => c.text.toString().includes("A19"))!;
    a.text.insert(a.text.length, "\n重啟前");
    await a.synced();
    const before = a.text.toString();
    // Poison the materialized copy: it must never be used to rebuild the document.
    await t.app.close();
    expect(await noteText()).toBe(before);
    await t.db.query("UPDATE notes SET content_md='汙染的純文字' WHERE id=$1", [noteId]);
    app2 = await buildApp({ config: t.config, db: t.db, storage: t.storage }, { logger: { level: "warn" } });
    await app2.ready();
    await listen(app2, port);
    // The old client reconnects with its own copy of the document and merges.
    await waitFor(() => a.provider.isSynced && a.provider.isAuthenticated, 15_000, "reconnect");
    a.text.insert(a.text.length, "\n重啟後");
    await a.synced();
    const fresh = open(base, `note:${noteId}`, bob.cookie);
    await fresh.authed;
    await waitFor(() => fresh.text.toString().endsWith("重啟後"), 10_000, "fresh client");
    expect(fresh.text.toString()).toBe(`${before}\n重啟後`);
    expect(fresh.text.toString().match(/起點/g)).toHaveLength(1);
    expect(fresh.text.toString()).not.toContain("汙染");
    await app2.collab.close();
    expect(await noteText()).toBe(`${before}\n重啟後`);
  });

  it("seeds a document from text only when it has no state at all", async () => {
    const id = (await t.db.query<{ id: string }>("INSERT INTO notes(study_id,title,content_md,created_by) VALUES($1,'舊資料','匯入的內容\n',$2) RETURNING id", [study.id, alice.id])).rows[0]!.id;
    const server = app2!;
    // Re-open a live server (the previous test closed collab of app2): build a third app on the same port.
    await server.close();
    app2 = await buildApp({ config: t.config, db: t.db, storage: t.storage }, { logger: { level: "warn" } });
    await app2.ready();
    await listen(app2, port);
    const c1 = open(base, `note:${id}`, alice.cookie);
    await c1.authed;
    await waitFor(() => c1.text.toString() === "匯入的內容\n", 5000, "seeded");
    const row = (await t.db.query("SELECT count(*)::int AS n FROM yjs_docs WHERE name=$1", [`note:${id}`])).rows[0];
    expect(row.n).toBe(1);
    c1.destroy();
    await t.db.query("UPDATE notes SET content_md='不應該再用' WHERE id=$1", [id]);
    const c2 = open(base, `note:${id}`, bob.cookie);
    await c2.authed;
    await waitFor(() => c2.provider.isSynced, 5000);
    expect(c2.text.toString()).toBe("匯入的內容\n");
  });

  it("closes sockets whose access changed (member removed)", async () => {
    const c = open(base, `note:${noteId}`, bob.cookie);
    expect(await c.authed).toBe("read-write");
    await waitFor(() => c.provider.isSynced, 5000);
    await t.db.query("DELETE FROM study_members WHERE study_id=$1 AND user_id=$2", [study.id, bob.id]);
    let closed = false;
    c.socket.on("close", () => (closed = true));
    await app2!.collab.revalidate();
    await waitFor(() => closed, 5000, "socket closed");
    // On reconnect the former member is read-only.
    await waitFor(() => c.provider.authorizedScope === "readonly", 10_000, "readonly after reconnect");
  });
});
