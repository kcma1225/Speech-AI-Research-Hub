import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db.js";
import { validThumbnailKey } from "../src/jobs/slide-finalizer.js";
import { DEFAULT_PREFERENCES, mergePreferences, preferencesPatchSchema, resolvePreferences } from "../src/lib/preferences.js";
import { createTestContext, hasTestDb, hasTestS3, ORIGIN, type TestContext } from "./helpers.js";
import { insertStudy } from "./study-fixtures.js";

type Session = { id: string; cookie: string };

describe("preferences (unit)", () => {
  it("fills defaults and drops invalid or unknown stored values", () => {
    expect(resolvePreferences(null)).toEqual(DEFAULT_PREFERENCES);
    expect(DEFAULT_PREFERENCES).toEqual({
      notify: { slideRendered: true, mediaTranscoded: true, reviews: true, replies: true, tasks: true },
      editor: { fontSize: 15, layout: "split" },
    });
    expect(resolvePreferences({ notify: { reviews: false, replies: "no" }, editor: { fontSize: 40, layout: "edit" }, extra: 1 })).toEqual({
      notify: { slideRendered: true, mediaTranscoded: true, reviews: false, replies: true, tasks: true },
      editor: { fontSize: 15, layout: "edit" },
    });
  });

  it("merges a deep-partial patch and rejects unknown keys", () => {
    const merged = mergePreferences({ notify: { reviews: false } }, { editor: { fontSize: 20 } });
    expect(merged.notify.reviews).toBe(false);
    expect(merged.editor).toEqual({ fontSize: 20, layout: "split" });
    expect(preferencesPatchSchema.safeParse({ notify: { other: true } }).success).toBe(false);
    expect(preferencesPatchSchema.safeParse({ theme: "dark" }).success).toBe(false);
    expect(preferencesPatchSchema.safeParse({ editor: { fontSize: 12.5 } }).success).toBe(false);
  });

  it("validates worker thumbnail keys", () => {
    const prefix = "slides/p/v/output/";
    expect(validThumbnailKey(`${prefix}_hub-thumbnail.png`, prefix)).toBe(`${prefix}_hub-thumbnail.png`);
    expect(validThumbnailKey("slides/p/other/output/_hub-thumbnail.png", prefix)).toBeNull();
    expect(validThumbnailKey(`${prefix}../x.png`, prefix)).toBeNull();
    expect(validThumbnailKey(prefix, prefix)).toBeNull();
    expect(validThumbnailKey(42, prefix)).toBeNull();
  });
});

const run = hasTestDb && hasTestS3 ? describe : describe.skip;

/** Inserts a deck whose version 1 is published (job already finalized) and active. */
async function insertDeck(db: Db, opts: { title: string; slug: string; createdBy: string; thumbnail?: boolean; finishedAgo?: string }) {
  const projectId = randomUUID();
  const versionId = randomUUID();
  const prefix = `slides/${projectId}/${versionId}/output/`;
  const study = await insertStudy(db, opts.createdBy);
  await db.query("INSERT INTO decks(id,study_id,title,slug,share_key,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$6)", [projectId, study.id, opts.title, opts.slug, randomUUID(), opts.createdBy]);
  const jobId = (await db.query<{ id: string }>(
    `INSERT INTO jobs(kind,status,payload,result,created_by,finished_at,finalized_at)
     VALUES('slide_render','succeeded',$1,'{}',$2,now()-$3::interval,now()) RETURNING id`,
    [JSON.stringify({ projectId, versionId, sourceKey: "x", entry: "index.qmd", outputPrefix: prefix }), opts.createdBy, opts.finishedAgo ?? "0 seconds"],
  )).rows[0]!.id;
  await db.query(
    `INSERT INTO slide_versions(id,deck_id,version,entry_qmd,entry_html,source_name,source_key,output_prefix,status,job_id,created_by,thumbnail_key)
     VALUES($1,$2,1,'index.qmd','index.html','deck.zip','x',$3,'published',$4,$5,$6)`,
    [versionId, projectId, prefix, jobId, opts.createdBy, opts.thumbnail ? `${prefix}_hub-thumbnail.png` : null],
  );
  await db.query("UPDATE decks SET active_version_id=$1 WHERE id=$2", [versionId, projectId]);
  return { projectId, versionId, prefix, thumbnailKey: `${prefix}_hub-thumbnail.png` };
}

run("UI support routes", () => {
  let ctx: TestContext;
  let owner: Session;
  let member: Session;
  let member2: Session;
  let professor: Session;

  const get = (who: Session | null, url: string, headers: Record<string, string> = {}) =>
    ctx.app.inject({ method: "GET", url, headers: { ...(who ? { cookie: who.cookie } : {}), ...headers } });
  const write = (who: Session, method: "POST" | "PATCH", url: string, payload: object) =>
    ctx.app.inject({ method, url, payload, headers: { origin: ORIGIN, cookie: who.cookie } });

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await ctx.ownerCookie();
    member = await ctx.login("student", "Member One");
    member2 = await ctx.login("student", "Member Two");
    professor = await ctx.login("professor", "Prof Lee");
  });
  afterAll(async () => {
    await ctx?.close();
  });

  describe("profile preferences", () => {
    it("exposes locale and default preferences on /auth/me", async () => {
      const user = (await get(member, "/api/auth/me")).json().user;
      expect(user).toMatchObject({ locale: "zh-TW", preferences: DEFAULT_PREFERENCES });
    });

    it("merges partial updates and validates them", async () => {
      let response = await write(member, "PATCH", "/api/auth/profile", { locale: "en", preferences: { notify: { reviews: false } } });
      expect(response.statusCode).toBe(200);
      expect(response.json().user).toMatchObject({ locale: "en", preferences: { notify: { reviews: false, replies: true } } });
      response = await write(member, "PATCH", "/api/auth/profile", { preferences: { editor: { fontSize: 18, layout: "preview" } } });
      expect(response.json().user.preferences).toEqual({
        notify: { slideRendered: true, mediaTranscoded: true, reviews: false, replies: true, tasks: true },
        editor: { fontSize: 18, layout: "preview" },
      });
      const stored = (await ctx.db.query("SELECT preferences,locale FROM users WHERE id=$1", [member.id])).rows[0];
      expect(stored.locale).toBe("en");
      expect(stored.preferences.editor.fontSize).toBe(18);

      for (const bad of [
        { locale: "fr" },
        { preferences: { notify: { unknown: true } } },
        { preferences: { editor: { fontSize: 23 } } },
        { preferences: { editor: { fontSize: 11 } } },
        { preferences: { editor: { layout: "grid" } } },
        { preferences: { notify: { reviews: "off" } } },
        { preferences: { extra: {} } },
      ]) {
        const result = await write(member, "PATCH", "/api/auth/profile", bad);
        expect(result.statusCode, JSON.stringify(bad)).toBe(400);
        expect(result.json().error).toBeTypeOf("string");
      }
      expect((await get(member, "/api/auth/me")).json().user.preferences.editor.fontSize).toBe(18);
    });

    it("gates Web Push by preference but always records in-app notifications", async () => {
      await ctx.db.query("INSERT INTO push_subscriptions(endpoint,user_id,p256dh,auth) VALUES($1,$2,'k','a')", [`https://push.test/${member.id}`, member.id]);
      expect(await ctx.app.notifier.subscriptionsFor([member.id], "reviews")).toEqual([]);
      expect(await ctx.app.notifier.subscriptionsFor([member.id], "replies")).toHaveLength(1);
      expect(await ctx.app.notifier.subscriptionsFor([member.id], null)).toHaveLength(1);

      const deck = await insertDeck(ctx.db, { title: "Prefs deck", slug: "prefs-deck", createdBy: member.id });
      expect((await write(professor, "POST", `/api/slides/${deck.projectId}/reviews`, { body: "Looks good" })).statusCode).toBe(201);
      const notes = await ctx.db.query("SELECT title FROM notifications WHERE user_id=$1 AND kind='slide'", [member.id]);
      expect(notes.rows).toContainEqual({ title: "Prof Lee 新增了簡報審閱" });
    });
  });

  describe("thumbnails", () => {
    it("streams the active version's thumbnail with caching headers", async () => {
      const deck = await insertDeck(ctx.db, { title: "Thumb deck", slug: "thumb-deck", createdBy: member.id, thumbnail: true });
      const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(64, 1)]);
      await ctx.storage.put(deck.thumbnailKey, png, "image/png");

      const response = await get(member, `/api/slides/${deck.projectId}/thumbnail`);
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe("image/png");
      expect(response.headers["cache-control"]).toBe("private, max-age=300");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers.etag).toBe(`"${deck.versionId}"`);
      expect(response.rawPayload.equals(png)).toBe(true);
      expect((await get(member, `/api/slides/${deck.projectId}/thumbnail`, { "if-none-match": `"${deck.versionId}"` })).statusCode).toBe(304);
      expect((await get(null, `/api/slides/${deck.projectId}/thumbnail`)).statusCode).toBe(401);

      const url = `/api/slides/${deck.projectId}/thumbnail?v=${deck.versionId}`;
      const list = (await get(member, "/api/slides")).json().slides as { id: string; thumbnailUrl: string | null }[];
      expect(list.find(s => s.id === deck.projectId)?.thumbnailUrl).toBe(url);
      expect((await get(professor, `/api/slides/${deck.projectId}`)).json().thumbnailUrl).toBe(url);

      const plain = await insertDeck(ctx.db, { title: "No thumb", slug: "no-thumb", createdBy: member.id });
      expect((await get(member, `/api/slides/${plain.projectId}/thumbnail`)).statusCode).toBe(404);
      expect((await get(member, `/api/slides/${plain.projectId}`)).json().thumbnailUrl).toBeNull();
      expect((await get(member, "/api/slides")).json().slides.find((s: { id: string }) => s.id === plain.projectId).thumbnailUrl).toBeNull();
      // Key recorded but object missing.
      const missing = await insertDeck(ctx.db, { title: "Lost thumb", slug: "lost-thumb", createdBy: member.id, thumbnail: true });
      expect((await get(member, `/api/slides/${missing.projectId}/thumbnail`)).statusCode).toBe(404);
      expect((await get(member, `/api/slides/${randomUUID()}/thumbnail`)).statusCode).toBe(404);
    });

    it("slide finalizer stores a valid thumbnail key and ignores others", async () => {
      const finalize = async (slug: string, thumbnailKey: (prefix: string) => string | undefined) => {
        const projectId = randomUUID();
        const versionId = randomUUID();
        const prefix = `slides/${projectId}/${versionId}/output/`;
        const study = await insertStudy(ctx.db, member.id);
        await ctx.db.query("INSERT INTO decks(id,study_id,title,slug,share_key,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$6)", [projectId, study.id, slug, slug, randomUUID(), member.id]);
        const key = thumbnailKey(prefix);
        const result = { entryHtml: "index.html", pdfKey: `${prefix}slides.pdf`, quartoVersion: "1.10", fileCount: 3, sharedPrefix: null, ...(key ? { thumbnailKey: key } : {}) };
        const jobId = (await ctx.db.query<{ id: string }>(
          "INSERT INTO jobs(kind,status,payload,result,created_by,finished_at) VALUES('slide_render','succeeded',$1,$2,$3,now()) RETURNING id",
          [JSON.stringify({ projectId, versionId, sourceKey: "x", entry: "index.qmd", outputPrefix: prefix }), JSON.stringify(result), member.id],
        )).rows[0]!.id;
        await ctx.db.query(
          "INSERT INTO slide_versions(id,deck_id,version,entry_qmd,source_name,source_key,output_prefix,job_id,created_by) VALUES($1,$2,1,'index.qmd','d.zip','x',$3,$4,$5)",
          [versionId, projectId, prefix, jobId, member.id],
        );
        await ctx.finalizer.drain();
        return { prefix, row: (await ctx.db.query("SELECT status,thumbnail_key FROM slide_versions WHERE id=$1", [versionId])).rows[0] };
      };
      const good = await finalize("fin-good", prefix => `${prefix}_hub-thumbnail.png`);
      expect(good.row).toEqual({ status: "published", thumbnail_key: `${good.prefix}_hub-thumbnail.png` });
      expect((await finalize("fin-foreign", () => "slides/other/v/output/_hub-thumbnail.png")).row).toEqual({ status: "published", thumbnail_key: null });
      expect((await finalize("fin-none", () => undefined)).row).toEqual({ status: "published", thumbnail_key: null });
    });
  });

  describe("jobs/active", () => {
    it("lists the caller's live and recently finished jobs with labels", async () => {
      const user = await ctx.login("student", "Job Runner");
      const deck = await insertDeck(ctx.db, { title: "Jobs deck", slug: "jobs-deck", createdBy: user.id, finishedAgo: "1 hour" });
      const itemId = randomUUID();
      const insert = async (kind: string, status: string, payload: object, extra: { createdAgo: string; finishedAgo?: string; stage?: string; progress?: number; by?: string }) =>
        (await ctx.db.query<{ id: string }>(
          `INSERT INTO jobs(kind,status,payload,stage,progress,created_by,created_at,finished_at,finalized_at)
           VALUES($1,$2,$3,$4,$5,$6,now()-$7::interval,now()-$8::interval,now()) RETURNING id`,
          [kind, status, JSON.stringify(payload), extra.stage ?? "queued", extra.progress ?? 0, extra.by ?? user.id, extra.createdAgo, extra.finishedAgo ?? null],
        )).rows[0]!.id;
      const slidePayload = { projectId: deck.projectId, versionId: deck.versionId, sourceKey: "x", entry: "index.qmd", outputPrefix: deck.prefix };
      const mediaPayload = { itemId, sourceKey: "s", outputKey: "o", fileName: "talk.webm" };
      const queued = await insert("slide_render", "queued", slidePayload, { createdAgo: "1 minute" });
      const running = await insert("media_transcode", "running", mediaPayload, { createdAgo: "2 minutes", stage: "音訊轉碼", progress: 40 });
      const done = await insert("media_transcode", "succeeded", mediaPayload, { createdAgo: "6 minutes", finishedAgo: "5 minutes", stage: "完成", progress: 100 });
      const orphan = await insert("media_transcode", "failed", { ...mediaPayload, itemId: randomUUID() }, { createdAgo: "7 minutes", finishedAgo: "7 minutes", stage: "失敗" });
      await insert("media_transcode", "failed", mediaPayload, { createdAgo: "30 minutes", finishedAgo: "20 minutes" });
      await insert("media_transcode", "running", mediaPayload, { createdAgo: "1 minute", by: member.id });

      const response = await get(user, "/api/jobs/active");
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      const jobs = response.json().jobs;
      expect(jobs.map((j: { id: string }) => j.id)).toEqual([queued, running, done, orphan]);
      expect(jobs[0]).toMatchObject({ kind: "slide_render", status: "queued", stage: "排隊中", progress: 0, label: "Jobs deck v1", url: `/slides/${deck.projectId}` });
      expect(jobs[0].updatedAt).toBeTypeOf("string");
      expect(jobs[1]).toMatchObject({ kind: "media_transcode", status: "running", stage: "音訊轉碼", progress: 40, label: "talk.webm", url: null });
      expect(jobs[2]).toMatchObject({ status: "succeeded", progress: 100, label: "talk.webm" });
      expect(jobs[3]).toMatchObject({ status: "failed", label: "talk.webm", url: null });
      expect((await get(owner, "/api/jobs/active")).json().jobs).toEqual([]);
      expect((await get(null, "/api/jobs/active")).statusCode).toBe(401);
    });
  });
});
