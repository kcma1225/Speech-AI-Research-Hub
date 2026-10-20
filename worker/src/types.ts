/** Job contracts shared with the backend. Keep in sync with backend/src/jobs/queue.ts. */
export type JobKind = "media_transcode" | "slide_render";

export type MediaTranscodePayload = { itemId: string; sourceKey: string; outputKey: string; fileName: string };
/** `peaks`: waveform overview, ≤1000 values in [0,1] (3 decimals); omitted when it could not be computed. */
export type MediaTranscodeResult = { outputKey: string; bytes: number; durationSeconds: number | null; peaks?: number[] };
export type SlideRenderPayload = { projectId: string; versionId: string; sourceKey: string; entry: string; outputPrefix: string };
/**
 * `sharedPrefix`: where `offline-assets/` of this render is stored (content-addressed, shared across versions).
 * `thumbnailKey`: full key of the 960 px wide, deck aspect ratio PNG of the first slide (`<outputPrefix>_hub-thumbnail.png`); omitted when
 * capture/upload failed or the deck ships its own `_hub-thumbnail.png`.
 */
export type SlideRenderResult = {
  entryHtml: string;
  pdfKey: string;
  quartoVersion: string;
  fileCount: number;
  sharedPrefix: string;
  thumbnailKey?: string;
};

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
