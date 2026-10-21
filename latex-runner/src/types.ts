import type { LatexCompilePayload } from "./shared/contract.js";

export type ClaimedJob = {
  id: string;
  kind: "latex_compile";
  payload: unknown;
  attempts: number;
  max_attempts: number;
};

export type { LatexCompilePayload };

/** Stage labels shown to users (same style as worker/src/types.ts). */
export const STAGES = {
  queued: "排隊中",
  prepare: "準備檔案",
  compile: "編譯中",
  upload: "上傳結果",
  done: "完成",
  failed: "失敗",
  cancelled: "已取消",
} as const;
