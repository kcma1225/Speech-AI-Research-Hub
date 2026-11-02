/**
 * Phone remote (routes/slide-remote.ts, lib/slides/remote.ts): the presenting player hosts a session over a WebSocket,
 * the account's phone lists and controls it; commands are validated and relayed, the host's page goes back to every
 * phone, other accounts never see or reach the session, and closing the player ends it on the phone.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { parseControl, parseHostState, deviceLabel, RemoteHub, type RemoteSocket } from "../src/lib/slides/remote.js";
import { createTestContext, hasTestDb, ORIGIN, type TestContext } from "./helpers.js";
import { insertStudy } from "./study-fixtures.js";

describe("remote messages", () => {
  it("accepts only well-formed commands and states", () => {
    expect(parseControl('{"type":"step","dir":1}')).toEqual({ type: "step", dir: 1 });
    expect(parseControl('{"type":"step","dir":2}')).toBeNull();
    expect(parseControl('{"type":"goto","page":3}')).toEqual({ type: "goto", page: 3 });
    expect(parseControl('{"type":"goto","page":0}')).toBeNull();
    expect(parseControl('{"type":"laser","page":2,"x":0.5,"y":1,"down":true}')).toEqual({ type: "laser", page: 2, x: 0.5, y: 1, down: true });
    expect(parseControl('{"type":"laser","page":2,"x":1.5,"y":0,"down":true}')).toBeNull();
    expect(parseControl('{"type":"laserOff","extra":"<script>"}')).toEqual({ type: "laserOff" });
    expect(parseControl("not json")).toBeNull();
    expect(parseControl(JSON.stringify({ type: "goto", page: 1, pad: "x".repeat(600) }))).toBeNull();
    expect(parseHostState('{"type":"state","page":4,"total":12}')).toEqual({ page: 4, total: 12 });
    expect(parseHostState('{"type":"state","page":4,"total":-1}')).toEqual({ page: 4, total: 0 });
    expect(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15")).toBe("Safari · Mac");
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0")).toBe("Edge · Windows");
  });

  it("rate-limits laser frames but always passes laserOff", () => {
    const hub = new RemoteHub();
    const sent: string[] = [];
    const host: RemoteSocket = { OPEN: 1, readyState: 1, send: (d) => sent.push(d), close: () => {} };
    const phone: RemoteSocket = { OPEN: 1, readyState: 1, send: () => {}, close: () => {} };
    const s = hub.open("u1", { deckId: "d", versionId: "v", slug: "s", title: "T", device: "x" }, host)!;
    hub.attach(s, phone);
    sent.length = 0;
    for (let i = 0; i < 200; i++) hub.controlMessage(s, phone, JSON.stringify({ type: "laser", page: 1, x: 0.5, y: 0.5, down: true }));
    hub.controlMessage(s, phone, '{"type":"laserOff"}');
    expect(sent.filter((m) => m.includes('"laser"')).length).toBe(60);
    expect(sent.at(-1)).toBe('{"type":"laserOff"}');
  });
});

describe.skipIf(!hasTestDb)("phone remote routes", () => {
  let t: TestContext;
  let alice: { id: string; cookie: string };
  let bob: { id: string; cookie: string };
  let deckId: string;
  let versionId: string;
  let draftId: string;

  beforeAll(async () => {
    t = await createTestContext();
    alice = await t.login("student", "Alice");
    bob = await t.login("student", "Bob");
    const study = await insertStudy(t.db, alice.id, "串流 ASR");
    deckId = (await t.app.inject({ method: "POST", url: "/api/slides", headers: { origin: ORIGIN, cookie: alice.cookie }, payload: { studyId: study.slug, title: "週報", kind: "progress" } })).json().id;
    const insert = async (version: number, status: string) =>
      (await t.db.query<{ id: string }>("INSERT INTO slide_versions (deck_id, version, entry_qmd, source_name, source_key, output_prefix, status) VALUES ($1,$2,'index.qmd','d.zip','k','p/',$3) RETURNING id", [deckId, version, status])).rows[0]!.id;
    versionId = await insert(1, "published");
    draftId = await insert(2, "failed");
  });
  afterAll(async () => t?.close());

  const ws = (url: string, who: { cookie: string }, origin = ORIGIN) => t.app.injectWS(url, { headers: { cookie: who.cookie, origin } });
  /** A socket whose inbox listens before the first frame (the server greets right after the upgrade). */
  async function connect(url: string, who: { cookie: string }) {
    let box!: ReturnType<typeof inbox>;
    const socket = await t.app.injectWS(url, { headers: { cookie: who.cookie, origin: ORIGIN } }, { onInit: (w) => (box = inbox(w)) });
    return { socket, box };
  }
  /** Collects a socket's JSON messages; `next(type)` waits for the next one of that type. */
  function inbox(socket: WebSocket) {
    const got: Record<string, unknown>[] = [];
    const waiters: { type: string; resolve: (m: Record<string, unknown>) => void }[] = [];
    socket.on("message", (data: Buffer) => {
      const m = JSON.parse(data.toString()) as Record<string, unknown>;
      const i = waiters.findIndex((w) => w.type === m.type);
      if (i >= 0) waiters.splice(i, 1)[0]!.resolve(m);
      else got.push(m);
    });
    return {
      next(type: string) {
        const i = got.findIndex((m) => m.type === type);
        if (i >= 0) return Promise.resolve(got.splice(i, 1)[0]!);
        return new Promise<Record<string, unknown>>((resolve, reject) => {
          waiters.push({ type, resolve });
          setTimeout(() => reject(new Error(`no ${type}`)), 3000);
        });
      },
    };
  }

  it("refuses foreign origins, signed-out users and unpublished versions", async () => {
    await expect(ws(`/api/slides/remote/host?version=${versionId}`, alice, "http://evil.test")).rejects.toThrow();
    await expect(ws(`/api/slides/remote/host?version=${versionId}`, { cookie: "" })).rejects.toThrow();
    await expect(ws(`/api/slides/remote/host?version=${draftId}`, alice)).rejects.toThrow();
    expect((await t.app.inject({ method: "GET", url: "/api/slides/remote/sessions" })).statusCode).toBe(401);
  });

  it("relays the phone's commands to the player and the player's page to the phone; only the same account sees it", async () => {
    const { socket: host, box: hostIn } = await connect(`/api/slides/remote/host?version=${versionId}`, alice);
    const { id } = (await hostIn.next("session")) as { id: string };
    host.send(JSON.stringify({ type: "state", page: 3, total: 10 }));

    const list = (who: { cookie: string }) => t.app.inject({ method: "GET", url: "/api/slides/remote/sessions", headers: { cookie: who.cookie } }).then((r) => r.json().sessions);
    await new Promise((r) => setTimeout(r, 50));
    expect(await list(alice)).toEqual([expect.objectContaining({ id, deckId, versionId, title: "週報", page: 3, total: 10, remotes: 0 })]);
    expect(await list(bob)).toEqual([]);
    await expect(ws(`/api/slides/remote/control/${id}`, bob)).rejects.toThrow();

    const { socket: phone, box: phoneIn } = await connect(`/api/slides/remote/control/${id}`, alice);
    expect(await phoneIn.next("state")).toMatchObject({ page: 3, total: 10, deckId, versionId, title: "週報" });
    expect(await hostIn.next("remotes")).toEqual({ type: "remotes", count: 1 });

    phone.send(JSON.stringify({ type: "step", dir: 1 }));
    expect(await hostIn.next("step")).toEqual({ type: "step", dir: 1 });
    phone.send(JSON.stringify({ type: "goto", page: 7, junk: true }));
    expect(await hostIn.next("goto")).toEqual({ type: "goto", page: 7 });
    phone.send(JSON.stringify({ type: "laser", page: 7, x: 0.25, y: 0.75, down: true }));
    expect(await hostIn.next("laser")).toEqual({ type: "laser", page: 7, x: 0.25, y: 0.75, down: true });
    phone.send(JSON.stringify({ type: "eval", code: "x" }));
    phone.send(JSON.stringify({ type: "laserOff" }));
    expect(await hostIn.next("laserOff")).toEqual({ type: "laserOff" });

    host.send(JSON.stringify({ type: "state", page: 7, total: 10 }));
    expect(await phoneIn.next("state")).toMatchObject({ page: 7, total: 10 });

    // The player stops presenting: the phone is told and the session is gone.
    const closed = new Promise((r) => phone.on("close", r));
    host.terminate();
    expect(await phoneIn.next("ended")).toEqual({ type: "ended" });
    await closed;
    expect(await list(alice)).toEqual([]);
  });
});
