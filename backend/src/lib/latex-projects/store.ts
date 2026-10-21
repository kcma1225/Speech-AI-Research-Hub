/**
 * LaTeX projects: queries, object keys, path rules, the `latex:<projectId>:<fileId>` collab namespace, the
 * `latex_file` suggestion target and the study cleanup hook. See docs/architecture.md "LaTeX".
 *
 * Split-file convention (spec §13 #14): the root file (`main.tex`) is the index (preamble + `\input` list) and every
 * section is its own file; the editor's tabs are the root file plus the sections in `\input` order.
 */
import { createHash } from "node:crypto";
import type pg from "pg";
import type { Db, Queryable } from "../../db.js";
import { registerCollabNamespace, type CollabUser } from "../../collab/registry.js";
import { closeDocumentEverywhere, readStoredDoc, type CollabServer } from "../../collab/server.js";
import { initialState } from "../../collab/text.js";
import type { CurrentUser } from "../auth.js";
import { isSafeProjectPath, type LatexCompiler } from "../latex/contract.js";
import { listInputs } from "../latex/inputs.js";
import { touchStudy } from "../studies/activity.js";
import { registerStudyCleanup } from "../studies/cleanup.js";
import { registerSuggestionTarget } from "../suggestions/targets.js";

export type LatexKind = "paper" | "thesis" | "other";
export type LatexBibMode = "auto" | "manual";
export type FileRole = "main" | "section" | "bib" | "style" | "asset" | "other";
export type ProjectSettings = { bibFile?: string; sectionCommand?: "chapter" | "section"; haltOnError?: boolean };

export const LATEX_KINDS: LatexKind[] = ["paper", "thesis", "other"];

export type ProjectRow = {
  id: string;
  study_id: string;
  title: string;
  kind: LatexKind;
  template: string;
  root_file: string;
  compiler: LatexCompiler;
  bib_mode: LatexBibMode;
  settings: ProjectSettings;
  last_compile_id: string | null;
  last_pdf_compile_id: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

export type FileRow = {
  id: string;
  project_id: string;
  path: string;
  kind: "text" | "binary";
  role: FileRole;
  position: number | null;
  content: string | null;
  s3_key: string | null;
  bytes: number;
  content_type: string | null;
  sha256: string | null;
  blob_sha256: string | null;
  updated_by: string | null;
  updated_at: string;
};

// ---------------------------------------------------------------- names, keys, urls

export const latexDocName = (projectId: string, fileId: string) => `latex:${projectId}:${fileId}`;
export const latexUrl = (studySlug: string, projectId: string, fileId?: string) =>
  `/studies/${encodeURIComponent(studySlug)}/latex/${projectId}${fileId ? `?file=${fileId}` : ""}`;

/** Object keys (bucket `$S3_BUCKET`); every key of a project is below `latex/<projectId>/`. */
export const latexKeys = {
  prefix: (projectId: string) => `latex/${projectId}/`,
  blob: (projectId: string, sha256: string) => `latex/${projectId}/blobs/${sha256}`,
  manifest: (projectId: string, compileId: string) => `latex/${projectId}/manifests/${compileId}.json`,
  build: (projectId: string, compileId: string) => `latex/${projectId}/builds/${compileId}/`,
  version: (projectId: string, versionId: string) => `latex/${projectId}/versions/${versionId}.json`,
};

export const sha256Hex = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

export const DEFAULT_BIB = "refs.bib";
export const bibFileOf = (project: Pick<ProjectRow, "settings">) => project.settings?.bibFile || DEFAULT_BIB;

// ---------------------------------------------------------------- path rules

/** Text files (edited as Yjs documents). Everything else is uploaded as a binary blob. */
export const TEXT_EXTENSIONS = new Set([
  "tex", "ltx", "sty", "cls", "bst", "bib", "bbx", "cbx", "lbx", "dbx", "cfg", "def", "clo", "dtx", "ins", "txt", "md",
  "csv", "tsv", "dat", "tikz", "pgf", "lua", "json", "yaml", "yml", "bbl",
]);
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
export const MAX_BINARY_BYTES = 50 * 1024 * 1024;
export const MAX_FILES = 500;

export const extOf = (path: string) => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};
export const isTextPath = (path: string) => TEXT_EXTENSIONS.has(extOf(path));
/** Executables and web documents never belong in a LaTeX project (uploads are refused, ZIP entries skipped). */
export const BLOCKED_EXTENSIONS = new Set(["exe", "dll", "msi", "bat", "cmd", "com", "scr", "ps1", "vbs", "js", "mjs", "html", "htm", "xhtml", "php", "jar", "apk", "dmg", "app"]);
export const isBlockedPath = (path: string) => BLOCKED_EXTENSIONS.has(extOf(path));

/**
 * A path users may create or rename to: the runner's rules (`isSafeProjectPath`) plus no hidden segments, no spaces
 * or quotes (TeX `\input` breaks on them), at most 8 levels.
 */
export function validProjectPath(path: string): boolean {
  if (!isSafeProjectPath(path)) return false;
  const segments = path.split("/");
  if (segments.length > 8) return false;
  return segments.every((s) => !s.startsWith(".") && !/[\s"'`$#%&{}~^\\]/.test(s));
}

export const PATH_RULES = "檔名只能使用英數字、中文、- _ . 與 /，不能以 . 或 - 開頭，也不能有空白。";

/** Role of a file from its path (the root file is always `main`; listed `\input`s are sections). */
export function roleOf(path: string, rootFile: string, sectionPaths: Set<string>): FileRole {
  if (path === rootFile) return "main";
  const ext = extOf(path);
  if (ext === "tex" && (sectionPaths.has(path) || path.startsWith("sections/") || path.startsWith("chapters/"))) return "section";
  if (ext === "bib") return "bib";
  if (["sty", "cls", "bst", "bbx", "cbx", "lbx", "dbx", "cfg", "def", "clo"].includes(ext)) return "style";
  if (!TEXT_EXTENSIONS.has(ext)) return "asset";
  return "other";
}

export const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml",
  webp: "image/webp", eps: "application/postscript", ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2",
};
export const contentTypeOf = (path: string) => (isTextPath(path) ? "text/plain; charset=utf-8" : CONTENT_TYPES[extOf(path)] ?? "application/octet-stream");

// ---------------------------------------------------------------- queries

export const PROJECT_COLUMNS = `p.id,p.study_id,p.title,p.kind,p.template,p.root_file,p.compiler,p.bib_mode,p.settings,p.last_compile_id,
  p.last_pdf_compile_id,p.created_by,p.updated_by,p.created_at,p.updated_at`;

export async function findProject(db: Queryable, id: string, forUpdate = false): Promise<ProjectRow | null> {
  return (await db.query<ProjectRow>(`SELECT ${PROJECT_COLUMNS} FROM latex_projects p WHERE p.id=$1${forUpdate ? " FOR UPDATE" : ""}`, [id])).rows[0] ?? null;
}

export const FILE_COLUMNS = "id,project_id,path,kind,role,position,content,s3_key,bytes,content_type,sha256,blob_sha256,updated_by,updated_at";

export async function listFiles(db: Queryable, projectId: string): Promise<FileRow[]> {
  return (await db.query<FileRow>(`SELECT ${FILE_COLUMNS} FROM latex_files WHERE project_id=$1 ORDER BY path`, [projectId])).rows;
}

export async function findFile(db: Queryable, projectId: string, fileId: string): Promise<FileRow | null> {
  return (await db.query<FileRow>(`SELECT ${FILE_COLUMNS} FROM latex_files WHERE project_id=$1 AND id=$2`, [projectId, fileId])).rows[0] ?? null;
}

export async function findFileByPath(db: Queryable, projectId: string, path: string): Promise<FileRow | null> {
  return (await db.query<FileRow>(`SELECT ${FILE_COLUMNS} FROM latex_files WHERE project_id=$1 AND path=$2`, [projectId, path])).rows[0] ?? null;
}

export async function isStudyEditor(db: Queryable, studyId: string, userId: string) {
  const role = (await db.query<{ role: string }>("SELECT role FROM study_members WHERE study_id=$1 AND user_id=$2", [studyId, userId])).rows[0]?.role;
  return role === "owner" || role === "member";
}

/**
 * Live text of a text file: the loaded Yjs document, else the stored state, else the materialized copy.
 * `collab` is null outside the backend process (ai-worker), which then reads the stored state.
 */
export async function liveText(db: Queryable, collab: CollabServer | null | undefined, file: Pick<FileRow, "id" | "project_id" | "content">): Promise<string> {
  const name = latexDocName(file.project_id, file.id);
  const read = (doc: import("yjs").Doc) => doc.getText("content").toString();
  const text = collab ? await collab.readDoc(name, read) : await readStoredDoc(db, name, read);
  return text ?? file.content ?? "";
}

/** Inserts a text file with its Yjs state (never seeded from text later). Returns the new id. */
export async function insertTextFile(
  client: Queryable,
  input: { projectId: string; path: string; content: string; role: FileRole; position?: number | null; actorId: string | null },
): Promise<string> {
  const bytes = Buffer.byteLength(input.content);
  const id = (
    await client.query<{ id: string }>(
      `INSERT INTO latex_files(project_id,path,kind,role,position,content,bytes,content_type,sha256,created_by,updated_by)
       VALUES($1,$2,'text',$3,$4,$5,$6,$7,$8,$9,$9) RETURNING id`,
      [input.projectId, input.path, input.role, input.position ?? null, input.content, bytes, contentTypeOf(input.path), sha256Hex(input.content), input.actorId],
    )
  ).rows[0]!.id;
  const state = initialState(input.content);
  await client.query("INSERT INTO yjs_docs(name,state,size) VALUES($1,$2,$3)", [latexDocName(input.projectId, id), Buffer.from(state), state.length]);
  return id;
}

/** Deletes Yjs states and suggestions of files (rows cascade separately). */
export async function forgetFileDocs(client: Queryable, projectId: string, fileIds: string[]) {
  if (!fileIds.length) return;
  await client.query("DELETE FROM yjs_docs WHERE name = ANY($1)", [fileIds.map((id) => latexDocName(projectId, id))]);
  await client.query("DELETE FROM suggestions WHERE target_type='latex_file' AND target_id = ANY($1)", [fileIds]);
}

export async function forgetProjectDocs(client: Queryable, projectIds: string[]) {
  if (!projectIds.length) return [];
  const files = (await client.query<{ id: string; project_id: string }>("SELECT id, project_id FROM latex_files WHERE project_id = ANY($1)", [projectIds])).rows;
  await client.query("DELETE FROM yjs_docs WHERE name = ANY($1)", [files.map((f) => latexDocName(f.project_id, f.id))]);
  await client.query("DELETE FROM suggestions WHERE target_type='latex_file' AND target_id = ANY($1)", [files.map((f) => f.id)]);
  return files.map((f) => latexDocName(f.project_id, f.id));
}

export const disconnectDocs = (names: string[]) => names.forEach((name) => closeDocumentEverywhere(name));

// ---------------------------------------------------------------- sections (tabs)

const HEADING = /\\(part|chapter|section|subsection)\*?\s*(?:\[[^\]]*\])?\s*\{((?:[^{}]|\{[^{}]*\})*)\}/;

/** First heading of a section file (`\chapter{緒論}` → `緒論`), comments ignored; null when none. */
export function sectionTitle(text: string): string | null {
  for (const raw of text.split(/\r?\n/).slice(0, 200)) {
    const line = stripComment(raw);
    const m = HEADING.exec(line);
    if (m) return m[2]!.replace(/\\label\{[^}]*\}/g, "").replace(/\s+/g, " ").trim() || null;
  }
  return null;
}

/** Replaces the argument of the first heading command (keeps `*`, optional args and labels). */
export function setSectionTitle(text: string, title: string, escape: (s: string) => string): string {
  const lines = text.split("\n");
  for (let i = 0; i < Math.min(lines.length, 200); i++) {
    const code = stripComment(lines[i]!);
    const m = HEADING.exec(code);
    if (!m) continue;
    const start = m.index;
    const whole = m[0];
    const brace = whole.lastIndexOf("{" + m[2] + "}");
    const before = lines[i]!.slice(0, start) + whole.slice(0, brace);
    const after = lines[i]!.slice(start + whole.length);
    lines[i] = `${before}{${escape(title)}}${after}`;
    return lines.join("\n");
  }
  return text;
}

function stripComment(line: string): string {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\") {
      i++;
      continue;
    }
    if (line[i] === "%") return line.slice(0, i);
  }
  return line;
}

export type SectionView = {
  /** Null when the root file inputs a path that does not exist (shown as a broken tab). */
  file_id: string | null;
  path: string;
  title: string | null;
  position: number;
  disabled: boolean;
  /** The `\input` line can be moved by tab drag (it is alone on its line). */
  managed: boolean;
  command: "input" | "include";
};

/** Sections of a project in `\input` order of the root text. */
export function sectionsOf(rootText: string, files: Pick<FileRow, "id" | "path" | "kind">[], titles: Map<string, string | null>): SectionView[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const seen = new Set<string>();
  const out: SectionView[] = [];
  for (const entry of listInputs(rootText)) {
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    const file = byPath.get(entry.path);
    out.push({
      file_id: file && file.kind === "text" ? file.id : null,
      path: entry.path,
      title: file ? titles.get(file.id) ?? null : null,
      position: out.length,
      disabled: entry.disabled,
      managed: entry.managed,
      command: entry.command,
    });
  }
  return out;
}

/** Re-caches `position`/`role` of section files after the root file's input list changed. */
export async function syncSectionPositions(client: Queryable, project: Pick<ProjectRow, "id" | "root_file">, rootText: string) {
  const paths = [...new Set(listInputs(rootText).map((e) => e.path))];
  await client.query(
    `UPDATE latex_files f SET position = o.pos - 1, role = CASE WHEN f.role IN ('other','section') AND f.path ~ '\\.tex$' THEN 'section' ELSE f.role END
       FROM unnest($2::text[]) WITH ORDINALITY AS o(path, pos) WHERE f.project_id=$1 AND f.path=o.path AND f.path<>$3`,
    [project.id, paths, project.root_file],
  );
  await client.query("UPDATE latex_files SET position=NULL WHERE project_id=$1 AND position IS NOT NULL AND NOT (path = ANY($2::text[]))", [project.id, paths]);
}

// ---------------------------------------------------------------- collab namespace

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `<projectId>:<fileId>` → ids, or null. */
export function parseRest(rest: string): { projectId: string; fileId: string } | null {
  const [projectId, fileId, extra] = rest.split(":");
  if (extra !== undefined || !projectId || !fileId || !UUID.test(projectId) || !UUID.test(fileId)) return null;
  return { projectId, fileId };
}

type DocInfo = { study_id: string; slug: string; path: string; project_title: string; bib_mode: LatexBibMode; settings: ProjectSettings; kind: string; content: string | null; role: string | null };

async function docInfo(db: Queryable, projectId: string, fileId: string, userId: string) {
  return (
    await db.query<DocInfo>(
      `SELECT p.study_id, s.slug, f.path, p.title AS project_title, p.bib_mode, p.settings, f.kind, f.content, m.role
         FROM latex_files f JOIN latex_projects p ON p.id=f.project_id JOIN studies s ON s.id=p.study_id
         LEFT JOIN study_members m ON m.study_id=p.study_id AND m.user_id=$3
        WHERE f.id=$2 AND f.project_id=$1`,
      [projectId, fileId, userId],
    )
  ).rows[0];
}

/** The generated bib file of an `auto` project is read-only in the editor (it is rewritten before each compile). */
export const isGeneratedBib = (info: { bib_mode: LatexBibMode; settings: ProjectSettings; path: string }) =>
  info.bib_mode === "auto" && info.path === (info.settings?.bibFile || DEFAULT_BIB);

registerCollabNamespace({
  prefix: "latex",
  // Everyone signed in reads every study; study owner/member edit.
  async authorize(db: Db, user: CollabUser, rest: string) {
    const ids = parseRest(rest);
    if (!ids) return null;
    const info = await docInfo(db, ids.projectId, ids.fileId, user.id);
    if (!info || info.kind !== "text") return null;
    const editor = info.role === "owner" || info.role === "member";
    return { readOnly: !editor || isGeneratedBib(info) };
  },
  // Only for text files created without a state (should not happen): seed once from the materialized copy.
  async seed(db: Db, rest: string) {
    const ids = parseRest(rest);
    if (!ids) return null;
    const row = (await db.query<{ content: string | null; kind: string }>("SELECT content, kind FROM latex_files WHERE id=$1 AND project_id=$2", [ids.fileId, ids.projectId])).rows[0];
    return row && row.kind === "text" ? row.content ?? "" : null;
  },
  async materialize(client: pg.PoolClient, rest: string, text: string, info) {
    const ids = parseRest(rest);
    if (!ids) return "gone";
    const row = (
      await client.query<{ study_id: string; changed: boolean; root: boolean; root_file: string }>(
        `WITH old AS (SELECT content FROM latex_files WHERE id=$1 AND project_id=$2)
         UPDATE latex_files f SET content=$3, bytes=octet_length($3), sha256=$5,
                updated_at=CASE WHEN f.content IS DISTINCT FROM $3 THEN now() ELSE f.updated_at END,
                updated_by=CASE WHEN f.content IS DISTINCT FROM $3 THEN coalesce($4::uuid, f.updated_by) ELSE f.updated_by END
           FROM latex_projects p, old
          WHERE f.id=$1 AND f.project_id=$2 AND p.id=f.project_id
          RETURNING p.study_id, (old.content IS DISTINCT FROM $3) AS changed, (f.path = p.root_file) AS root, p.root_file`,
        [ids.fileId, ids.projectId, text, info.lastActorId, sha256Hex(text)],
      )
    ).rows[0];
    if (!row) return "gone";
    if (!row.changed) return;
    await client.query("UPDATE latex_projects SET updated_at=now(), updated_by=coalesce($2::uuid, updated_by) WHERE id=$1", [ids.projectId, info.lastActorId]);
    if (row.root) await syncSectionPositions(client, { id: ids.projectId, root_file: row.root_file }, text);
    if (info.editors.length) await touchStudy(client, row.study_id, info.lastActorId);
  },
});

// ---------------------------------------------------------------- suggestion target

registerSuggestionTarget({
  type: "latex_file",
  async resolve(db, targetId) {
    if (!UUID.test(targetId)) return null;
    const row = (
      await db.query<{ project_id: string; study_id: string; slug: string; path: string; title: string; kind: string }>(
        `SELECT f.project_id, p.study_id, s.slug, f.path, p.title, f.kind FROM latex_files f JOIN latex_projects p ON p.id=f.project_id
           JOIN studies s ON s.id=p.study_id WHERE f.id=$1`,
        [targetId],
      )
    ).rows[0];
    if (!row || row.kind !== "text") return null;
    return { studyId: row.study_id, docName: latexDocName(row.project_id, targetId), title: `${row.title} · ${row.path}`, url: latexUrl(row.slug, row.project_id, targetId), version: null };
  },
  async canEdit(db, user: CurrentUser, target) {
    return target.studyId ? isStudyEditor(db, target.studyId, user.id) : false;
  },
  async afterApply(client, targetId, info) {
    await client.query(
      "UPDATE latex_files SET content=$2, bytes=octet_length($2), sha256=$4, updated_at=now(), updated_by=coalesce($3, updated_by) WHERE id=$1",
      [targetId, info.text, info.actorId, sha256Hex(info.text)],
    );
    await client.query("UPDATE latex_projects SET updated_at=now() WHERE id=(SELECT project_id FROM latex_files WHERE id=$1)", [targetId]);
  },
});

// ---------------------------------------------------------------- study cleanup

registerStudyCleanup("latex", async (client, studyId) => {
  const ids = (await client.query<{ id: string }>("SELECT id FROM latex_projects WHERE study_id=$1", [studyId])).rows.map((r) => r.id);
  if (!ids.length) return;
  const names = await forgetProjectDocs(client, ids);
  return async () => {
    disconnectDocs(names);
    const { storage } = cleanupStorage;
    if (storage) for (const id of ids) await storage.deletePrefix(latexKeys.prefix(id)).catch(() => {});
  };
});

/** The routes plugin sets the storage used by the study cleanup hook (S3 objects of deleted studies). */
export const cleanupStorage: { storage: { deletePrefix(prefix: string): Promise<void> } | null } = { storage: null };
