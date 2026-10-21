/** Roles (功能綁定): code asks for a role, never a model. See docs/v3-spec.md §4. */

export const AI_ROLES = ["assistant", "writing", "slides", "analysis", "fast", "embedding", "asr", "asr_live"] as const;
export type AiRole = (typeof AI_ROLES)[number];
export type ChatRole = "assistant" | "writing" | "slides" | "analysis" | "fast";
export type RouteCapability = "chat" | "embedding" | "asr";

export const isAiRole = (v: unknown): v is AiRole => typeof v === "string" && (AI_ROLES as readonly string[]).includes(v);

/** Which route capability a role binds to. */
export const ROLE_CAPABILITY: Record<AiRole, RouteCapability> = {
  assistant: "chat",
  writing: "chat",
  slides: "chat",
  analysis: "chat",
  fast: "chat",
  embedding: "embedding",
  asr: "asr",
  asr_live: "asr",
};

export const ROLE_LABEL_ZH: Record<AiRole, string> = {
  assistant: "AI 助理",
  writing: "寫作建議",
  slides: "簡報生成",
  analysis: "會議與文獻分析",
  fast: "快速任務",
  embedding: "語意搜尋",
  asr: "語音轉文字",
  asr_live: "即時字幕",
};

export type RoleState = "ok" | "degraded" | "unavailable" | "unconfigured";
