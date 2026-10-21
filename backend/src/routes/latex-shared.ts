/** Helpers shared by the LaTeX route plugins (latex.ts, latex-compile.ts, latex-ai.ts). */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireUser, type CurrentUser } from "../lib/auth.js";
import { forbidden, notFound } from "../lib/http.js";
import { loadStudyAccess, permissionsOf, type StudyAccess } from "../lib/studies/access.js";
import { compileView, findCompile, type LatexDeps } from "../lib/latex-projects/service.js";
import {
  bibFileOf, findProject, isGeneratedBib, liveText, MAX_BINARY_BYTES, MAX_FILES, MAX_TEXT_BYTES, sectionsOf, sectionTitle, type FileRow, type ProjectRow,
} from "../lib/latex-projects/store.js";

const MISSING = "LaTeX 專案不存在。";

export type ProjectContext = { user: CurrentUser; project: ProjectRow; access: StudyAccess };

/** The project, the caller and their study access (404 when missing). Everyone signed in reads. */
export async function projectFor(request: FastifyRequest, id: string): Promise<ProjectContext> {
  const user = await requireUser(request);
  const project = await findProject(request.server.db, id);
  if (!project) throw notFound(MISSING);
  return { user, project, access: await loadStudyAccess(request.server.db, project.study_id, user) };
}

/** Same, 403 unless the caller is a study owner/member. */
export async function editableProject(request: FastifyRequest, id: string): Promise<ProjectContext> {
  const ctx = await projectFor(request, id);
  if (!ctx.access.canEdit) throw forbidden("只有研究成員可以修改。");
  return ctx;
}

export const depsOf = (app: FastifyInstance): LatexDeps => ({ db: app.db, storage: app.storage, collab: app.collab ?? null });

export function fileView(f: FileRow & { updated_by_name?: string | null }, project: ProjectRow) {
  return {
    id: f.id, path: f.path, kind: f.kind, role: f.role, position: f.position, bytes: Number(f.bytes), content_type: f.content_type, updated_at: f.updated_at,
    updated_by_name: f.updated_by_name ?? null, title: f.kind === "text" && /\.tex$/i.test(f.path) ? sectionTitle(f.content ?? "") : null,
    generated: f.kind === "text" && isGeneratedBib({ bib_mode: project.bib_mode, settings: project.settings, path: f.path }),
  };
}

export async function projectDetail(app: FastifyInstance, project: ProjectRow, access: StudyAccess) {
  const files = (await app.db.query<FileRow & { updated_by_name: string | null }>(
    `SELECT f.id,f.project_id,f.path,f.kind,f.role,f.position,CASE WHEN f.path ~* '\\.tex$' THEN left(f.content, 20000) END AS content,f.s3_key,f.bytes,
            f.content_type,f.sha256,f.blob_sha256,f.updated_by,f.updated_at,u.name AS updated_by_name
       FROM latex_files f LEFT JOIN users u ON u.id=f.updated_by WHERE f.project_id=$1 ORDER BY f.path`,
    [project.id],
  )).rows;
  const root = files.find((f) => f.path === project.root_file && f.kind === "text") ?? null;
  const rootText = root ? await liveText(app.db, app.collab, root) : "";
  const views = files.map((f) => fileView(f, project));
  const titles = new Map(views.map((v) => [v.id, v.title]));
  const latest = project.last_compile_id ? compileView(await findCompile(app.db, project.id, project.last_compile_id)) : null;
  const pdf = project.last_pdf_compile_id ? compileView(await findCompile(app.db, project.id, project.last_pdf_compile_id)) : null;
  return {
    project: { ...project, bib_file: bibFileOf(project) },
    study: { id: access.study.id, slug: access.study.slug, title: access.study.title },
    files: views,
    root_file_id: root?.id ?? null,
    sections: sectionsOf(rootText, files, titles),
    permissions: permissionsOf(access),
    latest_compile: latest,
    pdf_compile: pdf,
    limits: { textBytes: MAX_TEXT_BYTES, binaryBytes: MAX_BINARY_BYTES, files: MAX_FILES },
  };
}

