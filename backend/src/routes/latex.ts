/**
 * LaTeX editor (spec §3, §10, §13 #14): projects per study, files (text = Yjs documents `latex:<p>:<f>`, binary =
 * content-addressed S3 blobs), sections (the root file's `\input` list), ZIP import/export. Child plugins:
 * `latex-compile.ts` (compile, outputs, versions) and `latex-ai.ts` (AI suggestions). See docs/architecture.md "LaTeX".
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { transaction } from "../db.js";
import { badRequest, conflict, HttpError, notFound, parse } from "../lib/http.js";
import { LATEX_COMPILERS, type LatexCompiler } from "../lib/latex/contract.js";
import { listInputs } from "../lib/latex/inputs.js";
import { LATEX_TEMPLATES, nextSectionName, type LatexTemplateId } from "../lib/latex/templates.js";
import { writeZip } from "../lib/slides/zip-write.js";
import { loadStudyAccess, permissionsOf, requireStudyEditor, requireStudyReader } from "../lib/studies/access.js";
import { recordActivity } from "../lib/studies/activity.js";
import {
  addSectionFile, createProjectFromTemplate, createVersion, deleteFile, regenerateBib, renameFile, reorderSections, retitleSection, rootFile,
  TEMPLATE_IDS,
} from "../lib/latex-projects/service.js";
import {
  bibFileOf, cleanupStorage, contentTypeOf, findFile, findFileByPath, findProject, forgetProjectDocs, disconnectDocs, insertTextFile,
  isBlockedPath, isTextPath, LATEX_KINDS, latexDocName, latexKeys, latexUrl, listFiles, liveText, MAX_BINARY_BYTES, MAX_FILES, MAX_TEXT_BYTES, PATH_RULES, roleOf,
  sha256Hex, validProjectPath, type LatexKind,
} from "../lib/latex-projects/store.js";
import { decodeText, detectCompiler, detectRoot, importablePath, readProjectZip } from "../lib/latex-projects/zip.js";
import { registerLatexFinalizer } from "../jobs/latex-finalizer.js";
import latexCompile from "./latex-compile.js";
import { depsOf, editableProject, fileView, projectDetail, projectFor } from "./latex-shared.js";
import latexAi from "./latex-ai.js";
import "../lib/latex-projects/agent-tools.js";

const refParams = z.object({ ref: z.string().min(1).max(80) });
const projectParams = z.object({ id: z.uuid() });
const fileParams = z.object({ id: z.uuid(), fileId: z.uuid() });
const title = z.string().trim().min(1).max(200);
const kind = z.enum(LATEX_KINDS as [LatexKind, ...LatexKind[]]);
const compiler = z.enum(LATEX_COMPILERS);
const createInput = z.object({
  title,
  kind: kind.default("paper"),
  template: z.enum(TEMPLATE_IDS).default("article-zh"),
  compiler: compiler.optional(),
  bib_mode: z.enum(["auto", "manual"]).default("auto"),
  author: z.string().trim().max(100).optional(),
  advisor: z.string().trim().max(100).optional(),
  institution: z.string().trim().max(200).optional(),
});
const patchInput = z.object({
  title: title.optional(),
  kind: kind.optional(),
  compiler: compiler.optional(),
  bib_mode: z.enum(["auto", "manual"]).optional(),
  root_file: z.string().min(1).max(255).optional(),
  bib_file: z.string().min(1).max(255).optional(),
  halt_on_error: z.boolean().optional(),
  section_command: z.enum(["chapter", "section"]).optional(),
});
const textFileInput = z.object({ path: z.string().trim().min(1).max(255), content: z.string().max(MAX_TEXT_BYTES).default("") });
const renameInput = z.object({ path: z.string().trim().min(1).max(255) });
const sectionInput = z.object({
  title: z.string().trim().min(1).max(200),
  name: z.string().trim().max(64).optional(),
  after: z.uuid().nullable().optional(),
});
const sectionPatch = z.object({ title: z.string().trim().min(1).max(200).optional(), name: z.string().trim().min(1).max(64).optional() });
const orderInput = z.object({ order: z.array(z.uuid()).min(1).max(MAX_FILES) });
const uploadQuery = z.object({ path: z.string().trim().min(1).max(255).optional() });

/** Project list card. */
async function projectCards(app: FastifyInstance, studyId: string) {
  return (
    await app.db.query(
      `SELECT p.id, p.title, p.kind, p.template, p.compiler, p.bib_mode, p.root_file, p.created_at, p.updated_at, uu.name AS updated_by_name,
              (SELECT count(*)::int FROM latex_files f WHERE f.project_id=p.id) AS file_count,
              (SELECT count(*)::int FROM latex_files f WHERE f.project_id=p.id AND f.position IS NOT NULL) AS section_count,
              lc.id AS last_compile_id, lc.status AS last_compile_status, lc.finished_at AS last_compile_at,
              CASE WHEN pc.pdf_key IS NOT NULL THEN '/api/latex/' || p.id || '/compiles/' || pc.id || '/pdf' END AS pdf_url,
              pc.finished_at AS pdf_at
         FROM latex_projects p LEFT JOIN users uu ON uu.id=p.updated_by
         LEFT JOIN latex_compiles lc ON lc.id=p.last_compile_id LEFT JOIN latex_compiles pc ON pc.id=p.last_pdf_compile_id
        WHERE p.study_id=$1 ORDER BY p.updated_at DESC`,
      [studyId],
    )
  ).rows;
}

/** Streams a multipart file part to a temp file, hashing it. */
async function receivePart(file: NodeJS.ReadableStream & { truncated?: boolean }, dir: string) {
  const path = join(dir, "upload");
  const hash = createHash("sha256");
  let bytes = 0;
  await pipeline(
    file,
    new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        bytes += chunk.length;
        cb(null, chunk);
      },
    }),
    createWriteStream(path),
  );
  if (file.truncated) throw new HttpError(413, `檔案超過大小限制（${MAX_BINARY_BYTES / 1024 / 1024} MB）。`);
  return { path, sha: hash.digest("hex"), bytes };
}

async function latexRoutes(app: FastifyInstance) {
  cleanupStorage.storage = app.storage;
  registerLatexFinalizer(app);
  const deps = () => depsOf(app);

  // ---- projects

  app.get("/studies/:ref/latex", async (request, reply) => {
    const { ref } = parse(refParams, request.params);
    const { access } = await requireStudyReader(request, ref);
    reply.header("Cache-Control", "no-store");
    return {
      projects: await projectCards(app, access.study.id),
      permissions: permissionsOf(access),
      templates: LATEX_TEMPLATES.map((t) => ({ id: t.id, name_zh: t.name_zh, name_en: t.name_en, description_zh: t.description_zh, description_en: t.description_en, compiler: t.compiler, kind: t.id === "zh-thesis" ? "thesis" : "paper" })),
    };
  });

  app.post("/studies/:ref/latex", async (request, reply) => {
    const { ref } = parse(refParams, request.params);
    const input = parse(createInput, request.body);
    const { user, access } = await requireStudyEditor(request, ref);
    const advisor = (await app.db.query<{ name: string }>(
      "SELECT u.name FROM study_members m JOIN users u ON u.id=m.user_id WHERE m.study_id=$1 AND m.role='advisor' ORDER BY m.added_at LIMIT 1",
      [access.study.id],
    )).rows[0]?.name;
    // pdfLaTeX templates cannot typeset CJK names: keep their placeholder unless the name is ASCII.
    const info = LATEX_TEMPLATES.find((t) => t.id === input.template)!;
    const fits = (name: string | undefined) => (name && ((input.compiler ?? info.compiler) !== "pdflatex" || /^[\x20-\x7e]*$/.test(name)) ? name : undefined);
    const id = await transaction(app.db, (client) =>
      createProjectFromTemplate(client, {
        studyId: access.study.id, studySlug: access.study.slug, title: input.title, kind: input.kind, template: input.template as LatexTemplateId,
        compiler: input.compiler, bibMode: input.bib_mode, author: input.author ?? fits(user.name), advisor: input.advisor ?? fits(advisor), institution: input.institution, actorId: user.id,
      }),
    );
    const project = (await findProject(app.db, id))!;
    reply.code(201);
    return { project, url: latexUrl(access.study.slug, id) };
  });

  app.post("/studies/:ref/latex/import", async (request, reply) => {
    const { ref } = parse(refParams, request.params);
    const { user, access } = await requireStudyEditor(request, ref);
    if (!request.isMultipart()) throw badRequest("請上傳 ZIP 檔。");
    const dir = await mkdtemp(join(tmpdir(), "latex-import-"));
    try {
      let projectTitle = "";
      let projectKind: LatexKind = "paper";
      let zipPath: string | null = null;
      for await (const part of request.parts({ limits: { fileSize: 300 * 1024 * 1024, files: 1 } })) {
        if (part.type === "field") {
          if (part.fieldname === "title" && typeof part.value === "string") projectTitle = part.value.trim().slice(0, 200);
          if (part.fieldname === "kind" && (LATEX_KINDS as string[]).includes(String(part.value))) projectKind = part.value as LatexKind;
          continue;
        }
        zipPath = join(dir, "project.zip");
        await pipeline(part.file, createWriteStream(zipPath));
        if (part.file.truncated) throw new HttpError(413, "ZIP 超過大小限制（300 MB）。");
        if (!projectTitle) projectTitle = (part.filename ?? "").replace(/\.zip$/i, "").slice(0, 200);
      }
      if (!zipPath || !(await stat(zipPath)).size) throw badRequest("請上傳 ZIP 檔。");
      const entries = await readProjectZip(zipPath);
      const skipped: string[] = [];
      const files: { path: string; text: string | null; data: Buffer }[] = [];
      for (const e of entries) {
        if (!importablePath(e.path)) {
          skipped.push(e.path);
          continue;
        }
        files.push({ path: e.path, text: isTextPath(e.path) ? decodeText(e.data) : null, data: e.data });
      }
      const tex = files.filter((f) => /\.(tex|ltx)$/i.test(f.path) && f.text !== null).map((f) => ({ path: f.path, text: f.text! }));
      const root = detectRoot(tex);
      if (!root) throw badRequest("ZIP 裡找不到主檔（含 \\documentclass 與 \\begin{document} 的 .tex 檔）。");
      const rootText = tex.find((f) => f.path === root)!.text;
      const sectionPaths = new Set(listInputs(rootText).map((e) => e.path));
      const order = listInputs(rootText).map((e) => e.path);
      // Binary blobs first (outside the transaction), content-addressed.
      const blobs = new Map<string, { key: string; sha: string }>();
      const id = (await app.db.query<{ id: string }>("SELECT gen_random_uuid() AS id")).rows[0]!.id;
      try {
        for (const f of files) {
          if (f.text !== null) continue;
          const sha = sha256Hex(f.data);
          const key = latexKeys.blob(id, sha);
          await app.storage.put(key, f.data, contentTypeOf(f.path));
          blobs.set(f.path, { key, sha });
        }
        const bib = files.find((f) => /\.bib$/i.test(f.path) && f.text !== null)?.path ?? "refs.bib";
        await transaction(app.db, async (client) => {
          await client.query(
            `INSERT INTO latex_projects(id,study_id,title,kind,template,root_file,compiler,bib_mode,settings,created_by,updated_by)
             VALUES($1,$2,$3,$4,'import',$5,$6,'manual',$7,$8,$8)`,
            [id, access.study.id, projectTitle || "匯入的專案", projectKind, root, detectCompiler(rootText), JSON.stringify({ bibFile: bib, sectionCommand: /\\chapter\b/.test(tex.map((t) => t.text).join("\n")) ? "chapter" : "section" }), user.id],
          );
          for (const f of files) {
            const role = roleOf(f.path, root, sectionPaths);
            const position = order.indexOf(f.path);
            if (f.text !== null) {
              await insertTextFile(client, { projectId: id, path: f.path, content: f.text, role, position: position >= 0 ? position : null, actorId: user.id });
            } else {
              const blob = blobs.get(f.path)!;
              await client.query(
                `INSERT INTO latex_files(project_id,path,kind,role,s3_key,bytes,content_type,sha256,created_by,updated_by) VALUES($1,$2,'binary',$3,$4,$5,$6,$7,$8,$8)`,
                [id, f.path, role, blob.key, f.data.length, contentTypeOf(f.path), blob.sha, user.id],
              );
            }
          }
          await recordActivity(client, { studyId: access.study.id, actorId: user.id, kind: "latex_project_created", title: projectTitle || "匯入的專案", url: latexUrl(access.study.slug, id), targetType: "latex_project", targetId: id });
        });
      } catch (e) {
        // Nothing references the uploaded blobs when the import did not commit.
        await app.storage.deletePrefix(latexKeys.prefix(id)).catch(() => {});
        throw e;
      }
      const project = (await findProject(app.db, id))!;
      await createVersion(deps(), project, { kind: "import", label: "匯入 ZIP", actorId: user.id }).catch((e) => request.log.warn({ err: e }, "import version failed"));
      reply.code(201);
      return { project, url: latexUrl(access.study.slug, id), files: files.length, skipped };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  app.get("/latex/:id", async (request, reply) => {
    const { id } = parse(projectParams, request.params);
    const { project, access } = await projectFor(request, id);
    reply.header("Cache-Control", "no-store");
    return projectDetail(app, project, access);
  });

  app.patch("/latex/:id", async (request) => {
    const { id } = parse(projectParams, request.params);
    const input = parse(patchInput, request.body);
    const { user, project } = await editableProject(request, id);
    if (input.root_file !== undefined) {
      const file = await findFileByPath(app.db, id, input.root_file);
      if (!file || file.kind !== "text" || !/\.(tex|ltx)$/i.test(input.root_file)) throw badRequest("主檔必須是專案裡的 .tex 檔。");
    }
    if (input.bib_file !== undefined && (!validProjectPath(input.bib_file) || !/\.bib$/i.test(input.bib_file))) throw badRequest("參考文獻檔必須是 .bib 檔。");
    const settings = { ...project.settings };
    if (input.bib_file !== undefined) settings.bibFile = input.bib_file;
    if (input.halt_on_error !== undefined) settings.haltOnError = input.halt_on_error;
    if (input.section_command !== undefined) settings.sectionCommand = input.section_command;
    await app.db.query(
      `UPDATE latex_projects SET title=coalesce($2,title), kind=coalesce($3,kind), compiler=coalesce($4,compiler), bib_mode=coalesce($5,bib_mode),
              root_file=coalesce($6,root_file), settings=$7, updated_at=now(), updated_by=$8 WHERE id=$1`,
      [id, input.title ?? null, input.kind ?? null, input.compiler ?? null, input.bib_mode ?? null, input.root_file ?? null, JSON.stringify(settings), user.id],
    );
    const fresh = (await findProject(app.db, id))!;
    if (input.root_file !== undefined) {
      const root = await rootFile(app.db, fresh);
      await transaction(app.db, async (client) => {
        await client.query("UPDATE latex_files SET role=CASE WHEN path=$2 THEN 'main' WHEN role='main' THEN 'other' ELSE role END WHERE project_id=$1", [id, fresh.root_file]);
        const { syncSectionPositions } = await import("../lib/latex-projects/store.js");
        await syncSectionPositions(client, fresh, await liveText(client, app.collab, root));
      });
    }
    // The bib file's read-only state follows bib_mode: reconnect its editors.
    if (input.bib_mode !== undefined || input.bib_file !== undefined) {
      for (const path of new Set([bibFileOf(project), bibFileOf(fresh)])) {
        const bibFile = await findFileByPath(app.db, id, path);
        if (bibFile) app.collab.closeDocument(latexDocName(id, bibFile.id));
      }
    }
    for (const f of await listFiles(app.db, id)) if (f.kind === "text") app.collab.broadcast(latexDocName(id, f.id), { type: "latex_meta" });
    return { project: fresh };
  });

  app.delete("/latex/:id", async (request) => {
    const { id } = parse(projectParams, request.params);
    const { project } = await editableProject(request, id);
    const names = await transaction(app.db, async (client) => {
      const n = await forgetProjectDocs(client, [project.id]);
      await client.query("UPDATE latex_projects SET last_compile_id=NULL, last_pdf_compile_id=NULL WHERE id=$1", [project.id]);
      const jobs = (await client.query<{ job_id: string }>("SELECT job_id FROM latex_compiles WHERE project_id=$1 AND job_id IS NOT NULL AND status IN ('queued','running')", [project.id])).rows;
      const { cancelJob } = await import("../jobs/queue.js");
      for (const j of jobs) await cancelJob(client, j.job_id);
      await client.query("DELETE FROM latex_projects WHERE id=$1", [project.id]);
      return n;
    });
    disconnectDocs(names);
    await app.storage.deletePrefix(latexKeys.prefix(project.id)).catch((e) => request.log.warn({ err: e }, "latex prefix delete failed"));
    return { ok: true };
  });

  // ---- files

  app.post("/latex/:id/files", async (request, reply) => {
    const { id } = parse(projectParams, request.params);
    const { user, project } = await editableProject(request, id);
    if (request.isMultipart()) {
      const { path: wanted } = parse(uploadQuery, request.query);
      const part = await request.file({ limits: { fileSize: MAX_BINARY_BYTES, files: 1 } });
      if (!part) throw badRequest("請選擇檔案。");
      const name = (part.filename || "file").replace(/[\\/]/g, "_").replace(/\s+/g, "-");
      const path = wanted ?? (/\.(png|jpe?g|gif|svg|webp|pdf|eps)$/i.test(name) ? `figures/${name}` : name);
      if (!validProjectPath(path)) throw badRequest(PATH_RULES);
      if (isBlockedPath(path)) throw badRequest("不能上傳執行檔或網頁檔。");
      const dir = await mkdtemp(join(tmpdir(), "latex-up-"));
      try {
        const received = await receivePart(part.file, dir);
        const existing = await findFileByPath(app.db, id, path);
        if (existing && existing.kind === "text") throw conflict("已經有同名的文字檔，請先刪除或改名。");
        if (isTextPath(path) && !existing) {
          // Text uploads (.bib, .sty…) become editable documents.
          const { readFile } = await import("node:fs/promises");
          const text = received.bytes <= MAX_TEXT_BYTES ? decodeText(await readFile(received.path)) : null;
          // A small text-type file that is not UTF-8 (Big5, UTF-16…) would silently become an uneditable blob.
          if (text === null && received.bytes <= MAX_TEXT_BYTES) throw badRequest(`「${path}」不是 UTF-8 文字檔，請先轉成 UTF-8 再上傳。`);
          if (text !== null) {
            const fileId = await transaction(app.db, (client) => insertTextFile(client, { projectId: id, path, content: text, role: roleOf(path, project.root_file, new Set()), actorId: user.id }));
            reply.code(201);
            return { file: fileView((await findFile(app.db, id, fileId))!, project) };
          }
        }
        const count = (await app.db.query<{ n: number }>("SELECT count(*)::int AS n FROM latex_files WHERE project_id=$1", [id])).rows[0]!.n;
        if (!existing && count >= MAX_FILES) throw badRequest(`每個專案最多 ${MAX_FILES} 個檔案。`);
        const key = latexKeys.blob(id, received.sha);
        await app.storage.put(key, createReadStream(received.path), contentTypeOf(path));
        const row = (await app.db.query<{ id: string }>(
          `INSERT INTO latex_files(project_id,path,kind,role,s3_key,bytes,content_type,sha256,created_by,updated_by) VALUES($1,$2,'binary',$3,$4,$5,$6,$7,$8,$8)
           ON CONFLICT (project_id,path) DO UPDATE SET s3_key=EXCLUDED.s3_key, bytes=EXCLUDED.bytes, sha256=EXCLUDED.sha256, content_type=EXCLUDED.content_type,
             updated_at=now(), updated_by=EXCLUDED.updated_by RETURNING id`,
          [id, path, roleOf(path, project.root_file, new Set()), key, received.bytes, contentTypeOf(path), received.sha, user.id],
        )).rows[0]!;
        await app.db.query("UPDATE latex_projects SET updated_at=now(), updated_by=$2 WHERE id=$1", [id, user.id]);
        reply.code(201);
        return { file: fileView((await findFile(app.db, id, row.id))!, project) };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
    const input = parse(textFileInput, request.body);
    if (!validProjectPath(input.path)) throw badRequest(PATH_RULES);
    if (!isTextPath(input.path)) throw badRequest("這種檔案請用上傳。");
    const fileId = await transaction(app.db, async (client) => {
      await client.query("SELECT 1 FROM latex_projects WHERE id=$1 FOR UPDATE", [id]);
      if (await findFileByPath(client, id, input.path)) throw conflict("已經有同名的檔案了。");
      const count = (await client.query<{ n: number }>("SELECT count(*)::int AS n FROM latex_files WHERE project_id=$1", [id])).rows[0]!.n;
      if (count >= MAX_FILES) throw badRequest(`每個專案最多 ${MAX_FILES} 個檔案。`);
      return insertTextFile(client, { projectId: id, path: input.path, content: input.content, role: roleOf(input.path, project.root_file, new Set()), actorId: user.id });
    });
    reply.code(201);
    return { file: fileView((await findFile(app.db, id, fileId))!, project) };
  });

  app.get("/latex/:id/files/:fileId/raw", async (request, reply) => {
    const { id, fileId } = parse(fileParams, request.params);
    await projectFor(request, id);
    const file = await findFile(app.db, id, fileId);
    if (!file) throw notFound("檔案不存在。");
    reply.header("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Cache-Control", "private, no-store");
    const name = file.path.slice(file.path.lastIndexOf("/") + 1);
    reply.header("Content-Disposition", `inline; filename="file"; filename*=UTF-8''${encodeURIComponent(name)}`);
    if (file.kind === "text") {
      reply.header("Content-Type", "text/plain; charset=utf-8");
      return liveText(app.db, app.collab, file);
    }
    const object = await app.storage.get(file.s3_key!);
    if (!object) throw notFound("檔案不存在。");
    reply.header("Content-Type", file.content_type ?? "application/octet-stream");
    if (object.contentLength !== undefined) reply.header("Content-Length", object.contentLength);
    return reply.send(object.body);
  });

  app.patch("/latex/:id/files/:fileId", async (request) => {
    const { id, fileId } = parse(fileParams, request.params);
    const input = parse(renameInput, request.body);
    const { user, project } = await editableProject(request, id);
    const file = await findFile(app.db, id, fileId);
    if (!file) throw notFound("檔案不存在。");
    await renameFile(deps(), project, file, input.path, user.id);
    return { file: fileView((await findFile(app.db, id, fileId))!, (await findProject(app.db, id))!) };
  });

  app.delete("/latex/:id/files/:fileId", async (request) => {
    const { id, fileId } = parse(fileParams, request.params);
    const { user, project } = await editableProject(request, id);
    const file = await findFile(app.db, id, fileId);
    if (!file) throw notFound("檔案不存在。");
    await deleteFile(deps(), project, file, user.id);
    return { ok: true };
  });

  // ---- sections (tabs)

  app.post("/latex/:id/sections", async (request, reply) => {
    const { id } = parse(projectParams, request.params);
    const input = parse(sectionInput, request.body);
    const { user, project } = await editableProject(request, id);
    const files = await listFiles(app.db, id);
    const name = input.name || nextSectionName(files.map((f) => f.path).filter((p) => p.startsWith("sections/")));
    const fileId = await addSectionFile(deps(), project, { title: input.title, name, afterFileId: input.after ?? null, actorId: user.id });
    const fresh = (await findProject(app.db, id))!;
    reply.code(201);
    return { file: fileView((await findFile(app.db, id, fileId))!, fresh), ...(await projectDetail(app, fresh, await loadStudyAccess(app.db, fresh.study_id, user))) };
  });

  app.patch("/latex/:id/sections/:fileId", async (request) => {
    const { id, fileId } = parse(fileParams, request.params);
    const input = parse(sectionPatch, request.body);
    const { user, project } = await editableProject(request, id);
    const file = await findFile(app.db, id, fileId);
    if (!file || file.kind !== "text" || !/\.tex$/i.test(file.path)) throw notFound("章節不存在。");
    if (file.path === project.root_file) throw badRequest("主檔不是章節。");
    if (input.title) await retitleSection(deps(), file, input.title, user.id);
    if (input.name) {
      const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/") + 1) : "";
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(input.name)) throw badRequest("章節檔名只能使用英數字、- 與 _，且以英數字開頭（最多 64 字）。");
      await renameFile(deps(), project, file, `${dir}${input.name}.tex`, user.id);
    }
    const fresh = (await findProject(app.db, id))!;
    return projectDetail(app, fresh, await loadStudyAccess(app.db, fresh.study_id, user));
  });

  app.put("/latex/:id/sections/order", async (request) => {
    const { id } = parse(projectParams, request.params);
    const input = parse(orderInput, request.body);
    const { user, project } = await editableProject(request, id);
    await reorderSections(deps(), project, input.order, user.id);
    const fresh = (await findProject(app.db, id))!;
    return projectDetail(app, fresh, await loadStudyAccess(app.db, fresh.study_id, user));
  });

  // ---- autocompletion data, bibliography

  app.get("/latex/:id/symbols", async (request, reply) => {
    const { id } = parse(projectParams, request.params);
    const { project } = await projectFor(request, id);
    const files = (await listFiles(app.db, id)).filter((f) => f.kind === "text");
    const labels: { key: string; file_id: string; path: string; line: number }[] = [];
    const bibKeys = new Map<string, { key: string; title: string | null; source: string }>();
    for (const f of files) {
      const text = /\.(tex|ltx|bib)$/i.test(f.path) ? await liveText(app.db, app.collab, f) : "";
      if (/\.(tex|ltx)$/i.test(f.path)) {
        text.split("\n").forEach((line, i) => {
          for (const m of line.replace(/(^|[^\\])%.*$/, "$1").matchAll(/\\label\{([^{}]{1,200})\}/g)) labels.push({ key: m[1]!, file_id: f.id, path: f.path, line: i + 1 });
        });
      } else if (/\.bib$/i.test(f.path)) {
        for (const m of text.matchAll(/@(\w+)\s*\{\s*([^,\s{}]+)\s*,([\s\S]*?)(?=\n@|$)/g)) {
          if (/^(comment|string|preamble)$/i.test(m[1]!)) continue;
          const t = /\btitle\s*=\s*[{"]([\s\S]*?)[}"]\s*,?\s*\n/i.exec(m[3]!)?.[1]?.replace(/[{}]/g, "").replace(/\s+/g, " ").trim() ?? null;
          bibKeys.set(m[2]!, { key: m[2]!, title: t, source: f.path });
        }
      }
    }
    const library = (await app.db.query<{ cite_key: string; title: string; year: number | null; authors_text: string }>(
      "SELECT sp.cite_key, p.title, p.year, p.authors_text FROM study_papers sp JOIN papers p ON p.id=sp.paper_id WHERE sp.study_id=$1 ORDER BY lower(sp.cite_key) LIMIT 2000",
      [project.study_id],
    )).rows;
    reply.header("Cache-Control", "no-store");
    return {
      labels,
      citations: [
        ...library.map((p) => ({ key: p.cite_key, title: p.title, year: p.year, authors: p.authors_text.split(";").slice(0, 3).join(";"), source: "library" })),
        ...[...bibKeys.values()].filter((b) => !library.some((p) => p.cite_key === b.key)).map((b) => ({ key: b.key, title: b.title, year: null, authors: "", source: b.source })),
      ],
      files: (await listFiles(app.db, id)).map((f) => ({ path: f.path, kind: f.kind })),
    };
  });

  app.post("/latex/:id/bib/refresh", async (request) => {
    const { id } = parse(projectParams, request.params);
    const { user, project } = await editableProject(request, id);
    if (project.bib_mode !== "auto") throw badRequest("這個專案的參考文獻是手動管理。");
    return regenerateBib(deps(), project, user.id);
  });

  // ---- ZIP export

  app.get("/latex/:id/export.zip", async (request, reply) => {
    const { id } = parse(projectParams, request.params);
    const { project } = await projectFor(request, id);
    const entries: { path: string; data: Buffer }[] = [];
    for (const f of await listFiles(app.db, id)) {
      if (f.kind === "text") entries.push({ path: f.path, data: Buffer.from(await liveText(app.db, app.collab, f), "utf8") });
      else {
        const data = await app.storage.getBuffer(f.s3_key!);
        if (data) entries.push({ path: f.path, data });
      }
    }
    const name = `${project.title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").slice(0, 120) || "latex"}.zip`;
    reply.header("Content-Type", "application/zip");
    reply.header("Content-Disposition", `attachment; filename="latex.zip"; filename*=UTF-8''${encodeURIComponent(name)}`);
    reply.header("Cache-Control", "no-store");
    return reply.send(writeZip(entries));
  });
}

export default async function latex(app: FastifyInstance) {
  await app.register(latexRoutes);
  await app.register(latexCompile);
  await app.register(latexAi);
}

export type { LatexCompiler };
