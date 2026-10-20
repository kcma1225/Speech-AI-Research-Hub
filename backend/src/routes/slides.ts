import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { transaction, type Queryable } from "../db.js";
import { requireEditor, requireUser, type CurrentUser } from "../lib/auth.js";
import { badRequest, conflict, HttpError, isUniqueViolation, notFound, parse } from "../lib/http.js";
import { keys } from "../lib/storage.js";
import { newShareKey, projectById, slugPattern, type SlideProject } from "../lib/slides/access.js";
import { listVersions, liveStatus, slideDetail, VERSION_SELECT } from "../lib/slides/detail.js";
import { parseTagFilter, tagIdsSchema } from "../lib/slides/filters.js";
import { receiveUpload, type ReceivedUpload } from "../lib/slides/upload.js";
import { chooseEntry, scanZip } from "../lib/slides/zip-validate.js";
import { cancelJob, enqueueJob, type SlideRenderPayload } from "../jobs/queue.js";
import { registerSlideFinalizer } from "../jobs/slide-finalizer.js";

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
  tagIds: tagIdsSchema.optional(),
  rotateShareKey: z.boolean().optional(),
});
const listQuery = z.object({ tags: z.string().optional(), q: z.string().max(200).optional() });
const referenceUrlInput = z.object({ title: z.string().trim().min(1).max(300), url: z.string().trim().max(2000) });
const referencePatch = z.object({ title: z.string().trim().min(1).max(300).optional(), isDefault: z.literal(true).optional() });
const versionPatch = z.object({ active: z.literal(true) });

const truthy = (value: string | undefined) => value === "true" || value === "1" || value === "on";
const escapeLike = (value: string) => value.replace(/[\\%_]/g, match => `\\${match}`);

async function lockProject(client: Queryable, id: string) {
  const row = (await client.query<SlideProject>("SELECT * FROM slide_projects WHERE id=$1 FOR UPDATE", [id])).rows[0];
  if (!row) throw notFound(MISSING);
  return row;
}

async function setProjectTags(client: Queryable, projectId: string, tagIds: string[]) {
  await client.query("DELETE FROM slide_project_tags WHERE project_id=$1", [projectId]);
  await client.query(
    "INSERT INTO slide_project_tags(project_id,tag_id) SELECT $1,t.id FROM slide_tags t WHERE t.id=ANY($2::uuid[]) ON CONFLICT DO NOTHING",
    [projectId, [...new Set(tagIds)]],
  );
}

/** Validates an uploaded deck ZIP and returns its entry QMD. */
async function validateDeckZip(upload: ReceivedUpload, maxBytes: number) {
  const file = upload.file;
  if (!file || !file.bytes || !/\.zip$/i.test(file.filename)) throw badRequest(`請選擇 ${Math.floor(maxBytes / 1024 / 1024)} MB 以下的 ZIP 檔案。`);
  const scan = await scanZip(file.path);
  const entry = chooseEntry(scan.qmd, upload.fields.entry);
  return { file, scan, entry };
}

/**
 * Inserts a version row plus its render job. The source ZIP must already be in S3 so a worker never
 * claims a job whose input is missing.
 */
async function insertVersion(client: Queryable, user: CurrentUser, projectId: string, versionId: string, version: number, entry: string, sourceName: string) {
  const payload: SlideRenderPayload = {
    projectId,
    versionId,
    sourceKey: keys.slideSource(projectId, versionId),
    entry,
    outputPrefix: keys.slideOutputPrefix(projectId, versionId),
  };
  const jobId = await enqueueJob(client, "slide_render", payload, user.id);
  await client.query(
    `INSERT INTO slide_versions(id,project_id,version,entry_qmd,source_name,source_key,output_prefix,job_id,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [versionId, projectId, version, entry, sourceName.slice(0, 255), payload.sourceKey, payload.outputPrefix, jobId, user.id],
  );
  return jobId;
}

async function uploadSource(app: FastifyInstance, projectId: string, versionId: string, path: string) {
  await app.storage.put(keys.slideSource(projectId, versionId), createReadStream(path), "application/zip");
}

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

const slides: FastifyPluginAsync = async app => {
  registerSlideFinalizer(app);
  const secret = app.config.AUTH_SECRET;

  app.get("/slides", async (request, reply) => {
    await requireUser(request);
    const query = parse(listQuery, request.query);
    const filter = parseTagFilter(query.tags);
    const q = query.q?.trim() ? `%${escapeLike(query.q.trim())}%` : null;
    const result = await app.db.query(
      `SELECT p.id,p.title,p.slug,p.public_view,p.created_at,p.updated_at,p.active_version_id,
              av.version AS active_version,
              lv.id AS latest_version_id,lv.version AS latest_version,lv.status AS latest_status,lj.status AS latest_job_status,
              COALESCE((SELECT json_agg(json_build_object('id',t.id,'name',t.name) ORDER BY lower(t.name))
                          FROM slide_project_tags j JOIN slide_tags t ON t.id=j.tag_id WHERE j.project_id=p.id),'[]') AS tags,
              (SELECT count(*)::int FROM slide_references r WHERE r.project_id=p.id) AS reference_count
         FROM slide_projects p
         LEFT JOIN slide_versions av ON av.id=p.active_version_id
         LEFT JOIN LATERAL (SELECT id,version,status,job_id FROM slide_versions WHERE project_id=p.id ORDER BY version DESC LIMIT 1) lv ON true
         LEFT JOIN jobs lj ON lj.id=lv.job_id
        WHERE ($1::text IS NULL OR p.title ILIKE $1 OR p.slug ILIKE $1)
          AND (NOT $2::boolean
               OR EXISTS (SELECT 1 FROM slide_project_tags j WHERE j.project_id=p.id AND j.tag_id=ANY($3::uuid[]))
               OR ($4::boolean AND NOT EXISTS (SELECT 1 FROM slide_project_tags j WHERE j.project_id=p.id)))
        ORDER BY p.updated_at DESC, p.id`,
      [q, filter.mode === "set", filter.mode === "set" ? filter.ids : [], filter.mode === "set" && filter.untagged],
    );
    const rows = result.rows.map(({ latest_job_status, latest_status, ...row }) => ({
      ...row,
      latest_status: latest_status ? liveStatus({ status: latest_status, job_status: latest_job_status }) : null,
    }));
    return reply.header("Cache-Control", "no-store").send({ slides: rows });
  });

  app.post("/slides", async (request, reply) => {
    const user = await requireEditor(request);
    const maxBytes = app.config.MAX_SLIDE_ZIP_BYTES;
    const upload = await receiveUpload(request, maxBytes);
    try {
      const fields = upload.fields;
      const parsedTitle = title.safeParse(fields.title ?? "");
      const parsedSlug = slug.safeParse(fields.slug ?? "");
      let rawTags: unknown = [];
      try {
        rawTags = JSON.parse(fields.tagIds || "[]");
      } catch {
        throw badRequest("標籤格式不正確。");
      }
      const tags = tagIdsSchema.safeParse(rawTags);
      if (!parsedTitle.success || !parsedSlug.success || !tags.success) throw badRequest("請確認名稱（1–160 字）、slug（小寫英數與連字號）與標籤。");
      const { file, scan, entry } = await validateDeckZip(upload, maxBytes);
      const exists = await app.db.query("SELECT 1 FROM slide_projects WHERE slug=$1", [parsedSlug.data]);
      if (exists.rowCount) throw conflict("slug 已被使用。");

      const projectId = randomUUID();
      const versionId = randomUUID();
      await uploadSource(app, projectId, versionId, file.path);
      let jobId: string;
      try {
        jobId = await transaction(app.db, async client => {
          await client.query(
            "INSERT INTO slide_projects(id,title,slug,public_view,share_key,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$6)",
            [projectId, parsedTitle.data, parsedSlug.data, truthy(fields.public), newShareKey(), user.id],
          );
          const job = await insertVersion(client, user, projectId, versionId, 1, entry, file.filename);
          if (tags.data.length) await setProjectTags(client, projectId, tags.data);
          return job;
        });
      } catch (error) {
        await app.storage.deletePrefix(keys.slideProjectPrefix(projectId)).catch(() => {});
        if (isUniqueViolation(error)) throw conflict("slug 已被使用。");
        throw error;
      }
      return reply.code(202).send({ id: projectId, slug: parsedSlug.data, versionId, version: 1, jobId, entry, scan: { files: scan.files, bytes: scan.bytes, qmd: scan.qmd } });
    } finally {
      await upload.cleanup();
    }
  });

  app.get("/slides/:id", async (request, reply) => {
    const user = await requireUser(request);
    const { id } = parse(projectParams, request.params);
    const project = await projectById(app.db, id);
    if (!project) throw notFound(MISSING);
    return reply.header("Cache-Control", "no-store").send(await slideDetail(app.db, secret, project, user));
  });

  app.patch("/slides/:id", async request => {
    const user = await requireEditor(request);
    const { id } = parse(projectParams, request.params);
    const input = parse(patchInput, request.body);
    try {
      return await transaction(app.db, async client => {
        await lockProject(client, id);
        const updated = (await client.query<SlideProject>(
          `UPDATE slide_projects SET title=COALESCE($2,title),slug=COALESCE($3,slug),public_view=COALESCE($4,public_view),
                  share_key=CASE WHEN $5::boolean THEN $6 ELSE share_key END,updated_by=$7,updated_at=now()
            WHERE id=$1 RETURNING id,title,slug,public_view,share_key,active_version_id,updated_at`,
          [id, input.title ?? null, input.slug ?? null, input.public_view ?? null, input.rotateShareKey ?? false, newShareKey(), user.id],
        )).rows[0]!;
        if (input.tagIds) await setProjectTags(client, id, input.tagIds);
        return { project: updated };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict("slug 已被使用。");
      throw error;
    }
  });

  app.delete("/slides/:id", async request => {
    await requireEditor(request);
    const { id } = parse(projectParams, request.params);
    await transaction(app.db, async client => {
      await lockProject(client, id);
      const jobs = await client.query<{ job_id: string }>(
        "SELECT v.job_id FROM slide_versions v JOIN jobs j ON j.id=v.job_id WHERE v.project_id=$1 AND j.status IN ('queued','running')",
        [id],
      );
      for (const job of jobs.rows) await cancelJob(client, job.job_id);
      await client.query("DELETE FROM slide_projects WHERE id=$1", [id]);
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
    const user = await requireEditor(request);
    const { id } = parse(projectParams, request.params);
    if (!(await projectById(app.db, id))) throw notFound(MISSING);
    const maxBytes = app.config.MAX_SLIDE_ZIP_BYTES;
    const upload = await receiveUpload(request, maxBytes);
    try {
      const { file, scan, entry } = await validateDeckZip(upload, maxBytes);
      const versionId = randomUUID();
      await uploadSource(app, id, versionId, file.path);
      try {
        const result = await transaction(app.db, async client => {
          await lockProject(client, id);
          const version = (await client.query<{ next: number }>("SELECT COALESCE(max(version),0)+1 AS next FROM slide_versions WHERE project_id=$1", [id])).rows[0]!.next;
          const jobId = await insertVersion(client, user, id, versionId, version, entry, file.filename);
          await client.query("UPDATE slide_projects SET updated_by=$2,updated_at=now() WHERE id=$1", [id, user.id]);
          return { version, jobId };
        });
        return reply.code(202).send({ versionId, ...result, entry, scan: { files: scan.files, bytes: scan.bytes, qmd: scan.qmd } });
      } catch (error) {
        await app.storage.deletePrefix(`${keys.slideProjectPrefix(id)}${versionId}/`).catch(() => {});
        throw error;
      }
    } finally {
      await upload.cleanup();
    }
  });

  app.patch("/slides/:id/versions/:versionId", async request => {
    const user = await requireEditor(request);
    const { id, versionId } = parse(versionParams, request.params);
    parse(versionPatch, request.body);
    const result = await app.db.query(
      `UPDATE slide_projects SET active_version_id=$1,updated_by=$3,updated_at=now()
        WHERE id=$2 AND EXISTS (SELECT 1 FROM slide_versions WHERE id=$1 AND project_id=$2 AND status='published') RETURNING id`,
      [versionId, id, user.id],
    );
    if (!result.rowCount) throw notFound("版本尚未發布或不存在。");
    return { ok: true };
  });

  app.delete("/slides/:id/versions/:versionId", async request => {
    await requireEditor(request);
    const { id, versionId } = parse(versionParams, request.params);
    await transaction(app.db, async client => {
      const project = await lockProject(client, id);
      if (project.active_version_id === versionId) throw conflict("無法刪除目前版本；請先切換版本。");
      const removed = await client.query<{ job_id: string | null }>("DELETE FROM slide_versions WHERE id=$1 AND project_id=$2 RETURNING job_id", [versionId, id]);
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
    const row = (await app.db.query<{ id: string; version: number; status: "queued" | "rendering" | "published" | "failed"; error: string | null; job_status: string | null; job_stage: string | null; job_progress: number | null }>(
      `${VERSION_SELECT} WHERE v.project_id=$1 ORDER BY v.version DESC LIMIT 1`,
      [id],
    )).rows[0];
    if (!row) throw notFound(MISSING);
    return reply.header("Cache-Control", "no-store").send({
      id: row.id,
      version: row.version,
      status: liveStatus(row),
      error: row.error,
      stage: row.job_stage,
      progress: row.status === "published" ? 100 : row.job_progress ?? 0,
    });
  });

  app.post("/slides/:id/render", async (request, reply) => {
    const user = await requireEditor(request);
    const { id } = parse(projectParams, request.params);
    const result = await transaction(app.db, async client => {
      await lockProject(client, id);
      const version = (await client.query<{ id: string; entry_qmd: string; source_key: string; output_prefix: string }>(
        "SELECT id,entry_qmd,source_key,output_prefix FROM slide_versions WHERE project_id=$1 AND status='failed' ORDER BY version DESC LIMIT 1",
        [id],
      )).rows[0];
      if (!version) throw notFound("沒有可重試的失敗版本。");
      const jobId = await enqueueJob(client, "slide_render", {
        projectId: id,
        versionId: version.id,
        sourceKey: version.source_key,
        entry: version.entry_qmd,
        outputPrefix: version.output_prefix,
      }, user.id);
      await client.query("UPDATE slide_versions SET status='queued',error=NULL,job_id=$2 WHERE id=$1", [version.id, jobId]);
      return { versionId: version.id, jobId };
    });
    return reply.code(202).send(result);
  });

  app.post("/slides/:id/references", async (request, reply) => {
    await requireEditor(request);
    const { id } = parse(projectParams, request.params);
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
        const count = (await client.query<{ count: number }>("SELECT count(*)::int AS count FROM slide_references WHERE project_id=$1", [id])).rows[0]!.count;
        return (await client.query(
          `INSERT INTO slide_references(id,project_id,title,url,file_key,file_name,file_bytes,is_default) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
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
    await requireEditor(request);
    const { id, referenceId } = parse(referenceParams, request.params);
    // v1 clients sent no body to mean "make default".
    const input = parse(referencePatch, request.body ?? { isDefault: true });
    await transaction(app.db, async client => {
      await lockProject(client, id);
      const found = await client.query("SELECT id FROM slide_references WHERE id=$1 AND project_id=$2", [referenceId, id]);
      if (!found.rowCount) throw notFound("參考資料不存在。");
      if (input.title) await client.query("UPDATE slide_references SET title=$2 WHERE id=$1", [referenceId, input.title]);
      if (input.isDefault) {
        await client.query("UPDATE slide_references SET is_default=false WHERE project_id=$1 AND is_default", [id]);
        await client.query("UPDATE slide_references SET is_default=true WHERE id=$1", [referenceId]);
      }
    });
    return { ok: true };
  });

  app.delete("/slides/:id/references/:referenceId", async request => {
    await requireEditor(request);
    const { id, referenceId } = parse(referenceParams, request.params);
    const removed = await transaction(app.db, async client => {
      await lockProject(client, id);
      const result = await client.query<{ file_key: string | null; is_default: boolean }>(
        "DELETE FROM slide_references WHERE id=$1 AND project_id=$2 RETURNING file_key,is_default",
        [referenceId, id],
      );
      const row = result.rows[0];
      if (!row) throw notFound("參考資料不存在。");
      if (row.is_default) {
        await client.query(
          "UPDATE slide_references SET is_default=true WHERE id=(SELECT id FROM slide_references WHERE project_id=$1 ORDER BY created_at,id LIMIT 1)",
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
