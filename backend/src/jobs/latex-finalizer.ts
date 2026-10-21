import type { FastifyInstance } from "fastify";
import { registerFinalizer } from "./queue.js";
import { LATEX_COMPILERS, LATEX_JOB_KIND, type LatexCompilePayload, type LatexCompileResult } from "../lib/latex/contract.js";
import { withHint } from "../lib/latex/hints.js";
import { latexDocName, latexKeys } from "../lib/latex-projects/store.js";

/** Compiles kept per project (rows + outputs); older ones are deleted by the finalizer. */
export const KEEP_COMPILES = 8;
const RESULT_STATUSES = new Set(["success", "partial", "failure", "timeout"]);

/** A full key the runner may report: plain, below the compile's own output prefix. */
function ownKey(value: unknown, prefix: string): string | null {
  if (typeof value !== "string" || !value.startsWith(prefix) || value.length > 1024 || value.includes("..") || /[\\\0]/.test(value)) return null;
  return value;
}

/** Keeps the parts of a runner result we store and show (bounded; unknown fields dropped). */
export function sanitizeResult(raw: unknown, prefix: string) {
  const r = (raw ?? {}) as Partial<LatexCompileResult>;
  const status = typeof r.status === "string" && RESULT_STATUSES.has(r.status) ? r.status : "failure";
  // Diagnostics the runner left without a zh hint get one from the backend's (possibly newer) hint table.
  const hinted = (d: Record<string, unknown>) => (typeof d.message === "string" && !d.title_zh ? withHint(d as never) : d);
  const list = (v: unknown, max: number) => (Array.isArray(v) ? v.slice(0, max).filter((d) => d && typeof d === "object").map(hinted) : []);
  const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
  return {
    status,
    pdfKey: ownKey(r.pdfKey, prefix),
    synctexKey: ownKey(r.synctexKey, prefix),
    logKey: ownKey(r.logKey, prefix),
    blgKey: ownKey(r.blgKey, prefix),
    durationMs: int(r.durationMs),
    pdfBytes: int(r.pdfBytes),
    compiler: LATEX_COMPILERS.includes(r.compiler as never) ? r.compiler : undefined,
    stored: {
      status,
      errors: list(r.errors, 100),
      warnings: list(r.warnings, 200),
      warningCount: int(r.warningCount) ?? 0,
      badBoxCount: int(r.badBoxCount) ?? 0,
      ...(r.retriedAfterStaleAux ? { retriedAfterStaleAux: true } : {}),
    },
  };
}

/**
 * Applies finished `latex_compile` jobs to `latex_compiles`: the runner's result (a LaTeX error is a successful
 * job with status failure), or failed/cancelled. A compile with a PDF becomes the project's preview unless a newer
 * one already is. Post-commit: the manifest is deleted, compiles beyond the newest KEEP_COMPILES are pruned (rows +
 * S3), and every open document of the project gets `{type:"latex_compiled", compileId, status}`.
 */
export function registerLatexFinalizer(app: FastifyInstance) {
  registerFinalizer(LATEX_JOB_KIND, async (job, { client }) => {
    const payload = job.payload as LatexCompilePayload;
    const row = (await client.query<{ id: string; project_id: string; created_at: string; manifest_key: string; output_prefix: string }>(
      "SELECT id, project_id, created_at, manifest_key, output_prefix FROM latex_compiles WHERE id=$1 AND job_id=$2 FOR UPDATE",
      [payload?.compileId, job.id],
    )).rows[0];
    if (!row) {
      return async () => {
        if (payload?.outputPrefix?.startsWith("latex/")) await app.storage.deletePrefix(payload.outputPrefix);
        if (payload?.manifestKey?.startsWith("latex/")) await app.storage.delete(payload.manifestKey).catch(() => {});
      };
    }
    let status: string;
    if (job.status === "succeeded") {
      const r = sanitizeResult(job.result, row.output_prefix);
      status = r.status;
      await client.query(
        `UPDATE latex_compiles SET status=$2, result=$3, pdf_key=$4, synctex_key=$5, log_key=$6, blg_key=$7, pdf_bytes=$8, duration_ms=$9,
                error=NULL, started_at=$10, finished_at=coalesce($11, now()) WHERE id=$1`,
        [row.id, status, JSON.stringify(r.stored), r.pdfKey, r.synctexKey, r.logKey, r.blgKey, r.pdfBytes, r.durationMs, job.started_at, job.finished_at],
      );
      if (r.pdfKey) {
        await client.query(
          `UPDATE latex_projects p SET last_pdf_compile_id=$2 WHERE p.id=$1 AND (p.last_pdf_compile_id IS NULL
             OR (SELECT created_at FROM latex_compiles WHERE id=p.last_pdf_compile_id) <= $3)`,
          [row.project_id, row.id, row.created_at],
        );
      }
    } else {
      status = job.status === "cancelled" ? "cancelled" : "failed";
      const error = status === "failed" ? (job.error ?? "編譯工作失敗。").slice(-4000) : "已取消。";
      await client.query(
        "UPDATE latex_compiles SET status=$2, error=coalesce(error,$3), started_at=$4, finished_at=coalesce($5, now()) WHERE id=$1",
        [row.id, status, error, job.started_at, job.finished_at],
      );
    }
    // Keep the newest compiles and the project's preview PDF.
    const pruned = (await client.query<{ id: string; output_prefix: string; manifest_key: string }>(
      `DELETE FROM latex_compiles c WHERE c.project_id=$1 AND c.status NOT IN ('queued','running')
          AND c.id NOT IN (SELECT id FROM latex_compiles WHERE project_id=$1 ORDER BY created_at DESC LIMIT ${KEEP_COMPILES})
          AND c.id IS DISTINCT FROM (SELECT last_pdf_compile_id FROM latex_projects WHERE id=$1)
        RETURNING c.id, c.output_prefix, c.manifest_key`,
      [row.project_id],
    )).rows;
    const docs = (await client.query<{ id: string }>("SELECT id FROM latex_files WHERE project_id=$1 AND kind='text'", [row.project_id])).rows;
    return async () => {
      await app.storage.delete(row.manifest_key).catch(() => {});
      for (const p of pruned) {
        await app.storage.deletePrefix(p.output_prefix).catch(() => {});
        await app.storage.delete(p.manifest_key).catch(() => {});
      }
      const collab = (app as { collab?: { broadcast(name: string, payload: Record<string, unknown>): void } }).collab;
      for (const d of docs) collab?.broadcast(latexDocName(row.project_id, d.id), { type: "latex_compiled", compileId: row.id, status });
    };
  });
}

export { latexKeys };
