import type { FastifyPluginAsync } from "fastify";
import type { JobKind, JobStatus } from "../jobs/queue.js";
import { requireUser } from "../lib/auth.js";

/** Stage values written by the database/backend rather than the worker, shown in 繁中 like the worker's. */
const STAGE_LABELS: Record<string, string> = { queued: "排隊中", starting: "準備中", cancelled: "已取消" };
const displayStage = (stage: string) => STAGE_LABELS[stage] ?? stage;

type ActiveJobRow = {
  id: string; kind: JobKind; status: JobStatus; stage: string; progress: number; updated_at: string;
  project_id: string | null; deck_title: string | null; version: number | null;
  item_id: string | null; item_title: string | null; file_name: string | null;
};

const jobs: FastifyPluginAsync = async app => {
  /** The caller's queued/running jobs plus those finished in the last 10 minutes (header job tray). */
  app.get("/jobs/active", async (request, reply) => {
    const user = await requireUser(request);
    const rows = (await app.db.query<ActiveJobRow>(
      `SELECT j.id,j.kind,j.status,j.stage,j.progress,
              GREATEST(j.created_at,j.started_at,j.heartbeat_at,j.finished_at) AS updated_at,
              COALESCE(p.id::text,j.payload->>'projectId') AS project_id,p.title AS deck_title,v.version,
              COALESCE(i.id::text,j.payload->>'itemId') AS item_id,i.title AS item_title,j.payload->>'fileName' AS file_name
         FROM jobs j
         LEFT JOIN slide_versions v ON j.kind='slide_render' AND v.id::text=j.payload->>'versionId'
         LEFT JOIN slide_projects p ON p.id=v.project_id
         LEFT JOIN items i ON j.kind='media_transcode' AND i.id::text=j.payload->>'itemId'
        WHERE j.created_by=$1
          AND (j.status IN ('queued','running') OR j.finished_at > now() - interval '10 minutes')
        ORDER BY j.created_at DESC, j.id
        LIMIT 10`,
      [user.id],
    )).rows;
    const result = rows.map(row => {
      const slide = row.kind === "slide_render";
      const label = slide
        ? row.deck_title ? `${row.deck_title} v${row.version}` : "已刪除的簡報"
        : row.item_title ?? row.file_name ?? "已刪除的筆記";
      return {
        id: row.id,
        kind: row.kind,
        status: row.status,
        stage: displayStage(row.stage),
        progress: row.status === "succeeded" ? 100 : row.progress,
        label,
        url: slide ? (row.deck_title ? `/slides/${row.project_id}` : null) : (row.item_title ? `/notes/${row.item_id}` : null),
        updatedAt: row.updated_at,
      };
    });
    return reply.header("Cache-Control", "no-store").send({ jobs: result });
  });
};

export default jobs;
