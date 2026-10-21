/**
 * LaTeX compile + outputs + versions (child of routes/latex.ts). A compile snapshots the project, enqueues
 * `latex_compile` for latex-runner and is applied by the finalizer (jobs/latex-finalizer.ts).
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { cancelJob } from "../jobs/queue.js";
import { HttpError, notFound, parse } from "../lib/http.js";
import type { StoredObject } from "../lib/storage.js";
import { COMPILE_SELECT, compileView, createVersion, findCompile, requestCompile, restoreVersion } from "../lib/latex-projects/service.js";
import { findProject } from "../lib/latex-projects/store.js";
import { depsOf, editableProject, projectDetail, projectFor } from "./latex-shared.js";

const projectParams = z.object({ id: z.uuid() });
const compileParams = z.object({ id: z.uuid(), compileId: z.uuid() });
const versionParams = z.object({ id: z.uuid(), versionId: z.uuid() });
const compileInput = z.object({ draft: z.boolean().optional() });
const versionInput = z.object({ label: z.string().trim().max(200).default("") });

async function sendObject(reply: FastifyReply, get: () => Promise<StoredObject | null>, type: string, extra: Record<string, string> = {}) {
  let object: StoredObject | null;
  try {
    object = await get();
  } catch (error) {
    if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 416) return reply.code(416).send({ error: "範圍不正確。" });
    throw error;
  }
  if (!object) throw notFound("編譯結果已不存在，請重新編譯。");
  reply.header("Content-Type", type).header("Accept-Ranges", "bytes").header("X-Content-Type-Options", "nosniff")
    // Compile outputs never change (one prefix per compile).
    .header("Cache-Control", "private, max-age=3600").header("Content-Security-Policy", "default-src 'none'; sandbox");
  for (const [k, v] of Object.entries(extra)) reply.header(k, v);
  if (object.contentLength !== undefined) reply.header("Content-Length", object.contentLength);
  if (object.contentRange) reply.code(206).header("Content-Range", object.contentRange);
  return reply.send(object.body);
}

export default async function latexCompile(app: FastifyInstance) {
  const deps = () => depsOf(app);

  app.post("/latex/:id/compile", async (request, reply) => {
    const { id } = parse(projectParams, request.params);
    const input = parse(compileInput, request.body ?? {});
    const { user, project } = await editableProject(request, id);
    const compileId = await requestCompile(deps(), project, { actorId: user.id, draft: input.draft });
    reply.code(202);
    return { compile: compileView(await findCompile(app.db, id, compileId)) };
  });

  app.get("/latex/:id/compiles", async (request, reply) => {
    const { id } = parse(projectParams, request.params);
    await projectFor(request, id);
    const rows = (await app.db.query(`${COMPILE_SELECT} WHERE c.project_id=$1 ORDER BY c.created_at DESC LIMIT 20`, [id])).rows;
    reply.header("Cache-Control", "no-store");
    return { compiles: rows.map((r) => compileView(r as never)) };
  });

  app.get("/latex/:id/compiles/:compileId", async (request, reply) => {
    const { id, compileId } = parse(compileParams, request.params);
    await projectFor(request, id);
    const row = await findCompile(app.db, id, compileId);
    if (!row) throw notFound("找不到這次編譯。");
    reply.header("Cache-Control", "no-store");
    return { compile: compileView(row) };
  });

  app.delete("/latex/:id/compiles/:compileId", async (request) => {
    const { id, compileId } = parse(compileParams, request.params);
    await editableProject(request, id);
    const row = await findCompile(app.db, id, compileId);
    if (!row) throw notFound("找不到這次編譯。");
    const cancelled = row.job_id && (row.status === "queued" || row.status === "running") ? await cancelJob(app.db, row.job_id) : false;
    return { ok: true, cancelled };
  });

  const output = (kind: "pdf_key" | "synctex_key" | "log_key" | "blg_key") => async (id: string, compileId: string) => {
    const row = await findCompile(app.db, id, compileId);
    const key = row?.[kind];
    if (!row || !key) throw notFound("這次編譯沒有這個檔案。");
    return { row, key };
  };

  app.get("/latex/:id/compiles/:compileId/pdf", async (request, reply) => {
    const { id, compileId } = parse(compileParams, request.params);
    const { project } = await projectFor(request, id);
    const { key } = await output("pdf_key")(id, compileId);
    const name = `${project.title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").slice(0, 120) || "output"}.pdf`;
    const disposition = (request.query as { download?: string }).download ? "attachment" : "inline";
    return sendObject(reply, () => app.storage.get(key, request.headers.range), "application/pdf", {
      "Content-Disposition": `${disposition}; filename="output.pdf"; filename*=UTF-8''${encodeURIComponent(name)}`,
    });
  });

  app.get("/latex/:id/compiles/:compileId/synctex", async (request, reply) => {
    const { id, compileId } = parse(compileParams, request.params);
    await projectFor(request, id);
    const { key } = await output("synctex_key")(id, compileId);
    return sendObject(reply, () => app.storage.get(key, request.headers.range), "application/gzip");
  });

  app.get("/latex/:id/compiles/:compileId/log", async (request, reply) => {
    const { id, compileId } = parse(compileParams, request.params);
    await projectFor(request, id);
    const which = (request.query as { file?: string }).file === "blg" ? "blg_key" : "log_key";
    const { key } = await output(which)(id, compileId);
    return sendObject(reply, () => app.storage.get(key, request.headers.range), "text/plain; charset=utf-8");
  });

  // ---- versions

  app.get("/latex/:id/versions", async (request, reply) => {
    const { id } = parse(projectParams, request.params);
    await projectFor(request, id);
    const versions = (await app.db.query(
      `SELECT v.id, v.kind, v.label, v.file_count, v.bytes, v.created_at, u.name AS created_by_name
         FROM latex_versions v LEFT JOIN users u ON u.id=v.created_by WHERE v.project_id=$1 ORDER BY v.created_at DESC LIMIT 200`,
      [id],
    )).rows;
    reply.header("Cache-Control", "no-store");
    return { versions };
  });

  app.post("/latex/:id/versions", async (request, reply) => {
    const { id } = parse(projectParams, request.params);
    const input = parse(versionInput, request.body ?? {});
    const { user, project } = await editableProject(request, id);
    const version = await createVersion(deps(), project, { kind: "manual", label: input.label, actorId: user.id });
    reply.code(201);
    return { version };
  });

  app.post("/latex/:id/versions/:versionId/restore", async (request) => {
    const { id, versionId } = parse(versionParams, request.params);
    const { user, project, access } = await editableProject(request, id);
    const version = await restoreVersion(deps(), project, versionId, user.id);
    const fresh = await findProject(app.db, id);
    if (!fresh) throw new HttpError(410, "專案已不存在。");
    return { version, ...(await projectDetail(app, fresh, access)) };
  });
}
