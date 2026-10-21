import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LightMyRequestResponse } from "fastify";
import { createTestContext, hasTestDb, hasTestS3, ORIGIN, type TestContext } from "./helpers.js";
import { deckZip, multipart, PDF_BYTES, pptxBytes, userSession } from "./slides-fixtures.js";
import { insertStudy } from "./study-fixtures.js";
import type { PageManifest, SlideRenderPayload, SlideRenderResult } from "../src/jobs/queue.js";

const run = hasTestDb && hasTestS3 ? describe : describe.skip;
const WEBP = Buffer.concat([Buffer.from("RIFF\0\0\0\0WEBPVP8 "), Buffer.alloc(64, 1)]);

run("slide pages, PDF/PPTX decks, per-page reviews", () => {
  let ctx: TestContext;
  let member: { id: string; cookie: string };
  let professor: { id: string; cookie: string };
  let studyId: string;
  const json = (response: LightMyRequestResponse) => response.json() as Record<string, any>;

  beforeAll(async () => {
    ctx = await createTestContext();
    member = await userSession(ctx.db, "student", "Member P");
    professor = await userSession(ctx.db, "professor", "Prof Pages");
    studyId = (await insertStudy(ctx.db, member.id)).id;
  });
  afterAll(async () => {
    await ctx?.close();
  });

  const write = (method: "POST" | "PATCH" | "DELETE", url: string, cookie: string | undefined, payload?: unknown) =>
    ctx.app.inject({ method, url, headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) });
  const get = (url: string, cookie?: string, headers: Record<string, string> = {}) => ctx.app.inject({ method: "GET", url, headers: { ...(cookie ? { cookie } : {}), ...headers } });
  const upload = (url: string, fields: Record<string, string>, data: Buffer, filename: string) => {
    const body = multipart(url === "/api/slides" ? { studyId, ...fields } : fields, { filename, data });
    return ctx.app.inject({ method: "POST", url, headers: { origin: ORIGIN, cookie: member.cookie, ...body.headers }, payload: body.payload });
  };
  const jobFor = async (versionId: string) =>
    (await ctx.db.query<{ id: string; payload: SlideRenderPayload }>("SELECT j.id,j.payload FROM jobs j JOIN slide_versions v ON v.job_id=j.id WHERE v.id=$1", [versionId])).rows[0]!;

  /** Plays the worker: pages + manifest (when `pages` > 0) and a succeeded result. */
  async function complete(versionId: string, pages: number, extra: Partial<SlideRenderResult> = {}) {
    const job = await jobFor(versionId);
    const prefix = job.payload.outputPrefix;
    const sourceType = job.payload.sourceType ?? "quarto";
    const result: SlideRenderResult = sourceType === "quarto"
      ? { entryHtml: "index.html", pdfKey: `${prefix}slides.pdf`, quartoVersion: "1.10.19", fileCount: 2, sharedPrefix: "slides/_shared/0123456789abcdef0123456789abcdef/" }
      : { entryHtml: null, pdfKey: sourceType === "pdf" ? job.payload.sourceKey : `${prefix}slides.pdf`, quartoVersion: null, fileCount: 2, sharedPrefix: null };
    if (sourceType === "quarto") await ctx.storage.put(`${prefix}index.html`, "<html><head></head><body><script>Reveal.initialize({})</script></body></html>", "text/html");
    if (sourceType === "pptx") await ctx.storage.put(`${prefix}slides.pdf`, PDF_BYTES, "application/pdf");
    if (pages) {
      const manifest: PageManifest = {
        version: 1, sourceType, width: 1920, height: 1080,
        pages: Array.from({ length: pages }, (_, i) => ({
          index: i + 1, thumb: `_hub/pages/${i + 1}-thumb.webp`, ...(sourceType === "quarto" ? { h: i } : { full: `_hub/pages/${i + 1}-full.webp` }),
          ...(i === 0 ? { title: "第一頁", notes: { text: "講者備忘", html: "<p>講者備忘</p>" } } : {}),
        })),
      };
      for (let i = 1; i <= pages; i++) {
        await ctx.storage.put(`${prefix}_hub/pages/${i}-thumb.webp`, WEBP, "image/webp");
        if (sourceType !== "quarto") await ctx.storage.put(`${prefix}_hub/pages/${i}-full.webp`, WEBP, "image/webp");
      }
      await ctx.storage.put(`${prefix}_hub/thumbnail.webp`, WEBP, "image/webp");
      await ctx.storage.put(`${prefix}_hub/pages.json`, JSON.stringify(manifest), "application/json");
      Object.assign(result, { pageCount: pages, manifestKey: `${prefix}_hub/pages.json`, thumbnailKey: `${prefix}_hub/thumbnail.webp` });
    }
    Object.assign(result, extra);
    await ctx.db.query("UPDATE jobs SET status='succeeded',progress=100,finished_at=now(),result=$2 WHERE id=$1", [job.id, JSON.stringify(result)]);
    await ctx.finalizer.drain();
    return prefix;
  }

  let deckId: string;
  let v1: string; // quarto, legacy (no pages)
  let v2: string; // pdf, 3 pages
  let shareKey: string;
  const slug = "pages-deck";

  it("accepts a PDF deck: stored as source.pdf, published at once, pages served", async () => {
    const created = await upload("/api/slides", { title: "Pages", slug }, deckZip(), "deck.zip");
    expect(created.statusCode).toBe(202);
    deckId = json(created).id;
    v1 = json(created).versionId;
    expect(json(created)).toMatchObject({ sourceType: "quarto", entry: "index.qmd" });
    await complete(v1, 0);

    const pdf = await upload(`/api/slides/${deckId}/versions`, {}, PDF_BYTES, "paper.PDF");
    expect(pdf.statusCode).toBe(202);
    expect(json(pdf)).toMatchObject({ version: 2, sourceType: "pdf", entry: null, scan: null });
    v2 = json(pdf).versionId;
    const job = await jobFor(v2);
    expect(job.payload).toEqual({
      projectId: deckId, versionId: v2, sourceKey: `slides/${deckId}/${v2}/source.pdf`, entry: "", outputPrefix: `slides/${deckId}/${v2}/output/`, sourceType: "pdf",
    });
    expect((await ctx.storage.get(job.payload.sourceKey))?.contentType).toBe("application/pdf");
    expect((await upload(`/api/slides/${deckId}/versions`, {}, deckZip(), "fake.pdf")).statusCode).toBe(415);
    expect((await upload(`/api/slides/${deckId}/versions`, {}, pptxBytes(), "deck.pptm")).statusCode).toBe(400);

    const prefix = await complete(v2, 3);
    const detail = json(await get(`/api/slides/${deckId}`, member.cookie));
    expect(detail.project.active_version_id).toBe(v2);
    expect(detail.activeVersion).toMatchObject({ id: v2, sourceType: "pdf", status: "published", pageCount: 3, pagesUrl: `/api/slides/${deckId}/versions/${v2}/pages`, viewUrl: null });
    expect(detail.pdfUrl).toBe(`/api/slides/pdf/${slug}/${v2}`);
    expect(detail.viewUrl).toBeNull();
    const legacy = detail.versions.find((v: any) => v.id === v1);
    expect(legacy).toMatchObject({ sourceType: "quarto", pageCount: null, pagesUrl: null });
    expect(legacy.viewUrl).toBeTruthy();
    // The PDF download is the uploaded file itself.
    const download = await get(detail.pdfUrl, member.cookie);
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    // Deck thumbnail is page 1 (WebP).
    const thumb = await get(detail.thumbnailUrl, member.cookie);
    expect(thumb.headers["content-type"]).toBe("image/webp");
    const versionRow = (await ctx.db.query("SELECT page_count,manifest_key,published_at FROM slide_versions WHERE id=$1", [v2])).rows[0];
    expect(versionRow).toMatchObject({ page_count: 3, manifest_key: `${prefix}_hub/pages.json` });
    expect(versionRow.published_at).not.toBeNull();
  });

  it("serves the manifest with fetchable URLs and immutable page images", async () => {
    const manifest = await get(`/api/slides/${deckId}/versions/${v2}/pages`, professor.cookie);
    expect(manifest.statusCode).toBe(200);
    expect(manifest.headers["cache-control"]).toBe("private, max-age=300");
    const body = json(manifest);
    expect(body).toMatchObject({ version: 1, versionId: v2, sourceType: "pdf", width: 1920, height: 1080, pageCount: 3 });
    expect(body.pages[0]).toEqual({
      index: 1, title: "第一頁", notes: { text: "講者備忘", html: "<p>講者備忘</p>" },
      thumb: `/api/slides/${deckId}/versions/${v2}/pages/1/thumb`, full: `/api/slides/${deckId}/versions/${v2}/pages/1/full`,
    });
    const image = await get(body.pages[2].full, professor.cookie);
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toBe("image/webp");
    expect(image.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(image.headers["x-content-type-options"]).toBe("nosniff");
    expect(image.rawPayload.subarray(0, 4).toString()).toBe("RIFF");
    expect((await get(`/api/slides/${deckId}/versions/${v2}/pages/1/thumb`)).statusCode).toBe(401);
    expect((await get(`/api/slides/${deckId}/versions/${v2}/pages/4/thumb`, member.cookie)).statusCode).toBe(404);
    expect((await get(`/api/slides/${deckId}/versions/${v2}/pages/0/thumb`, member.cookie)).statusCode).toBe(404);
    expect((await get(`/api/slides/${deckId}/versions/${v2}/pages/1/huge`, member.cookie)).statusCode).toBe(404);
    expect((await get(`/api/slides/${deckId}/versions/${v1}/pages`, member.cookie)).statusCode).toBe(404);
    expect((await get(`/api/slides/${deckId}/versions/${crypto.randomUUID()}/pages`, member.cookie)).statusCode).toBe(404);
    // Hub files are not reachable through the deck asset route.
    const viewUrl: string = json(await get(`/api/slides/${deckId}`, member.cookie)).versions.find((v: any) => v.id === v1).viewUrl;
    expect((await get(viewUrl.replace(/index\.html$/, "_hub/pages.json"))).statusCode).toBe(400);
  });

  it("applies the player's access rules to by-slug page routes", async () => {
    const base = `/api/slides/pages/${slug}/${v2}`;
    expect((await get(base)).statusCode).toBe(404);
    expect((await get(`${base}/1/thumb`)).statusCode).toBe(404);
    shareKey = json(await get(`/api/slides/${deckId}`, member.cookie)).project.share_key;
    const key = encodeURIComponent(shareKey);

    const bySlug = json(await get(`/api/slides/by-slug/${slug}?key=${key}`));
    expect(bySlug.activeVersion.pagesUrl).toBe(`${base}?key=${key}`);
    const viaKey = json(await get(bySlug.activeVersion.pagesUrl));
    expect(viaKey.pages[1].thumb).toBe(`${base}/2/thumb?key=${key}`);
    expect(viaKey.pages[0].notes.text).toBe("講者備忘");
    const image = await get(viaKey.pages[1].thumb);
    expect(image.statusCode).toBe(200);
    expect(image.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect((await get(`${base}/2/thumb?key=wrong`)).statusCode).toBe(404);

    const share = await get(`/api/slides/share/${slug}/${key}`);
    const cookie = `slide_share_${slug}=${encodeURIComponent(share.cookies.find(c => c.name === `slide_share_${slug}`)!.value)}`;
    const viaCookie = json(await get(`/api/slides/by-slug/${slug}`, cookie));
    expect(viaCookie.activeVersion.pagesUrl).toBe(base);
    expect((await get(`${base}/1/full`, cookie)).statusCode).toBe(200);
    // Signed-in users can use the player routes too.
    expect((await get(base, member.cookie)).statusCode).toBe(200);

    expect((await write("PATCH", `/api/slides/${deckId}`, member.cookie, { public_view: true })).statusCode).toBe(200);
    expect(json(await get(base)).pages[0].thumb).toBe(`${base}/1/thumb`);
    expect((await get(`${base}/3/full`)).statusCode).toBe(200);
    await write("PATCH", `/api/slides/${deckId}`, member.cookie, { public_view: false });
  });

  let v3: string;
  it("puts a converted PPTX in review: not active, uploader notified, publish → active", async () => {
    const pptx = await upload(`/api/slides/${deckId}/versions`, {}, pptxBytes(), "talk.pptx");
    expect(pptx.statusCode).toBe(202);
    expect(json(pptx)).toMatchObject({ version: 3, sourceType: "pptx" });
    v3 = json(pptx).versionId;
    const job = await jobFor(v3);
    expect(job.payload).toMatchObject({ sourceType: "pptx", sourceKey: `slides/${deckId}/${v3}/source.pptx` });
    await complete(v3, 2);

    let detail = json(await get(`/api/slides/${deckId}`, member.cookie));
    expect(detail.project.active_version_id).toBe(v2);
    const inReview = detail.versions.find((v: any) => v.id === v3);
    expect(inReview).toMatchObject({ status: "review", progress: 100, pageCount: 2, pagesUrl: `/api/slides/${deckId}/versions/${v3}/pages`, pdfUrl: null, published_at: null, is_active: false });
    expect(json(await get(`/api/slides/${deckId}/status`, member.cookie))).toMatchObject({ status: "review", progress: 100 });
    // The uploader can check the pages; the player cannot see a review version.
    expect((await get(inReview.pagesUrl, member.cookie)).statusCode).toBe(200);
    expect((await get(`/api/slides/${deckId}/versions/${v3}/pages/2/full`, member.cookie)).statusCode).toBe(200);
    expect((await get(`/api/slides/pages/${slug}/${v3}?key=${encodeURIComponent(shareKey)}`)).statusCode).toBe(404);
    expect(json(await get(`/api/slides/by-slug/${slug}`, member.cookie)).versions.find((v: any) => v.id === v3).pagesUrl).toBeNull();
    const notes = (await ctx.db.query("SELECT title,body FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1", [member.id])).rows[0];
    expect(notes).toEqual({ title: "簡報轉換完成，請確認", body: "Pages · Version 3" });

    expect((await write("PATCH", `/api/slides/${deckId}/versions/${v3}`, member.cookie, { active: true })).statusCode).toBe(404);
    expect((await write("POST", `/api/slides/${deckId}/versions/${v3}/publish`, professor.cookie)).statusCode).toBe(403);
    const published = await write("POST", `/api/slides/${deckId}/versions/${v3}/publish`, member.cookie);
    expect(published.statusCode).toBe(200);
    expect(json(published)).toEqual({ ok: true, status: "published", active: true });
    expect((await write("POST", `/api/slides/${deckId}/versions/${v3}/publish`, member.cookie)).statusCode).toBe(404);
    detail = json(await get(`/api/slides/${deckId}`, member.cookie));
    expect(detail.activeVersion).toMatchObject({ id: v3, status: "published", pdfUrl: `/api/slides/pdf/${slug}/${v3}` });
    expect(detail.activeVersion.published_at).toBeTruthy();
  });

  it("discards a review version with DELETE", async () => {
    const pptx = json(await upload(`/api/slides/${deckId}/versions`, {}, pptxBytes(), "talk2.pptx"));
    const prefix = await complete(pptx.versionId, 1);
    expect(json(await get(`/api/slides/${deckId}/status`, member.cookie)).status).toBe("review");
    expect((await write("DELETE", `/api/slides/${deckId}/versions/${pptx.versionId}`, member.cookie)).statusCode).toBe(200);
    expect(await ctx.storage.get(`${prefix}_hub/pages.json`)).toBeNull();
    expect(await ctx.storage.get(`slides/${deckId}/${pptx.versionId}/source.pptx`)).toBeNull();
    expect(json(await get(`/api/slides/${deckId}`, member.cookie)).project.active_version_id).toBe(v3);
  });

  it("ignores page fields that do not belong to the version", async () => {
    const pdf = json(await upload(`/api/slides/${deckId}/versions`, {}, PDF_BYTES, "x.pdf"));
    await complete(pdf.versionId, 0, { pageCount: 5, manifestKey: `slides/${deckId}/${v2}/output/_hub/pages.json` });
    const row = (await ctx.db.query("SELECT status,page_count,manifest_key FROM slide_versions WHERE id=$1", [pdf.versionId])).rows[0];
    expect(row).toEqual({ status: "published", page_count: null, manifest_key: null });
    await write("PATCH", `/api/slides/${deckId}/versions/${v3}`, member.cookie, { active: true });
  });

  it("validates per-page reviews and reports the page", async () => {
    const add = (payload: object) => write("POST", `/api/slides/${deckId}/reviews`, professor.cookie, payload);
    // Page without versionId → the active version (v3, 2 pages).
    const onPage = await add({ body: "圖表太小", page: 2 });
    expect(onPage.statusCode).toBe(201);
    expect(json(onPage).review).toMatchObject({ body: "圖表太小", page: 2, versionId: v3, replies: [] });
    expect(json(await add({ body: "x", page: 3 })).error).toMatch(/頁碼超出範圍（共 2 頁）/);
    expect((await add({ body: "x", page: 0 })).statusCode).toBe(400);
    expect((await add({ body: "x", page: 1.5 })).statusCode).toBe(400);
    expect(json(await add({ body: "x", page: 1, versionId: v1 })).error).toMatch(/沒有頁面資訊/);
    expect((await add({ body: "x", page: 1, versionId: crypto.randomUUID() })).statusCode).toBe(404);
    const onV2 = json(await add({ body: "第三頁錯字", page: 3, versionId: v2 })).review;
    expect(onV2).toMatchObject({ page: 3, versionId: v2 });
    const general = json(await add({ body: "整體不錯" })).review;
    expect(general).toMatchObject({ page: null, versionId: null });

    const notice = (await ctx.db.query("SELECT body FROM notifications WHERE user_id=$1 AND title LIKE '%審閱%' ORDER BY created_at", [member.id])).rows.map(r => r.body);
    expect(notice).toEqual(["Pages 第 2 頁：圖表太小", "Pages 第 3 頁：第三頁錯字", "Pages：整體不錯"]);
    const reviews = json(await get(`/api/slides/${deckId}`, member.cookie)).reviews;
    expect(reviews.map((r: any) => [r.page, r.versionId])).toEqual([[2, v3], [3, v2], [null, null]]);
    const bySlug = json(await get(`/api/slides/by-slug/${slug}?key=${encodeURIComponent(shareKey)}`)).reviews;
    expect(bySlug[0]).toMatchObject({ page: 2, versionId: v3 });
  });

  it("re-indexes a legacy version into a new prefix without touching the served deck until it succeeds", async () => {
    const before = (await ctx.db.query("SELECT output_prefix,published_at FROM slide_versions WHERE id=$1", [v1])).rows[0];
    expect((await write("POST", `/api/slides/${deckId}/versions/${v1}/reindex`, professor.cookie)).statusCode).toBe(403);
    // A failing re-index leaves the version untouched and removes its partial output.
    const failing = await write("POST", `/api/slides/${deckId}/versions/${v1}/reindex`, member.cookie);
    expect(failing.statusCode).toBe(202);
    expect((await write("POST", `/api/slides/${deckId}/versions/${v1}/reindex`, member.cookie)).statusCode).toBe(409);
    const failedJob = await jobFor(v1);
    expect(failedJob.payload.outputPrefix).toMatch(new RegExp(`^slides/${deckId}/${v1}/output-[a-z0-9]+/$`));
    expect(failedJob.payload).toMatchObject({ sourceType: "quarto", entry: "index.qmd", sourceKey: `slides/${deckId}/${v1}/source.zip` });
    await ctx.storage.put(`${failedJob.payload.outputPrefix}partial.html`, "x", "text/html");
    await ctx.db.query("UPDATE jobs SET status='failed',error='boom',finished_at=now() WHERE id=$1", [failedJob.id]);
    await ctx.finalizer.drain();
    expect(await ctx.storage.get(`${failedJob.payload.outputPrefix}partial.html`)).toBeNull();
    expect((await ctx.db.query("SELECT status,output_prefix FROM slide_versions WHERE id=$1", [v1])).rows[0]).toEqual({ status: "published", output_prefix: before.output_prefix });
    expect(await ctx.storage.get(`${before.output_prefix}index.html`)).not.toBeNull();

    expect((await write("POST", `/api/slides/${deckId}/versions/${v1}/reindex`, member.cookie)).statusCode).toBe(202);
    const newPrefix = await complete(v1, 4);
    const after = (await ctx.db.query("SELECT status,output_prefix,page_count,manifest_key,thumbnail_key,published_at FROM slide_versions WHERE id=$1", [v1])).rows[0];
    expect(after).toMatchObject({ status: "published", output_prefix: newPrefix, page_count: 4, manifest_key: `${newPrefix}_hub/pages.json` });
    expect(after.published_at).toEqual(before.published_at);
    expect(await ctx.storage.get(`${before.output_prefix}index.html`)).toBeNull();
    const version = json(await get(`/api/slides/${deckId}`, member.cookie)).versions.find((v: any) => v.id === v1);
    expect(version).toMatchObject({ pageCount: 4, status: "published" });
    expect((await get(version.viewUrl)).statusCode).toBe(200);
    // Re-indexed pages carry a revision so the immutable browser cache never serves the old images.
    const rev = /\/output-([a-z0-9]+)\/$/.exec(newPrefix)![1];
    const reindexed = json(await get(version.pagesUrl, member.cookie)).pages[0];
    expect(reindexed).toMatchObject({ index: 1, h: 0, thumb: `/api/slides/${deckId}/versions/${v1}/pages/1/thumb?r=${rev}` });
    expect(reindexed.full).toBeUndefined();
    expect((await get(reindexed.thumb, member.cookie)).statusCode).toBe(200);
    const key = encodeURIComponent(shareKey);
    const viaKey = json(await get(`/api/slides/pages/${slug}/${v1}?key=${key}`)).pages[0];
    expect(viaKey.thumb).toBe(`/api/slides/pages/${slug}/${v1}/1/thumb?r=${rev}&key=${key}`);
    expect((await get(viaKey.thumb)).statusCode).toBe(200);
    // Only published versions can be re-indexed.
    expect((await write("POST", `/api/slides/${deckId}/versions/${crypto.randomUUID()}/reindex`, member.cookie)).statusCode).toBe(404);
  });
});
