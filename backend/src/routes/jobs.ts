import type { FastifyPluginAsync } from "fastify";
import type { JobKind, JobStatus } from "../jobs/queue.js";
import { requireUser } from "../lib/auth.js";
import { focusHref } from "../workflows/active.js";

/** Stage values written by the database/backend rather than the worker, shown in 繁中 like the worker's. */
const STAGE_LABELS: Record<string, string> = {
  queued: "排隊中", starting: "準備中", cancelled: "已取消",
  // ai-worker jobs report machine stages (`ctx.progress("generating", …)`).
  context: "整理資料", generating: "AI 撰寫中", writing: "寫入檔案", validating: "檢查格式", fixing: "修正格式", continuing: "AI 接續撰寫", visual_check: "檢查版面", publishing: "發布第一版",
  analyzing: "分析中", transcribing: "轉錄中", mapping: "對應語者", saving: "儲存中", downloading: "下載中",
  fetching_pdfs: "下載全文", done: "完成",
};
const displayStage = (stage: string) => STAGE_LABELS[stage] ?? stage;

/** Housekeeping jobs that have their own UI (editor status, preview pane) or none; never shown in the tray. */
const HIDDEN_KINDS = ["slide_preview", "latex_compile", "ai_search_index"];

type ActiveJobRow = {
  id: string; kind: JobKind; status: JobStatus; stage: string; progress: number; updated_at: string;
  payload: Record<string, unknown>; deck_id: string | null; deck_title: string | null; version: number | null;
  meeting_id: string | null; study_slug: string | null; wf_status: string | null; wf_conversation: string | null; wf_id: string | null; wf_goal?: string | null;
};

/** Workflow runs outlive their job (the job ends while the run waits for the user): show the run's own state. */
const WORKFLOW_WAITING: Record<string, string> = { awaiting_plan_approval: "等待確認計畫", awaiting_input: "等待你回答", needs_pdf: "需要 PDF", paused: "已暫停", queued: "排隊中" };

const str = (value: unknown) => (typeof value === "string" && value ? value : null);

/** Tray label and SPA link for each job kind; unknown kinds fall back to the payload's `fileName`. */
function present(row: ActiveJobRow): { label: string; url: string | null } {
  const fileName = str(row.payload.fileName);
  switch (row.kind) {
    case "slide_render":
      return row.deck_title ? { label: `${row.deck_title} v${row.version}`, url: `/slides/${row.deck_id}` } : { label: "已刪除的簡報", url: null };
    case "ai_slides_generate":
      return { label: fileName ?? "AI 簡報草稿", url: str(row.payload.deckId) ? `/slides/${row.payload.deckId}` : null };
    case "media_transcode":
      return { label: fileName ?? "錄音轉檔", url: row.meeting_id ? `/meetings/${row.meeting_id}` : null };
    case "ai_meeting_transcribe":
    case "ai_meeting_analyze":
      return {
        label: fileName ?? (row.kind === "ai_meeting_transcribe" ? "會議轉錄" : "會議分析"),
        url: str(row.payload.meetingId) ? `/meetings/${row.payload.meetingId}` : null,
      };
    case "ai_library_import":
      return { label: "下載開放全文", url: row.study_slug ? `/studies/${row.study_slug}?tab=papers` : "/library" };
    case "ai_workflow":
      // Deep link to the run's card (plan / question card when it waits for the user): see workflows/active.ts.
      return { label: fileName ?? "Agent 工作流程", url: row.wf_id ? focusHref(row.wf_conversation, row.wf_goal ? `goal:${row.wf_goal}` : `workflow:${row.wf_id}`, row.wf_id) : "/assistant/workflows" };
    case "ai_embedding_reindex":
      return { label: "重建語意索引", url: "/admin/models" };
    default:
      return { label: fileName ?? "背景工作", url: null };
  }
}

const jobs: FastifyPluginAsync = async app => {
  /** The caller's queued/running jobs plus those finished in the last 10 minutes (header job tray). */
  app.get("/jobs/active", async (request, reply) => {
    const user = await requireUser(request);
    const rows = (await app.db.query<ActiveJobRow>(
      `SELECT j.id,j.kind,j.status,j.stage,j.progress,j.payload,
              GREATEST(j.created_at,j.started_at,j.heartbeat_at,j.finished_at) AS updated_at,
              COALESCE(p.id::text,j.payload->>'projectId') AS deck_id,p.title AS deck_title,v.version,
              mm.meeting_id::text AS meeting_id,s.slug AS study_slug,wr.status AS wf_status,wr.conversation_id::text AS wf_conversation,wr.id::text AS wf_id,wr.goal_id::text AS wf_goal
         FROM jobs j
         LEFT JOIN slide_versions v ON j.kind='slide_render' AND v.id::text=j.payload->>'versionId'
         LEFT JOIN decks p ON p.id=v.deck_id
         LEFT JOIN meeting_media mm ON j.kind='media_transcode' AND mm.id::text=j.payload->>'itemId'
         LEFT JOIN import_batches b ON j.kind='ai_library_import' AND b.id::text=j.payload->>'batchId'
         LEFT JOIN studies s ON s.id=b.study_id
         LEFT JOIN workflow_runs wr ON j.kind='ai_workflow' AND wr.id::text=j.payload->>'workflowId'
        WHERE j.created_by=$1 AND j.kind <> ALL($2::text[])
          AND (j.status IN ('queued','running') OR j.finished_at > now() - interval '10 minutes'
               OR wr.status IN ('awaiting_plan_approval','awaiting_input','needs_pdf','paused'))
        ORDER BY j.created_at DESC, j.id
        LIMIT 10`,
      [user.id, HIDDEN_KINDS],
    )).rows;
    const result = rows.map(row => {
      const waiting = row.wf_status ? WORKFLOW_WAITING[row.wf_status] : undefined;
      const status: JobStatus = row.wf_status === "queued" ? "queued" : waiting ? "running" : row.wf_status === "failed" ? "failed" : row.status;
      const stage = waiting ?? (row.wf_status === "partial" ? "部分完成" : displayStage(row.stage));
      return {
      id: row.id,
      kind: row.kind,
      status,
      stage,
      progress: status === "succeeded" ? 100 : row.progress,
      ...present(row),
      updatedAt: row.updated_at,
      };
    });
    return reply.header("Cache-Control", "no-store").send({ jobs: result });
  });
};

export default jobs;
