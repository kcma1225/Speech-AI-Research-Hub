/** Admin-facing warnings (繁中) for subscription logins. Show them before and after connecting. */

export const OAUTH_EXPERIMENTAL_ZH = "實驗性功能：僅供 POC 使用，不可商用。廠商隨時可能變更或封鎖，屆時這個帳號會停止運作。";

export const CHATGPT_WARNINGS_ZH = [
  OAUTH_EXPERIMENTAL_ZH,
  "使用 Codex CLI 的登入方式呼叫 ChatGPT 的非公開介面，可能違反 OpenAI 的使用條款，帳號有被停用的風險。",
  "請先在 ChatGPT「設定 → 安全性」開啟「裝置代碼登入」，再按「開始登入」，到 auth.openai.com/codex/device 輸入畫面上的代碼（15 分鐘內有效）。",
  "用量計入你的 ChatGPT 方案額度；額度用完時，相關 AI 功能會顯示「維護中」，直到額度重置。",
] as const;

export const CLAUDE_OAUTH_WARNINGS_ZH = [
  OAUTH_EXPERIMENTAL_ZH,
  "Anthropic 的條款不允許第三方應用程式使用 Claude 訂閱登入，帳號可能在不另行通知的情況下被封鎖。",
  "自 2026-04-04 起，第三方使用 Claude 訂閱會算成「額外用量」，按 token 另外計費，不會使用方案內的額度。請到 https://claude.ai/settings/usage 管理額外用量上限。",
  "登入方式：開啟授權連結並登入 claude.ai，複製頁面顯示的代碼（格式為 code#state），貼回這裡（10 分鐘內有效）。",
] as const;

export const CLAUDE_CLI_WARNINGS_ZH = [
  OAUTH_EXPERIMENTAL_ZH,
  "這個方式在可以連外網的 ai-worker 容器裡執行官方 Claude Code CLI，使用 `claude setup-token` 產生的 token（有效期約一年）。",
  "CLI 只能產生文字，不支援本平台的工具呼叫；適合寫作、摘要、分析等功能，不適合聊天助理（assistant）。",
  "計費方式（方案額度或額外用量）由 Anthropic 決定，目前沒有公開說明。",
] as const;

export const OAUTH_REAUTH_ZH = "訂閱帳號的登入已失效，請管理員到「模型設定」重新登入。";
