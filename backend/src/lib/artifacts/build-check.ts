/**
 * Edit gate for every artifact the assistant changes (docs/architecture.md "Artifact edit gate"; harness survey: SWE-agent
 * rejects edits that do not lint, Cursor's shadow workspace, Aider lints every edit). Before a suggestion is created —
 * or applied, under autopilot — the edited text is checked by the artifact's own rules:
 *
 *   1. static: the kind's parsers (deck: YAML front matter / blocks / diagram specs; LaTeX: braces, environments;
 *      note: fences, math, divs) — only problems the edit introduces;
 *   2. build (decks, LaTeX): a dry run with the real compiler on a scratch copy — the deck tree packed with the edited
 *      file → a `slide_preview` job, the LaTeX snapshot with it → a draft `latex_compile` job; no preview / compile row
 *      is written (their finalizers only clean the scratch objects), so the real preview and the user's PDF are untouched.
 *      Errors the current artifact already has are not the edit's (deck: its last failed preview; LaTeX: its last compile).
 *
 * `ok: false` → the tool refuses with `problems` (one actionable line each); the completion review keeps the turn from
 * ending on an edit that never went through (agent/guards.ts). `verified: "unverified"`: the build did not finish in time
 * (busy worker) — the suggestion is created on the static check alone and the result says so.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { enqueueJob } from "../../jobs/queue.js";
import { LATEX_JOB_KIND, type LatexCompilePayload } from "../latex/contract.js";
import { newLatexProblems } from "../latex-projects/source-lint.js";
import { runnerManifest, snapshotProject, type LatexDeps } from "../latex-projects/service.js";
import { latexKeys, sha256Hex } from "../latex-projects/store.js";
import { packTree, sourceKeys } from "../slides/sources.js";
import type { SlidePreviewPayload } from "../slides/preview.js";
import { newSourceProblems } from "../slides/source-lint.js";
import { plainLog } from "../slides/render-followup.js";
import { deckRenderedView, type ArtifactView } from "./view.js";

export type EditCheck = {
  ok: boolean; problems: string[]; verified: "built" | "static" | "unverified"; note?: string;
  /** What the edited artifact shows (a deck's dry-run render, lib/artifacts/view.ts), for the turn's requirement checks. */
  view?: ArtifactView;
};

/** Max wait for a dry-run build (tests set it low; no worker runs there). */
let BUILD_WAIT_MS = 120_000;
let BUILDS_ON = process.env.NODE_ENV !== "test";
export function setBuildCheck(opts: { waitMs?: number; enabled?: boolean }) {
  if (opts.waitMs !== undefined) BUILD_WAIT_MS = opts.waitMs;
  if (opts.enabled !== undefined) BUILDS_ON = opts.enabled;
}

type JobEnd = { status: string; result: unknown; error: string | null } | null;
/** Polls a job until it finishes (or the wait runs out → null). */
async function waitJob(app: FastifyInstance, jobId: string, signal?: AbortSignal): Promise<JobEnd> {
  const end = Date.now() + BUILD_WAIT_MS;
  for (;;) {
    const row = (await app.db.query<{ status: string; result: unknown; error: string | null }>("SELECT status, result, error FROM jobs WHERE id=$1", [jobId])).rows[0];
    if (row && ["succeeded", "failed", "cancelled"].includes(row.status)) return row;
    if (Date.now() > end || signal?.aborted) {
      // Nobody needs it any more: a queued dry run is cancelled; a running one finishes and is cleaned by its finalizer.
      await app.db.query("UPDATE jobs SET status='cancelled', stage='cancelled', finished_at=now() WHERE id=$1 AND status='queued'", [jobId]).catch(() => undefined);
      return null;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** The lines of a build log that say what broke (Quarto / YAML / Pandoc errors), ANSI stripped, ≤ 6. */
export function errorLines(log: string): string[] {
  const lines = plainLog(log).split("\n").map((l) => l.trim()).filter(Boolean);
  const hits = lines.filter((l) => /\berror\b|錯誤|exception|failed|not found|unknown|invalid|duplicated|unexpected/i.test(l));
  return (hits.length ? hits : lines.slice(-3)).slice(0, 6).map((l) => l.slice(0, 240));
}
const errKey = (l: string) => l.replace(/\(.*?\)|\d+/g, "").replace(/\s+/g, " ").trim().toLowerCase();

// ---------------------------------------------------------------- decks

/** A deck source edit: static rules, then a dry-run render of the tree with the edited file. */
export async function checkDeckEdit(app: FastifyInstance, deck: { id: string }, path: string, before: string, after: string, opts: { signal?: AbortSignal } = {}): Promise<EditCheck> {
  const stat = newSourceProblems(path, before, after);
  if (stat.length) return { ok: false, problems: stat, verified: "static" };
  if (!BUILDS_ON || !/\.(?:qmd|md|ya?ml|css|scss|bib|lua|json)$/i.test(path)) return { ok: true, problems: [], verified: "static" };
  const previewId = randomUUID();
  const { zip, tree } = await packTree(app.db, app.storage, deck.id, { [path]: after });
  const payload: SlidePreviewPayload = { deckId: deck.id, previewId, sourceKey: sourceKeys.previewSource(deck.id, previewId), entry: tree.entry, outputPrefix: sourceKeys.previewOutput(deck.id, previewId), dryRun: true };
  await app.storage.put(payload.sourceKey, zip, "application/zip");
  const jobId = await enqueueJob(app.db, "slide_preview", payload, null, 1);
  try {
    return await deckOutcome(app, deck.id, payload, await waitJob(app, jobId, opts.signal));
  } finally {
    // The dry run's scratch objects (source ZIP + render) are ours to remove (its finalizer leaves them for this read).
    await app.storage.deletePrefix(sourceKeys.previewPrefix(deck.id, previewId)).catch(() => undefined);
  }
}

async function deckOutcome(app: FastifyInstance, deckId: string, payload: SlidePreviewPayload, end: JobEnd): Promise<EditCheck> {
  if (!end) return { ok: true, problems: [], verified: "unverified", note: "編譯檢查沒有在時間內完成（編譯服務忙碌），這個建議只通過了語法檢查；使用者接受後若預覽失敗會再通知你。" };
  if (end.status === "succeeded") {
    const entry = (end.result as { entryHtml?: unknown } | null)?.entryHtml;
    const html = typeof entry === "string" && /^[\w./-]+\.html?$/.test(entry) && !entry.includes("..") ? await app.storage.getBuffer(`${payload.outputPrefix}${entry}`).catch(() => null) : null;
    return { ok: true, problems: [], verified: "built", ...(html ? { view: deckRenderedView(html.toString("utf8")) } : {}) };
  }
  const deck = { id: deckId };
  const lines = errorLines(end.error ?? "");
  // The deck already failed the same way before the edit: not this edit's breakage.
  const last = (await app.db.query<{ status: string; error: string | null }>("SELECT status, error FROM deck_previews WHERE deck_id=$1 AND status IN ('ready','failed') ORDER BY created_at DESC LIMIT 1", [deck.id])).rows[0];
  if (last?.status === "failed") {
    const had = new Set(errorLines(last.error ?? "").map(errKey));
    if (lines.every((l) => had.has(errKey(l)))) return { ok: true, problems: [], verified: "built", note: `簡報在這次修改之前就編譯失敗（${lines[0] ?? "錯誤"}）；這個修改沒有讓它更糟，可以順便修正那個錯誤。` };
  }
  return { ok: false, problems: lines.map((l) => `編譯錯誤：${l}`), verified: "built" };
}

// ---------------------------------------------------------------- LaTeX

type Diag = { message?: string; file?: string | null; line?: number | null };
const diagKey = (d: Diag) => `${d.file ?? ""}|${(d.message ?? "").replace(/\d+/g, "").trim().toLowerCase()}`;
const diagText = (d: Diag) => `${d.file ? `${d.file}${d.line ? `:${d.line}` : ""} ` : ""}${(d.message ?? "").slice(0, 200)}`;

/** A LaTeX file edit: braces / environments, then a draft compile of the project with the edited file. */
export async function checkLatexEdit(app: FastifyInstance, project: { id: string; root_file: string; compiler: LatexCompilePayload["compiler"]; last_compile_id?: string | null }, file: { path: string }, before: string, after: string, opts: { signal?: AbortSignal } = {}): Promise<EditCheck> {
  const stat = newLatexProblems(file.path, before, after);
  if (stat.length) return { ok: false, problems: stat, verified: "static" };
  if (!BUILDS_ON || !/\.(?:tex|bib|sty|cls|ltx)$/i.test(file.path) || !/\.(?:tex|ltx)$/i.test(project.root_file)) return { ok: true, problems: [], verified: "static" };
  const deps: LatexDeps = { db: app.db, storage: app.storage, collab: (app as unknown as { collab?: LatexDeps["collab"] }).collab ?? null };
  const entries = await snapshotProject(deps, project.id);
  const data = Buffer.from(after, "utf8");
  const sha = sha256Hex(data);
  const key = latexKeys.blob(project.id, sha);
  await app.storage.put(key, data, "text/plain; charset=utf-8");
  const edited = entries.map((e) => (e.path === file.path ? { ...e, key, size: data.length, sha256: sha } : e));
  const compileId = randomUUID();
  const manifestKey = latexKeys.manifest(project.id, compileId);
  await app.storage.put(manifestKey, JSON.stringify(runnerManifest(edited)), "application/json");
  const payload: LatexCompilePayload = { projectId: project.id, compileId, manifestKey, rootFile: project.root_file, compiler: project.compiler, outputPrefix: latexKeys.build(project.id, compileId), draft: true };
  const jobId = await enqueueJob(app.db, LATEX_JOB_KIND, payload, null, 1);
  const end = await waitJob(app, jobId, opts.signal);
  if (!end) return { ok: true, problems: [], verified: "unverified", note: "編譯檢查沒有在時間內完成，這個修改只通過了語法檢查。" };
  const result = (end.result ?? {}) as { status?: string; errors?: Diag[] };
  if (end.status !== "succeeded") return { ok: true, problems: [], verified: "unverified", note: `編譯服務沒有完成檢查（${(end.error ?? "").slice(0, 120)}）。` };
  const errors = Array.isArray(result.errors) ? result.errors : [];
  if (result.status === "success" || !errors.length) return { ok: true, problems: [], verified: "built" };
  // Errors the project's last compile already had are not this edit's.
  const lastErrors = project.last_compile_id
    ? (((await app.db.query<{ result: { errors?: Diag[] } | null }>("SELECT result FROM latex_compiles WHERE id=$1", [project.last_compile_id])).rows[0]?.result?.errors) ?? [])
    : [];
  const had = new Set(lastErrors.map(diagKey));
  const fresh = errors.filter((d) => !had.has(diagKey(d)));
  if (!fresh.length) return { ok: true, problems: [], verified: "built", note: "專案在這次修改之前就有編譯錯誤；這個修改沒有新增錯誤。" };
  return { ok: false, problems: fresh.slice(0, 6).map((d) => `編譯錯誤：${diagText(d)}`), verified: "built" };
}

// ---------------------------------------------------------------- notes (Markdown)

/** Structural problems of a Markdown note: unclosed ``` fences, $$ blocks, ::: divs, HTML comments. */
export function noteProblems(text: string): string[] {
  const out: string[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let fence = false;
  let math = 0;
  let depth = 0;
  for (const l of lines) {
    if (/^\s*(```|~~~)/.test(l)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    math += (l.match(/(?<!\\)\$\$/g) ?? []).length;
    if (/^:{3,}\s*[^:\s]/.test(l)) depth++;
    else if (/^:{3,}\s*$/.test(l)) depth = Math.max(0, depth - 1);
  }
  if (fence) out.push("程式碼區塊（```）沒有關閉");
  if (math % 2) out.push("$$ 數學區塊沒有關閉");
  if (depth) out.push("::: 區塊沒有關閉");
  if ((text.match(/<!--/g) ?? []).length !== (text.match(/-->/g) ?? []).length) out.push("HTML 註解（<!-- -->）沒有關閉");
  return out;
}

/** A note edit: only the structural problems it introduces. */
export function checkNoteEdit(before: string, after: string): EditCheck {
  const had = new Set(noteProblems(before));
  const fresh = noteProblems(after).filter((p) => !had.has(p));
  return { ok: !fresh.length, problems: fresh, verified: "static" };
}

/** The refusal every edit tool returns for a failed check (one actionable message; guards.ts recognises its head). */
export const EDIT_REFUSED = "這個修改沒有通過檢查，建議沒有建立";
export function refusal(kind: "簡報" | "LaTeX" | "筆記", c: EditCheck, reread: string): string {
  return `${EDIT_REFUSED}（${kind}${c.verified === "built" ? "，實際編譯" : ""}）：${c.problems.slice(0, 5).join("；")}。請用 ${reread} 看目前的內容，只修正造成問題的地方，再提一次。`;
}
