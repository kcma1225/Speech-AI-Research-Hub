import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { markdownExcerpt } from "../src/lib/notes/excerpt.js";
import { parseSrt } from "../src/lib/notes/srt.js";
import { createTestContext, hasTestDb, hasTestS3, ORIGIN, type TestContext } from "./helpers.js";

describe("parseSrt", () => {
  it("parses cues, strips markup and sorts", () => {
    const cues = parseSrt("﻿2\r\n00:00:05,500 --> 00:00:07,000\r\n<i>second</i>\r\n\r\n1\n00:00:01.2 --> 00:00:02,000 X1:0\nfirst {\\an8}line\nnext\n\nbad\n00:00:09 --> nope\ntext\n");
    expect(cues).toEqual([
      { start: 1.2, end: 2, text: "first line\nnext" },
      { start: 5.5, end: 7, text: "second" },
    ]);
  });
  it("returns nothing for non-SRT text", () => {
    expect(parseSrt("hello world")).toEqual([]);
  });
});

describe("markdownExcerpt", () => {
  it("reduces Markdown to plain text", () => {
    expect(markdownExcerpt("# Title\n\n- **bold** [link](http://x) `code`\n\n```js\nhidden()\n```\n> quote")).toBe("Title bold link code quote");
    expect(markdownExcerpt("a".repeat(500), 10)).toHaveLength(10);
  });
});

function multipart(field: string, filename: string, content: Buffer | string, type = "application/octet-stream") {
  const boundary = "----hubtestboundary";
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`),
    Buffer.isBuffer(content) ? content : Buffer.from(content),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

describe.skipIf(!hasTestDb)("notes API", () => {
  let ctx: TestContext;
  let owner: { id: string; cookie: string };
  let member: { id: string; cookie: string };
  let professor: { id: string; cookie: string };

  const call = (who: { cookie: string } | null, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: object, headers: Record<string, string> = {}) =>
    ctx.app.inject({ method, url, payload, headers: { origin: ORIGIN, ...(who ? { cookie: who.cookie } : {}), ...headers } });
  const createItem = async (title: string, extra: object = {}) => {
    const response = await call(owner, "POST", "/api/items", { title, ...extra });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  };
  const createTag = async (path: string, name: string) => {
    const response = await call(owner, "POST", path, { name });
    expect(response.statusCode).toBe(201);
    return response.json<{ tag: { id: string } }>().tag.id;
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await ctx.ownerCookie();
    member = await ctx.login("member");
    professor = await ctx.login("professor");
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it("requires a session and same-origin writes", async () => {
    expect((await call(null, "GET", "/api/items")).statusCode).toBe(401);
    const response = await ctx.app.inject({ method: "POST", url: "/api/items", payload: { title: "x" }, headers: { cookie: owner.cookie } });
    expect(response.statusCode).toBe(403);
  });

  it("creates, reads, updates and deletes notes; Professor is read-only", async () => {
    const id = await createItem("Weekly meeting", { event_date: "2026-10-14", content: "# Agenda\nWER results" });
    const detail = (await call(professor, "GET", `/api/items/${id}`)).json().item;
    expect(detail).toMatchObject({ id, title: "Weekly meeting", event_date: "2026-10-14", content: "# Agenda\nWER results", tags: [], audio: null, transcript: null, media_job: null });
    expect(detail.created_by.name).toBe("Owner");

    const denied = await call(professor, "POST", "/api/items", { title: "nope" });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toBe("Professor 僅可閱讀研究筆記。");
    expect((await call(professor, "PATCH", `/api/items/${id}`, { title: "x" })).statusCode).toBe(403);
    expect((await call(professor, "DELETE", `/api/items/${id}`)).statusCode).toBe(403);

    expect((await call(member, "PATCH", `/api/items/${id}`, { title: "Renamed", event_date: "2026-02-30" })).statusCode).toBe(400);
    expect((await call(member, "PATCH", `/api/items/${id}`, {})).statusCode).toBe(400);
    expect((await call(member, "PATCH", `/api/items/${id}`, { title: "Renamed" })).statusCode).toBe(200);
    const updated = (await call(owner, "GET", `/api/items/${id}`)).json().item;
    expect(updated.title).toBe("Renamed");
    expect(updated.content).toBe("# Agenda\nWER results");
    expect(updated.updated_by.id).toBe(member.id);

    const today = (await call(owner, "GET", `/api/items/${await createItem("Defaults")}`)).json().item;
    expect(today.event_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((await call(owner, "POST", "/api/items", { title: "  " })).json().error).toBe("請輸入筆記名稱。");

    expect((await call(member, "DELETE", `/api/items/${id}`)).statusCode).toBe(200);
    expect((await call(owner, "GET", `/api/items/${id}`)).statusCode).toBe(404);
    expect((await call(owner, "DELETE", `/api/items/${id}`)).statusCode).toBe(404);
    expect((await call(owner, "GET", "/api/items/not-a-uuid")).statusCode).toBe(400);
  });

  describe("listing", () => {
    let tagA: string, tagB: string, i1: string, i2: string, i3: string;
    const list = async (query: string) => {
      const response = await call(owner, "GET", `/api/items${query}`);
      expect(response.statusCode).toBe(200);
      return response.json<{ items: { id: string; title: string; excerpt: string; tags: { name: string }[] }[]; nextCursor: string | null }>();
    };
    const ids = async (query: string) => (await list(query)).items.map(item => item.id).filter(id => [i1, i2, i3].includes(id)).sort();

    beforeAll(async () => {
      await ctx.db.query("DELETE FROM items");
      tagA = await createTag("/api/tags", "ASR");
      tagB = await createTag("/api/tags", "TTS");
      i1 = await createItem("Alpha 100% done", { tagIds: [tagA], event_date: "2026-10-01", content: "**decoder** notes" });
      i2 = await createItem("Beta", { tagIds: [tagB], event_date: "2026-10-02", content: "vocoder" });
      i3 = await createItem("Gamma", { event_date: "2026-10-03" });
    });

    it("applies tag filter semantics", async () => {
      expect(await ids("")).toEqual([i1, i2, i3].sort());
      expect(await ids("?tags=")).toEqual([]);
      expect(await ids("?tags=none")).toEqual([i3]);
      expect(await ids(`?tags=${tagA}`)).toEqual([i1]);
      expect(await ids(`?tags=${tagA},none`)).toEqual([i1, i3].sort());
      expect(await ids(`?tags=${tagA},${tagB},garbage`)).toEqual([i1, i2].sort());
    });

    it("searches title and content, escaping LIKE wildcards", async () => {
      expect(await ids("?q=vocoder")).toEqual([i2]);
      expect(await ids("?q=ALPHA")).toEqual([i1]);
      expect(await ids("?q=100%25")).toEqual([i1]);
      expect(await ids("?q=%25")).toEqual([i1]);
      expect(await ids(`?q=decoder&tags=${tagB}`)).toEqual([]);
    });

    it("returns excerpts and tags, newest event first", async () => {
      const { items } = await list("");
      expect(items.map(item => item.id)).toEqual([i3, i2, i1]);
      expect(items[2]).toMatchObject({ excerpt: "decoder notes", tags: [{ name: "ASR" }] });
    });

    it("paginates with a keyset cursor", async () => {
      const first = await list("?limit=2");
      expect(first.items.map(item => item.id)).toEqual([i3, i2]);
      expect(first.nextCursor).toBeTruthy();
      const second = await list(`?limit=2&cursor=${first.nextCursor}`);
      expect(second.items.map(item => item.id)).toEqual([i1]);
      expect(second.nextCursor).toBeNull();
      expect((await call(owner, "GET", "/api/items?cursor=bogus")).statusCode).toBe(400);
    });

    it("replaces a note's tags", async () => {
      const response = await call(member, "PUT", `/api/items/${i3}/tags`, { tagIds: [tagA, tagB, tagA] });
      expect(response.json().tags.map((tag: { name: string }) => tag.name)).toEqual(["ASR", "TTS"]);
      expect((await call(professor, "PUT", `/api/items/${i3}/tags`, { tagIds: [] })).statusCode).toBe(403);
      expect((await call(owner, "PUT", `/api/items/${crypto.randomUUID()}/tags`, { tagIds: [] })).statusCode).toBe(404);
      await call(member, "PUT", `/api/items/${i3}/tags`, { tagIds: [] });
    });
  });

  it("manages tags with case-insensitive uniqueness, separately for slides", async () => {
    const id = await createTag("/api/tags", "Meeting");
    expect((await call(owner, "POST", "/api/tags", { name: "meeting" })).statusCode).toBe(409);
    expect((await call(owner, "POST", "/api/tags", { name: "x".repeat(41) })).json().error).toBe("標籤名稱最多 40 字。");
    expect((await call(professor, "POST", "/api/tags", { name: "Prof" })).statusCode).toBe(403);
    const other = await createTag("/api/tags", "Other");
    expect((await call(owner, "PATCH", `/api/tags/${other}`, { name: "MEETING" })).statusCode).toBe(409);
    expect((await call(owner, "PATCH", `/api/tags/${other}`, { name: " Renamed " })).json().tag.name).toBe("Renamed");

    const note = await createItem("tagged", { tagIds: [id] });
    const tags = (await call(professor, "GET", "/api/tags")).json().tags;
    expect(tags.find((tag: { id: string }) => tag.id === id)).toMatchObject({ name: "Meeting", count: 1 });
    expect((await call(owner, "DELETE", `/api/tags/${id}`)).statusCode).toBe(200);
    expect((await call(owner, "DELETE", `/api/tags/${id}`)).statusCode).toBe(404);
    expect((await call(owner, "GET", `/api/items/${note}`)).json().item.tags).toEqual([]);

    const slideTag = await createTag("/api/slide-tags", "Meeting");
    expect((await call(owner, "GET", "/api/slide-tags")).json().tags).toEqual([{ id: slideTag, name: "Meeting", count: 0 }]);
    expect((await call(professor, "DELETE", `/api/slide-tags/${slideTag}`)).json().error).toBe("Professor 僅可檢視簡報。");
  });

  it("uploads and removes SRT transcripts", async () => {
    const id = await createItem("Transcript");
    const srt = "1\n00:00:00,000 --> 00:00:01,500\nhello\n";
    const upload = (name: string, content: string | Buffer, who = owner) => {
      const body = multipart("file", name, content, "application/x-subrip");
      return ctx.app.inject({ method: "POST", url: `/api/items/${id}/transcript`, payload: body.payload, headers: { ...body.headers, origin: ORIGIN, cookie: who.cookie } });
    };
    expect((await upload("a.srt", srt)).statusCode).toBe(409); // no audio yet
    await ctx.db.query("UPDATE items SET audio_key='media/items/x/y.m4a' WHERE id=$1", [id]);
    expect((await upload("a.txt", srt)).statusCode).toBe(415);
    expect((await upload("a.srt", "not srt")).statusCode).toBe(422);
    expect((await upload("big.srt", Buffer.alloc(5 * 1024 * 1024 + 10, 65))).statusCode).toBe(413);
    expect((await upload("a.srt", srt, professor)).statusCode).toBe(403);
    const ok = await upload("talk.srt", srt);
    expect(ok.json()).toEqual({ ok: true, count: 1 });
    const item = (await call(owner, "GET", `/api/items/${id}`)).json().item;
    expect(item.transcript).toEqual([{ start: 0, end: 1.5, text: "hello" }]);
    expect(item.transcript_name).toBe("talk.srt");
    expect((await call(owner, "DELETE", `/api/items/${id}/transcript`)).statusCode).toBe(200);
    expect((await call(owner, "GET", `/api/items/${id}`)).json().item.transcript).toBeNull();
  });

  describe.skipIf(!hasTestS3)("media", () => {
    const uploadMedia = (itemId: string, who = owner, name = "talk.webm", content: Buffer = Buffer.from("fake media bytes"), type = "audio/webm") => {
      const body = multipart("file", name, content, type);
      return ctx.app.inject({ method: "POST", url: `/api/items/${itemId}/media`, payload: body.payload, headers: { ...body.headers, origin: ORIGIN, cookie: who.cookie } });
    };
    const jobRow = async (jobId: string) =>
      (await ctx.db.query<{ status: string; payload: { itemId: string; sourceKey: string; outputKey: string; fileName: string } }>("SELECT status,payload FROM jobs WHERE id=$1", [jobId])).rows[0]!;
    /** Pretend to be the worker: write output, finish the job, run the finalizer. */
    const completeJob = async (jobId: string, audio: Buffer) => {
      const { payload } = await jobRow(jobId);
      await ctx.storage.put(payload.outputKey, audio, "audio/mp4");
      await ctx.db.query(
        "UPDATE jobs SET status='succeeded',stage='完成',progress=100,result=$2,finished_at=now() WHERE id=$1",
        [jobId, JSON.stringify({ outputKey: payload.outputKey, bytes: audio.length, durationSeconds: 12.5 })],
      );
      await ctx.storage.delete(payload.sourceKey);
      await ctx.finalizer.drain();
      return payload;
    };

    it("stores the upload and enqueues a transcode job", async () => {
      const itemId = await createItem("Recording");
      expect((await uploadMedia(itemId, professor)).statusCode).toBe(403);
      expect((await uploadMedia(itemId, owner, "notes.txt", Buffer.from("x"), "text/plain")).statusCode).toBe(415);
      expect((await uploadMedia(crypto.randomUUID())).statusCode).toBe(404);
      expect((await uploadMedia(itemId, owner, "empty.webm", Buffer.alloc(0))).statusCode).toBe(400);

      const response = await uploadMedia(itemId);
      expect(response.statusCode).toBe(202);
      const { jobId } = response.json<{ jobId: string }>();
      const job = await jobRow(jobId);
      expect(job.status).toBe("queued");
      expect(job.payload).toMatchObject({ itemId, fileName: "talk.webm" });
      expect(job.payload.sourceKey).toMatch(/^media\/uploads\/[0-9a-f-]+\/source$/);
      expect(job.payload.outputKey).toMatch(new RegExp(`^media/items/${itemId}/[0-9a-f-]+\\.m4a$`));
      expect((await ctx.storage.getBuffer(job.payload.sourceKey))?.toString()).toBe("fake media bytes");

      const jobs = (await call(owner, "GET", "/api/media-jobs")).json().jobs;
      expect(jobs[0]).toMatchObject({ id: jobId, item_id: itemId, status: "processing", file_name: "talk.webm", progress: 0 });
      expect((await call(member, "GET", "/api/media-jobs")).json().jobs).toEqual([]);
      expect((await call(member, "GET", `/api/media-jobs/${jobId}`)).statusCode).toBe(404);
      expect((await call(owner, "GET", `/api/media-jobs/${jobId}`)).json().job.status).toBe("processing");
      expect((await call(owner, "GET", `/api/items/${itemId}`)).json().item.media_job).toMatchObject({ id: jobId, status: "processing" });
    });

    it("finalizes a successful transcode, streams with Range and replaces old audio", async () => {
      const itemId = await createItem("Streaming");
      const first = (await uploadMedia(itemId)).json().jobId as string;
      const firstPayload = await completeJob(first, Buffer.from("0123456789"));

      const item = (await call(owner, "GET", `/api/items/${itemId}`)).json().item;
      expect(item.audio).toEqual({ name: "talk.webm", bytes: 10, duration_seconds: 12.5, url: `/api/media/${itemId}` });
      expect(item.media_job).toBeNull();
      expect((await call(owner, "GET", `/api/media-jobs/${first}`)).json().job).toMatchObject({ status: "completed", duration_seconds: 12.5 });
      const notes = await ctx.db.query("SELECT title,url FROM notifications WHERE user_id=$1 AND kind='media'", [owner.id]);
      expect(notes.rows).toContainEqual({ title: "影音處理完成", url: `/recordings/${itemId}` });
      const silent = await createItem("No audio");
      const withAudio = (await call(owner, "GET", "/api/items?audio=1")).json().items;
      expect(withAudio.every((i: { has_audio: boolean }) => i.has_audio)).toBe(true);
      expect(withAudio.find((i: { id: string }) => i.id === itemId)).toMatchObject({ audio_name: "talk.webm", audio_duration_seconds: 12.5 });
      expect(withAudio.some((i: { id: string }) => i.id === silent)).toBe(false);

      const full = await call(professor, "GET", `/api/media/${itemId}`);
      expect(full.statusCode).toBe(200);
      expect(full.body).toBe("0123456789");
      expect(full.headers["accept-ranges"]).toBe("bytes");
      expect(full.headers["content-type"]).toBe("audio/mp4");
      const partial = await call(owner, "GET", `/api/media/${itemId}`, undefined, { range: "bytes=2-5" });
      expect(partial.statusCode).toBe(206);
      expect(partial.body).toBe("2345");
      expect(partial.headers["content-range"]).toBe("bytes 2-5/10");
      expect((await call(owner, "GET", `/api/media/${itemId}`, undefined, { range: "bytes=50-60" })).statusCode).toBe(416);
      expect((await call(owner, "GET", `/api/media/${itemId}`, undefined, { range: "items=1-2" })).statusCode).toBe(416);
      expect((await call(null, "GET", `/api/media/${itemId}`)).statusCode).toBe(401);

      const second = (await uploadMedia(itemId, member, "take2.m4a", Buffer.from("again"), "audio/mp4")).json().jobId as string;
      const secondPayload = await completeJob(second, Buffer.from("abc"));
      expect(await ctx.storage.get(firstPayload.outputKey)).toBeNull();
      expect((await ctx.storage.getBuffer(secondPayload.outputKey))?.toString()).toBe("abc");
      const replaced = (await call(owner, "GET", `/api/items/${itemId}`)).json().item;
      expect(replaced.audio.name).toBe("take2.m4a");
      expect(replaced.updated_by.id).toBe(member.id);

      expect((await call(owner, "DELETE", `/api/items/${itemId}`)).statusCode).toBe(200);
      expect(await ctx.storage.get(secondPayload.outputKey)).toBeNull();
    });

    it("cleans up after a failed transcode and notifies the uploader", async () => {
      const itemId = await createItem("Broken");
      const jobId = (await uploadMedia(itemId, member)).json().jobId as string;
      const { payload } = await jobRow(jobId);
      await ctx.db.query("UPDATE jobs SET status='failed',stage='失敗',error='無法解析媒體檔',finished_at=now() WHERE id=$1", [jobId]);
      await ctx.finalizer.drain();
      expect(await ctx.storage.get(payload.sourceKey)).toBeNull();
      expect((await call(member, "GET", `/api/media-jobs/${jobId}`)).json().job).toMatchObject({ status: "failed", error: "無法解析媒體檔" });
      expect((await call(owner, "GET", `/api/items/${itemId}`)).json().item.audio).toBeNull();
      const notes = await ctx.db.query("SELECT title FROM notifications WHERE user_id=$1 AND url=$2", [member.id, `/notes/${itemId}`]);
      expect(notes.rows).toEqual([{ title: "影音處理失敗" }]);
    });

    it("lets only the uploader cancel, and cleans up the upload", async () => {
      const itemId = await createItem("Cancel me");
      const jobId = (await uploadMedia(itemId, member)).json().jobId as string;
      const { payload } = await jobRow(jobId);
      expect((await call(owner, "DELETE", `/api/media-jobs/${jobId}`)).statusCode).toBe(404);
      expect((await call(member, "DELETE", `/api/media-jobs/${jobId}`)).json()).toEqual({ ok: true });
      expect((await call(member, "DELETE", `/api/media-jobs/${jobId}`)).statusCode).toBe(409);
      await ctx.finalizer.drain();
      expect(await ctx.storage.get(payload.sourceKey)).toBeNull();
      expect((await call(member, "GET", `/api/media-jobs/${jobId}`)).json().job.status).toBe("cancelled");

      // A running job is only flagged; the worker stops it.
      const running = (await uploadMedia(itemId, member)).json().jobId as string;
      await ctx.db.query("UPDATE jobs SET status='running' WHERE id=$1", [running]);
      expect((await call(member, "DELETE", `/api/media-jobs/${running}`)).statusCode).toBe(200);
      expect((await ctx.db.query("SELECT status,cancel_requested FROM jobs WHERE id=$1", [running])).rows[0]).toEqual({ status: "running", cancel_requested: true });
    });

    it("cancels pending jobs when a note is deleted and drops late results", async () => {
      const itemId = await createItem("Delete during upload");
      const queued = (await uploadMedia(itemId)).json().jobId as string;
      const late = (await uploadMedia(itemId)).json().jobId as string;
      const latePayload = (await jobRow(late)).payload;
      await ctx.db.query("UPDATE jobs SET status='running' WHERE id=$1", [late]);
      expect((await call(owner, "DELETE", `/api/items/${itemId}`)).statusCode).toBe(200);
      expect((await jobRow(queued)).status).toBe("cancelled");
      // Worker finished before seeing the cancel flag: output must not be orphaned.
      await completeJob(late, Buffer.from("late"));
      expect(await ctx.storage.get(latePayload.outputKey)).toBeNull();
    });
  });
});
