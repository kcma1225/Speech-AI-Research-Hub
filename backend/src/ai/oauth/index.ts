/** Public subscription-OAuth API (EXPERIMENTAL). See docs/ai-asr-oauth.md. */
export type { OAuthTokens, OAuthHttp, SubscriptionProvider } from "./types.js";
export { isReauthRequired, decodeJwtPayload, pkcePair, type OAuthError } from "./util.js";
export {
  CHATGPT,
  startChatgptDeviceLogin,
  pollChatgptDeviceLogin,
  exchangeChatgptCode,
  refreshChatgptTokens,
  revokeChatgpt,
  chatgptClaims,
  decorateCodexRequest,
  codexModelsUrl,
  parseCodexModels,
  parseCodexRateLimits,
  mapCodexError,
  CODEX_STRIPPED_FIELDS,
  type DeviceLogin,
  type DevicePollResult,
  type CodexRequestInput,
  type CodexRateLimits,
} from "./chatgpt.js";
export {
  CLAUDE,
  startClaudeLogin,
  parsePastedClaudeCode,
  exchangeClaudeCode,
  refreshClaudeTokens,
  claudeSetupToken,
  isClaudeOAuthToken,
  decorateClaudeRequest,
  type ClaudePendingLogin,
} from "./claude.js";
export { refreshIfNeeded, needsRefresh, type RefreshOptions } from "./refresh.js";
export {
  runClaudeCli,
  buildClaudeCliInvocation,
  cliUserMessage,
  createClaudeStreamParser,
  parseClaudeStreamJson,
  classifyCliError,
  type ClaudeCliOptions,
  type CliInvocation,
} from "./claude-cli.js";
export { OAUTH_EXPERIMENTAL_ZH, CHATGPT_WARNINGS_ZH, CLAUDE_OAUTH_WARNINGS_ZH, CLAUDE_CLI_WARNINGS_ZH, OAUTH_REAUTH_ZH } from "./warnings.js";
