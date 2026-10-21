import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { transaction } from "../db.js";
import { requireUser, type CurrentUser } from "../lib/auth.js";
import { badRequest, conflict, isUniqueViolation, notFound, parse } from "../lib/http.js";
import { projectById, requireDeckEditor, type SlideProject } from "../lib/slides/access.js";
import { enqueuePreview, previewState, previewToken, previewViewUrl, type PreviewRow } from "../lib/slides/preview.js";
import {
  BINARY_CONTENT_TYPES, createTree, fileById, listFiles, loadTree, packTree, requireTree, saveBinary, saveText, SOURCE_LIMITS, sourceKeys, sourcePath, touchTree,
} from "../lib/slides/sources.js";
import { DECK_TEMPLATES, progressTitle, taipeiToday, templateQmd, type DeckTemplate } from "../lib/slides/templates.js";
import { receiveUpload } from "../lib/slides/upload.js";
import { publishTree } from "../lib/slides/publish.js";
import { setDeckSourcePreview } from "../lib/slides/suggest-target.js";
import { loadStudyAccess } from "../lib/studies/access.js";
import { deleteSuggestionsOf } from "../lib/suggestions/service.js";

const deckParams = z.object({ id: z.uuid() });
const fileParams = z.object({ id: z.uuid(), fileId: z.uuid() });
const MISSING = "簡報不存在。";

const initInput = z.object({ template: z.enum(DECK_TEMPLATES as [DeckTemplate, ...DeckTemplate[]]).default("blank") });
const textInput = z.object({ path: z.string().min(1).max(200), content: z.string().max(SOURCE_LIMITS.textBytes), baseVersion: z.number().int().min(0).optional() });
const renameInput = z.object({ path: z.string().min(1).max(200) });
const treePatch = z.object({ entry: z.string().min(1).max(200) });

/** Preview fields for the editor: newest attempt (with job stage) and newest ready render (with its iframe URL). */
export function previewInfo(secret: string, project: Pick<SlideProject, "id" | "slug">, state: Awaited<ReturnType<typeof previewState>>) {
  const { latest, ready } = state;
  return {
    latest: latest
      ? {
          id: latest.id,
          revision: latest.revision,
          status: latest.status === "queued" && latest.job_status === "running" ? "rendering" : latest.status,
          error: latest.error,
          stage: latest.stage,
          progress: latest.status === "ready" ? 100 : latest.progress ?? 0,
          created_at: latest.created_at,
        }
      : null,
    ready: ready?.entry_html ? { id: ready.id, revision: ready.revision, finished_at: ready.finished_at, viewUrl: previewViewUrl(project.slug, previewToken(secret, project.id, ready.id), ready.id, ready.entry_html) } : null,
  };
}

/** Text of the first template file for a deck. */
async function initialQmd(app: FastifyInstance, project: SlideProject, template: DeckTemplate, user: CurrentUser) {
  const study = (await app.db.query<{ title: string }>("SELECT title FROM studies WHERE id=$1", [project.study_id])).rows[0];
  const date = taipeiToday();
  let paper = (project.metadata?.paper ?? null) as { title?: string } | null;
  if (project.paper_id) {
    const linked = await app.db.query<{ title: string }>("SELECT title FROM papers WHERE id=$1", [project.paper_id]).catch(() => null);
    if (linked?.rows[0]) paper = linked.rows[0];
  }
  const title = template === "progress" ? (project.title || progressTitle(study?.title ?? "", date)) : template === "paper_report" ? (paper?.title ?? project.title) : project.title;
  return templateQmd(template, { title, author: user.name, date, ...(template === "paper_report" ? { subtitle: "〔第一作者 et al., 會議 年份〕" } : {}) });
}

/** Creates the tree of a deck from a template (inside the caller's transaction). */
export async function initSource(app: FastifyInstance, client: Parameters<typeof createTree>[0], project: SlideProject, template: DeckTemplate, user: CurrentUser) {
  await createTree(client, project.id, user.id, template, [{ path: "index.qmd", content: await initialQmd(app, project, template, user) }]);
}

function sendFileBody(reply: FastifyReply, body: Buffer | NodeJS.ReadableStream, type: string) {
  return reply
    .header("Content-Type", type)
    .header("Cache-Control", "private, no-store")
    .header("X-Content-Type-Options", "nosniff")
    .header("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox")
    .send(body);
}

const slideSources: FastifyPluginAsync = async app => {
  const secret = app.config.AUTH_SECRET;
  // Accepted suggestions on a source file (assistant / viewer / MCP): queue a preview so the deck page shows the change.
  setDeckSourcePreview(async (fileId, actorId) => {
    const deckId = (await app.db.query<{ deck_id: string }>("SELECT deck_id FROM deck_sources WHERE id=$1", [fileId])).rows[0]?.deck_id;
    // Not awaited: packing + upload must not slow down the accept request.
    if (deckId) void enqueuePreview(app.db, app.storage, deckId, actorId).catch(error => app.log.warn({ err: error, deckId }, "preview after accepted suggestion failed"));
  });

  /** The deck's source tree (text contents included), latest preview and the caller's edit permission. */
  app.get("/slides/:id/source", async (request, reply) => {
    const user = await requireUser(request);
    const { id } = parse(deckParams, request.params);
    const project = await projectById(app.db, id);
    if (!project) throw notFound(MISSING);
    const [tree, files, state, access] = await Promise.all([
      loadTree(app.db, id),
      listFiles(app.db, id, true),
      previewState(app.db, id),
      loadStudyAccess(app.db, project.study_id, user),
    ]);
    const editor = tree ? (await app.db.query<{ name: string }>("SELECT name FROM users WHERE id=$1", [tree.updated_by])).rows[0]?.name ?? null : null;
    return reply.header("Cache-Control", "no-store").send({
      source: tree ? { entry: tree.entry, origin: tree.origin, revision: tree.revision, published_revision: tree.published_revision, updated_at: tree.updated_at, updated_by_name: editor } : null,
      files: tree ? files : [],
      preview: previewInfo(secret, project, state),
      permissions: { edit: access.canEdit },
      limits: SOURCE_LIMITS,
      templates: DECK_TEMPLATES,
    });
  });

  /** Starts in-app editing of a deck that has no tree yet (e.g. created by upload). */
  app.post("/slides/:id/source", async (request, reply) => {
    const { id } = parse(deckParams, request.params);
    const { user, project } = await requireDeckEditor(request, id);
    const { template } = parse(initInput, request.body ?? {});
    try {
      await transaction(app.db, async client => {
        await client.query("SELECT 1 FROM decks WHERE id=$1 FOR UPDATE", [id]);
        if (await loadTree(client, id)) throw conflict("這份簡報已經有原始檔。");
        await initSource(app, client, project, template, user);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict("這份簡報已經有原始檔。");
      throw error;
    }
    return reply.code(201).send({ source: await loadTree(app.db, id), files: await listFiles(app.db, id) });
  });

  app.patch("/slides/:id/source", async request => {
    const { id } = parse(deckParams, request.params);
    const { user } = await requireDeckEditor(request, id);
    const input = parse(treePatch, request.body);
    const entry = sourcePath(input.entry).path;
    if (!entry.endsWith(".qmd")) throw badRequest("入口檔必須是 .qmd 檔。");
    return transaction(app.db, async client => {
      await requireTree(client, id, true);
      if (!(await client.query("SELECT 1 FROM deck_sources WHERE deck_id=$1 AND path=$2", [id, entry])).rowCount) throw badRequest(`找不到 ${entry}。`);
      await client.query("UPDATE deck_source_trees SET entry=$2 WHERE deck_id=$1", [id, entry]);
      return { entry, revision: await touchTree(client, id, user.id) };
    });
  });

  /** Creates or saves a text file. `baseVersion` = the version loaded by the editor (0 or absent for a new file). */
  app.put("/slides/:id/source/files", async request => {
    const { id } = parse(deckParams, request.params);
    const { user } = await requireDeckEditor(request, id);
    const input = parse(textInput, request.body, "檔案內容不正確。");
    return transaction(app.db, async client => {
      await requireTree(client, id, true);
      const saved = await saveText(client, id, input.path, input.content, user.id, input.baseVersion);
      return { file: saved.file, revision: saved.revision };
    });
  });

  /** Uploads a file (multipart: `file`, optional `path`; default `images/<name>` for images, the name otherwise). */
  app.post("/slides/:id/source/files", async (request, reply) => {
    const { id } = parse(deckParams, request.params);
    const { user } = await requireDeckEditor(request, id);
    await requireTree(app.db, id);
    const upload = await receiveUpload(request, SOURCE_LIMITS.binaryBytes);
    try {
      const file = upload.file;
      if (!file || !file.bytes) throw badRequest(`請選擇 ${SOURCE_LIMITS.binaryBytes / 1024 / 1024} MB 以下的檔案。`);
      const name = path.posix.basename(file.filename.replace(/\\/g, "/")).replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+/, "") || "file";
      const extension = path.posix.extname(name).toLowerCase();
      const fallback = /^\.(png|jpe?g|gif|svg|webp)$/.test(extension) ? `images/${name}` : name;
      const target = sourcePath(upload.fields.path?.trim() || fallback);
      if (target.kind === "text") {
        const content = await readFile(file.path, "utf8");
        const saved = await transaction(app.db, async client => {
          await requireTree(client, id, true);
          return saveText(client, id, target.path, content, user.id);
        });
        return reply.code(201).send({ file: saved.file, revision: saved.revision });
      }
      const contentType = BINARY_CONTENT_TYPES[path.posix.extname(target.path).toLowerCase()] ?? "application/octet-stream";
      const fileId = randomUUID();
      const key = sourceKeys.binary(id, fileId);
      await app.storage.put(key, createReadStream(file.path), contentType);
      let saved;
      try {
        saved = await transaction(app.db, async client => {
          await requireTree(client, id, true);
          return saveBinary(client, id, fileId, target.path, key, file.bytes, contentType, user.id);
        });
      } catch (error) {
        await app.storage.delete(key).catch(() => {});
        throw error;
      }
      if (saved.replacedKey) await app.storage.delete(saved.replacedKey).catch(() => {});
      return reply.code(201).send({ file: saved.file, revision: saved.revision });
    } finally {
      await upload.cleanup();
    }
  });

  /** Raw file (images shown in the editor's file tree). Sandboxed, never rendered as a page. */
  app.get("/slides/:id/source/files/:fileId/raw", async (request, reply) => {
    await requireUser(request);
    const { id, fileId } = parse(fileParams, request.params, "找不到檔案。");
    const file = await fileById(app.db, id, fileId);
    if (!file) throw notFound("找不到檔案。");
    if (file.kind === "text") return sendFileBody(reply, Buffer.from(file.content ?? "", "utf8"), "text/plain; charset=utf-8");
    const object = file.s3_key ? await app.storage.get(file.s3_key) : null;
    if (!object) throw notFound("找不到檔案。");
    return sendFileBody(reply, object.body, file.content_type ?? "application/octet-stream");
  });

  app.patch("/slides/:id/source/files/:fileId", async request => {
    const { id, fileId } = parse(fileParams, request.params);
    const { user } = await requireDeckEditor(request, id);
    const target = sourcePath(parse(renameInput, request.body).path);
    try {
      return await transaction(app.db, async client => {
        const tree = await requireTree(client, id, true);
        const file = await fileById(client, id, fileId, true);
        if (!file) throw notFound("找不到檔案。");
        if (file.kind !== target.kind) throw badRequest("不能變更檔案類型。");
        if (file.path === target.path) return { file, revision: tree.revision };
        await client.query("UPDATE deck_sources SET path=$2,version=version+1,updated_by=$3,updated_at=now() WHERE id=$1", [fileId, target.path, user.id]);
        if (tree.entry === file.path) {
          if (!target.path.endsWith(".qmd")) throw badRequest("入口檔必須是 .qmd 檔。");
          await client.query("UPDATE deck_source_trees SET entry=$2 WHERE deck_id=$1", [id, target.path]);
        }
        const revision = await touchTree(client, id, user.id);
        const { content: _, s3_key: __, ...updated } = (await fileById(client, id, fileId))!;
        return { file: updated, revision };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict("已有同名的檔案。");
      throw error;
    }
  });

  app.delete("/slides/:id/source/files/:fileId", async request => {
    const { id, fileId } = parse(fileParams, request.params);
    const { user } = await requireDeckEditor(request, id);
    const result = await transaction(app.db, async client => {
      const tree = await requireTree(client, id, true);
      const file = await fileById(client, id, fileId, true);
      if (!file) throw notFound("找不到檔案。");
      if (file.path === tree.entry) throw badRequest("不能刪除入口檔。");
      await client.query("DELETE FROM deck_sources WHERE id=$1", [fileId]);
      await deleteSuggestionsOf(client, "deck_source", fileId);
      return { key: file.s3_key, revision: await touchTree(client, id, user.id) };
    });
    if (result.key) await app.storage.delete(result.key).catch(error => request.log.warn({ err: error }, "source file cleanup failed"));
    return { ok: true, revision: result.revision };
  });

  /** Queues a quick preview of the current revision (debounced by the editor). */
  app.post("/slides/:id/source/preview", async (request, reply) => {
    const { id } = parse(deckParams, request.params);
    const { user, project } = await requireDeckEditor(request, id);
    const { reused } = await enqueuePreview(app.db, app.storage, id, user.id);
    return reply.code(reused ? 200 : 202).send({ preview: previewInfo(secret, project, await previewState(app.db, id)) });
  });

  app.get("/slides/:id/source/preview", async (request, reply) => {
    await requireUser(request);
    const { id } = parse(deckParams, request.params);
    const project = await projectById(app.db, id);
    if (!project) throw notFound(MISSING);
    return reply.header("Cache-Control", "no-store").send({ preview: previewInfo(secret, project, await previewState(app.db, id)) });
  });

  /** 「發布新版本」: packs the tree into a Quarto ZIP and renders it as a new version (same flow as an upload). */
  app.post("/slides/:id/source/publish", async (request, reply) => {
    const { id } = parse(deckParams, request.params);
    const { user } = await requireDeckEditor(request, id);
    const published = (await publishTree(app.db, app.storage, id, user.id, { maxZipBytes: app.config.MAX_SLIDE_ZIP_BYTES }))!;
    return reply.code(202).send({ versionId: published.versionId, version: published.version, jobId: published.jobId, revision: published.revision, sourceType: "quarto", entry: published.entry });
  });
};

export type { PreviewRow };
export default slideSources;
