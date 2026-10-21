import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { transaction, type Queryable } from "../db.js";
import { requireUser } from "../lib/auth.js";
import { badRequest, conflict, HttpError, isUniqueViolation, notFound, parse } from "../lib/http.js";
import { keys } from "../lib/storage.js";
import { newShareKey, projectById, requireDeckEditor, slideUrls, slugPattern, type SlideProject } from "../lib/slides/access.js";
import { listVersions, liveStatus, slideDetail, VERSION_SELECT, type VersionStatus } from "../lib/slides/detail.js";
import { detectDeck, SOURCE_CONTENT_TYPES, SOURCE_EXTENSIONS, type DetectedDeck } from "../lib/slides/source.js";
import { receiveUpload, type ReceivedUpload } from "../lib/slides/upload.js";
import { cancelJob, enqueueJob, type SlideSourceType } from "../jobs/queue.js";
import { insertVersion, nextVersionNumber, renderPayload } from "../lib/slides/versions.js";
import { activateIfNewest, recordDeckPublished, registerSlideFinalizer } from "../jobs/slide-finalizer.js";
import { findStudy, requireStudyEditor, studyUrl } from "../lib/studies/access.js";
import { recordActivity } from "../lib/studies/activity.js";
import { SLIDES_GENERATE_JOB } from "../ai-jobs/slides/generate.js";
import { registerStudyCleanup } from "../lib/studies/cleanup.js";
import { registerSlidePreviewFinalizer } from "../jobs/slide-preview-finalizer.js";
import { freeSlug, paperMeta, withPaper } from "../lib/slides/create.js";
import { DECK_TEMPLATES, taipeiToday, type DeckTemplate } from "../lib/slides/templates.js";
import slideSources, { initSource } from "./slide-sources.js";
import slideAi from "./slide-ai.js";
import "../lib/slides/agent-tools.js";

const projectParams = z.object({ id: z.uuid() });
const versionParams = z.object({ id: z.uuid(), versionId: z.uuid() });
const referenceParams = z.object({ id: z.uuid(), referenceId: z.uuid() });
const MISSING = "簡報不存在。";

const title = z.string().trim().min(1).max(160);
const slug = z.string().trim().toLowerCase().max(80).regex(slugPattern);
const patchInput = z.object({
  title: title.optional(),
  slug: slug.optional(),
  public_view: z.boolean().optional(),
  kind: z.enum(["progress", "paper_report"]).optional(),
  paper_id: z.uuid().nullable().optional(),
  paper: paperMeta.nullable().optional(),
  rotateShareKey: z.boolean().optional(),
});
const deckKind = z.enum(["progress", "paper_report"]);
const listQuery = z.object({ studyId: z.string().min(1).max(80).optional(), q: z.string().max(200).optional(), kind: deckKind.optional() });
/** JSON create (no upload): a deck edited in the platform (`source: "editor"`) or drafted by AI (`"ai"`, then POST …/ai/generate). */
const createInput = z.object({
  studyId: z.string().min(1).max(80),
  title,
  slug: slug.optional(),
  kind: deckKind.default("progress"),
  paperId: z.uuid().nullable().optional(),
  paper: paperMeta.nullable().optional(),
  public: z.boolean().optional(),
  source: z.enum(["editor", "ai"]).default("editor"),
  template: z.enum(DECK_TEMPLATES as [DeckTemplate, ...DeckTemplate[]]).optional(),
});
const referenceUrlInput = z.object({ title: z.string().trim().min(1).max(300), url: z.string().trim().max(2000) });
const referencePatch = z.object({ title: z.string().trim().min(1).max(300).optional(), isDefault: z.literal(true).optional() });
const versionPatch = z.object({ active: z.literal(true) });

/** Postgres foreign_key_violation (an unknown `paper_id`). */
const isForeignKeyViolation = (error: unknown) => (error as { code?: string })?.code === "23503";
const PAPER_MISSING = "找不到這篇論文；請從研究的文獻庫選擇。";

const truthy = (value: string | undefined) => value === "true" || value === "1" || value === "on";
const escapeLike = (value: string) => value.replace(/[\\%_]/g, match => `\\${match}`);

async function lockProject(client: Queryable, id: string) {
  const row = (await client.query<SlideProject>("SELECT * FROM decks WHERE id=$1 FOR UPDATE", [id])).rows[0];
  if (!row) throw notFound(MISSING);
  return row;
}

/** Validates an uploaded deck (Quarto ZIP, PDF or PPTX; see lib/slides/source.ts). */
async function validateDeck(upload: ReceivedUpload, maxBytes: number) {
  const file = upload.file;
  if (!file || !file.bytes) throw badRequest(`請選擇 ${Math.floor(maxBytes / 1024 / 1024)} MB 以下的 ZIP、PDF 或 PPTX 檔案。`);
  return { file, deck: await detectDeck(file, upload.fields.entry, maxBytes) };
}

async function uploadSource(app: FastifyInstance, projectId: string, versionId: string, path: string, sourceType: SlideSourceType) {
  await app.storage.put(keys.slideSource(projectId, versionId, SOURCE_EXTENSIONS[sourceType]), createReadStream(path), SOURCE_CONTENT_TYPES[sourceType]);
}

/** Upload response fields describing what was detected. */
const uploadSummary = (deck: DetectedDeck) => ({
  sourceType: deck.sourceType,
  entry: deck.sourceType === "quarto" ? deck.entry : null,
  scan: deck.scan ? { files: deck.scan.files, bytes: deck.scan.bytes, qmd: deck.scan.qmd, skipped: deck.scan.skipped, skippedCount: deck.scan.skippedCount } : null,
});

async function isPdf(path: string) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(5);
    await handle.read(buffer, 0, 5, 0);
    return buffer.toString("latin1") === "%PDF-";
  } finally {
    await handle.close();
  }
}

/**
 * Upload size limits, so the SPA can reject oversized files before sending them. `MAX_SLIDE_ZIP_BYTES` applies to
 * every deck upload (ZIP, PDF, PPTX); `deckBytes` is the same value under a type-neutral name.
 */
const uploadLimits = (app: FastifyInstance) => ({
  zipBytes: app.config.MAX_SLIDE_ZIP_BYTES,
  deckBytes: app.config.MAX_SLIDE_ZIP_BYTES,
  deckTypes: [".zip", ".pdf", ".pptx"],
  referenceBytes: app.config.MAX_REFERENCE_BYTES,
});

const slides: FastifyPluginAsync = async app => {
  registerSlideFinalizer(app);
  registerSlidePreviewFinalizer(app);
  await app.register(slideSources);
  await app.register(slideAi);
  // Deleting a study cascades to its decks; their S3 objects go after commit.
  registerStudyCleanup("slides", async (client, studyId) => {
    const decks = (await client.query<{ id: string }>("SELECT id FROM decks WHERE study_id=$1", [studyId])).rows.map(row => row.id);
    if (!decks.length) return;
    const live = await client.query<{ job_id: string }>(
      "SELECT v.job_id FROM slide_versions v JOIN jobs j ON j.id=v.job_id WHERE v.deck_id=ANY($1::uuid[]) AND j.status IN ('queued','running')",
      [decks],
    );
    for (const job of live.rows) await cancelJob(client, job.job_id);
    const previews = await client.query<{ job_id: string }>("SELECT job_id FROM deck_previews WHERE deck_id=ANY($1::uuid[]) AND job_id IS NOT NULL", [decks]);
    for (const job of previews.rows) await cancelJob(client, job.job_id);
    return async () => {
      for (const id of decks) {
        await Promise.all([app.storage.deletePrefix(keys.slideProjectPrefix(id)), app.storage.deletePrefix(keys.referenceProjectPrefix(id))])
          .catch(error => app.log.warn({ err: error, deckId: id }, "deck storage cleanup failed"));
      }
    };
  });
  const secret = app.config.AUTH_SECRET;

  app.get("/slides", async (request, reply) => {
    const user = await requireUser(request);
    const query = parse(listQuery, request.query);
    let studyId: string | null = null;
    if (query.studyId) {
      const study = await findStudy(app.db, query.studyId);
      if (!study) throw notFound("研究不存在。");
      studyId = study.id;
    }
    const q = query.q?.trim() ? `%${escapeLike(query.q.trim())}%` : null;
    const result = await app.db.query(
      `SELECT p.id,p.title,p.slug,p.kind,p.paper_id,p.metadata,p.study_id,p.public_view,(t.deck_id IS NOT NULL) AS has_source,p.created_at,p.updated_at,p.active_version_id,
              json_build_object('id',s.id,'slug',s.slug,'title',s.title) AS study,
              av.version AS active_version,(av.thumbnail_key IS NOT NULL AND av.status='published') AS has_thumbnail,
              lv.id AS latest_version_id,lv.version AS latest_version,lv.status AS latest_status,lj.status AS latest_job_status,
              (SELECT count(*)::int FROM slide_references r WHERE r.deck_id=p.id) AS reference_count,
              (SELECT count(*)::int FROM slide_reviews r WHERE r.deck_id=p.id) AS review_count,
              COALESCE(au.name,cu.name) AS author_name,
              CASE WHEN av.status='published' THEN COALESCE(av.published_at,aj.finished_at,av.created_at) END AS published_at,
              EXISTS (SELECT 1 FROM study_members sm WHERE sm.study_id=p.study_id AND sm.user_id=$4 AND sm.role IN ('owner','member')) AS can_edit
         FROM decks p
         JOIN studies s ON s.id=p.study_id
         LEFT JOIN slide_versions av ON av.id=p.active_version_id
         LEFT JOIN jobs aj ON aj.id=av.job_id
         LEFT JOIN users au ON au.id=av.created_by
         LEFT JOIN users cu ON cu.id=p.created_by
         LEFT JOIN LATERAL (SELECT id,version,status,job_id FROM slide_versions WHERE deck_id=p.id ORDER BY version DESC LIMIT 1) lv ON true
         LEFT JOIN jobs lj ON lj.id=lv.job_id
         LEFT JOIN deck_source_trees t ON t.deck_id=p.id
        WHERE ($1::text IS NULL OR p.title ILIKE $1 OR p.slug ILIKE $1)
          AND ($2::uuid IS NULL OR p.study_id=$2)
          AND ($3::text IS NULL OR p.kind=$3)
        ORDER BY p.updated_at DESC, p.id`,
      [q, studyId, query.kind ?? null, user.id],
    );
    const rows = result.rows.map(({ latest_job_status, latest_status, has_thumbnail, ...row }) => ({
      ...row,
      latest_status: latest_status ? liveStatus({ status: latest_status, job_status: latest_job_status }) : null,
      thumbnailUrl: has_thumbnail ? slideUrls.thumbnail(row.id, row.active_version_id) : null,
    }));
    return reply.header("Cache-Control", "no-store").send({ slides: rows, limits: uploadLimits(app) });
  });

  app.post("/slides", async (request, reply) => {
    await requireUser(request);
    if (!request.isMultipart()) {
      const input = parse(createInput, request.body, "請確認名稱（1–160 字）、研究與簡報類型。");
      const { user, access } = await requireStudyEditor(request, input.studyId);
      const deckSlug = input.slug ?? (await freeSlug(app.db, input.title, taipeiToday()));
      const template = input.template ?? (input.kind === "paper_report" ? "paper_report" : "progress");
      const projectId = randomUUID();
      try {
        await transaction(app.db, async client => {
          const project = (await client.query<SlideProject>(
            `INSERT INTO decks(id,study_id,kind,paper_id,metadata,title,slug,public_view,share_key,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
             RETURNING *`,
            [projectId, access.study.id, input.kind, input.paperId ?? null, JSON.stringify(withPaper({}, input.paper ?? undefined)), input.title, deckSlug, input.public ?? false, newShareKey(), user.id],
          )).rows[0]!;
          await initSource(app, client, project, template, user);
          await client.query("UPDATE studies SET activity_at=now() WHERE id=$1", [access.study.id]);
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict("這個網址代稱已被使用。");
        if (isForeignKeyViolation(error)) throw badRequest(PAPER_MISSING);
        throw error;
      }
      return reply.code(201).send({ id: projectId, slug: deckSlug, studyId: access.study.id, source: input.source, template });
    }
    const maxBytes = app.config.MAX_SLIDE_ZIP_BYTES;
    const upload = await receiveUpload(request, maxBytes);
    try {
      const fields = upload.fields;
      if (!fields.studyId) throw badRequest("請選擇簡報所屬的研究。");
      const { user, access } = await requireStudyEditor(request, fields.studyId);
      const parsedKind = deckKind.safeParse(fields.kind || "progress");
      const parsedPaper = z.uuid().optional().safeParse(fields.paperId || undefined);
      if (!parsedKind.success || !parsedPaper.success) throw badRequest("簡報類型不正確。");
      // Paper of a paper report not linked to the library (multipart fields paperTitle / paperUrl).
      const paperField = paperMeta.safeParse(fields.paperTitle ? { title: fields.paperTitle, url: fields.paperUrl || undefined } : null);
      const parsedTitle = title.safeParse(fields.title ?? "");
      const parsedSlug = slug.safeParse(fields.slug ?? "");
      if (!parsedTitle.success || !parsedSlug.success) throw badRequest("請確認名稱（1–160 字）與 slug（小寫英數與連字號）。");
      const { file, deck } = await validateDeck(upload, maxBytes);
      const exists = await app.db.query("SELECT 1 FROM decks WHERE slug=$1", [parsedSlug.data]);
      if (exists.rowCount) throw conflict("這個網址代稱已被使用。");

      const projectId = randomUUID();
      const versionId = randomUUID();
      await uploadSource(app, projectId, versionId, file.path, deck.sourceType);
      let jobId: string;
      try {
        jobId = await transaction(app.db, async client => {
          await client.query(
            "INSERT INTO decks(id,study_id,kind,paper_id,title,slug,public_view,share_key,created_by,updated_by,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10)",
            [projectId, access.study.id, parsedKind.data, parsedPaper.data ?? null, parsedTitle.data, parsedSlug.data, truthy(fields.public), newShareKey(), user.id,
              JSON.stringify(withPaper({}, paperField.success ? paperField.data : undefined))],
          );
          const job = await insertVersion(client, user.id, projectId, versionId, 1, deck, file.filename);
          await client.query("UPDATE studies SET activity_at=now() WHERE id=$1", [access.study.id]);
          return job;
        });
      } catch (error) {
        await app.storage.deletePrefix(keys.slideProjectPrefix(projectId)).catch(() => {});
        if (isUniqueViolation(error)) throw conflict("這個網址代稱已被使用。");
        if (isForeignKeyViolation(error)) throw badRequest(PAPER_MISSING);
        throw error;
      }
      return reply.code(202).send({ id: projectId, slug: parsedSlug.data, studyId: access.study.id, versionId, version: 1, jobId, ...uploadSummary(deck) });
    } finally {
      await upload.cleanup();
    }
  });

  app.get("/slides/:id", async (request, reply) => {
    const user = await requireUser(request);
    const { id } = parse(projectParams, request.params);
    const project = await projectById(app.db, id);
    if (!project) throw notFound(MISSING);
    return reply.header("Cache-Control", "no-store").send({ ...(await slideDetail(app.db, secret, project, user)), limits: uploadLimits(app) });
  });

  /** Active version's first-slide image (PNG for quarto, WebP for pdf/pptx). ETag = version id, so a new active version changes it. */
  app.get("/slides/:id/thumbnail", async (request, reply) => {
    await requireUser(request);
    const { id } = parse(projectParams, request.params, "找不到縮圖。");
    const row = (await app.db.query<{ id: string; thumbnail_key: string | null }>(
      `SELECT v.id,v.thumbnail_key FROM decks p JOIN slide_versions v ON v.id=p.active_version_id
        WHERE p.id=$1 AND v.status='published'`,
      [id],
    )).rows[0];
    if (!row?.thumbnail_key) throw notFound("找不到縮圖。");
    const etag = `"${row.id}"`;
    reply
      .header("Cache-Control", "private, max-age=300")
      .header("X-Content-Type-Options", "nosniff")
      .header("ETag", etag);
    if (request.headers["if-none-match"] === etag) return reply.code(304).send();
    const object = await app.storage.get(row.thumbnail_key);
    if (!object) {
      reply.removeHeader("ETag").header("Cache-Control", "no-store");
      throw notFound("找不到縮圖。");
    }
    reply.header("Content-Type", row.thumbnail_key.endsWith(".webp") ? "image/webp" : "image/png");
    if (object.contentLength !== undefined) reply.header("Content-Length", object.contentLength);
    return reply.send(object.body);
  });

  app.patch("/slides/:id", async request => {
    const { id } = parse(projectParams, request.params);
    const { user } = await requireDeckEditor(request, id);
    const input = parse(patchInput, request.body);
    try {
      return await transaction(app.db, async client => {
        const current = await lockProject(client, id);
        const metadata = withPaper(current.metadata ?? {}, input.paper);
        const updated = (await client.query<SlideProject>(
          `UPDATE decks SET metadata=$11,title=COALESCE($2,title),slug=COALESCE($3,slug),public_view=COALESCE($4,public_view),
                  share_key=CASE WHEN $5::boolean THEN $6 ELSE share_key END,updated_by=$7,updated_at=now(),
                  kind=COALESCE($8,kind),paper_id=CASE WHEN $9::boolean THEN $10::uuid ELSE paper_id END
            WHERE id=$1 RETURNING id,study_id,kind,paper_id,metadata,title,slug,public_view,share_key,active_version_id,updated_at`,
          [id, input.title ?? null, input.slug ?? null, input.public_view ?? null, input.rotateShareKey ?? false, newShareKey(), user.id,
            input.kind ?? null, input.paper_id !== undefined, input.paper_id ?? null, JSON.stringify(metadata)],
        )).rows[0]!;
        return { project: updated };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict("這個網址代稱已被使用。");
        if (isForeignKeyViolation(error)) throw badRequest(PAPER_MISSING);
      throw error;
    }
  });

  app.delete("/slides/:id", async request => {
    const { id } = parse(projectParams, request.params);
    const { user } = await requireDeckEditor(request, id);
    await transaction(app.db, async client => {
      const project = await lockProject(client, id);
      const jobs = await client.query<{ job_id: string }>(
        "SELECT v.job_id FROM slide_versions v JOIN jobs j ON j.id=v.job_id WHERE v.deck_id=$1 AND j.status IN ('queued','running')",
        [id],
      );
      for (const job of jobs.rows) await cancelJob(client, job.job_id);
      for (const preview of (await client.query<{ job_id: string }>("SELECT job_id FROM deck_previews WHERE deck_id=$1 AND job_id IS NOT NULL", [id])).rows) await cancelJob(client, preview.job_id);
      // AI drafts reference the deck only by payload (no FK): stop them before they write into a deck that is gone.
      const drafts = await client.query<{ id: string }>(
        "SELECT id FROM jobs WHERE kind=$1 AND payload->>'deckId'=$2 AND status IN ('queued','running')",
        [SLIDES_GENERATE_JOB, id],
      );
      for (const job of drafts.rows) await cancelJob(client, job.id);
      await client.query("DELETE FROM suggestions WHERE target_type='deck_source' AND target_id IN (SELECT id::text FROM deck_sources WHERE deck_id=$1)", [id]);
      // Workflow runs list the decks they wrote; drop the dead link (the run's report keeps its text).
      await client.query(
        `UPDATE workflow_runs SET artifacts=(SELECT coalesce(jsonb_agg(a),'[]'::jsonb) FROM jsonb_array_elements(artifacts) a WHERE NOT (a->>'kind'='deck' AND a->>'id'=$1))
          WHERE artifacts @> jsonb_build_array(jsonb_build_object('kind','deck','id',$1::text))`,
        [id],
      );
      await client.query("DELETE FROM decks WHERE id=$1", [id]);
      const study = (await client.query<{ slug: string }>("SELECT slug FROM studies WHERE id=$1", [project.study_id])).rows[0];
      await recordActivity(client, {
        studyId: project.study_id, actorId: user.id, kind: "deck_deleted", title: project.title,
        url: study ? studyUrl(study.slug, "decks") : null, targetType: "deck", targetId: id,
      });
    });
    await Promise.all([
      app.storage.deletePrefix(keys.slideProjectPrefix(id)),
      app.storage.deletePrefix(keys.referenceProjectPrefix(id)),
    ]).catch(error => request.log.warn({ err: error, projectId: id }, "slide storage cleanup failed"));
    return { ok: true };
  });

  app.get("/slides/:id/versions", async (request, reply) => {
    await requireUser(request);
    const { id } = parse(projectParams, request.params);
    const project = await projectById(app.db, id);
    if (!project) throw notFound(MISSING);
    return reply.header("Cache-Control", "no-store").send({ versions: await listVersions(app.db, secret, project) });
  });

  app.post("/slides/:id/versions", async (request, reply) => {
    const { id } = parse(projectParams, request.params);
    const { user } = await requireDeckEditor(request, id);
    if (!(await projectById(app.db, id))) throw notFound(MISSING);
    const maxBytes = app.config.MAX_SLIDE_ZIP_BYTES;
    const upload = await receiveUpload(request, maxBytes);
    try {
      const { file, deck } = await validateDeck(upload, maxBytes);
      const versionId = randomUUID();
      await uploadSource(app, id, versionId, file.path, deck.sourceType);
      try {
        const result = await transaction(app.db, async client => {
          await lockProject(client, id);
          const version = await nextVersionNumber(client, id);
          const jobId = await insertVersion(client, user.id, id, versionId, version, deck, file.filename);
          await client.query("UPDATE decks SET updated_by=$2,updated_at=now() WHERE id=$1", [id, user.id]);
          return { version, jobId };
        });
        return reply.code(202).send({ versionId, ...result, ...uploadSummary(deck) });
      } catch (error) {
        await app.storage.deletePrefix(`${keys.slideProjectPrefix(id)}${versionId}/`).catch(() => {});
        throw error;
      }
    } finally {
      await upload.cleanup();
    }
  });

  app.patch("/slides/:id/versions/:versionId", async request => {
    const { id, versionId } = parse(versionParams, request.params);
    const { user } = await requireDeckEditor(request, id);
    parse(versionPatch, request.body);
    const result = await app.db.query(
      `UPDATE decks SET active_version_id=$1,updated_by=$3,updated_at=now()
        WHERE id=$2 AND EXISTS (SELECT 1 FROM slide_versions WHERE id=$1 AND deck_id=$2 AND status='published') RETURNING id`,
      [versionId, id, user.id],
    );
    if (!result.rowCount) throw notFound("版本尚未發布或不存在。");
    return { ok: true };
  });

  /** Confirms a converted (PPTX) version waiting in `review`: it becomes published and, by the activation rule, active. */
  app.post("/slides/:id/versions/:versionId/publish", async request => {
    const { id, versionId } = parse(versionParams, request.params);
    const { user } = await requireDeckEditor(request, id);
    return transaction(app.db, async client => {
      await lockProject(client, id);
      const version = (await client.query<{ id: string; deck_id: string; version: number }>(
        "UPDATE slide_versions SET status='published',published_at=now() WHERE id=$1 AND deck_id=$2 AND status='review' RETURNING id,deck_id,version",
        [versionId, id],
      )).rows[0];
      if (!version) throw notFound("沒有待確認的版本。");
      await activateIfNewest(client, version);
      await recordDeckPublished(client, version, user.id);
      await client.query("UPDATE decks SET updated_by=$2,updated_at=now() WHERE id=$1", [id, user.id]);
      const active = (await client.query<{ active_version_id: string | null }>("SELECT active_version_id FROM decks WHERE id=$1", [id])).rows[0]!;
      return { ok: true, status: "published", active: active.active_version_id === versionId };
    });
  });

  /**
   * Re-renders a published version into a fresh output prefix to (re)build its pages; the deck keeps being
   * served from the current output until the job succeeds (see the slide finalizer).
   */
  app.post("/slides/:id/versions/:versionId/reindex", async (request, reply) => {
    const { id, versionId } = parse(versionParams, request.params);
    const { user } = await requireDeckEditor(request, id);
    const result = await transaction(app.db, async client => {
      await lockProject(client, id);
      const version = (await client.query<{ id: string; entry_qmd: string; source_type: SlideSourceType; job_status: string | null }>(
        `SELECT v.id,v.entry_qmd,v.source_type,j.status AS job_status FROM slide_versions v LEFT JOIN jobs j ON j.id=v.job_id
          WHERE v.id=$1 AND v.deck_id=$2 AND v.status='published' FOR UPDATE OF v`,
        [versionId, id],
      )).rows[0];
      if (!version) throw notFound("版本尚未發布或不存在。");
      if (version.job_status === "queued" || version.job_status === "running") throw conflict("此版本正在處理中。");
      const prefix = keys.slideReindexPrefix(id, versionId, Date.now().toString(36));
      const jobId = await enqueueJob(client, "slide_render", renderPayload(id, versionId, version.source_type, version.entry_qmd, prefix), user.id);
      await client.query("UPDATE slide_versions SET job_id=$2 WHERE id=$1", [versionId, jobId]);
      return { versionId, jobId };
    });
    return reply.code(202).send(result);
  });

  app.delete("/slides/:id/versions/:versionId", async request => {
    const { id, versionId } = parse(versionParams, request.params);
    await requireDeckEditor(request, id);
    await transaction(app.db, async client => {
      const project = await lockProject(client, id);
      if (project.active_version_id === versionId) throw conflict("無法刪除目前版本；請先切換版本。");
      const removed = await client.query<{ job_id: string | null }>("DELETE FROM slide_versions WHERE id=$1 AND deck_id=$2 RETURNING job_id", [versionId, id]);
      if (!removed.rowCount) throw notFound("版本不存在。");
      const jobId = removed.rows[0]!.job_id;
      if (jobId) await cancelJob(client, jobId);
    });
    await app.storage.deletePrefix(`${keys.slideProjectPrefix(id)}${versionId}/`)
      .catch(error => request.log.warn({ err: error, versionId }, "slide version cleanup failed"));
    return { ok: true };
  });

  app.get("/slides/:id/status", async (request, reply) => {
    await requireUser(request);
    const { id } = parse(projectParams, request.params);
    const row = (await app.db.query<{ id: string; version: number; status: VersionStatus; error: string | null; job_status: string | null; job_stage: string | null; job_progress: number | null }>(
      `${VERSION_SELECT} WHERE v.deck_id=$1 ORDER BY v.version DESC LIMIT 1`,
      [id],
    )).rows[0];
    if (!row) throw notFound(MISSING);
    return reply.header("Cache-Control", "no-store").send({
      id: row.id,
      version: row.version,
      status: liveStatus(row),
      error: row.error,
      stage: row.job_stage,
      progress: row.status === "published" || row.status === "review" ? 100 : row.job_progress ?? 0,
    });
  });

  app.post("/slides/:id/render", async (request, reply) => {
    const { id } = parse(projectParams, request.params);
    const { user } = await requireDeckEditor(request, id);
    const result = await transaction(app.db, async client => {
      await lockProject(client, id);
      const version = (await client.query<{ id: string; entry_qmd: string; source_key: string; output_prefix: string; source_type: SlideSourceType }>(
        "SELECT id,entry_qmd,source_key,output_prefix,source_type FROM slide_versions WHERE deck_id=$1 AND status='failed' ORDER BY version DESC LIMIT 1",
        [id],
      )).rows[0];
      if (!version) throw notFound("沒有可重試的失敗版本。");
      const jobId = await enqueueJob(client, "slide_render", {
        projectId: id,
        versionId: version.id,
        sourceKey: version.source_key,
        entry: version.entry_qmd,
        outputPrefix: version.output_prefix,
        sourceType: version.source_type,
      }, user.id);
      await client.query("UPDATE slide_versions SET status='queued',error=NULL,job_id=$2 WHERE id=$1", [version.id, jobId]);
      return { versionId: version.id, jobId };
    });
    return reply.code(202).send(result);
  });

  app.post("/slides/:id/references", async (request, reply) => {
    const { id } = parse(projectParams, request.params);
    await requireDeckEditor(request, id);
    if (!(await projectById(app.db, id))) throw notFound(MISSING);
    const maxBytes = app.config.MAX_REFERENCE_BYTES;
    const hint = `請填名稱，並提供 PDF（${Math.floor(maxBytes / 1024 / 1024)} MB 以下）或 HTTP(S) 連結。`;
    const referenceId = randomUUID();
    let fileKey: string | null = null;
    let fileName: string | null = null;
    let fileBytes: number | null = null;
    let refTitle: string;
    let url: string | null = null;

    if (request.isMultipart()) {
      const upload = await receiveUpload(request, maxBytes);
      try {
        const parsed = z.string().trim().min(1).max(300).safeParse(upload.fields.title ?? "");
        const link = (upload.fields.url ?? "").trim();
        const file = upload.file && upload.file.bytes ? upload.file : null;
        if (!parsed.success || Boolean(link) === Boolean(file)) throw badRequest(hint);
        refTitle = parsed.data;
        if (file) {
          if (!file.filename.toLowerCase().endsWith(".pdf")) throw badRequest(hint);
          if (!(await isPdf(file.path))) throw new HttpError(415, "檔案不是 PDF。");
          fileKey = keys.reference(id, referenceId);
          fileName = file.filename.slice(0, 255);
          fileBytes = file.bytes;
          await app.storage.put(fileKey, createReadStream(file.path), "application/pdf");
        } else {
          url = link;
        }
      } finally {
        await upload.cleanup();
      }
    } else {
      const input = parse(referenceUrlInput, request.body, hint);
      refTitle = input.title;
      url = input.url;
    }
    if (url !== null) {
      let protocol = "";
      try {
        protocol = new URL(url).protocol;
      } catch {}
      if (protocol !== "http:" && protocol !== "https:") throw badRequest("連結須為 HTTP(S) 網址。");
    }
    try {
      const reference = await transaction(app.db, async client => {
        await lockProject(client, id);
        const count = (await client.query<{ count: number }>("SELECT count(*)::int AS count FROM slide_references WHERE deck_id=$1", [id])).rows[0]!.count;
        return (await client.query(
          `INSERT INTO slide_references(id,deck_id,title,url,file_key,file_name,file_bytes,is_default) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
           RETURNING id,title,url,file_name,file_bytes,is_default,created_at`,
          [referenceId, id, refTitle, url, fileKey, fileName, fileBytes, count === 0],
        )).rows[0];
      });
      return reply.code(201).send({ reference });
    } catch (error) {
      if (fileKey) await app.storage.delete(fileKey).catch(() => {});
      throw error;
    }
  });

  app.patch("/slides/:id/references/:referenceId", async request => {
    const { id, referenceId } = parse(referenceParams, request.params);
    await requireDeckEditor(request, id);
    // v1 clients sent no body to mean "make default".
    const input = parse(referencePatch, request.body ?? { isDefault: true });
    await transaction(app.db, async client => {
      await lockProject(client, id);
      const found = await client.query("SELECT id FROM slide_references WHERE id=$1 AND deck_id=$2", [referenceId, id]);
      if (!found.rowCount) throw notFound("參考資料不存在。");
      if (input.title) await client.query("UPDATE slide_references SET title=$2 WHERE id=$1", [referenceId, input.title]);
      if (input.isDefault) {
        await client.query("UPDATE slide_references SET is_default=false WHERE deck_id=$1 AND is_default", [id]);
        await client.query("UPDATE slide_references SET is_default=true WHERE id=$1", [referenceId]);
      }
    });
    return { ok: true };
  });

  app.delete("/slides/:id/references/:referenceId", async request => {
    const { id, referenceId } = parse(referenceParams, request.params);
    await requireDeckEditor(request, id);
    const removed = await transaction(app.db, async client => {
      await lockProject(client, id);
      const result = await client.query<{ file_key: string | null; is_default: boolean }>(
        "DELETE FROM slide_references WHERE id=$1 AND deck_id=$2 RETURNING file_key,is_default",
        [referenceId, id],
      );
      const row = result.rows[0];
      if (!row) throw notFound("參考資料不存在。");
      if (row.is_default) {
        await client.query(
          "UPDATE slide_references SET is_default=true WHERE id=(SELECT id FROM slide_references WHERE deck_id=$1 ORDER BY created_at,id LIMIT 1)",
          [id],
        );
      }
      return row;
    });
    if (removed.file_key) await app.storage.delete(removed.file_key).catch(error => request.log.warn({ err: error }, "reference cleanup failed"));
    return { ok: true };
  });
};

export default slides;
