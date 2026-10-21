/**
 * Domain operations of LaTeX projects that need the database, S3 and the collab server: create from a template,
 * section add/rename/reorder/delete through the live root document, snapshots (content-addressed blobs + manifest),
 * refs.bib regeneration, compile requests and named versions.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { transaction, type Db, type Queryable } from "../../db.js";
import type { CollabServer } from "../../collab/server.js";
import { replaceText } from "../../collab/text.js";
import { cancelJob, enqueueJob } from "../../jobs/queue.js";
import { badRequest, conflict, HttpError, notFound } from "../http.js";
import type { Storage } from "../storage.js";
import { LATEX_JOB_KIND, type LatexCompilePayload, type LatexCompiler, type LatexSnapshotManifest } from "../latex/contract.js";
import { addInput, removeInput, renameInput, reorderInputs } from "../latex/inputs.js";
import { escapeLatex, generateTemplate, LATEX_TEMPLATES, newSectionContent, sectionPath, templateInfo, type LatexTemplateId } from "../latex/templates.js";
import { exportStudyBibtex } from "../library/study-export.js";
import { recordActivity } from "../studies/activity.js";
import {
  bibFileOf, contentTypeOf, findFile, findFileByPath, findProject, forgetFileDocs, insertTextFile, isGeneratedBib, latexDocName, latexKeys, latexUrl,
  listFiles, liveText, MAX_FILES, roleOf, sectionTitle, setSectionTitle, sha256Hex, syncSectionPositions, validProjectPath, PATH_RULES,
  type FileRole, type FileRow, type LatexBibMode, type LatexKind, type ProjectRow, type ProjectSettings,
} from "./store.js";

export type LatexDeps = { db: Db; storage: Storage; collab: CollabServer | null };

// ---------------------------------------------------------------- create

export type CreateProjectInput = {
  studyId: string;
  studySlug: string;
  title: string;
  kind: LatexKind;
  template: LatexTemplateId;
  compiler?: LatexCompiler;
  bibMode?: LatexBibMode;
  author?: string;
  advisor?: string;
  institution?: string;
  actorId: string;
};

export async function createProjectFromTemplate(client: pg.PoolClient, input: CreateProjectInput): Promise<string> {
  const info = templateInfo(input.template);
  const built = generateTemplate(input.template, { title: input.title, author: input.author, advisor: input.advisor, institution: input.institution });
  const settings: ProjectSettings = { bibFile: "refs.bib", sectionCommand: info.sectionCommand };
  const id = (
    await client.query<{ id: string }>(
      `INSERT INTO latex_projects(study_id,title,kind,template,root_file,compiler,bib_mode,settings,created_by,updated_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING id`,
      [input.studyId, input.title, input.kind, input.template, built.rootFile, input.compiler ?? built.compiler, input.bibMode ?? "auto", JSON.stringify(settings), input.actorId],
    )
  ).rows[0]!.id;
  const sections = new Set(built.sections);
  for (const file of built.files) {
    await insertTextFile(client, {
      projectId: id, path: file.path, content: file.content, role: roleOf(file.path, built.rootFile, sections),
      position: sections.has(file.path) ? built.sections.indexOf(file.path) : null, actorId: input.actorId,
    });
  }
  await recordActivity(client, {
    studyId: input.studyId, actorId: input.actorId, kind: "latex_project_created", title: input.title, url: latexUrl(input.studySlug, id), targetType: "latex_project", targetId: id,
  });
  return id;
}

export const TEMPLATE_IDS = LATEX_TEMPLATES.map((t) => t.id) as [LatexTemplateId, ...LatexTemplateId[]];

// ---------------------------------------------------------------- root document edits

/** The root file row (404 when the project has none, e.g. after a broken import). */
export async function rootFile(db: Queryable, project: ProjectRow): Promise<FileRow> {
  const file = await findFileByPath(db, project.id, project.root_file);
  if (!file || file.kind !== "text") throw notFound(`找不到主檔 ${project.root_file}。`);
  return file;
}

/**
 * Applies `change(text) → text` to the live root document in one Yjs transaction (connected editors see it; a
 * user's concurrent typing merges). Returns the new text. Re-caches section positions.
 */
export async function editRoot(deps: LatexDeps, project: ProjectRow, actorId: string, change: (text: string) => string): Promise<string> {
  const root = await rootFile(deps.db, project);
  let next = "";
  if (deps.collab) {
    next = await deps.collab.edit(latexDocName(project.id, root.id), actorId, (_doc, ytext) => {
      next = change(ytext.toString());
      replaceText(ytext, next);
      return next;
    });
  } else {
    throw new Error("collab server required for root edits");
  }
  await transaction(deps.db, (client) => syncSectionPositions(client, project, next));
  return next;
}

/** Applies a full new text to a text file through its live document. */
export async function replaceFileText(deps: LatexDeps, file: Pick<FileRow, "id" | "project_id">, actorId: string | null, text: string) {
  if (!deps.collab) throw new Error("collab server required");
  return deps.collab.edit(latexDocName(file.project_id, file.id), actorId, (_doc, ytext) => replaceText(ytext, text));
}

async function fileCount(db: Queryable, projectId: string) {
  return (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM latex_files WHERE project_id=$1", [projectId])).rows[0]!.n;
}

/** 「新增章節」: creates `sections/<name>.tex` with a heading and inserts its `\input` (after `afterFileId`, else last). */
export async function addSectionFile(deps: LatexDeps, project: ProjectRow, input: { title: string; name: string; afterFileId?: string | null; actorId: string }) {
  let path: string;
  try {
    path = sectionPath(input.name);
  } catch (e) {
    throw badRequest((e as Error).message);
  }
  if ((await fileCount(deps.db, project.id)) >= MAX_FILES) throw badRequest(`每個專案最多 ${MAX_FILES} 個檔案。`);
  const after = input.afterFileId ? await findFile(deps.db, project.id, input.afterFileId) : null;
  if (input.afterFileId && !after) throw notFound("找不到要接在後面的章節。");
  const command = project.settings?.sectionCommand ?? (project.template === "zh-thesis" ? "chapter" : "section");
  const fileId = await transaction(deps.db, async (client) => {
    await client.query("SELECT 1 FROM latex_projects WHERE id=$1 FOR UPDATE", [project.id]);
    if (await findFileByPath(client, project.id, path)) throw conflict(`已經有 ${path} 了，請換一個檔名。`);
    return insertTextFile(client, { projectId: project.id, path, content: newSectionContent(command, input.title, input.name), role: "section", actorId: input.actorId });
  });
  await editRoot(deps, project, input.actorId, (text) => addInput(text, path, { after: after?.path }));
  return fileId;
}

/** Renames a file; `\input`s of the root file follow (sections keep their tab position). */
export async function renameFile(deps: LatexDeps, project: ProjectRow, file: FileRow, nextPath: string, actorId: string) {
  if (!validProjectPath(nextPath)) throw badRequest(PATH_RULES);
  if (nextPath === file.path) return;
  if (file.path === project.root_file) {
    if (!/\.(tex|ltx)$/i.test(nextPath)) throw badRequest("主檔必須是 .tex 檔。");
  } else if (file.kind === "text" && (/\.tex$/i.test(file.path) !== /\.tex$/i.test(nextPath))) {
    throw badRequest("章節檔必須維持 .tex 副檔名。");
  }
  await transaction(deps.db, async (client) => {
    await client.query("SELECT 1 FROM latex_projects WHERE id=$1 FOR UPDATE", [project.id]);
    if (await findFileByPath(client, project.id, nextPath)) throw conflict("已經有同名的檔案了。");
    await client.query("UPDATE latex_files SET path=$3, content_type=$4, updated_at=now(), updated_by=$5 WHERE id=$1 AND project_id=$2", [file.id, project.id, nextPath, contentTypeOf(nextPath), actorId]);
    if (file.path === project.root_file) await client.query("UPDATE latex_projects SET root_file=$2, updated_at=now() WHERE id=$1", [project.id, nextPath]);
    if (file.path === bibFileOf(project)) {
      await client.query("UPDATE latex_projects SET settings = settings || jsonb_build_object('bibFile', $2::text) WHERE id=$1", [project.id, nextPath]);
    }
  });
  if (file.path !== project.root_file && /\.tex$/i.test(file.path)) {
    const fresh = (await findProject(deps.db, project.id))!;
    await editRoot(deps, fresh, actorId, (text) => renameInput(text, file.path, nextPath));
  }
}

/** Changes the heading (`\chapter{…}`) of a section file. */
export async function retitleSection(deps: LatexDeps, file: FileRow, title: string, actorId: string) {
  if (!deps.collab) throw new Error("collab server required");
  await deps.collab.edit(latexDocName(file.project_id, file.id), actorId, (_doc, ytext) => {
    const current = ytext.toString();
    const next = sectionTitle(current) === null ? `\\section{${escapeLatex(title)}}\n\n${current}` : setSectionTitle(current, title, escapeLatex);
    replaceText(ytext, next);
  });
}

/** Deletes a file (never the root); a section's `\input` is removed from the root file first. */
export async function deleteFile(deps: LatexDeps, project: ProjectRow, file: FileRow, actorId: string) {
  if (file.path === project.root_file) throw badRequest("不能刪除主檔。");
  if (/\.tex$/i.test(file.path)) await editRoot(deps, project, actorId, (text) => removeInput(text, file.path));
  await transaction(deps.db, async (client) => {
    await forgetFileDocs(client, project.id, [file.id]);
    await client.query("DELETE FROM latex_files WHERE id=$1 AND project_id=$2", [file.id, project.id]);
    await client.query("UPDATE latex_projects SET updated_at=now(), updated_by=$2 WHERE id=$1", [project.id, actorId]);
  });
  deps.collab?.closeDocument(latexDocName(project.id, file.id));
}

/** Tab drag: rewrites the order of the `\input` lines (only whole-line inputs move; everything else stays). */
export async function reorderSections(deps: LatexDeps, project: ProjectRow, fileIds: string[], actorId: string) {
  const files = await listFiles(deps.db, project.id);
  const byId = new Map(files.map((f) => [f.id, f]));
  const paths = fileIds.map((id) => byId.get(id)?.path).filter((p): p is string => !!p);
  if (paths.length !== fileIds.length) throw badRequest("章節清單已變更，請重新整理後再試。");
  return editRoot(deps, project, actorId, (text) => reorderInputs(text, paths));
}

// ---------------------------------------------------------------- bibliography

/**
 * `auto` projects: rewrites the bib file from the study library (`exportStudyBibtex`). An empty library leaves the
 * file unchanged (templates ship sample entries). Creates the file when missing. Returns whether it changed.
 */
export async function regenerateBib(deps: LatexDeps, project: ProjectRow, actorId: string | null): Promise<{ changed: boolean; count: number }> {
  const { bibtex, count } = await exportStudyBibtex(deps.db, project.study_id);
  if (!count) return { changed: false, count };
  const text = `% 此檔由研究文獻庫自動產生（${count} 筆），每次編譯前更新；手動修改會被覆蓋。\n% 要自行編輯，請在專案設定把參考文獻改為「手動」。\n\n${bibtex}`;
  const path = bibFileOf(project);
  const file = await findFileByPath(deps.db, project.id, path);
  if (!file) {
    await transaction(deps.db, (client) => insertTextFile(client, { projectId: project.id, path, content: text, role: "bib", actorId }));
    return { changed: true, count };
  }
  if (file.kind !== "text") throw badRequest(`${path} 不是文字檔，無法自動產生參考文獻。`);
  const current = await liveText(deps.db, deps.collab, file);
  if (current === text) return { changed: false, count };
  await replaceFileText(deps, file, actorId, text);
  return { changed: true, count };
}

// ---------------------------------------------------------------- snapshots

export type SnapshotEntry = { path: string; key: string; size: number; sha256: string; fileId: string; kind: "text" | "binary"; role: FileRole; contentType: string | null };

/**
 * Freezes every file: text files are read from their live documents and stored as content-addressed blobs
 * (uploaded only when the hash changed since the last snapshot); binary files already are blobs.
 */
export async function snapshotProject(deps: LatexDeps, projectId: string): Promise<SnapshotEntry[]> {
  const files = await listFiles(deps.db, projectId);
  const out: SnapshotEntry[] = [];
  for (const file of files) {
    if (file.kind === "binary") {
      out.push({ path: file.path, key: file.s3_key!, size: Number(file.bytes), sha256: file.sha256 ?? "", fileId: file.id, kind: "binary", role: file.role, contentType: file.content_type });
      continue;
    }
    const text = await liveText(deps.db, deps.collab, file);
    const data = Buffer.from(text, "utf8");
    const sha = sha256Hex(data);
    const key = latexKeys.blob(projectId, sha);
    if (file.blob_sha256 !== sha) {
      await deps.storage.put(key, data, "text/plain; charset=utf-8");
      await deps.db.query("UPDATE latex_files SET blob_sha256=$2 WHERE id=$1", [file.id, sha]);
    }
    out.push({ path: file.path, key, size: data.length, sha256: sha, fileId: file.id, kind: "text", role: file.role, contentType: file.content_type });
  }
  return out;
}

/** The runner's manifest (contract.ts) from a snapshot. Empty `sha256` (legacy binary rows) is omitted. */
export function runnerManifest(entries: SnapshotEntry[]): LatexSnapshotManifest {
  return { version: 1, files: entries.map((e) => ({ path: e.path, key: e.key, size: e.size, ...(e.sha256 ? { sha256: e.sha256 } : {}) })) };
}

// ---------------------------------------------------------------- compile

export type CompileRow = {
  id: string;
  project_id: string;
  job_id: string | null;
  status: string;
  compiler: LatexCompiler;
  root_file: string;
  draft: boolean;
  result: unknown;
  pdf_key: string | null;
  synctex_key: string | null;
  log_key: string | null;
  blg_key: string | null;
  pdf_bytes: number | null;
  duration_ms: number | null;
  error: string | null;
  file_map: Record<string, string>;
  triggered_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

/**
 * 「編譯」: (auto bib) → snapshot → manifest → `latex_compile` job. Queued compiles of the project are cancelled
 * (the newest request wins); a running one finishes first (the runner serializes compiles of one project).
 * The job has `created_by` NULL (kept out of the jobs tray; the editor shows the status).
 */
export async function requestCompile(deps: LatexDeps, project: ProjectRow, opts: { actorId: string; draft?: boolean }): Promise<string> {
  if (project.bib_mode === "auto") await regenerateBib(deps, project, null);
  const entries = await snapshotProject(deps, project.id);
  if (!entries.some((e) => e.path === project.root_file && e.kind === "text")) throw badRequest(`找不到主檔 ${project.root_file}，請在專案設定指定主檔。`);
  if (!/\.(tex|ltx)$/i.test(project.root_file)) throw badRequest("主檔必須是 .tex 檔。");
  const compileId = randomUUID();
  const manifestKey = latexKeys.manifest(project.id, compileId);
  await deps.storage.put(manifestKey, JSON.stringify(runnerManifest(entries)), "application/json");
  const outputPrefix = latexKeys.build(project.id, compileId);
  const payload: LatexCompilePayload = {
    projectId: project.id, compileId, manifestKey, rootFile: project.root_file, compiler: project.compiler, outputPrefix,
    ...(opts.draft ? { draft: true } : {}), ...(project.settings?.haltOnError ? { haltOnError: true } : {}),
  };
  const fileMap = Object.fromEntries(entries.map((e) => [e.path, e.fileId]));
  await transaction(deps.db, async (client) => {
    await client.query("SELECT 1 FROM latex_projects WHERE id=$1 FOR UPDATE", [project.id]);
    const queued = (await client.query<{ id: string; job_id: string | null }>(
      "SELECT c.id, c.job_id FROM latex_compiles c JOIN jobs j ON j.id=c.job_id WHERE c.project_id=$1 AND c.status='queued' AND j.status='queued'",
      [project.id],
    )).rows;
    for (const q of queued) {
      if (q.job_id) await cancelJob(client, q.job_id);
      await client.query("UPDATE latex_compiles SET status='cancelled', error='已由較新的編譯取代。', finished_at=now() WHERE id=$1", [q.id]);
    }
    await client.query(
      `INSERT INTO latex_compiles(id,project_id,compiler,root_file,draft,manifest_key,output_prefix,file_map,triggered_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [compileId, project.id, project.compiler, project.root_file, !!opts.draft, manifestKey, outputPrefix, JSON.stringify(fileMap), opts.actorId],
    );
    const jobId = await enqueueJob(client, LATEX_JOB_KIND, payload, null, 2);
    await client.query("UPDATE latex_compiles SET job_id=$2 WHERE id=$1", [compileId, jobId]);
    await client.query("UPDATE latex_projects SET last_compile_id=$2 WHERE id=$1", [project.id, compileId]);
  });
  return compileId;
}

export const COMPILE_SELECT = `SELECT c.id,c.project_id,c.job_id,c.status,c.compiler,c.root_file,c.draft,c.result,c.pdf_key,c.synctex_key,c.log_key,
  c.blg_key,c.pdf_bytes,c.duration_ms,c.error,c.file_map,c.triggered_by,u.name AS triggered_by_name,c.created_at,c.started_at,c.finished_at,
  j.stage AS job_stage, j.progress AS job_progress, j.status AS job_status
  FROM latex_compiles c LEFT JOIN jobs j ON j.id=c.job_id LEFT JOIN users u ON u.id=c.triggered_by`;

export async function findCompile(db: Queryable, projectId: string, compileId: string) {
  return (await db.query<CompileRow & { job_stage: string | null; job_progress: number | null; job_status: string | null; triggered_by_name: string | null }>(
    `${COMPILE_SELECT} WHERE c.project_id=$1 AND c.id=$2`, [projectId, compileId],
  )).rows[0] ?? null;
}

const STAGE_LABELS: Record<string, string> = { queued: "排隊中", starting: "準備中", cancelled: "已取消" };

/** Compile as the SPA sees it (no S3 keys; URLs instead). */
export function compileView(row: Awaited<ReturnType<typeof findCompile>>) {
  if (!row) return null;
  const running = row.status === "queued" || row.status === "running";
  // The runner moves the job to running; latex_compiles follows when the finalizer runs.
  const status = running && row.job_status === "running" ? "running" : row.status;
  const base = `/api/latex/${row.project_id}/compiles/${row.id}`;
  const result = (row.result ?? null) as { errors?: unknown[]; warnings?: unknown[]; warningCount?: number; badBoxCount?: number; status?: string } | null;
  return {
    id: row.id,
    status,
    compiler: row.compiler,
    root_file: row.root_file,
    draft: row.draft,
    stage: running ? STAGE_LABELS[row.job_stage ?? "queued"] ?? row.job_stage ?? "排隊中" : null,
    progress: running ? row.job_progress ?? 0 : 100,
    error: row.error,
    errors: result?.errors ?? [],
    warnings: result?.warnings ?? [],
    warning_count: result?.warningCount ?? 0,
    badbox_count: result?.badBoxCount ?? 0,
    duration_ms: row.duration_ms,
    pdf_bytes: row.pdf_bytes,
    file_map: row.file_map,
    pdf_url: row.pdf_key ? `${base}/pdf` : null,
    synctex_url: row.synctex_key ? `${base}/synctex` : null,
    log_url: row.log_key ? `${base}/log` : null,
    triggered_by: row.triggered_by ? { id: row.triggered_by, name: row.triggered_by_name } : null,
    created_at: row.created_at,
    finished_at: row.finished_at,
  };
}
export type CompileView = NonNullable<ReturnType<typeof compileView>>;

// ---------------------------------------------------------------- versions

type VersionManifest = { version: 1; project: { root_file: string; compiler: LatexCompiler; bib_mode: LatexBibMode; settings: ProjectSettings }; files: SnapshotEntry[] };

export async function createVersion(deps: LatexDeps, project: ProjectRow, input: { kind: "manual" | "restore" | "backup" | "import"; label: string; actorId: string | null }) {
  const entries = await snapshotProject(deps, project.id);
  const id = randomUUID();
  const key = latexKeys.version(project.id, id);
  const manifest: VersionManifest = { version: 1, project: { root_file: project.root_file, compiler: project.compiler, bib_mode: project.bib_mode, settings: project.settings }, files: entries };
  await deps.storage.put(key, JSON.stringify(manifest), "application/json");
  const bytes = entries.reduce((n, e) => n + e.size, 0);
  return (
    await deps.db.query<{ id: string; kind: string; label: string; file_count: number; bytes: number; created_at: string }>(
      `INSERT INTO latex_versions(id,project_id,kind,label,manifest_key,file_count,bytes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id,kind,label,file_count,bytes,created_at`,
      [id, project.id, input.kind, input.label.slice(0, 200), key, entries.length, bytes, input.actorId],
    )
  ).rows[0]!;
}

/**
 * Makes the project match a version: a backup version of the current state is saved first; text files are changed
 * through their live documents (line diff, editors see it), missing files are recreated, binary files point at the
 * version's blobs, and files that are not in the version are deleted.
 */
export async function restoreVersion(deps: LatexDeps, project: ProjectRow, versionId: string, actorId: string) {
  const row = (await deps.db.query<{ manifest_key: string; label: string; created_at: string }>("SELECT manifest_key,label,created_at FROM latex_versions WHERE id=$1 AND project_id=$2", [versionId, project.id])).rows[0];
  if (!row) throw notFound("版本不存在。");
  const raw = await deps.storage.getBuffer(row.manifest_key);
  if (!raw) throw new HttpError(410, "這個版本的檔案已不存在。");
  const manifest = JSON.parse(raw.toString("utf8")) as VersionManifest;
  await createVersion(deps, project, { kind: "backup", label: "還原前自動備份", actorId });
  const current = await listFiles(deps.db, project.id);
  const byPath = new Map(current.map((f) => [f.path, f]));
  const wanted = new Set(manifest.files.map((f) => f.path));
  for (const entry of manifest.files) {
    const existing = byPath.get(entry.path);
    if (entry.kind === "text") {
      const data = await deps.storage.getBuffer(entry.key);
      if (data === null) continue;
      const text = data.toString("utf8");
      if (existing && existing.kind === "text") {
        await replaceFileText(deps, existing, actorId, text);
      } else {
        await transaction(deps.db, async (client) => {
          if (existing) {
            await forgetFileDocs(client, project.id, [existing.id]);
            await client.query("DELETE FROM latex_files WHERE id=$1", [existing.id]);
          }
          await insertTextFile(client, { projectId: project.id, path: entry.path, content: text, role: entry.role, actorId });
        });
      }
    } else {
      await transaction(deps.db, async (client) => {
        if (existing && existing.kind === "text") {
          await forgetFileDocs(client, project.id, [existing.id]);
          await client.query("DELETE FROM latex_files WHERE id=$1", [existing.id]);
        }
        await client.query(
          `INSERT INTO latex_files(project_id,path,kind,role,s3_key,bytes,content_type,sha256,created_by,updated_by)
           VALUES($1,$2,'binary',$3,$4,$5,$6,$7,$8,$8)
           ON CONFLICT (project_id,path) DO UPDATE SET s3_key=EXCLUDED.s3_key, bytes=EXCLUDED.bytes, sha256=EXCLUDED.sha256, updated_at=now(), updated_by=EXCLUDED.updated_by`,
          [project.id, entry.path, entry.role, entry.key, entry.size, entry.contentType ?? contentTypeOf(entry.path), entry.sha256 || null, actorId],
        );
      });
    }
  }
  const stale = current.filter((f) => !wanted.has(f.path));
  if (stale.length) {
    await transaction(deps.db, async (client) => {
      await forgetFileDocs(client, project.id, stale.map((f) => f.id));
      await client.query("DELETE FROM latex_files WHERE id = ANY($1)", [stale.map((f) => f.id)]);
    });
    for (const f of stale) deps.collab?.closeDocument(latexDocName(project.id, f.id));
  }
  await deps.db.query("UPDATE latex_projects SET root_file=$2, compiler=$3, bib_mode=$4, settings=$5, updated_at=now(), updated_by=$6 WHERE id=$1", [
    project.id, manifest.project.root_file, manifest.project.compiler, manifest.project.bib_mode, JSON.stringify(manifest.project.settings ?? {}), actorId,
  ]);
  const fresh = (await findProject(deps.db, project.id))!;
  const root = await findFileByPath(deps.db, project.id, fresh.root_file);
  if (root) await transaction(deps.db, async (client) => syncSectionPositions(client, fresh, await liveText(client, deps.collab, root)));
  const label = row.label || new Date(row.created_at).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
  return createVersion(deps, fresh, { kind: "restore", label: `還原至〈${label}〉`, actorId });
}

// ---------------------------------------------------------------- misc

export { isGeneratedBib };
