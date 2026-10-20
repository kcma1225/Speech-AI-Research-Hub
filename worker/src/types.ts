/** Job contracts shared with the backend. Keep in sync with backend/src/jobs/queue.ts. */
export type JobKind = "media_transcode" | "slide_render";

export type MediaTranscodePayload = { itemId: string; sourceKey: string; outputKey: string; fileName: string };
export type MediaTranscodeResult = { outputKey: string; bytes: number; durationSeconds: number | null };
export type SlideRenderPayload = { projectId: string; versionId: string; sourceKey: string; entry: string; outputPrefix: string };
/** `sharedPrefix`: where `offline-assets/` of this render is stored (content-addressed, shared across versions). */
export type SlideRenderResult = { entryHtml: string; pdfKey: string; quartoVersion: string; fileCount: number; sharedPrefix: string };

export type ClaimedJob = {
  id: string;
  kind: JobKind;
  payload: unknown;
  attempts: number;
  max_attempts: number;
};

/** Stage labels shown to users. */
export const STAGES = {
  queued: "排隊中",
  analyze: "分析媒體",
  transcode: "音訊轉碼",
  extract: "解壓縮",
  render: "編譯簡報",
  pdf: "匯出 PDF",
  upload: "上傳結果",
  done: "完成",
  failed: "失敗",
  cancelled: "已取消",
} as const;
