/** MCP endpoint: personal tokens, bearer-only auth, JSON-RPC methods, exposure rules, suggestions only. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, hasTestDb, ORIGIN, type TestContext } from "./helpers.js";
import { addStudyMember, insertStudy } from "./study-fixtures.js";

describe.skipIf(!hasTestDb)("MCP endpoint", () => {
  let t: TestContext;
  let alice: { id: string; cookie: string };
  let bob: { id: string; cookie: string };
  let study: { id: string; slug: string };
  let readToken = "";
  let suggestToken = "";
  let noteId = "";
  const rpc = (token: string | null, body: unknown, headers: Record<string, string> = {}) =>
    t.app.inject({ method: "POST", url: "/api/mcp", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, payload: JSON.stringify(body) });
  const call = (token: string, name: string, args: object, id = 1) => rpc(token, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

  beforeAll(async () => {
    t = await createTestContext();
    alice = await t.login("student", "Alice");
    bob = await t.login("student", "Bob");
    study = await insertStudy(t.db, alice.id, "MCP 研究");
    await addStudyMember(t.db, study.id, bob.id);
    noteId = (await t.app.inject({ method: "POST", url: `/api/studies/${study.slug}/notes`, headers: { origin: ORIGIN, cookie: alice.cookie }, payload: { title: "實驗紀錄", content_md: "第一段。\n\n第二段。\n" } })).json().note.id;
    const mk = async (scopes: string[]) => {
      const r = await t.app.inject({ method: "POST", url: "/api/agent/mcp-tokens", headers: { origin: ORIGIN, cookie: alice.cookie }, payload: { name: `token ${scopes.join("+")}`, scopes } });
      expect(r.statusCode, r.body).toBe(201);
      return r.json() as { secret: string; token: { id: string; prefix: string; scopes: string[] }; endpoint: string };
    };
    const a = await mk(["read"]);
    const b = await mk(["read", "suggest"]);
    expect(a.secret).toMatch(/^hubmcp_/);
    expect(a.endpoint).toBe(`${ORIGIN}/api/mcp`);
    expect(b.token.scopes).toEqual(["read", "suggest"]);
    readToken = a.secret;
    suggestToken = b.secret;
  });
  afterAll(async () => t?.close());

  it("lists tokens without secrets; only the owner sees them", async () => {
    const list = (await t.app.inject({ method: "GET", url: "/api/agent/mcp-tokens", headers: { cookie: alice.cookie } })).json();
    expect(list.tokens).toHaveLength(2);
    expect(JSON.stringify(list)).not.toContain(readToken);
    expect((await t.app.inject({ method: "GET", url: "/api/agent/mcp-tokens", headers: { cookie: bob.cookie } })).json().tokens).toHaveLength(0);
  });

  it("requires a bearer token; the session cookie is never enough; Origin must match when sent", async () => {
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } };
    const none = await rpc(null, init);
    expect(none.statusCode).toBe(401);
    expect(none.headers["www-authenticate"]).toContain("Bearer");
    expect((await rpc(null, init, { cookie: alice.cookie, origin: ORIGIN })).statusCode).toBe(401);
    expect((await rpc("hubmcp_wrong", init)).statusCode).toBe(401);
    expect((await rpc(readToken, init, { origin: "http://evil.example" })).statusCode).toBe(403);
    const ok = await rpc(readToken, init);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "speech-ai-hub" } });
    expect((await rpc(readToken, { jsonrpc: "2.0", method: "notifications/initialized" })).statusCode).toBe(202);
    expect((await rpc(readToken, { jsonrpc: "2.0", id: 2, method: "ping" })).json().result).toEqual({});
    expect((await rpc(readToken, { jsonrpc: "2.0", id: 3, method: "nope" })).json().error.code).toBe(-32601);
    expect((await t.app.inject({ method: "GET", url: "/api/mcp", headers: { authorization: `Bearer ${readToken}` } })).statusCode).toBe(405);
  });

  it("exposes reads (+ suggestions with the suggest scope), never deletes, memory or direct creates", async () => {
    const names = (token: string) => rpc(token, { jsonrpc: "2.0", id: 1, method: "tools/list" }).then((r) => (r.json().result.tools as { name: string; annotations: Record<string, unknown> }[]));
    const read = await names(readToken);
    const suggest = await names(suggestToken);
    const readNames = read.map((x) => x.name);
    expect(readNames).toEqual(expect.arrayContaining(["list_studies", "get_note", "search", "get_study_progress"]));
    expect(readNames).not.toContain("suggest_note_edit");
    for (const banned of ["delete_note", "delete_task", "remove_paper_from_study", "remember", "create_task", "propose_study_plan"]) expect(suggest.map((x) => x.name)).not.toContain(banned);
    expect(suggest.map((x) => x.name)).toEqual(expect.arrayContaining(["suggest_note_edit", "suggest_study_summary"]));
    const getNote = read.find((x) => x.name === "get_note")!;
    expect(getNote.annotations).toEqual({ title: "讀取筆記", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  });

  it("calls tools with the token owner's permissions and wraps results as data", async () => {
    const r = await call(readToken, "list_studies", { member: "me" });
    const res = r.json().result;
    expect(res.isError).toBe(false);
    expect(res.content[0].text).toMatch(/^<tool_result tool="list_studies"/);
    expect(res.structuredContent.studies[0].title).toBe("MCP 研究");
    expect((await call(readToken, "delete_note", { note_id: noteId })).json().error.code).toBe(-32602);
    expect((await call(readToken, "suggest_note_edit", { note_id: noteId, content_md: "x" })).json().error.code).toBe(-32602);
    expect((await call(readToken, "get_note", { note_id: "nope" })).json().result.isError).toBe(true);
    expect((await call(readToken, "list_notes", {})).json().error.code).toBe(-32602);
  });

  it("writes through MCP only create suggestions", async () => {
    const r = await call(suggestToken, "suggest_note_edit", { note_id: noteId, edits: [{ before: "第二段。", after: "第二段（MCP 建議）。" }] });
    expect(r.json().result.isError, r.body).toBe(false);
    const sug = (await t.db.query("SELECT status, source FROM suggestions WHERE target_id=$1", [noteId])).rows;
    expect(sug).toEqual([{ status: "pending", source: "ai" }]);
    const note = (await t.app.inject({ method: "GET", url: `/api/notes/${noteId}`, headers: { cookie: alice.cookie } })).json().note;
    expect(note.content_md).toBe("第一段。\n\n第二段。\n");
  });

  it("revoked tokens stop working", async () => {
    const id = (await t.app.inject({ method: "GET", url: "/api/agent/mcp-tokens", headers: { cookie: alice.cookie } })).json().tokens.find((x: { scopes: string[] }) => x.scopes.length === 1).id;
    expect((await t.app.inject({ method: "DELETE", url: `/api/agent/mcp-tokens/${id}`, headers: { origin: ORIGIN, cookie: bob.cookie } })).statusCode).toBe(404);
    expect((await t.app.inject({ method: "DELETE", url: `/api/agent/mcp-tokens/${id}`, headers: { origin: ORIGIN, cookie: alice.cookie } })).statusCode).toBe(200);
    expect((await rpc(readToken, { jsonrpc: "2.0", id: 1, method: "tools/list" })).statusCode).toBe(401);
  });
});
