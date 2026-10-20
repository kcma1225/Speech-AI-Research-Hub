import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LightMyRequestResponse } from "fastify";
import { createTestContext, hasTestDb, hasTestS3, ORIGIN, type TestContext } from "./helpers.js";
import { deckZip, makeZip, multipart, PDF_BYTES, userSession } from "./slides-fixtures.js";
import { viewToken } from "../src/lib/slides/access.js";
import type { SlideRenderPayload } from "../src/jobs/queue.js";

const run = hasTestDb && hasTestS3 ? describe : describe.skip;

run("slides routes", () => {
  let ctx: TestContext;
  let member: { id: string; cookie: string };
  let professor: { id: string; cookie: string };
  let owner: { id: string; cookie: string };
  const json = (response: LightMyRequestResponse) => response.json() as Record<string, any>;

  beforeAll(async () => {
    ctx = await createTestContext();
    member = await userSession(ctx.db, "member", "Member A");
    professor = await userSession(ctx.db, "professor", "Prof Lee");
    owner = await userSession(ctx.db, "owner");
  });
  afterAll(async () => {
    await ctx?.close();
  });

  const write = (method: "POST" | "PATCH" | "DELETE" | "PUT", url: string, cookie: string | undefined, payload?: unknown) =>
    ctx.app.inject({ method, url, headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) });
  const get = (url: string, cookie?: string, headers: Record<string, string> = {}) => ctx.app.inject({ method: "GET", url, headers: { ...(cookie ? { cookie } : {}), ...headers } });
  const upload = (url: string, cookie: string, fields: Record<string, string>, zip: Buffer, filename = "deck.zip") => {
    const body = multipart(fields, { filename, data: zip, type: "application/zip" });
    return ctx.app.inject({ method: "POST", url, headers: { origin: ORIGIN, cookie, ...body.headers }, payload: body.payload });
  };
  const jobFor = async (versionId: string) =>
    (await ctx.db.query<{ id: string; status: string; payload: SlideRenderPayload; kind: string }>("SELECT j.id,j.status,j.payload,j.kind FROM jobs j JOIN slide_versions v ON v.job_id=j.id WHERE v.id=$1", [versionId])).rows[0]!;

  /** Plays the worker: write rendered output to S3 and finish the job. */
  async function completeJob(versionId: string, ok = true) {
    const job = await jobFor(versionId);
    if (ok) {
      const prefix = job.payload.outputPrefix;
      await ctx.storage.put(`${prefix}index.html`, '<html><head><title>t</title></head><body><script>Reveal.initialize({hash:true})</script></body></html>', "text/html");
      await ctx.storage.put(`${prefix}index_files/app.js`, "console.log(1)", "application/javascript");
      await ctx.storage.put(`${prefix}slides.pdf`, PDF_BYTES, "application/pdf");
      await ctx.db.query("UPDATE jobs SET status='succeeded',progress=100,finished_at=now(),result=$2 WHERE id=$1", [job.id, JSON.stringify({ entryHtml: "index.html", pdfKey: `${prefix}slides.pdf`, quartoVersion: "1.10.19", fileCount: 3 })]);
    } else {
      await ctx.storage.put(`${job.payload.outputPrefix}partial.html`, "x", "text/html");
      await ctx.db.query("UPDATE jobs SET status='failed',error='ERROR: render failed',finished_at=now() WHERE id=$1", [job.id]);
    }
    await ctx.finalizer.drain();
  }

  let deck: { id: string; slug: string; versionId: string };

  it("creates a deck, uploads the ZIP and enqueues a render job", async () => {
    const response = await upload("/api/slides", member.cookie, { title: "Week 1", slug: "week-1", public: "false" }, deckZip());
    expect(response.statusCode).toBe(202);
    const body = json(response);
    deck = { id: body.id, slug: "week-1", versionId: body.versionId };
    expect(body).toMatchObject({ slug: "week-1", version: 1, entry: "index.qmd" });
    const job = await jobFor(deck.versionId);
    expect(job).toMatchObject({ kind: "slide_render", status: "queued" });
    expect(job.payload).toEqual({
      projectId: deck.id,
      versionId: deck.versionId,
      sourceKey: `slides/${deck.id}/${deck.versionId}/source.zip`,
      entry: "index.qmd",
      outputPrefix: `slides/${deck.id}/${deck.versionId}/output/`,
      sourceType: "quarto",
    });
    const stored = await ctx.storage.getBuffer(job.payload.sourceKey);
    expect(stored?.subarray(0, 4).toString("hex")).toBe("504b0304");
    const status = json(await get(`/api/slides/${deck.id}/status`, member.cookie));
    expect(status).toMatchObject({ status: "queued", version: 1 });
  });

  it("rejects bad uploads", async () => {
    expect((await upload("/api/slides", professor.cookie, { title: "P", slug: "p" }, deckZip())).statusCode).toBe(403);
    expect((await upload("/api/slides", member.cookie, { title: "Dup", slug: "week-1" }, deckZip())).statusCode).toBe(409);
    expect((await upload("/api/slides", member.cookie, { title: "Bad", slug: "Bad Slug" }, deckZip())).statusCode).toBe(400);
    const traversal = await upload("/api/slides", member.cookie, { title: "T", slug: "t" }, makeZip([{ name: "index.qmd" }, { name: "x.sh", data: "rm -rf /" }]));
    expect(traversal.statusCode).toBe(400);
    expect(json(traversal).error).toMatch(/不支援檔案類型/);
    const multi = await upload("/api/slides", member.cookie, { title: "M", slug: "multi" }, makeZip([{ name: "a.qmd" }, { name: "b.qmd" }]));
    expect(json(multi).error).toMatch(/多個 QMD/);
    const chosen = await upload("/api/slides", member.cookie, { title: "M", slug: "multi", entry: "b.qmd" }, makeZip([{ name: "a.qmd" }, { name: "b.qmd" }]));
    expect(chosen.statusCode).toBe(202);
    expect(json(chosen).entry).toBe("b.qmd");
    expect((await upload("/api/slides", member.cookie, { title: "N", slug: "notzip" }, deckZip(), "deck.tar")).statusCode).toBe(400);
    const csrf = multipart({ title: "x", slug: "csrf" }, { filename: "d.zip", data: deckZip() });
    const forged = await ctx.app.inject({ method: "POST", url: "/api/slides", headers: { origin: "https://evil.example", cookie: member.cookie, ...csrf.headers }, payload: csrf.payload });
    expect(forged.statusCode).toBe(403);
    expect((await get("/api/slides")).statusCode).toBe(401);
  });

  it("publishes on success and notifies the uploader", async () => {
    await completeJob(deck.versionId);
    const detail = json(await get(`/api/slides/${deck.id}`, member.cookie));
    expect(detail.project.active_version_id).toBe(deck.versionId);
    expect(detail.versions[0]).toMatchObject({ status: "published", is_active: true, quarto_version: "1.10.19", uploader_name: "Member A" });
    expect(detail.versions[0].published_at).toBeTruthy();
    expect(detail.project.creator_name).toBe("Member A");
    expect(detail.limits).toEqual({ zipBytes: expect.any(Number), deckBytes: expect.any(Number), deckTypes: [".zip", ".pdf", ".pptx"], referenceBytes: expect.any(Number) });
    expect(detail.viewUrl).toMatch(new RegExp(`^/api/slides/view/week-1/t\\.\\d{10}\\.[\\w-]{43}/${deck.versionId}/index\\.html$`));
    expect(detail.project.share_key).toBeTruthy();
    expect(detail.permissions).toEqual({ manage: true, review: false, reply: false });
    const notes = await ctx.db.query("SELECT kind,title,url FROM notifications WHERE user_id=$1", [member.id]);
    expect(notes.rows).toContainEqual({ kind: "slide", title: "簡報編譯完成", url: "/slides/play/week-1" });
    const asProfessor = json(await get(`/api/slides/${deck.id}`, professor.cookie));
    expect(asProfessor.project.share_key).toBeNull();
    expect(asProfessor.permissions.review).toBe(true);
  });

  it("keeps a newer published version active and handles failure + retry", async () => {
    const v2 = json(await upload(`/api/slides/${deck.id}/versions`, member.cookie, {}, deckZip()));
    const v3 = json(await upload(`/api/slides/${deck.id}/versions`, member.cookie, {}, deckZip()));
    expect([v2.version, v3.version]).toEqual([2, 3]);
    await completeJob(v3.versionId);
    await completeJob(v2.versionId);
    let detail = json(await get(`/api/slides/${deck.id}`, member.cookie));
    expect(detail.project.active_version_id).toBe(v3.versionId);

    const v4 = json(await upload(`/api/slides/${deck.id}/versions`, member.cookie, {}, deckZip()));
    const failedJob = await jobFor(v4.versionId);
    await completeJob(v4.versionId, false);
    detail = json(await get(`/api/slides/${deck.id}`, member.cookie));
    expect(detail.versions[0]).toMatchObject({ version: 4, status: "failed", error: "ERROR: render failed" });
    expect(detail.project.active_version_id).toBe(v3.versionId);
    expect(await ctx.storage.get(`${failedJob.payload.outputPrefix}partial.html`)).toBeNull();

    const retry = await write("POST", `/api/slides/${deck.id}/render`, member.cookie);
    expect(retry.statusCode).toBe(202);
    expect(json(retry).versionId).toBe(v4.versionId);
    expect((await jobFor(v4.versionId)).id).not.toBe(failedJob.id);
    expect(json(await get(`/api/slides/${deck.id}/status`, member.cookie)).status).toBe("queued");
    expect((await write("POST", `/api/slides/${deck.id}/render`, member.cookie)).statusCode).toBe(404);

    // Switch active back to v1, delete rules.
    expect((await write("PATCH", `/api/slides/${deck.id}/versions/${deck.versionId}`, member.cookie, { active: true })).statusCode).toBe(200);
    expect((await write("PATCH", `/api/slides/${deck.id}/versions/${v4.versionId}`, member.cookie, { active: true })).statusCode).toBe(404);
    expect((await write("DELETE", `/api/slides/${deck.id}/versions/${deck.versionId}`, member.cookie)).statusCode).toBe(409);
    const v2Prefix = (await jobFor(v2.versionId)).payload.outputPrefix;
    expect((await write("DELETE", `/api/slides/${deck.id}/versions/${v2.versionId}`, member.cookie)).statusCode).toBe(200);
    expect(await ctx.storage.get(`${v2Prefix}index.html`)).toBeNull();
    // v4's retry job was cancelled when deleted.
    const v4Job = await jobFor(v4.versionId);
    expect((await write("DELETE", `/api/slides/${deck.id}/versions/${v4.versionId}`, member.cookie)).statusCode).toBe(200);
    expect((await ctx.db.query("SELECT status FROM jobs WHERE id=$1", [v4Job.id])).rows[0].status).toBe("cancelled");
  });

  it("serves deck assets by capability with sandbox headers", async () => {
    const detail = json(await get(`/api/slides/${deck.id}`, member.cookie));
    const viewUrl: string = detail.viewUrl;
    const html = await get(viewUrl);
    expect(html.statusCode).toBe(200);
    expect(html.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(html.headers["content-security-policy"]).toMatch(/^sandbox allow-scripts allow-pointer-lock allow-presentation;.*frame-ancestors http:\/\/hub\.test$/);
    expect(html.headers["cache-control"]).toBe("private, no-store");
    expect(html.headers["x-content-type-options"]).toBe("nosniff");
    expect(html.headers["referrer-policy"]).toBe("no-referrer");
    expect(html.body).toContain("<head><script>(function(){function m()");
    expect(html.body).toContain("Reveal.initialize({scrollActivationWidth:0,postMessage:true,postMessageEvents:true,hash:true})");

    const base = viewUrl.replace(/index\.html$/, "");
    expect((await get(base)).body).toContain("scrollActivationWidth");
    const asset = await get(`${base}index_files/app.js`);
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["content-type"]).toBe("application/javascript; charset=utf-8");
    expect(asset.headers["access-control-allow-origin"]).toBeUndefined();
    // Web fonts load in CORS mode from the opaque-origin sandbox (`Origin: null`).
    const fromSandbox = await get(`${base}index_files/app.js`, undefined, { origin: "null" });
    expect(fromSandbox.headers["access-control-allow-origin"]).toBe("null");
    expect((await get(`${base}index_files/app.js`, undefined, { origin: "https://evil.example" })).headers["access-control-allow-origin"]).toBeUndefined();
    const ranged = await get(`${base}index_files/app.js`, undefined, { range: "bytes=0-6" });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.body).toBe("console");

    expect((await get(`${base}slides.pdf`)).statusCode).toBe(400);
    expect((await get(`${base}..%2F..%2Fsource.zip`)).statusCode).toBe(400);
    // Encoded dot segments are either normalised away by the URL parser or rejected; never served.
    expect([400, 404]).toContain((await get(`${base}a/%2e%2e/%2e%2e/source.zip`)).statusCode);
    expect((await get(`${base}missing.js`)).statusCode).toBe(404);

    const tampered = viewUrl.replace(/\/t\.(\d+)\.([\w-]{43})\//, (_m, exp) => `/t.${exp}.${"A".repeat(43)}/`);
    expect((await get(tampered)).statusCode).toBe(404);
    const expired = viewToken(ctx.config.AUTH_SECRET, deck.id, deck.versionId, Date.now() - 13 * 3600_000);
    expect((await get(`/api/slides/view/week-1/${expired}/${deck.versionId}/index.html`)).statusCode).toBe(404);
    const otherVersion = viewUrl.replace(deck.versionId, crypto.randomUUID());
    expect((await get(otherVersion)).statusCode).toBe(404);
    expect((await get(`/api/slides/view/week-1/public/${deck.versionId}/index.html`)).statusCode).toBe(404);
    expect((await get(`/api/slides/view/week-1/${detail.project.share_key}/${deck.versionId}/index.html`)).statusCode).toBe(200);
  });

  it("controls anonymous access: denied, public, share key, share cookie", async () => {
    expect((await get("/api/slides/by-slug/week-1")).statusCode).toBe(404);
    expect((await get(`/api/slides/pdf/week-1/${deck.versionId}`)).statusCode).toBe(404);
    const shareKey = json(await get(`/api/slides/${deck.id}`, member.cookie)).project.share_key as string;

    const withKey = await get(`/api/slides/by-slug/week-1?key=${encodeURIComponent(shareKey)}`);
    expect(withKey.statusCode).toBe(200);
    expect(json(withKey).project.share_key).toBeNull();
    expect(json(withKey).permissions).toEqual({ manage: false, review: false, reply: false });

    expect((await get("/api/slides/share/week-1/wrong")).statusCode).toBe(404);
    const share = await get(`/api/slides/share/week-1/${encodeURIComponent(shareKey)}`);
    expect(share.statusCode).toBe(302);
    expect(share.headers.location).toBe("/slides/play/week-1");
    const cookie = share.cookies.find(c => c.name === "slide_share_week-1")!;
    expect(cookie).toMatchObject({ httpOnly: true, path: "/", sameSite: "Lax" });
    const viaCookie = await get("/api/slides/by-slug/week-1", `slide_share_week-1=${encodeURIComponent(cookie.value)}`);
    expect(viaCookie.statusCode).toBe(200);
    expect(json(viaCookie).viewUrl).toBeTruthy();

    // Rotating the share key invalidates the cookie.
    expect((await write("PATCH", `/api/slides/${deck.id}`, member.cookie, { rotateShareKey: true })).statusCode).toBe(200);
    expect((await get("/api/slides/by-slug/week-1", `slide_share_week-1=${encodeURIComponent(cookie.value)}`)).statusCode).toBe(404);

    expect((await write("PATCH", `/api/slides/${deck.id}`, member.cookie, { public_view: true })).statusCode).toBe(200);
    const pub = await get("/api/slides/by-slug/week-1");
    expect(pub.statusCode).toBe(200);
    expect((await get(`/api/slides/view/week-1/public/${deck.versionId}/index.html`)).statusCode).toBe(200);
    await write("PATCH", `/api/slides/${deck.id}`, member.cookie, { public_view: false });
  });

  it("streams the PDF", async () => {
    const pdf = await get(`/api/slides/pdf/week-1/${deck.versionId}`, professor.cookie);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.headers["content-disposition"]).toBe('attachment; filename="week-1-v1.pdf"');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    const partial = await get(`/api/slides/pdf/week-1/${deck.versionId}`, professor.cookie, { range: "bytes=0-3" });
    expect(partial.statusCode).toBe(206);
    expect(partial.headers["content-range"]).toMatch(/^bytes 0-3\//);
  });

  it("manages references", async () => {
    const pdfBody = multipart({ title: "Paper" }, { filename: "paper.pdf", data: PDF_BYTES, type: "application/pdf" });
    const created = await ctx.app.inject({ method: "POST", url: `/api/slides/${deck.id}/references`, headers: { origin: ORIGIN, cookie: member.cookie, ...pdfBody.headers }, payload: pdfBody.payload });
    expect(created.statusCode).toBe(201);
    const pdfRef = json(created).reference;
    expect(pdfRef).toMatchObject({ title: "Paper", is_default: true, file_name: "paper.pdf" });

    const fake = multipart({ title: "Fake" }, { filename: "fake.pdf", data: Buffer.from("hello world"), type: "application/pdf" });
    expect((await ctx.app.inject({ method: "POST", url: `/api/slides/${deck.id}/references`, headers: { origin: ORIGIN, cookie: member.cookie, ...fake.headers }, payload: fake.payload })).statusCode).toBe(415);
    expect((await write("POST", `/api/slides/${deck.id}/references`, member.cookie, { title: "Bad", url: "javascript:alert(1)" })).statusCode).toBe(400);
    expect((await write("POST", `/api/slides/${deck.id}/references`, professor.cookie, { title: "P", url: "https://a.b" })).statusCode).toBe(403);
    const link = json(await write("POST", `/api/slides/${deck.id}/references`, member.cookie, { title: "Site", url: "https://example.org/paper" })).reference;
    expect(link.is_default).toBe(false);

    const file = await get(`/api/slides/reference/week-1/${pdfRef.id}`, member.cookie);
    expect(file.statusCode).toBe(200);
    expect(file.headers["content-type"]).toBe("application/pdf");
    expect(file.headers["content-disposition"]).toMatch(/^inline;/);
    const redirect = await get(`/api/slides/reference/week-1/${link.id}`, member.cookie);
    expect(redirect.statusCode).toBe(302);
    expect(redirect.headers.location).toBe("https://example.org/paper");
    expect((await get(`/api/slides/reference/week-1/${pdfRef.id}`)).statusCode).toBe(404);

    expect((await write("PATCH", `/api/slides/${deck.id}/references/${link.id}`, member.cookie, { isDefault: true })).statusCode).toBe(200);
    const fileKey = (await ctx.db.query("SELECT file_key FROM slide_references WHERE id=$1", [pdfRef.id])).rows[0].file_key;
    expect((await write("DELETE", `/api/slides/${deck.id}/references/${link.id}`, member.cookie)).statusCode).toBe(200);
    const refs = json(await get(`/api/slides/${deck.id}`, member.cookie)).references;
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ id: pdfRef.id, is_default: true, kind: "file", href: `/api/slides/reference/week-1/${pdfRef.id}` });
    expect((await write("DELETE", `/api/slides/${deck.id}/references/${pdfRef.id}`, member.cookie)).statusCode).toBe(200);
    expect(await ctx.storage.get(fileKey)).toBeNull();
  });

  it("allows professor/owner reviews and owner replies", async () => {
    expect((await write("POST", `/api/slides/${deck.id}/reviews`, member.cookie, { body: "x" })).statusCode).toBe(403);
    const review = await write("POST", `/api/slides/${deck.id}/reviews`, professor.cookie, { body: "Fix figure 2" });
    expect(review.statusCode).toBe(201);
    const reviewId = json(review).review.id;
    expect((await write("POST", `/api/slides/${deck.id}/reviews`, professor.cookie, { body: "" })).statusCode).toBe(400);
    expect((await write("POST", `/api/slides/${deck.id}/reviews`, owner.cookie, { body: "Owner note" })).statusCode).toBe(201);
    expect((await write("POST", `/api/slides/${deck.id}/reviews/${reviewId}/replies`, professor.cookie, { body: "x" })).statusCode).toBe(403);
    expect((await write("POST", `/api/slides/${deck.id}/reviews/${reviewId}/replies`, member.cookie, { body: "x" })).statusCode).toBe(403);
    const replied = await write("POST", `/api/slides/${deck.id}/reviews/${reviewId}/replies`, owner.cookie, { body: "Done" });
    expect(replied.statusCode).toBe(201);
    expect((await write("POST", `/api/slides/${deck.id}/reviews/${crypto.randomUUID()}/replies`, owner.cookie, { body: "Done" })).statusCode).toBe(404);

    const detail = json(await get(`/api/slides/${deck.id}`, member.cookie));
    expect(detail.reviews[0]).toMatchObject({ body: "Fix figure 2", author: "Prof Lee", replies: [{ body: "Done" }] });
    const memberNotes = (await ctx.db.query("SELECT title FROM notifications WHERE user_id=$1", [member.id])).rows.map(r => r.title);
    expect(memberNotes).toContain("Prof Lee 新增了簡報審閱");
    const profNotes = (await ctx.db.query("SELECT title FROM notifications WHERE user_id=$1", [professor.id])).rows;
    expect(profNotes).toHaveLength(1);
  });

  it("lists decks with tag and text filters", async () => {
    const tag = (await ctx.db.query<{ id: string }>("INSERT INTO slide_tags(name) VALUES('Paper') RETURNING id")).rows[0]!.id;
    expect((await write("PATCH", `/api/slides/${deck.id}`, member.cookie, { tagIds: [tag], title: "Week One" })).statusCode).toBe(200);
    const all = json(await get("/api/slides", professor.cookie)).slides;
    expect(all.length).toBeGreaterThanOrEqual(2);
    const tagged = json(await get(`/api/slides?tags=${tag}`, member.cookie)).slides;
    expect(tagged.map((s: any) => s.id)).toEqual([deck.id]);
    expect(tagged[0]).toMatchObject({ title: "Week One", tags: [{ id: tag, name: "Paper" }], active_version: 1, reference_count: 0, author_name: "Member A" });
    expect(typeof tagged[0].review_count).toBe("number");
    expect(tagged[0].published_at).toBeTruthy();
    const untagged = json(await get("/api/slides?tags=none", member.cookie)).slides;
    expect(untagged.some((s: any) => s.id === deck.id)).toBe(false);
    expect(json(await get("/api/slides?tags=", member.cookie)).slides).toEqual([]);
    expect(json(await get("/api/slides?q=one", member.cookie)).slides.map((s: any) => s.id)).toEqual([deck.id]);
    expect(json(await get("/api/slides?q=%25", member.cookie)).slides).toEqual([]);
    expect((await write("PATCH", `/api/slides/${deck.id}`, member.cookie, { slug: "multi" })).statusCode).toBe(409);
  });

  it("deletes a deck and its storage", async () => {
    const keysBefore = (await ctx.db.query<{ output_prefix: string; source_key: string }>("SELECT output_prefix,source_key FROM slide_versions WHERE project_id=$1", [deck.id])).rows;
    expect(keysBefore.length).toBeGreaterThan(0);
    expect((await write("DELETE", `/api/slides/${deck.id}`, professor.cookie)).statusCode).toBe(403);
    expect((await write("DELETE", `/api/slides/${deck.id}`, member.cookie)).statusCode).toBe(200);
    for (const row of keysBefore) {
      expect(await ctx.storage.get(row.source_key)).toBeNull();
      expect(await ctx.storage.get(`${row.output_prefix}index.html`)).toBeNull();
    }
    expect((await get(`/api/slides/${deck.id}`, member.cookie)).statusCode).toBe(404);
    expect((await write("DELETE", `/api/slides/${deck.id}`, member.cookie)).statusCode).toBe(404);
  });

  it("cleans up output of jobs whose version disappeared", async () => {
    const created = json(await upload("/api/slides", member.cookie, { title: "Gone", slug: "gone" }, deckZip()));
    const job = await jobFor(created.versionId);
    await ctx.db.query("UPDATE jobs SET status='running' WHERE id=$1", [job.id]);
    expect((await write("DELETE", `/api/slides/${created.id}`, member.cookie)).statusCode).toBe(200);
    expect((await ctx.db.query("SELECT cancel_requested FROM jobs WHERE id=$1", [job.id])).rows[0].cancel_requested).toBe(true);
    // Worker finishes anyway and writes output after deletion.
    await ctx.storage.put(`${job.payload.outputPrefix}index.html`, "late", "text/html");
    await ctx.db.query("UPDATE jobs SET status='cancelled',finished_at=now() WHERE id=$1", [job.id]);
    await ctx.finalizer.drain();
    expect(await ctx.storage.get(`${job.payload.outputPrefix}index.html`)).toBeNull();
    expect((await ctx.db.query("SELECT finalized_at FROM jobs WHERE id=$1", [job.id])).rows[0].finalized_at).not.toBeNull();
  });
});
