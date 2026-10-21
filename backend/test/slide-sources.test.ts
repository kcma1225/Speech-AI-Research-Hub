import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LightMyRequestResponse } from "fastify";
import { createTestContext, hasTestDb, hasTestS3, ORIGIN, type TestContext } from "./helpers.js";
import { multipart, PDF_BYTES, userSession } from "./slides-fixtures.js";
import { addStudyMember, insertStudy } from "./study-fixtures.js";
import { runSlidesGenerate, type SlidesGeneratePayload } from "../src/ai-jobs/slides/generate.js";
import type { AiJobContext } from "../src/ai-worker/registry.js";
import { scanZip } from "../src/lib/slides/zip-validate.js";
import type { SlidePreviewPayload } from "../src/lib/slides/preview.js";

const run = hasTestDb && hasTestS3 ? describe : describe.skip;
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(64, 1)]);

run("slide sources, previews, publish and AI drafts", () => {
  let ctx: TestContext;
  let member: { id: string; cookie: string };
  let advisor: { id: string; cookie: string };
  let admin: { id: string; cookie: string };
  let outsider: { id: string; cookie: string };
  let study: { id: string; slug: string };
  const json = (response: LightMyRequestResponse) => response.json() as Record<string, any>;
  const write = (method: "POST" | "PATCH" | "DELETE" | "PUT", url: string, cookie: string, payload?: unknown) =>
    ctx.app.inject({ method, url, headers: { origin: ORIGIN, cookie }, ...(payload === undefined ? {} : { payload: payload as object }) });
  const get = (url: string, cookie?: string) => ctx.app.inject({ method: "GET", url, headers: cookie ? { cookie } : {} });

  beforeAll(async () => {
    ctx = await createTestContext();
    member = await userSession(ctx.db, "student", "林雅婷");
    advisor = await userSession(ctx.db, "professor", "王教授");
    admin = await userSession(ctx.db, "admin", "Admin");
    outsider = await userSession(ctx.db, "student", "Outsider");
    study = await insertStudy(ctx.db, member.id, "語音辨識研究");
    await addStudyMember(ctx.db, study.id, advisor.id, "advisor");
  });
  afterAll(async () => {
    await ctx?.close();
  });

  /** Plays the worker for a preview job: writes output and finishes the job, then runs the finalizer. */
  async function finishPreview(jobId: string, ok = true) {
    const job = (await ctx.db.query<{ payload: SlidePreviewPayload }>("SELECT payload FROM jobs WHERE id=$1", [jobId])).rows[0]!;
    if (ok) {
      await ctx.storage.put(`${job.payload.outputPrefix}index.html`, "<html><head></head><body><script>Reveal.initialize({hash:true})</script></body></html>", "text/html");
      await ctx.storage.put(`${job.payload.outputPrefix}index_files/libs/app.js`, "1", "application/javascript");
      await ctx.db.query("UPDATE jobs SET status='succeeded',progress=100,finished_at=now(),result=$2 WHERE id=$1", [jobId, JSON.stringify({ entryHtml: "index.html", fileCount: 2, quartoVersion: "1.10.19" })]);
    } else {
      await ctx.db.query("UPDATE jobs SET status='failed',error='ERROR: YAML parse error',finished_at=now() WHERE id=$1", [jobId]);
    }
    await ctx.finalizer.drain();
    return job.payload;
  }

  let deckId: string;
  let entry: { id: string; version: number };

  it("creates an editable progress deck from the Lab-Hub template (members only)", async () => {
    const denied = await write("POST", "/api/slides", advisor.cookie, { studyId: study.slug, title: "第 3 週進度", kind: "progress" });
    expect(denied.statusCode).toBe(403);
    expect((await write("POST", "/api/slides", outsider.cookie, { studyId: study.id, title: "x" })).statusCode).toBe(403);
    expect((await write("POST", "/api/slides", admin.cookie, { studyId: study.id, title: "x" })).statusCode).toBe(403);

    const response = await write("POST", "/api/slides", member.cookie, { studyId: study.slug, title: "第 3 週進度", kind: "progress" });
    expect(response.statusCode).toBe(201);
    const body = json(response);
    deckId = body.id;
    expect(body.slug).toMatch(/^deck-3-\d{6}$/);
    expect(body.template).toBe("progress");

    const source = json(await get(`/api/slides/${deckId}/source`, outsider.cookie));
    expect(source.permissions.edit).toBe(false);
    expect(source.source).toMatchObject({ entry: "index.qmd", origin: "progress", revision: 1 });
    expect(source.files).toHaveLength(1);
    const qmd = source.files[0].content as string;
    expect(qmd).toContain('title: "第 3 週進度"');
    expect(qmd).toContain('author: "林雅婷"');
    expect(qmd).toContain("width: 1280");
    expect(qmd.match(/^## /gm)).toHaveLength(8);
    entry = { id: source.files[0].id, version: source.files[0].version };

    const detail = json(await get(`/api/slides/${deckId}`, member.cookie));
    expect(detail.project.source).toEqual({ revision: 1, published_revision: null });
    const list = json(await get(`/api/slides?studyId=${study.id}&kind=progress`, member.cookie));
    expect(list.slides.map((s: any) => [s.id, s.has_source])).toEqual([[deckId, true]]);
    expect(json(await get(`/api/slides?studyId=${study.id}&kind=paper_report`, member.cookie)).slides).toHaveLength(0);
  });

  it("creates a paper report with free-text paper metadata", async () => {
    const response = await write("POST", "/api/slides", member.cookie, {
      studyId: study.id, title: "Conformer 報告", kind: "paper_report", paper: { title: "Conformer: Convolution-augmented Transformer", url: "https://arxiv.org/abs/2005.08100" },
    });
    expect(response.statusCode).toBe(201);
    const id = json(response).id;
    const detail = json(await get(`/api/slides/${id}`, member.cookie));
    expect(detail.project.metadata.paper.title).toContain("Conformer");
    const qmd = json(await get(`/api/slides/${id}/source`, member.cookie)).files[0].content as string;
    expect(qmd.match(/^## /gm)).toHaveLength(13);
    expect(qmd).toContain('title: "Conformer: Convolution-augmented Transformer"');
    expect((await write("POST", "/api/slides", member.cookie, { studyId: study.id, title: "x", kind: "paper_report", paper: { title: "t", url: "javascript:alert(1)" } })).statusCode).toBe(400);
    const patched = await write("PATCH", `/api/slides/${id}`, member.cookie, { paper: null });
    expect(json(patched).project.metadata).toEqual({});
  });

  it("saves text files with optimistic versions and validates paths", async () => {
    const url = `/api/slides/${deckId}/source/files`;
    const saved = await write("PUT", url, member.cookie, { path: "index.qmd", content: "---\ntitle: t\n---\n\n## A\n\nhello\n", baseVersion: entry.version });
    expect(saved.statusCode).toBe(200);
    expect(json(saved)).toMatchObject({ revision: 2, file: { path: "index.qmd", version: 2 } });
    const stale = await write("PUT", url, member.cookie, { path: "index.qmd", content: "x", baseVersion: entry.version });
    expect(stale.statusCode).toBe(409);
    expect((await write("PUT", url, advisor.cookie, { path: "index.qmd", content: "x" })).statusCode).toBe(403);
    for (const bad of ["../x.qmd", "/abs.qmd", "a\\b.qmd", "_hub/x.css", ".env", "run.exe", "a/./b.md", "_site/x.md"]) {
      expect((await write("PUT", url, member.cookie, { path: bad, content: "x" })).statusCode, bad).toBe(400);
    }
    expect((await write("PUT", url, member.cookie, { path: "img.png", content: "x" })).statusCode).toBe(400);
    const css = json(await write("PUT", url, member.cookie, { path: "styles/custom.css", content: ".reveal{}" }));
    expect(css.file).toMatchObject({ path: "styles/custom.css", kind: "text", version: 1 });
    // Unchanged content does not bump the revision.
    const same = json(await write("PUT", url, member.cookie, { path: "styles/custom.css", content: ".reveal{}" }));
    expect(same.revision).toBe(css.revision);
  });

  it("uploads, serves, renames and deletes binary files", async () => {
    const body = multipart({}, { filename: "fig 1.png", data: PNG, type: "image/png" });
    const uploaded = await ctx.app.inject({ method: "POST", url: `/api/slides/${deckId}/source/files`, headers: { origin: ORIGIN, cookie: member.cookie, ...body.headers }, payload: body.payload });
    expect(uploaded.statusCode).toBe(201);
    const file = json(uploaded).file;
    expect(file).toMatchObject({ path: "images/fig-1.png", kind: "binary", bytes: PNG.length, content_type: "image/png" });
    const raw = await get(`/api/slides/${deckId}/source/files/${file.id}/raw`, outsider.cookie);
    expect(raw.statusCode).toBe(200);
    expect(raw.headers["content-security-policy"]).toContain("sandbox");
    expect(raw.rawPayload.equals(PNG)).toBe(true);
    expect((await get(`/api/slides/${deckId}/source/files/${file.id}/raw`)).statusCode).toBe(401);

    const renamed = await write("PATCH", `/api/slides/${deckId}/source/files/${file.id}`, member.cookie, { path: "figs/problem.png" });
    expect(json(renamed).file.path).toBe("figs/problem.png");
    expect((await write("PATCH", `/api/slides/${deckId}/source/files/${file.id}`, member.cookie, { path: "figs/problem.md" })).statusCode).toBe(400);
    expect((await write("DELETE", `/api/slides/${deckId}/source/files/${entry.id}`, member.cookie)).statusCode).toBe(400);
    const other = json(await write("PUT", `/api/slides/${deckId}/source/files`, member.cookie, { path: "notes.md", content: "x" })).file;
    expect((await write("DELETE", `/api/slides/${deckId}/source/files/${other.id}`, advisor.cookie)).statusCode).toBe(403);
    expect((await write("DELETE", `/api/slides/${deckId}/source/files/${other.id}`, member.cookie)).statusCode).toBe(200);
    expect(json(await get(`/api/slides/${deckId}/source`, member.cookie)).files.map((f: any) => f.path)).toEqual(["figs/problem.png", "index.qmd", "styles/custom.css"]);
  });

  let readyPreview: { id: string; viewUrl: string };

  it("queues low-priority previews, reuses one per revision and serves the ready render by capability", async () => {
    expect((await write("POST", `/api/slides/${deckId}/source/preview`, advisor.cookie)).statusCode).toBe(403);
    const first = await write("POST", `/api/slides/${deckId}/source/preview`, member.cookie);
    expect(first.statusCode).toBe(202);
    const latest = json(first).preview.latest;
    expect(latest.status).toBe("queued");
    const job = (await ctx.db.query<{ id: string; kind: string; created_by: string | null; payload: SlidePreviewPayload; max_attempts: number }>(
      "SELECT j.id,j.kind,j.created_by,j.payload,j.max_attempts FROM jobs j JOIN deck_previews p ON p.job_id=j.id WHERE p.id=$1", [latest.id],
    )).rows[0]!;
    expect(job).toMatchObject({ kind: "slide_preview", created_by: null, max_attempts: 1 });
    expect(job.payload).toEqual({
      deckId, previewId: latest.id, entry: "index.qmd",
      sourceKey: `slides/${deckId}/preview/${latest.id}/source.zip`,
      outputPrefix: `slides/${deckId}/preview/${latest.id}/output/`,
    });
    const zip = await ctx.storage.getBuffer(job.payload.sourceKey);
    const dir = await mkdtemp(path.join(tmpdir(), "slide-src-"));
    try {
      await writeFile(path.join(dir, "s.zip"), zip!);
      const scan = await scanZip(path.join(dir, "s.zip"));
      expect(scan).toMatchObject({ files: 3, qmd: ["index.qmd"] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    // Same revision: the queued preview is reused (no second job).
    const again = await write("POST", `/api/slides/${deckId}/source/preview`, member.cookie);
    expect(again.statusCode).toBe(200);
    expect(json(again).preview.latest.id).toBe(latest.id);
    // Not in the caller's jobs tray.
    expect(json(await get("/api/jobs/active", member.cookie)).jobs.some((j: any) => j.kind === "slide_preview")).toBe(false);

    await finishPreview(job.id);
    const state = json(await get(`/api/slides/${deckId}/source/preview`, outsider.cookie)).preview;
    expect(state.latest).toMatchObject({ id: latest.id, status: "ready", progress: 100 });
    expect(state.ready.viewUrl).toMatch(new RegExp(`^/api/slides/view/[a-z0-9-]+/p\\.\\d{10}\\.[A-Za-z0-9_-]{43}/preview/${latest.id}/index\\.html$`));
    readyPreview = { id: latest.id, viewUrl: state.ready.viewUrl };
    const html = await get(readyPreview.viewUrl);
    expect(html.statusCode).toBe(200);
    expect(html.headers["content-security-policy"]).toContain("sandbox allow-scripts");
    expect(html.body).toContain("postMessage:true");
    expect((await get(readyPreview.viewUrl.replace("index.html", "index_files/libs/app.js"))).body).toBe("1");
    const slug = readyPreview.viewUrl.split("/")[4];
    expect((await get(`/api/slides/view/${slug}/public/preview/${latest.id}/index.html`)).statusCode).toBe(404);
    expect((await get(readyPreview.viewUrl.replace(/p\.\d{10}\.[^/]+/, "p.9999999999.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"))).statusCode).toBe(404);
    // The source ZIP is removed once rendered.
    expect(await ctx.storage.getBuffer(job.payload.sourceKey)).toBeNull();
  });

  it("keeps the last ready preview when a newer one fails, and replaces it when a newer one succeeds", async () => {
    await write("PUT", `/api/slides/${deckId}/source/files`, member.cookie, { path: "index.qmd", content: "---\ntitle: t\n---\n\n## B\n" });
    const failing = json(await write("POST", `/api/slides/${deckId}/source/preview`, member.cookie)).preview.latest;
    const failingJob = (await ctx.db.query<{ job_id: string }>("SELECT job_id FROM deck_previews WHERE id=$1", [failing.id])).rows[0]!.job_id;
    await finishPreview(failingJob, false);
    let state = json(await get(`/api/slides/${deckId}/source/preview`, member.cookie)).preview;
    expect(state.latest).toMatchObject({ id: failing.id, status: "failed" });
    expect(state.latest.error).toContain("YAML");
    expect(state.ready.id).toBe(readyPreview.id);

    await write("PUT", `/api/slides/${deckId}/source/files`, member.cookie, { path: "index.qmd", content: "---\ntitle: t\n---\n\n## C\n" });
    const next = json(await write("POST", `/api/slides/${deckId}/source/preview`, member.cookie)).preview.latest;
    const nextJob = (await ctx.db.query<{ job_id: string }>("SELECT job_id FROM deck_previews WHERE id=$1", [next.id])).rows[0]!.job_id;
    await finishPreview(nextJob);
    state = json(await get(`/api/slides/${deckId}/source/preview`, member.cookie)).preview;
    expect(state.ready.id).toBe(next.id);
    const rows = (await ctx.db.query<{ id: string }>("SELECT id FROM deck_previews WHERE deck_id=$1", [deckId])).rows.map(r => r.id);
    expect(rows).toEqual([next.id]);
    expect((await get(readyPreview.viewUrl)).statusCode).toBe(404);
    expect(await ctx.storage.getBuffer(`slides/${deckId}/preview/${readyPreview.id}/output/index.html`)).toBeNull();
  });

  it("cancels an older queued preview when a newer revision is queued", async () => {
    await write("PUT", `/api/slides/${deckId}/source/files`, member.cookie, { path: "index.qmd", content: "---\ntitle: t\n---\n\n## D\n" });
    const older = json(await write("POST", `/api/slides/${deckId}/source/preview`, member.cookie)).preview.latest;
    await write("PUT", `/api/slides/${deckId}/source/files`, member.cookie, { path: "index.qmd", content: "---\ntitle: t\n---\n\n## E\n" });
    const newer = json(await write("POST", `/api/slides/${deckId}/source/preview`, member.cookie)).preview.latest;
    const jobs = (await ctx.db.query<{ id: string; status: string }>("SELECT p.id,j.status FROM deck_previews p JOIN jobs j ON j.id=p.job_id WHERE p.id=ANY($1::uuid[])", [[older.id, newer.id]])).rows;
    expect(Object.fromEntries(jobs.map(j => [j.id, j.status]))).toEqual({ [older.id]: "cancelled", [newer.id]: "queued" });
    await ctx.finalizer.drain();
    expect((await ctx.db.query("SELECT status FROM deck_previews WHERE id=$1", [older.id])).rows[0]?.status).toBe("cancelled");
  });

  it("publishes the tree as a Quarto version through the normal render job", async () => {
    expect((await write("POST", `/api/slides/${deckId}/source/publish`, advisor.cookie)).statusCode).toBe(403);
    const response = await write("POST", `/api/slides/${deckId}/source/publish`, member.cookie);
    expect(response.statusCode).toBe(202);
    const body = json(response);
    expect(body).toMatchObject({ version: 1, sourceType: "quarto", entry: "index.qmd" });
    const job = (await ctx.db.query<{ kind: string; payload: any; created_by: string }>("SELECT kind,payload,created_by FROM jobs WHERE id=$1", [body.jobId])).rows[0]!;
    expect(job).toMatchObject({ kind: "slide_render", created_by: member.id });
    expect(job.payload).toMatchObject({ projectId: deckId, versionId: body.versionId, entry: "index.qmd", sourceType: "quarto" });
    expect((await ctx.storage.getBuffer(job.payload.sourceKey))?.subarray(0, 2).toString()).toBe("PK");
    const tree = json(await get(`/api/slides/${deckId}/source`, member.cookie)).source;
    expect(tree.published_revision).toBe(body.revision);
    const versions = json(await get(`/api/slides/${deckId}/versions`, member.cookie)).versions;
    expect(versions[0]).toMatchObject({ version: 1, sourceType: "quarto", status: "queued" });
  });

  it("starts editing an uploaded deck from a template, and changes the entry", async () => {
    const created = json(await write("POST", "/api/slides", member.cookie, { studyId: study.id, title: "Blank deck", kind: "progress", template: "blank" }));
    expect((await write("POST", `/api/slides/${created.id}/source`, member.cookie, { template: "blank" })).statusCode).toBe(409);
    await ctx.db.query("DELETE FROM deck_source_trees WHERE deck_id=$1", [created.id]);
    expect((await write("POST", `/api/slides/${created.id}/source`, advisor.cookie, { template: "progress" })).statusCode).toBe(403);
    expect((await write("POST", `/api/slides/${created.id}/source`, member.cookie, { template: "progress" })).statusCode).toBe(201);
    await write("PUT", `/api/slides/${created.id}/source/files`, member.cookie, { path: "talk.qmd", content: "## x\n" });
    expect((await write("PATCH", `/api/slides/${created.id}/source`, member.cookie, { entry: "missing.qmd" })).statusCode).toBe(400);
    expect(json(await write("PATCH", `/api/slides/${created.id}/source`, member.cookie, { entry: "talk.qmd" })).entry).toBe("talk.qmd");
  });

  it("refuses AI drafts while the slides role is unavailable", async () => {
    const response = await write("POST", `/api/slides/${deckId}/ai/generate`, member.cookie, {});
    expect(response.statusCode).toBe(503);
    expect(json(response)).toMatchObject({ code: "llm_unavailable" });
    expect((await write("POST", `/api/slides/${deckId}/ai/generate`, advisor.cookie, {})).statusCode).toBe(403);
    expect(json(await get(`/api/slides/${deckId}/ai/generate`, outsider.cookie))).toEqual({ job: null });
  });

  /** AiJobContext with a scripted model: each call returns the next reply, streamed in small chunks. */
  function aiContext(payload: SlidesGeneratePayload, replies: (string | { text: string; stop: string })[], seen: { messages: any[] }[]) {
    const stages: string[] = [];
    const fakeAi = {
      async capabilities() {
        return { vision: false };
      },
      async *chatStream(role: string, request: { messages: any[] }) {
        expect(role).toBe("slides");
        seen.push({ messages: request.messages });
        const next = replies.shift() ?? "";
        const { text, stop } = typeof next === "string" ? { text: next, stop: "end_turn" } : next;
        for (let i = 0; i < text.length; i += 40) yield { type: "text_delta", text: text.slice(i, i + 40) };
        yield { type: "done", stopReason: stop };
      },
    };
    const context = {
      job: { id: "00000000-0000-4000-8000-000000000001", kind: "ai_slides_generate", payload, attempts: 1, maxAttempts: 2, createdBy: payload.userId },
      db: ctx.db, storage: ctx.storage, ai: fakeAi, log: ctx.app.log, signal: new AbortController().signal,
      progress: async (stage: string) => void stages.push(stage), checkpoint: null, saveCheckpoint: async () => {},
    } as unknown as AiJobContext<SlidesGeneratePayload>;
    return { context, stages };
  }

  it("drafts a progress report from study context, validates it with a preview and fixes a failed render once", async () => {
    await ctx.db.query("UPDATE studies SET summary_md='以自監督特徵改善台語辨識。' WHERE id=$1", [study.id]);
    await ctx.db.query("INSERT INTO tasks(study_id,title,status,completed_at,created_by) VALUES($1,'重跑 baseline WER','done',now(),$2)", [study.id, member.id]);
    const created = json(await write("POST", "/api/slides", member.cookie, { studyId: study.id, title: "AI 進度", kind: "progress", source: "ai" }));
    const seen: { messages: any[] }[] = [];
    const broken = "```markdown\n---\ntitle: x\n---\n\n## 問題定義\n\n```{mermaid}\nflowchart LR\n  A[a (b)] --> B\n```\n\n::: {.notes}\n講稿\n:::\n\n## 對帳\n\n- 重跑 baseline WER\n```";
    const fixedBody = "## 問題定義\n\n〔　〕\n\n::: {.notes}\n講稿\n:::\n\n## 對帳\n\n- 重跑 baseline WER\n";
    const notes: any[] = [];
    const { context, stages } = aiContext({ deckId: created.id, userId: member.id, mode: "progress", instructions: "請強調 WER，做 2 頁就好" }, [broken, fixedBody], seen);
    // Fake worker: the first preview render fails, the second succeeds.
    let renders = 0;
    let stopped = false;
    const worker = (async () => {
      while (!stopped) {
        const job = (await ctx.db.query<{ id: string }>("SELECT j.id FROM jobs j JOIN deck_previews p ON p.job_id=j.id WHERE p.deck_id=$1 AND j.status='queued' LIMIT 1", [created.id])).rows[0];
        if (job) await finishPreview(job.id, renders++ > 0);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    })();
    try {
      const result = await runSlidesGenerate(context, { storage: ctx.storage, waitMs: 30_000, notify: async (_db, _payload, outcome) => void notes.push(outcome) });
      expect(result).toMatchObject({ valid: true, fixed: true, pages: 2, expectedPages: 2, publishedVersion: 1 });
      expect(result.partial).toBeUndefined();
    } finally {
      stopped = true;
      await worker;
    }
    expect(stages).toEqual(expect.arrayContaining(["context", "generating", "writing", "validating", "fixing", "publishing"]));
    // A complete draft of a deck without versions is published as v1 (normal render job) and the user is told.
    const versions = (await ctx.db.query<{ version: number; job_id: string }>("SELECT version,job_id FROM slide_versions WHERE deck_id=$1", [created.id])).rows;
    expect(versions.map(v => v.version)).toEqual([1]);
    expect(notes).toEqual([{ ok: true, title: "AI 簡報草稿完成", body: "2 頁，已發布為第 1 版。" }]);
    const prompt = seen[0]!.messages.map((m: any) => m.content).join("\n");
    expect(prompt).toContain("以自監督特徵改善台語辨識");
    expect(prompt).toContain("重跑 baseline WER");
    expect(prompt).toContain("請強調 WER");
    expect(prompt).toContain("<資料>");
    expect(seen[1]!.messages[1].content).toContain("YAML parse error");
    const source = json(await get(`/api/slides/${created.id}/source`, member.cookie));
    expect(source.source.origin).toBe("ai");
    const qmd = source.files.find((f: any) => f.path === "index.qmd").content as string;
    expect(qmd.startsWith('---\ntitle: "AI 進度"')).toBe(true);
    expect(qmd).toContain("width: 1280");
    expect(qmd).toContain("## 對帳");
    expect(qmd).not.toContain("```markdown");
  });

  it("drafts a paper report from deck paper metadata and the reference PDF, as the caller only", async () => {
    const created = json(await write("POST", "/api/slides", member.cookie, {
      studyId: study.id, title: "Paper", kind: "paper_report", paper: { title: "Whisper", abstract: "Robust speech recognition via large-scale weak supervision." },
    }));
    const ref = multipart({ title: "paper.pdf" }, { filename: "paper.pdf", data: PDF_BYTES, type: "application/pdf" });
    await ctx.app.inject({ method: "POST", url: `/api/slides/${created.id}/references`, headers: { origin: ORIGIN, cookie: member.cookie, ...ref.headers }, payload: ref.payload });
    const seen: { messages: any[] }[] = [];
    const { context } = aiContext({ deckId: created.id, userId: member.id, mode: "paper_report" }, ["## One-sentence claim\n\nIn ASR …\n"], seen);
    // One page of 13 (and the continuations bring nothing): fail clearly, keep the template source.
    await expect(runSlidesGenerate(context, { storage: ctx.storage, waitMs: 200, extractText: async () => "WEAK SUPERVISION BODY TEXT", notify: async () => {} })).rejects.toThrow("只產生了 1 / 13 頁");
    expect(seen.length).toBe(2); // the draft + one continuation that returned nothing
    expect(seen[1]!.messages.at(-2)).toMatchObject({ role: "assistant" });
    const kept = json(await get(`/api/slides/${created.id}/source`, member.cookie)).files.find((f: any) => f.path === "index.qmd").content as string;
    expect(kept).not.toContain("In ASR …");
    const prompt = seen[0]!.messages[1].content as string;
    expect(prompt).toContain("Whisper");
    expect(prompt).toContain("large-scale weak supervision");
    expect(prompt).toContain("WEAK SUPERVISION BODY TEXT");
    expect(prompt).toContain("One-sentence claim");

    const denied = aiContext({ deckId: created.id, userId: advisor.id, mode: "paper_report" }, ["## x\n"], []);
    await expect(runSlidesGenerate(denied.context, { storage: ctx.storage, waitMs: 100 })).rejects.toThrow("只有研究成員");
  });

  const slide = (n: number, extra = "") => `## Page ${n}\n\n- point ${n}${extra}\n\n::: {.notes}\n講稿 ${n}\n:::\n`;
  const deckOf = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => slide(from + i)).join("\n");

  it("continues a draft that stopped early (end_turn after 3 of 11 pages, then max_tokens mid-slide)", async () => {
    const created = json(await write("POST", "/api/slides", member.cookie, { studyId: study.id, title: "Paper 11", kind: "paper_report", paper: { title: "Neural biasing", abstract: "Early context injection." } }));
    const seen: { messages: any[] }[] = [];
    const replies = [
      deckOf(1, 3), // stopped early with a normal end (the ChatGPT case)
      { text: `${deckOf(3, 6)}\n## Page 7\n\n- cut off mid`, stop: "max_tokens" }, // repeats page 3, then hits the limit
      deckOf(7, 11),
    ];
    const instructions = "請建立一份 11 頁的論文報告。\n頁面結構：\n1. 標題頁\n2. 動機\n3. 背景\n11. 結論";
    const { context, stages } = aiContext({ deckId: created.id, userId: member.id, mode: "paper_report", instructions }, replies, seen);
    const result = await runSlidesGenerate(context, { storage: ctx.storage, waitMs: 200, notify: async () => {} });
    expect(result).toMatchObject({ pages: 11, expectedPages: 11, continued: 2, valid: null });
    expect(result.partial).toBeUndefined();
    expect(result.publishedVersion).toBeUndefined(); // the preview did not finish: no automatic v1
    expect(stages).toContain("continuing");
    expect(seen[0]!.messages[1].content).toContain("請一次輸出完整的 11 頁");
    expect(seen[0]!.messages[1].content).toContain("優先於上面的規則");
    expect(seen[1]!.messages.at(-1).content).toContain("從第 4 頁接著寫");
    // After max_tokens the cut slide (Page 7) is dropped and rewritten by the next round.
    expect(seen[2]!.messages.at(-2).content).not.toContain("cut off mid");
    expect(seen[2]!.messages.at(-1).content).toContain("從第 7 頁接著寫");
    const qmd = json(await get(`/api/slides/${created.id}/source`, member.cookie)).files.find((f: any) => f.path === "index.qmd").content as string;
    expect((qmd.match(/^## Page \d+$/gm) ?? [])).toEqual(Array.from({ length: 11 }, (_, i) => `## Page ${i + 1}`));
    expect(qmd).not.toContain("cut off mid");
  });

  it("marks a still-short draft partial (written, not published) and tells the user", async () => {
    const created = json(await write("POST", "/api/slides", member.cookie, { studyId: study.id, title: "Paper short", kind: "paper_report", paper: { title: "Short", abstract: "x" } }));
    const notes: any[] = [];
    const { context } = aiContext({ deckId: created.id, userId: member.id, mode: "paper_report", instructions: "11 頁" }, [deckOf(1, 5), deckOf(1, 2), ""], []);
    const result = await runSlidesGenerate(context, { storage: ctx.storage, waitMs: 200, notify: async (_db, _p, o) => void notes.push(o) });
    expect(result).toMatchObject({ pages: 5, expectedPages: 11, partial: true, warning: "AI 只完成了 5 / 11 頁，其餘頁面請在編輯器補上，或重新產生草稿。" });
    expect(notes[0]).toMatchObject({ ok: true, title: "AI 簡報草稿只完成一部分" });
    expect((await ctx.db.query("SELECT 1 FROM slide_versions WHERE deck_id=$1", [created.id])).rowCount).toBe(0);
  });

  it("takes suggestions on a source file (target deck_source) and refuses AI edits while the role is down", async () => {
    const source = json(await get(`/api/slides/${deckId}/source`, member.cookie));
    const file = source.files.find((f: any) => f.path === "index.qmd");
    const proposed = `${file.content}\n## 新的一頁\n`;
    const denied = await write("POST", "/api/suggestions", advisor.cookie, { target_type: "deck_source", target_id: file.id, proposed_text: proposed });
    expect(denied.statusCode).toBe(403);
    const created = await write("POST", "/api/suggestions", member.cookie, { target_type: "deck_source", target_id: file.id, proposed_text: proposed, title: "加一頁" });
    expect(created.statusCode).toBe(201);
    const suggestion = json(created).suggestion;
    expect(suggestion).toMatchObject({ target_type: "deck_source", study_id: study.id, base_version: file.version, pending: 1 });
    expect(suggestion.url).toBe(`/studies/${study.slug}/decks/${deckId}/edit?file=${file.id}`);
    const accepted = await write("POST", `/api/suggestions/${suggestion.id}/accept-all`, member.cookie);
    expect(accepted.statusCode).toBe(200);
    const after = json(await get(`/api/slides/${deckId}/source`, member.cookie));
    const updated = after.files.find((f: any) => f.id === file.id);
    expect(updated.content).toBe(proposed);
    expect(updated.version).toBe(file.version + 1);
    expect(after.source.revision).toBe(source.source.revision + 1);
    // Accepting re-renders the preview (the deck page's draft view), without slowing down the accept request.
    let queued = 0;
    for (let i = 0; i < 40 && !queued; i++) {
      queued = (await ctx.db.query("SELECT 1 FROM deck_previews WHERE deck_id=$1 AND revision=$2", [deckId, after.source.revision])).rowCount ?? 0;
      if (!queued) await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(queued).toBe(1);

    const edit = await write("POST", `/api/slides/${deckId}/source/files/${file.id}/ai-edit`, member.cookie, { instruction: "改成英文" });
    expect(edit.statusCode).toBe(503);
    expect((await write("POST", `/api/slides/${deckId}/source/files/${file.id}/ai-edit`, advisor.cookie, { instruction: "x" })).statusCode).toBe(403);
    // Deleting a file drops its suggestions.
    const other = json(await write("PUT", `/api/slides/${deckId}/source/files`, member.cookie, { path: "extra.md", content: "a\n" })).file;
    await write("POST", "/api/suggestions", member.cookie, { target_type: "deck_source", target_id: other.id, proposed_text: "b\n" });
    await write("DELETE", `/api/slides/${deckId}/source/files/${other.id}`, member.cookie);
    expect((await ctx.db.query("SELECT 1 FROM suggestions WHERE target_id=$1", [other.id])).rowCount).toBe(0);
  });
  it("suggest_deck_edit (agent / MCP) proposes a suggestion on a source file, members only", async () => {
    const mcp = async (cookie: string, name: string, args: object) => {
      const token = json(await write("POST", "/api/agent/mcp-tokens", cookie, { name: "t", scopes: ["read", "suggest"] })).secret as string;
      const r = await ctx.app.inject({ method: "POST", url: "/api/mcp", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } });
      return json(r).result as { isError: boolean; structuredContent: any; content: { text: string }[] };
    };
    const tree = json(await get(`/api/slides/${deckId}/source`, member.cookie));
    const qmd = tree.files.find((f: any) => f.path === tree.source.entry);
    const firstTitle = (qmd.content as string).match(/^## .+$/m)![0];
    const ok = await mcp(member.cookie, "suggest_deck_edit", { deck_id: deckId, edits: [{ before: firstTitle, after: "## QA 改過的標題" }], title: "改標題" });
    expect(ok.isError).toBe(false);
    const suggestionId = ok.structuredContent.suggestion_id;
    const row = (await ctx.db.query("SELECT target_type,target_id,status FROM suggestions WHERE id=$1", [suggestionId])).rows[0];
    expect(row).toEqual({ target_type: "deck_source", target_id: qmd.id, status: "pending" });
    // The file itself is unchanged until the member accepts.
    expect(json(await get(`/api/slides/${deckId}/source`, member.cookie)).files.find((f: any) => f.id === qmd.id).content).toBe(qmd.content);
    const denied = await mcp(advisor.cookie, "suggest_deck_edit", { deck_id: deckId, content: "x" });
    expect(denied.isError).toBe(true);
    expect(denied.content[0]!.text).toContain("不能修改這份簡報");
    await ctx.db.query("DELETE FROM suggestions WHERE id=$1", [suggestionId]);
  });
});
