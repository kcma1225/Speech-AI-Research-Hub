/**
 * Subscription logins as provider entries (EXPERIMENTAL, POC only): ChatGPT (Codex), Claude (OAuth) and the
 * Claude Code CLI adapter. HTTP entries reuse the normal codecs; a fetch wrapper rewrites each request with the
 * library's `decorate*Request` helpers using tokens from the encrypted, row-locked store (`oauth-store.ts`).
 */
import {
  CHATGPT_WARNINGS_ZH,
  CLAUDE_CLI_WARNINGS_ZH,
  CLAUDE_OAUTH_WARNINGS_ZH,
  codexModelsUrl,
  decorateClaudeRequest,
  decorateCodexRequest,
  mapCodexError,
  parseCodexModels,
  type OAuthTokens,
} from "../oauth/index.js";
import { getProvider, registerProvider, type ProviderEntry } from "../providers/index.js";

export const SUBSCRIPTION_KINDS = ["chatgpt", "claude-oauth", "claude-cli"] as const;
export type SubscriptionKind = (typeof SUBSCRIPTION_KINDS)[number];
export const isSubscriptionKind = (k: string): k is SubscriptionKind => (SUBSCRIPTION_KINDS as readonly string[]).includes(k);

const timeoutField = { key: "timeoutMs", label: { zh: "逾時（毫秒）", en: "Timeout (ms)" }, type: "number" as const, default: 180_000 };

const ENTRIES: ProviderEntry[] = [
  {
    id: "chatgpt",
    label: { zh: "ChatGPT 訂閱（實驗性）", en: "ChatGPT subscription (experimental)" },
    category: "external",
    codec: "openai-responses",
    defaultBaseUrl: "https://chatgpt.com/backend-api/codex",
    auth: { type: "oauth" },
    fields: [timeoutField],
    capabilities: { chat: true, tools: true, vision: true, reasoning: true, embeddings: false, listModels: true, jsonSchema: true },
    params: [],
    quirks: {
      responsesStore: false,
      includeEncryptedReasoning: true,
      warnings_zh: [...CHATGPT_WARNINGS_ZH],
      mapError: ({ status, body }) => mapCodexError(status, body),
    },
    docsUrl: "https://developers.openai.com/codex/auth",
    help_zh: "以 Codex CLI 的裝置代碼流程登入你的 ChatGPT 方案。建立帳號後按「登入」。",
  },
  {
    id: "claude-oauth",
    label: { zh: "Claude 訂閱（實驗性）", en: "Claude subscription (experimental)" },
    category: "external",
    codec: "anthropic-messages",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    auth: { type: "oauth" },
    fields: [timeoutField],
    capabilities: { chat: true, tools: true, vision: true, reasoning: true, embeddings: false, listModels: true, jsonSchema: true },
    params: [],
    quirks: { warnings_zh: [...CLAUDE_OAUTH_WARNINGS_ZH] },
    docsUrl: "https://docs.claude.com/en/docs/claude-code/iam",
    help_zh: "以 Claude Code 的 OAuth（貼回代碼）或 setup-token 登入。第三方使用會按 token 另外計費。",
  },
  {
    id: "claude-cli",
    label: { zh: "Claude Code CLI（實驗性）", en: "Claude Code CLI (experimental)" },
    category: "external",
    // Nominal: chat runs through runClaudeCli in the router, not a codec.
    codec: "anthropic-messages",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    auth: { type: "oauth" },
    fields: [
      {
        key: "oauthToken",
        label: { zh: "setup-token", en: "setup-token" },
        type: "secret",
        required: true,
        help_zh: "在任何一台電腦執行 `claude setup-token`，把產生的 sk-ant-oat… 貼到這裡（有效期約一年）。",
      },
      { key: "command", label: { zh: "CLI 指令", en: "CLI command" }, type: "text", default: "claude", help_zh: "ai-worker 映像內的 claude 執行檔。" },
      { key: "maxBudgetUsd", label: { zh: "單次花費上限（美元）", en: "Max budget per call (USD)" }, type: "number" },
      { key: "timeoutMs", label: { zh: "逾時（毫秒）", en: "Timeout (ms)" }, type: "number", default: 600_000 },
    ],
    capabilities: { chat: true, tools: false, vision: true, reasoning: true, embeddings: false, listModels: false, jsonSchema: true },
    params: [],
    quirks: { modelsPath: null, staticModels: ["sonnet", "opus", "haiku"], warnings_zh: [...CLAUDE_CLI_WARNINGS_ZH] },
    docsUrl: "https://docs.claude.com/en/docs/claude-code/cli-reference",
    help_zh: "在 ai-worker 執行官方 claude CLI（只能產生文字，不支援工具呼叫，不適合 AI 助理）。",
  },
];

let registered = false;
/** Adds the subscription entries to the provider registry (idempotent). */
export function registerSubscriptionProviders() {
  if (registered && getProvider("chatgpt")) return;
  for (const e of ENTRIES) registerProvider(e);
  registered = true;
}
registerSubscriptionProviders();

const headerRecord = (h: RequestInit["headers"] | undefined): Record<string, string> => Object.fromEntries(new Headers(h ?? {}).entries());

/**
 * fetch wrapper for `chatgpt` / `claude-oauth` accounts: every request gets fresh tokens and the vendor's
 * required headers/body changes. Tokens never appear in errors or logs.
 */
export function subscriptionFetch(kind: SubscriptionKind, getTokens: () => Promise<OAuthTokens>, base: typeof fetch = globalThis.fetch): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const tokens = await getTokens();
    const method = (init.method ?? "GET").toUpperCase();
    const bodyObj = typeof init.body === "string" && init.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    if (kind === "chatgpt") {
      if (method === "GET" && /\/models(\?|$)/.test(url)) {
        const d = decorateCodexRequest({ tokens, body: {} });
        const res = await base(codexModelsUrl(), { method: "GET", headers: { ...d.headers, accept: "application/json" }, signal: init.signal });
        if (!res.ok) return res;
        const models = parseCodexModels(await res.json());
        return new Response(JSON.stringify({ data: models.map((m) => ({ id: m.id, object: "model", context_window: m.contextWindow })) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const d = decorateCodexRequest({ tokens, body: bodyObj ?? {} });
      return base(d.url, { ...init, headers: d.headers, body: JSON.stringify(d.body) });
    }
    // claude-oauth
    const d = decorateClaudeRequest({ accessToken: tokens.accessToken, body: bodyObj ?? {}, headers: headerRecord(init.headers) });
    if (method === "GET") return base(url, { ...init, headers: d.headers });
    return base(d.url, { ...init, headers: d.headers, body: JSON.stringify(d.body) });
  }) as typeof fetch;
}
