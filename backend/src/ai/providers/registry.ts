/**
 * Provider registry: one entry per vendor. Entries are data + small hooks; codecs do the wire work.
 * Model ids in staticModels are examples only (vendors rename monthly) — prefer listModels().
 */
import { AiError } from "../errors.js";
import type { AuthSpec, Capabilities, FormField, ParamSpec, ProviderEntry, PublicProviderEntry, Quirks } from "./entry.js";

// ---------------------------------------------------------------- field builders

const F = {
  apiKey: (required = true, help_zh?: string): FormField => ({
    key: "apiKey",
    label: { zh: "API 金鑰", en: "API key" },
    type: "secret",
    required,
    help_zh: help_zh ?? (required ? "從廠商後台建立的 API 金鑰；儲存後會加密，畫面上只顯示遮罩。" : "伺服器有設定 --api-key 時才需要填寫。"),
  }),
  baseUrl: (def?: string, required = false): FormField => ({
    key: "baseUrl",
    label: { zh: "服務網址", en: "Base URL" },
    type: "url",
    required,
    default: def,
    placeholder: def,
    help_zh: "一般不需要修改；使用代理或自架閘道時才改。",
  }),
  supportsTools: (def: boolean): FormField => ({
    key: "supportsTools",
    label: { zh: "支援工具呼叫", en: "Supports tool calls" },
    type: "boolean",
    default: def,
    help_zh: "本機伺服器能否呼叫工具取決於啟動參數（例如 vLLM 的 --enable-auto-tool-choice --tool-call-parser）。開啟後請按「測試」確認。",
  }),
  timeoutMs: (def = 120_000): FormField => ({
    key: "timeoutMs",
    label: { zh: "逾時（毫秒）", en: "Timeout (ms)" },
    type: "number",
    default: def,
    help_zh: "等待第一個回應位元組及串流中斷的最長時間。本機模型冷啟動較慢，可調高。",
  }),
  extraHeaders: (): FormField => ({
    key: "extraHeaders",
    label: { zh: "額外標頭", en: "Extra headers" },
    type: "json",
    multiline: true,
    help_zh: '每次請求都會加上的 HTTP 標頭，JSON 物件，例如 {"X-Team": "lab"}。',
  }),
  extraBody: (): FormField => ({
    key: "extraBody",
    label: { zh: "額外請求欄位", en: "Extra body fields" },
    type: "json",
    multiline: true,
    help_zh: '合併到每次聊天請求本文的 JSON 物件（進階）。例如 {"chat_template_kwargs": {"enable_thinking": false}}。',
  }),
  probeModel: (help_zh = "此廠商沒有模型清單端點；「測試」會用這個模型送一個極短的請求。"): FormField => ({
    key: "probeModel",
    label: { zh: "測試用模型", en: "Probe model" },
    type: "text",
    help_zh,
  }),
  region: (options: Array<[string, string, string]>, def: string): FormField => ({
    key: "region",
    label: { zh: "區域", en: "Region" },
    type: "select",
    required: true,
    default: def,
    options: options.map(([value, zh, en]) => ({ value, label: { zh, en } })),
  }),
};

/** Embedding-related fields (client-side templates, normalisation, batch size). */
const EMBED_FIELDS: FormField[] = [
  {
    key: "queryTemplate",
    label: { zh: "查詢前綴範本", en: "Query template" },
    type: "text",
    help_zh: "只對沒有 input_type 參數的模型使用。用 {text} 代表原文、{task} 代表任務說明，例如 Qwen3-Embedding：Instruct: {task}\\nQuery:{text}。更改後必須重算所有向量。",
  },
  {
    key: "documentTemplate",
    label: { zh: "文件前綴範本", en: "Document template" },
    type: "text",
    help_zh: "例如 nomic-embed-text：search_document: {text}。多數模型留空。",
  },
  { key: "taskInstruction", label: { zh: "任務說明", en: "Task instruction" }, type: "text", help_zh: "填入範本中的 {task}。" },
  { key: "normalize", label: { zh: "L2 正規化", en: "L2 normalise" }, type: "boolean", default: true, help_zh: "在本機把向量正規化為單位長度（建議開啟）。" },
  { key: "batchSize", label: { zh: "批次大小", en: "Batch size" }, type: "number", help_zh: "每次請求最多送出的文字數。" },
];

const COMMON_TAIL = (opts: { headers?: boolean; body?: boolean } = {}): FormField[] => [
  F.timeoutMs(),
  ...(opts.headers === false ? [] : [F.extraHeaders()]),
  ...(opts.body === false ? [] : [F.extraBody()]),
];

// ---------------------------------------------------------------- param builders

const P = {
  num: (key: string, zh: string, en: string, extra: Partial<ParamSpec> = {}): ParamSpec => ({ key, type: "number", label: { zh, en }, ...extra }),
  int: (key: string, zh: string, en: string, extra: Partial<ParamSpec> = {}): ParamSpec => ({ key, type: "integer", label: { zh, en }, ...extra }),
  str: (key: string, zh: string, en: string, extra: Partial<ParamSpec> = {}): ParamSpec => ({ key, type: "string", label: { zh, en }, ...extra }),
  bool: (key: string, zh: string, en: string, extra: Partial<ParamSpec> = {}): ParamSpec => ({ key, type: "boolean", label: { zh, en }, ...extra }),
  sel: (key: string, zh: string, en: string, options: string[], extra: Partial<ParamSpec> = {}): ParamSpec => ({ key, type: "select", label: { zh, en }, options, ...extra }),
  json: (key: string, zh: string, en: string, extra: Partial<ParamSpec> = {}): ParamSpec => ({ key, type: "json", label: { zh, en }, ...extra }),
};

const SAMPLING_COMPAT: ParamSpec[] = [
  P.num("presence_penalty", "存在懲罰", "Presence penalty", { min: -2, max: 2 }),
  P.num("frequency_penalty", "頻率懲罰", "Frequency penalty", { min: -2, max: 2 }),
  P.int("seed", "亂數種子", "Seed"),
];
const LOCAL_SAMPLING: ParamSpec[] = [
  ...SAMPLING_COMPAT,
  P.int("top_k", "Top-K", "Top-K"),
  P.num("min_p", "Min-P", "Min-P", { min: 0, max: 1 }),
  P.num("repetition_penalty", "重複懲罰", "Repetition penalty"),
  P.json("chat_template_kwargs", "對話範本參數", "chat_template_kwargs", { help_zh: '例如 {"enable_thinking": false} 關閉 Qwen3 的思考。' }),
];

// ---------------------------------------------------------------- capability presets

const caps = (c: Partial<Capabilities>): Capabilities => ({
  chat: true,
  tools: true,
  vision: false,
  reasoning: false,
  embeddings: false,
  listModels: true,
  ...c,
});
const EMBED_ONLY = caps({ chat: false, tools: false, embeddings: true });

const bearer = (optional = false): AuthSpec => ({ type: "api_key", header: "authorization", scheme: "Bearer", optional });

// ---------------------------------------------------------------- vendor error tables

/** Zhipu: map by business code, not HTTP status (their 429 also means "overloaded"/"no balance"). */
function zhipuError(input: { status: number; body: unknown }): AiError | undefined {
  const e = (input.body as { error?: { code?: unknown; message?: string } })?.error;
  const code = e?.code != null ? String(e.code) : "";
  if (!code) return undefined;
  const base = { status: input.status, vendorCode: code, vendorMessage: e?.message };
  if (["1000", "1001", "1002", "1003", "1004"].includes(code)) return new AiError("auth_failed", base);
  if (code === "1113") return new AiError("quota_exhausted", base);
  if (code === "1211") return new AiError("model_not_found", base);
  if (code === "1261") return new AiError("context_too_long", base);
  if (code === "1301") return new AiError("content_filtered", base);
  if (code === "1302") return new AiError("rate_limited", base);
  if (code === "1305") return new AiError("overloaded", base);
  if (code === "1308" || code === "1310") return new AiError("rate_limited", { ...base, retryable: false });
  if (code === "1234") return new AiError("unavailable", base);
  if (/^12\d\d$/.test(code)) return new AiError("bad_request", base);
  return undefined;
}

/** DashScope: `data_inspection_failed` is a content filter; wrong-region keys give invalid_api_key. */
function dashscopeError(input: { status: number; body: unknown }): AiError | undefined {
  const e = (input.body as { error?: { code?: string; message?: string }; code?: string; message?: string }) ?? {};
  const code = String(e.error?.code ?? e.code ?? "");
  const message = e.error?.message ?? e.message;
  if (/data_inspection_failed|DataInspectionFailed/i.test(code)) return new AiError("content_filtered", { status: input.status, vendorCode: code, vendorMessage: message });
  if (/Arrearage|insufficient/i.test(code)) return new AiError("quota_exhausted", { status: input.status, vendorCode: code, vendorMessage: message });
  return undefined;
}

/** OpenRouter 403 = moderation; 402 = credits. */
function openRouterError(input: { status: number; body: unknown }): AiError | undefined {
  const e = (input.body as { error?: { message?: string; metadata?: unknown } })?.error;
  if (input.status === 403 && e?.metadata) return new AiError("content_filtered", { status: 403, vendorMessage: e.message });
  return undefined;
}

// ---------------------------------------------------------------- entries

const OPENAI_COMPAT_FIELDS = (def: string) => [F.apiKey(), F.baseUrl(def), ...COMMON_TAIL()];

const entries: ProviderEntry[] = [
  // ======================================================== external
  {
    id: "openai",
    label: { zh: "OpenAI", en: "OpenAI" },
    category: "external",
    codec: "openai-responses",
    defaultBaseUrl: "https://api.openai.com/v1",
    auth: bearer(),
    fields: [
      F.apiKey(),
      F.baseUrl("https://api.openai.com/v1"),
      { key: "organization", label: { zh: "組織 ID", en: "Organization" }, type: "text" },
      { key: "project", label: { zh: "專案 ID", en: "Project" }, type: "text" },
      {
        key: "apiStyle",
        label: { zh: "API 類型", en: "API style" },
        type: "select",
        default: "responses",
        options: [
          { value: "responses", label: { zh: "Responses（建議；旗艦模型的工具呼叫只在這裡）", en: "Responses (recommended)" } },
          { value: "chat", label: { zh: "Chat Completions", en: "Chat Completions" } },
        ],
      },
      ...COMMON_TAIL(),
    ],
    capabilities: caps({ vision: true, reasoning: true, embeddings: true, jsonSchema: true }),
    params: [
      P.sel("service_tier", "服務等級", "Service tier", ["auto", "default", "flex", "priority"]),
      P.str("prompt_cache_key", "快取鍵", "Prompt cache key"),
      P.json("reasoning", "推理設定（完整）", "reasoning object", { help_zh: '例如 {"effort":"high","summary":"auto"}；會覆蓋統一的推理設定。' }),
      ...SAMPLING_COMPAT,
    ],
    quirks: { maxTokensField: "max_completion_tokens", reasoningStyle: "openai_effort" },
    docsUrl: "https://developers.openai.com/api/docs",
    help_zh: "預設使用 Responses API（store:false，不在 OpenAI 端保存對話）。推理模型不接受 temperature / top_p。",
    codecFor: (c) => (c.apiStyle === "chat" ? "openai-chat" : "openai-responses"),
    resolveHeaders: (c) => ({
      ...(c.organization ? { "OpenAI-Organization": String(c.organization) } : {}),
      ...(c.project ? { "OpenAI-Project": String(c.project) } : {}),
    }),
  },
  {
    id: "anthropic",
    label: { zh: "Anthropic（Claude）", en: "Anthropic (Claude)" },
    category: "external",
    codec: "anthropic-messages",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    auth: { type: "api_key", header: "x-api-key" },
    fields: [
      F.apiKey(),
      F.baseUrl("https://api.anthropic.com/v1"),
      { key: "betas", label: { zh: "Beta 功能", en: "Beta headers" }, type: "text", help_zh: "以逗號分隔，會送出 anthropic-beta 標頭。" },
      ...COMMON_TAIL(),
    ],
    capabilities: caps({ vision: true, reasoning: true, jsonSchema: true }),
    params: [
      P.int("top_k", "Top-K", "Top-K", { help_zh: "開啟思考時不可用。" }),
      P.json("cache_control", "提示快取", "cache_control", { help_zh: '例如 {"type":"ephemeral","ttl":"1h"}。' }),
      P.json("thinking", "思考設定（完整）", "thinking object"),
      P.json("output_config", "輸出設定（完整）", "output_config object"),
    ],
    quirks: { fixedHeaders: { "anthropic-version": "2023-06-01" } },
    docsUrl: "https://platform.claude.com/docs",
    help_zh: "沒有 embedding；請另外設定 Voyage 等服務。部分新模型不接受強制 tool_choice（required / 指定工具）。",
    resolveHeaders: (c): Record<string, string> => (c.betas ? { "anthropic-beta": String(c.betas).split(",").map((s) => s.trim()).filter(Boolean).join(",") } : {}),
  },
  {
    id: "gemini",
    label: { zh: "Google Gemini（AI Studio）", en: "Google Gemini (AI Studio)" },
    category: "external",
    codec: "gemini",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    auth: { type: "api_key", header: "x-goog-api-key" },
    fields: [F.apiKey(), F.baseUrl("https://generativelanguage.googleapis.com/v1beta"), ...EMBED_FIELDS.filter((f) => f.key === "normalize" || f.key === "batchSize"), ...COMMON_TAIL()],
    capabilities: caps({ vision: true, reasoning: true, embeddings: true, jsonSchema: true }),
    params: [
      P.int("generationConfig.topK", "Top-K", "Top-K"),
      P.json("safetySettings", "安全設定", "safetySettings"),
      P.json("generationConfig.thinkingConfig", "思考設定（完整）", "thinkingConfig"),
      P.str("cachedContent", "快取內容", "cachedContent"),
    ],
    quirks: {},
    docsUrl: "https://ai.google.dev/gemini-api/docs",
    help_zh: "gemini-embedding-001 在低於 3072 維時需要正規化（預設已開啟）。",
  },
  {
    id: "vertex",
    label: { zh: "Google Vertex AI", en: "Google Vertex AI" },
    category: "external",
    codec: "gemini",
    auth: { type: "google_service_account" },
    fields: [
      { key: "serviceAccountJson", label: { zh: "服務帳戶 JSON", en: "Service account JSON" }, type: "secret", multiline: true, required: true, help_zh: "在 GCP IAM 建立服務帳戶金鑰（需要 Vertex AI User 角色），貼上整份 JSON。" },
      { key: "projectId", label: { zh: "專案 ID", en: "Project ID" }, type: "text", help_zh: "留空則使用服務帳戶 JSON 裡的 project_id。" },
      { key: "location", label: { zh: "位置", en: "Location" }, type: "text", default: "global", help_zh: "global 或區域（例如 us-central1、asia-east1）。" },
      {
        key: "publisher",
        label: { zh: "模型發布者", en: "Publisher" },
        type: "select",
        default: "google",
        options: [
          { value: "google", label: { zh: "Google（Gemini）", en: "Google (Gemini)" } },
          { value: "anthropic", label: { zh: "Anthropic（Claude on Vertex）", en: "Anthropic (Claude on Vertex)" } },
        ],
      },
      F.probeModel("「測試」時用 countTokens 檢查這個模型的專案權限（免費）。"),
      ...EMBED_FIELDS.filter((f) => f.key === "normalize" || f.key === "batchSize"),
      ...COMMON_TAIL(),
    ],
    capabilities: caps({ vision: true, reasoning: true, embeddings: true, listModels: false, jsonSchema: true }),
    params: [P.int("generationConfig.topK", "Top-K", "Top-K"), P.json("safetySettings", "安全設定", "safetySettings")],
    quirks: { staticModels: [] },
    docsUrl: "https://docs.cloud.google.com/vertex-ai/generative-ai/docs",
    help_zh: "Vertex 沒有好用的模型清單，請手動輸入模型 ID。",
    codecFor: (c) => (c.publisher === "anthropic" ? "anthropic-messages" : "gemini"),
    resolveBaseUrl: (c, s) => {
      let project = String(c.projectId ?? "");
      if (!project && s.serviceAccountJson) {
        try {
          project = String((JSON.parse(s.serviceAccountJson) as { project_id?: string }).project_id ?? "");
        } catch {
          /* validated by auth */
        }
      }
      const loc = String(c.location || "global");
      const host = loc === "global" ? "https://aiplatform.googleapis.com" : `https://${loc}-aiplatform.googleapis.com`;
      return `${host}/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(loc)}`;
    },
  },
  {
    id: "azure",
    label: { zh: "Azure OpenAI / Foundry", en: "Azure OpenAI / Foundry" },
    category: "external",
    codec: "openai-responses",
    auth: { type: "azure", entraScope: "https://ai.azure.com/.default" },
    fields: [
      { key: "endpoint", label: { zh: "資源端點", en: "Resource endpoint" }, type: "url", required: true, placeholder: "https://my-resource.openai.azure.com", help_zh: "Azure 入口網站中的端點；也可用 https://<資源>.services.ai.azure.com。會自動加上 /openai/v1。" },
      {
        key: "authMode",
        label: { zh: "驗證方式", en: "Auth mode" },
        type: "select",
        default: "api_key",
        options: [
          { value: "api_key", label: { zh: "API 金鑰", en: "API key" } },
          { value: "entra", label: { zh: "Microsoft Entra ID（服務主體）", en: "Microsoft Entra ID" } },
        ],
      },
      { ...F.apiKey(true), showIf: { key: "authMode", equals: ["api_key"] } },
      { key: "tenantId", label: { zh: "租用戶 ID", en: "Tenant ID" }, type: "text", required: true, showIf: { key: "authMode", equals: ["entra"] } },
      { key: "clientId", label: { zh: "用戶端 ID", en: "Client ID" }, type: "text", required: true, showIf: { key: "authMode", equals: ["entra"] } },
      { key: "clientSecret", label: { zh: "用戶端密碼", en: "Client secret" }, type: "secret", required: true, showIf: { key: "authMode", equals: ["entra"] }, help_zh: "服務主體需要 Cognitive Services OpenAI User 角色。" },
      {
        key: "apiStyle",
        label: { zh: "API 類型", en: "API style" },
        type: "select",
        default: "responses",
        options: [
          { value: "responses", label: { zh: "Responses（Azure OpenAI 模型建議）", en: "Responses" } },
          { value: "chat", label: { zh: "Chat Completions（DeepSeek、Grok 等合作模型）", en: "Chat Completions" } },
        ],
      },
      ...COMMON_TAIL(),
    ],
    capabilities: caps({ vision: true, reasoning: true, embeddings: true, jsonSchema: true }),
    params: [...SAMPLING_COMPAT],
    quirks: { maxTokensField: "max_completion_tokens" },
    docsUrl: "https://learn.microsoft.com/azure/foundry/openai/api-version-lifecycle",
    help_zh: "使用 v1 API（不需要 api-version）。「模型」欄位填部署名稱，不是模型名稱；模型清單只列出資源可用模型，不是部署。",
    codecFor: (c) => (c.apiStyle === "chat" ? "openai-chat" : "openai-responses"),
    resolveBaseUrl: (c) => `${String(c.endpoint ?? "").replace(/\/+$/, "").replace(/\/openai(\/v1)?$/, "")}/openai/v1`,
  },
  {
    id: "bedrock",
    label: { zh: "AWS Bedrock", en: "AWS Bedrock" },
    category: "external",
    codec: "bedrock-converse",
    auth: { type: "aws", service: "bedrock" },
    fields: [
      { key: "region", label: { zh: "區域", en: "Region" }, type: "text", required: true, default: "us-east-1", help_zh: "例如 us-east-1、us-west-2、ap-northeast-1。長期 API 金鑰只在建立的區域有效。" },
      {
        key: "authMode",
        label: { zh: "驗證方式", en: "Auth mode" },
        type: "select",
        default: "sigv4",
        options: [
          { value: "sigv4", label: { zh: "IAM 存取金鑰（SigV4）", en: "IAM access key (SigV4)" } },
          { value: "bedrock_api_key", label: { zh: "Bedrock API 金鑰", en: "Bedrock API key" } },
        ],
      },
      { key: "accessKeyId", label: { zh: "存取金鑰 ID", en: "Access key ID" }, type: "text", required: true, showIf: { key: "authMode", equals: ["sigv4"] } },
      { key: "secretAccessKey", label: { zh: "秘密存取金鑰", en: "Secret access key" }, type: "secret", required: true, showIf: { key: "authMode", equals: ["sigv4"] } },
      { key: "sessionToken", label: { zh: "工作階段權杖", en: "Session token" }, type: "secret", showIf: { key: "authMode", equals: ["sigv4"] }, help_zh: "只有臨時憑證需要。" },
      { ...F.apiKey(true, "Bedrock 主控台建立的 API 金鑰（Bearer）。需要 bedrock:CallWithBearerToken 權限。"), showIf: { key: "authMode", equals: ["bedrock_api_key"] } },
      F.probeModel("API 金鑰可能無法列出模型；「測試」會改用這個模型（或推論設定檔）送 1 個 token 的請求。"),
      ...EMBED_FIELDS.filter((f) => f.key === "normalize"),
      ...COMMON_TAIL({ body: true }),
    ],
    capabilities: caps({ vision: true, reasoning: true, embeddings: true }),
    params: [
      P.json("additionalModelRequestFields", "模型額外欄位", "additionalModelRequestFields", { help_zh: '直接傳給模型，例如 Claude 的 {"top_k": 50}。' }),
      P.json("guardrailConfig", "防護機制", "guardrailConfig"),
      P.json("performanceConfig", "效能設定", "performanceConfig"),
    ],
    quirks: {},
    docsUrl: "https://docs.aws.amazon.com/bedrock/latest/userguide/",
    help_zh: "新模型多半要用推論設定檔 ID（us. / eu. / global. 開頭）。",
    resolveBaseUrl: (c) => `https://bedrock-runtime.${String(c.region || "us-east-1")}.amazonaws.com`,
  },
  {
    id: "mistral",
    label: { zh: "Mistral AI", en: "Mistral AI" },
    category: "external",
    codec: "openai-chat",
    defaultBaseUrl: "https://api.mistral.ai/v1",
    auth: bearer(),
    fields: [...OPENAI_COMPAT_FIELDS("https://api.mistral.ai/v1"), ...EMBED_FIELDS.filter((f) => f.key === "normalize")],
    capabilities: caps({ vision: true, reasoning: true, embeddings: true, jsonSchema: true }),
    params: [
      P.int("random_seed", "亂數種子", "random_seed"),
      P.bool("safe_prompt", "安全提示", "safe_prompt"),
      P.sel("prompt_mode", "提示模式", "prompt_mode", ["reasoning"]),
      P.num("presence_penalty", "存在懲罰", "Presence penalty"),
      P.num("frequency_penalty", "頻率懲罰", "Frequency penalty"),
    ],
    quirks: { reasoningStyle: "openai_effort", embedBatchSize: 128 },
    docsUrl: "https://docs.mistral.ai/api/",
  },
  {
    id: "deepseek",
    label: { zh: "DeepSeek", en: "DeepSeek" },
    category: "external",
    codec: "openai-chat",
    defaultBaseUrl: "https://api.deepseek.com",
    auth: bearer(),
    fields: OPENAI_COMPAT_FIELDS("https://api.deepseek.com"),
    capabilities: caps({ reasoning: true, jsonSchema: false }),
    params: [...SAMPLING_COMPAT],
    quirks: { reasoningStyle: "thinking_type", reasoningFields: ["reasoning_content"] },
    docsUrl: "https://api-docs.deepseek.com/",
    help_zh: "思考模式預設開啟；有工具時必須把先前的 reasoning_content 送回（本系統會自動處理）。402 代表餘額不足。",
  },
  {
    id: "xai",
    label: { zh: "xAI（Grok）", en: "xAI (Grok)" },
    category: "external",
    codec: "openai-responses",
    defaultBaseUrl: "https://api.x.ai/v1",
    auth: bearer(),
    fields: OPENAI_COMPAT_FIELDS("https://api.x.ai/v1"),
    capabilities: caps({ vision: true, reasoning: true, jsonSchema: true }),
    params: [],
    quirks: {},
    docsUrl: "https://docs.x.ai/docs/api-reference",
    help_zh: "推理模型不接受 presence/frequency penalty 與 stop；推理無法關閉。",
  },
  {
    id: "groq",
    label: { zh: "Groq", en: "Groq" },
    category: "external",
    codec: "openai-chat",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    auth: bearer(),
    fields: OPENAI_COMPAT_FIELDS("https://api.groq.com/openai/v1"),
    capabilities: caps({ vision: true, reasoning: true, jsonSchema: true }),
    params: [P.sel("reasoning_format", "推理格式", "reasoning_format", ["parsed", "raw", "hidden"]), P.bool("include_reasoning", "包含推理", "include_reasoning"), P.int("seed", "亂數種子", "Seed")],
    quirks: { reasoningStyle: "openai_effort", reasoningFields: ["reasoning", "reasoning_content"], stripFields: ["logprobs", "top_logprobs", "logit_bias", "n"] },
    docsUrl: "https://console.groq.com/docs/openai",
  },
  {
    id: "cohere",
    label: { zh: "Cohere", en: "Cohere" },
    category: "external",
    codec: "cohere",
    defaultBaseUrl: "https://api.cohere.com",
    auth: bearer(),
    fields: [F.apiKey(), F.baseUrl("https://api.cohere.com"), ...EMBED_FIELDS.filter((f) => f.key === "normalize"), ...COMMON_TAIL()],
    capabilities: caps({ vision: true, reasoning: true, embeddings: true, jsonSchema: true }),
    params: [
      P.int("k", "Top-K", "k"),
      P.int("seed", "亂數種子", "Seed"),
      P.sel("safety_mode", "安全模式", "safety_mode", ["CONTEXTUAL", "STRICT", "OFF"]),
      P.bool("strict_tools", "嚴格工具", "strict_tools"),
      P.num("presence_penalty", "存在懲罰", "Presence penalty", { min: 0, max: 1 }),
      P.num("frequency_penalty", "頻率懲罰", "Frequency penalty", { min: 0, max: 1 }),
    ],
    quirks: { embedBatchSize: 96 },
    docsUrl: "https://docs.cohere.com/reference/chat",
    help_zh: "embedding 使用原生 v2 API（支援 input_type 與 output_dimension）。response_format 不能和工具一起使用。",
  },
  {
    id: "together",
    label: { zh: "Together AI", en: "Together AI" },
    category: "external",
    codec: "openai-chat",
    defaultBaseUrl: "https://api.together.ai/v1",
    auth: bearer(),
    fields: [...OPENAI_COMPAT_FIELDS("https://api.together.ai/v1"), ...EMBED_FIELDS.filter((f) => f.key !== "batchSize")],
    capabilities: caps({ vision: true, reasoning: true, embeddings: true, jsonSchema: true }),
    params: [...SAMPLING_COMPAT, P.int("top_k", "Top-K", "Top-K"), P.num("repetition_penalty", "重複懲罰", "Repetition penalty"), P.json("chat_template_kwargs", "對話範本參數", "chat_template_kwargs")],
    quirks: { reasoningStyle: "reasoning_object", reasoningFields: ["reasoning", "reasoning_content"] },
    docsUrl: "https://docs.together.ai/docs/openai-api-compatibility",
    help_zh: "模型 ID 有命名空間（例如 org/model）；推理內容會以原欄位名稱送回。",
  },
  {
    id: "fireworks",
    label: { zh: "Fireworks AI", en: "Fireworks AI" },
    category: "external",
    codec: "openai-chat",
    defaultBaseUrl: "https://api.fireworks.ai/inference/v1",
    auth: bearer(),
    fields: [...OPENAI_COMPAT_FIELDS("https://api.fireworks.ai/inference/v1"), ...EMBED_FIELDS.filter((f) => f.key === "normalize")],
    capabilities: caps({ vision: true, reasoning: true, embeddings: true, jsonSchema: true }),
    params: [
      P.sel("context_length_exceeded_behavior", "超過上下文時", "context_length_exceeded_behavior", ["error", "truncate"], {
        default: "error",
        sendDefault: true,
        help_zh: "預設 error：讓「內容太長」能被正確辨識；truncate 會默默縮短輸出長度。",
      }),
      P.int("top_k", "Top-K", "Top-K"),
      P.int("prompt_cache_max_len", "快取上限", "prompt_cache_max_len"),
      ...SAMPLING_COMPAT,
    ],
    quirks: { reasoningStyle: "openai_effort", modelsPath: "https://api.fireworks.ai/v1/accounts/fireworks/models?pageSize=200" },
    docsUrl: "https://docs.fireworks.ai/tools-sdks/openai-compatibility",
  },
  {
    id: "openrouter",
    label: { zh: "OpenRouter", en: "OpenRouter" },
    category: "external",
    codec: "openai-chat",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    auth: bearer(),
    fields: [
      F.apiKey(),
      F.baseUrl("https://openrouter.ai/api/v1"),
      { key: "httpReferer", label: { zh: "網站網址（HTTP-Referer）", en: "HTTP-Referer" }, type: "url", help_zh: "選填，用於 OpenRouter 的排行榜歸屬。" },
      { key: "appTitle", label: { zh: "應用程式名稱", en: "App title" }, type: "text", default: "Speech-AI Research Hub" },
      ...EMBED_FIELDS.filter((f) => f.key === "normalize"),
      ...COMMON_TAIL(),
    ],
    capabilities: caps({ vision: true, reasoning: true, embeddings: true, jsonSchema: true }),
    params: [
      P.json("provider", "供應商路由偏好", "provider", { help_zh: '例如 {"data_collection":"deny","allow_fallbacks":true}。' }),
      P.json("models", "備援模型清單", "models"),
      P.sel("route", "路由", "route", ["fallback"]),
      P.json("plugins", "外掛", "plugins"),
      ...SAMPLING_COMPAT,
      P.int("top_k", "Top-K", "Top-K"),
    ],
    quirks: { reasoningStyle: "reasoning_object", reasoningFields: ["reasoning", "reasoning_content"], mapError: openRouterError },
    docsUrl: "https://openrouter.ai/docs/api/reference/overview",
    help_zh: "錯誤可能出現在 HTTP 200 的串流中（已處理）。模型清單的 supported_parameters 可用來決定可調參數。",
    resolveHeaders: (c) => ({
      ...(c.httpReferer ? { "HTTP-Referer": String(c.httpReferer) } : {}),
      ...(c.appTitle ? { "X-Title": String(c.appTitle) } : {}),
    }),
  },
  {
    id: "perplexity",
    label: { zh: "Perplexity（Agent API）", en: "Perplexity (Agent API)" },
    category: "external",
    codec: "openai-responses",
    defaultBaseUrl: "https://api.perplexity.ai/v1",
    auth: bearer(),
    fields: [F.apiKey(), F.baseUrl("https://api.perplexity.ai/v1"), ...COMMON_TAIL()],
    capabilities: caps({ reasoning: true, listModels: false, jsonSchema: true }),
    params: [P.sel("preset", "預設組合", "preset", ["fast", "low", "medium", "high", "xhigh"]), P.json("tools", "內建工具", "tools", { help_zh: "例如網頁搜尋工具設定（會覆蓋自訂工具）。" })],
    quirks: { chatPath: "/agent", modelsPath: null, staticModels: ["openai/gpt-5.6-luna"], includeEncryptedReasoning: false },
    docsUrl: "https://docs.perplexity.ai/",
    help_zh: "Sonar Chat Completions 已於 2026-09-27 停止支援；改用 Agent API（Responses 格式）。沒有模型清單端點，請手動輸入模型。",
  },
  {
    id: "cerebras",
    label: { zh: "Cerebras", en: "Cerebras" },
    category: "external",
    codec: "openai-chat",
    defaultBaseUrl: "https://api.cerebras.ai/v1",
    auth: bearer(),
    fields: OPENAI_COMPAT_FIELDS("https://api.cerebras.ai/v1"),
    capabilities: caps({ reasoning: true, jsonSchema: true }),
    params: [P.sel("reasoning_format", "推理格式", "reasoning_format", ["parsed", "raw", "hidden"]), P.bool("clear_thinking", "清除思考", "clear_thinking"), P.sel("service_tier", "服務等級", "service_tier", ["auto", "default", "flex"]), P.int("seed", "亂數種子", "Seed")],
    quirks: { reasoningStyle: "openai_effort", reasoningFields: ["reasoning", "reasoning_content"] },
    docsUrl: "https://inference-docs.cerebras.ai/resources/openai",
  },
  dashscope("dashscope-intl", { zh: "阿里雲百煉 DashScope（國際區）", en: "Alibaba DashScope (International)" }, "ap-southeast-1"),
  dashscope("dashscope-cn", { zh: "阿里雲百煉 DashScope（中國區）", en: "Alibaba DashScope (China)" }, "cn-beijing"),
  {
    id: "zhipu",
    label: { zh: "智譜 AI（GLM）", en: "Zhipu AI (GLM)" },
    category: "external",
    codec: "openai-chat",
    defaultBaseUrl: "https://api.z.ai/api/paas/v4",
    auth: bearer(),
    fields: [
      F.apiKey(),
      F.region(
        [
          ["intl", "國際（z.ai）", "International (z.ai)"],
          ["cn", "中國（bigmodel.cn）", "China (bigmodel.cn)"],
          ["coding", "GLM Coding Plan", "GLM Coding Plan"],
        ],
        "intl",
      ),
      F.baseUrl(undefined),
      F.probeModel(),
      ...EMBED_FIELDS.filter((f) => f.key === "normalize"),
      ...COMMON_TAIL(),
    ],
    capabilities: caps({ vision: true, reasoning: true, embeddings: true, listModels: false }),
    params: [P.bool("do_sample", "取樣", "do_sample")],
    quirks: {
      reasoningStyle: "thinking_type",
      reasoningFields: ["reasoning_content"],
      modelsPath: null,
      staticModels: ["glm-5.3", "glm-5.3-flash", "embedding-3"],
      probeModel: "glm-5.3-flash",
      mapError: zhipuError,
      finishReasonErrors: { network_error: "unavailable" },
    },
    docsUrl: "https://docs.z.ai/api-reference/introduction",
    help_zh: "錯誤依業務代碼判斷（例如 1113 餘額不足、1261 內容太長、1305 忙碌）。沒有模型清單端點。",
    resolveBaseUrl: (c) =>
      String(c.baseUrl || "") ||
      (c.region === "cn" ? "https://open.bigmodel.cn/api/paas/v4" : c.region === "coding" ? "https://api.z.ai/api/coding/paas/v4" : "https://api.z.ai/api/paas/v4"),
  },
  {
    id: "moonshot",
    label: { zh: "Moonshot AI（Kimi）", en: "Moonshot AI (Kimi)" },
    category: "external",
    codec: "openai-chat",
    defaultBaseUrl: "https://api.moonshot.ai/v1",
    auth: bearer(),
    fields: [
      F.apiKey(),
      F.region(
        [
          ["intl", "國際（moonshot.ai）", "International"],
          ["cn", "中國（moonshot.cn）", "China"],
        ],
        "intl",
      ),
      F.baseUrl(undefined),
      ...COMMON_TAIL(),
    ],
    capabilities: caps({ vision: true, reasoning: true, jsonSchema: true }),
    params: [...SAMPLING_COMPAT],
    quirks: { reasoningStyle: "thinking_type", reasoningFields: ["reasoning_content"] },
    docsUrl: "https://platform.kimi.ai/docs/api/chat",
    help_zh: "推理內容（reasoning_content）必須保留在對話歷史中（本系統會自動處理）。",
    resolveBaseUrl: (c) => String(c.baseUrl || "") || (c.region === "cn" ? "https://api.moonshot.cn/v1" : "https://api.moonshot.ai/v1"),
  },
  {
    id: "voyage",
    label: { zh: "Voyage AI（向量嵌入）", en: "Voyage AI (embeddings)" },
    category: "external",
    codec: "voyage-embed",
    defaultBaseUrl: "https://api.voyageai.com/v1",
    auth: bearer(),
    fields: [F.apiKey(), F.baseUrl("https://api.voyageai.com/v1"), F.probeModel("「測試」會用這個模型嵌入一個短字串（預設 voyage-4-lite）。"), ...EMBED_FIELDS.filter((f) => f.key === "normalize" || f.key === "batchSize"), F.timeoutMs()],
    capabilities: EMBED_ONLY,
    params: [],
    quirks: { staticModels: ["voyage-4-large", "voyage-4", "voyage-4-lite", "voyage-code-4", "voyage-finance-2", "voyage-law-2"], probeModel: "voyage-4-lite", embedBatchSize: 128 },
    docsUrl: "https://docs.voyageai.com/docs/embeddings",
    help_zh: "以 input_type（query / document）區分查詢與文件；沒有模型清單端點。",
  },
  {
    id: "jina",
    label: { zh: "Jina AI（向量嵌入）", en: "Jina AI (embeddings)" },
    category: "external",
    codec: "jina-embed",
    defaultBaseUrl: "https://api.jina.ai/v1",
    auth: bearer(),
    fields: [
      F.apiKey(),
      F.baseUrl("https://api.jina.ai/v1"),
      F.probeModel("「測試」會用這個模型嵌入一個短字串。"),
      { key: "lateChunking", label: { zh: "延遲分塊", en: "Late chunking" }, type: "boolean", default: false },
      ...EMBED_FIELDS.filter((f) => f.key === "normalize" || f.key === "batchSize"),
      F.timeoutMs(),
    ],
    capabilities: EMBED_ONLY,
    params: [],
    quirks: { staticModels: ["jina-embeddings-v5-text-small", "jina-embeddings-v5-text-nano", "jina-embeddings-v3"], probeModel: "jina-embeddings-v5-text-nano", embedBatchSize: 64 },
    docsUrl: "https://jina.ai/embeddings/",
    help_zh: "jina-embeddings-v4 為非商業授權，請留意。",
  },

  // ======================================================== local
  localCompat("vllm", { zh: "vLLM", en: "vLLM" }, "http://vllm:8000/v1", {
    quirks: { healthPath: "/health", reasoningStyle: "chat_template_kwargs", reasoningFields: ["reasoning", "reasoning_content"] },
    embeddings: true,
    help_zh: "工具呼叫需要啟動參數 --enable-auto-tool-choice --tool-call-parser <parser>；推理需要 --reasoning-parser。一個伺服器只服務一個模型。",
    docsUrl: "https://docs.vllm.ai/en/latest/serving/online_serving/",
  }),
  {
    id: "ollama",
    label: { zh: "Ollama", en: "Ollama" },
    category: "local",
    codec: "ollama-native",
    defaultBaseUrl: "http://ollama:11434",
    auth: bearer(true),
    fields: [
      F.baseUrl("http://ollama:11434", true),
      F.apiKey(false, "連 ollama.com 雲端時才需要。"),
      { key: "keepAlive", label: { zh: "模型常駐時間", en: "keep_alive" }, type: "text", default: "5m", help_zh: "例如 5m、1h；-1 代表一直保留在記憶體。" },
      {
        key: "think",
        label: { zh: "思考模式", en: "Thinking" },
        type: "select",
        default: "default",
        options: ["default", "true", "false", "low", "medium", "high"].map((v) => ({ value: v, label: { zh: v === "default" ? "模型預設" : v, en: v } })),
      },
      { key: "options", label: { zh: "其他選項", en: "Options" }, type: "json", multiline: true, help_zh: '傳給 Ollama 的 options，例如 {"min_p": 0.05}。' },
      F.supportsTools(true),
      ...EMBED_FIELDS,
      ...COMMON_TAIL({ body: true }),
    ],
    capabilities: caps({ vision: true, reasoning: true, embeddings: true, jsonSchema: true }),
    params: [P.int("options.top_k", "Top-K", "top_k"), P.num("options.min_p", "Min-P", "min_p"), P.int("options.seed", "亂數種子", "seed"), P.num("options.repeat_penalty", "重複懲罰", "repeat_penalty")],
    quirks: { warnings_zh: ["Ollama 預設上下文只有 4096 tokens：平台預設送出 num_ctx 8192；要更長請到「模型」分頁設定該模型的上下文長度（受顯示卡記憶體限制）。"] },
    docsUrl: "https://docs.ollama.com/api/introduction",
    help_zh: "使用 Ollama 原生 API（/api/chat）。模型需要有 tools 能力才能呼叫工具。",
  },
  localCompat("lmstudio", { zh: "LM Studio", en: "LM Studio" }, "http://host.docker.internal:1234/v1", {
    quirks: { reasoningStyle: "openai_effort", reasoningFields: ["reasoning", "reasoning_content"] },
    embeddings: true,
    tools: true,
    help_zh: "在 LM Studio 開發者設定開啟伺服器；若有設定 API Token 請填入金鑰。",
    docsUrl: "https://lmstudio.ai/docs/developer/openai-compat",
  }),
  localCompat("llamacpp", { zh: "llama.cpp（llama-server）", en: "llama.cpp (llama-server)" }, "http://llama:9931/v1", {
    quirks: { healthPath: "/health", reasoningStyle: "chat_template_kwargs", reasoningFields: ["reasoning_content", "reasoning"] },
    embeddings: true,
    tools: true,
    help_zh: "新版預設埠為 9931（Docker 範例仍常用 8080）。模型載入中時 /health 回 503（顯示為忙碌）。embedding 需以 --embeddings 啟動。",
    docsUrl: "https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md",
  }),
  localCompat("sglang", { zh: "SGLang", en: "SGLang" }, "http://sglang:30000/v1", {
    quirks: { healthPath: "/health", reasoningStyle: "chat_template_kwargs", reasoningFields: ["reasoning_content", "reasoning"] },
    embeddings: true,
    help_zh: "工具呼叫需要啟動參數 --tool-call-parser；推理需要 --reasoning-parser。",
    docsUrl: "https://docs.sglang.io/basic_usage/openai_api_completions.html",
  }),
  localCompat("tgi", { zh: "Hugging Face TGI", en: "Hugging Face TGI" }, "http://tgi:80/v1", {
    quirks: { healthPath: "/health", reasoningStyle: "none", streamUsage: false },
    help_zh: "TGI 已進入維護模式，建議改用 vLLM / SGLang / llama.cpp。embedding 請用 TEI。",
    docsUrl: "https://huggingface.co/docs/text-generation-inference/en/index",
  }),
  localCompat("localai", { zh: "LocalAI", en: "LocalAI" }, "http://localai:8080/v1", {
    quirks: { healthPath: "/readyz", reasoningStyle: "none", reasoningFields: ["reasoning_content", "reasoning"] },
    embeddings: true,
    tools: true,
    help_zh: "行為取決於每個模型 YAML 設定的後端（llama.cpp、vLLM…）。",
    docsUrl: "https://localai.io/",
  }),
  {
    id: "tei",
    label: { zh: "Hugging Face TEI（向量嵌入）", en: "Hugging Face TEI (embeddings)" },
    category: "local",
    codec: "tei-embed",
    defaultBaseUrl: "http://tei:80",
    auth: bearer(true),
    fields: [
      F.baseUrl("http://tei:80", true),
      F.apiKey(false),
      { key: "useNativeEndpoint", label: { zh: "使用原生 /embed", en: "Use native /embed" }, type: "boolean", default: true, help_zh: "原生端點支援 prompt_name；關閉則用 /v1/embeddings。" },
      { key: "queryPromptName", label: { zh: "查詢 prompt_name", en: "Query prompt_name" }, type: "text", help_zh: "模型 config_sentence_transformers.json 中的 prompt 名稱，例如 Qwen3-Embedding 的 query。" },
      { key: "documentPromptName", label: { zh: "文件 prompt_name", en: "Document prompt_name" }, type: "text" },
      ...EMBED_FIELDS,
      F.timeoutMs(),
    ],
    capabilities: EMBED_ONLY,
    params: [],
    quirks: { embedBatchSize: 32 },
    docsUrl: "https://huggingface.co/docs/text-embeddings-inference/en/quick_tour",
    help_zh: "一個伺服器只服務一個模型；預設每次最多 32 筆（--max-client-batch-size）。",
  },
  {
    id: "openai-compatible",
    label: { zh: "通用 OpenAI 相容端點", en: "Generic OpenAI-compatible" },
    category: "local",
    codec: "openai-chat",
    auth: bearer(true),
    fields: [
      F.baseUrl(undefined, true),
      F.apiKey(false, "端點需要 Bearer 金鑰時填寫。"),
      {
        key: "reasoningField",
        label: { zh: "推理欄位", en: "Reasoning field" },
        type: "select",
        default: "auto",
        options: [
          { value: "auto", label: { zh: "自動（reasoning_content / reasoning）", en: "Auto" } },
          { value: "reasoning_content", label: { zh: "reasoning_content", en: "reasoning_content" } },
          { value: "reasoning", label: { zh: "reasoning", en: "reasoning" } },
          { value: "none", label: { zh: "不讀取", en: "None" } },
        ],
      },
      {
        key: "reasoningStyle",
        label: { zh: "推理開關方式", en: "Reasoning control" },
        type: "select",
        default: "openai_effort",
        options: [
          { value: "openai_effort", label: { zh: "reasoning_effort", en: "reasoning_effort" } },
          { value: "thinking_type", label: { zh: "thinking.type（DeepSeek / GLM 風格）", en: "thinking.type" } },
          { value: "chat_template_kwargs", label: { zh: "chat_template_kwargs.enable_thinking", en: "chat_template_kwargs" } },
          { value: "reasoning_object", label: { zh: "reasoning 物件（OpenRouter 風格）", en: "reasoning object" } },
          { value: "none", label: { zh: "不送出", en: "None" } },
        ],
      },
      { key: "supportsStreamUsage", label: { zh: "支援串流用量", en: "Stream usage" }, type: "boolean", default: true, help_zh: "送出 stream_options.include_usage；舊伺服器不支援時請關閉。" },
      { key: "modelsEndpoint", label: { zh: "有模型清單端點", en: "Has /models" }, type: "boolean", default: true, help_zh: "關閉後模型名稱改為手動輸入。" },
      { key: "sendDimensions", label: { zh: "送出 dimensions", en: "Send dimensions" }, type: "boolean", default: false, help_zh: "很多伺服器不接受 embedding 的 dimensions 參數。" },
      F.supportsTools(true),
      F.probeModel("沒有模型清單時，「測試」會用這個模型送 1 個 token 的請求。"),
      ...EMBED_FIELDS,
      ...COMMON_TAIL(),
    ],
    capabilities: caps({ vision: true, reasoning: true, embeddings: true, jsonSchema: true }),
    params: [...LOCAL_SAMPLING, P.str("reasoning_effort", "推理強度（原始）", "reasoning_effort")],
    quirks: { reasoningFields: ["reasoning_content", "reasoning"] },
    help_zh: "適用 LiteLLM、Xinference、自架閘道等任何 OpenAI 相容服務。",
    resolveQuirks: (c) => {
      const q: Partial<Quirks> = {};
      if (c.reasoningField === "none") q.reasoningFields = [];
      else if (c.reasoningField === "reasoning" || c.reasoningField === "reasoning_content") q.reasoningFields = [String(c.reasoningField)];
      if (typeof c.reasoningStyle === "string") q.reasoningStyle = c.reasoningStyle as Quirks["reasoningStyle"];
      if (c.supportsStreamUsage === false) q.streamUsage = false;
      if (c.modelsEndpoint === false) q.modelsPath = null;
      if (c.sendDimensions !== true) q.sendDimensions = false;
      return q;
    },
  },
];

function dashscope(id: string, label: { zh: string; en: string }, defRegion: string): ProviderEntry {
  const legacy: Record<string, string> = {
    "ap-southeast-1": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    "cn-beijing": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  };
  const regions: Array<[string, string, string]> =
    id === "dashscope-cn"
      ? [
          ["cn-beijing", "華北 2（北京）", "China (Beijing)"],
          ["cn-hongkong", "中國香港", "China (Hong Kong)"],
        ]
      : [
          ["ap-southeast-1", "新加坡", "Singapore"],
          ["us-east-1", "美國（維吉尼亞）", "US (Virginia)"],
          ["ap-northeast-1", "日本（東京）", "Japan (Tokyo)"],
        ];
  return {
    id,
    label,
    category: "external",
    codec: "openai-chat",
    defaultBaseUrl: legacy[defRegion],
    auth: bearer(),
    fields: [
      { ...F.apiKey(), help_zh: "金鑰綁定區域：用錯區域會回 401 invalid_api_key。使用專屬工作空間網域時需要該工作空間的金鑰。" },
      F.region(regions, defRegion),
      { key: "workspaceId", label: { zh: "工作空間 ID", en: "Workspace ID" }, type: "text", help_zh: "建議填寫（使用 {工作空間}.{區域}.maas.aliyuncs.com 專屬網域）；新加坡與北京留空時使用共用網域。" },
      F.baseUrl(undefined),
      ...EMBED_FIELDS.filter((f) => f.key === "normalize"),
      ...COMMON_TAIL(),
    ],
    capabilities: caps({ vision: true, reasoning: true, embeddings: true, jsonSchema: true }),
    params: [P.int("top_k", "Top-K", "top_k"), P.int("seed", "亂數種子", "seed"), P.bool("enable_search", "聯網搜尋", "enable_search"), P.num("presence_penalty", "存在懲罰", "Presence penalty")],
    quirks: { reasoningStyle: "dashscope", reasoningFields: ["reasoning_content"], mapError: dashscopeError },
    docsUrl: "https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope",
    help_zh: "思考開關為 enable_thinking / thinking_budget。部分模型在串流模式下不支援工具，若工具呼叫失敗請改用其他模型。",
    resolveBaseUrl: (c) => {
      if (c.baseUrl) return String(c.baseUrl);
      const region = String(c.region || defRegion);
      if (c.workspaceId) return `https://${String(c.workspaceId)}.${region}.maas.aliyuncs.com/compatible-mode/v1`;
      const url = legacy[region];
      if (!url) throw new AiError("bad_request", { vendorMessage: `region ${region} needs a workspace id`, providerId: id });
      return url;
    },
  };
}

function localCompat(
  id: string,
  label: { zh: string; en: string },
  baseUrl: string,
  o: { quirks: Quirks; embeddings?: boolean; tools?: boolean; help_zh?: string; docsUrl?: string },
): ProviderEntry {
  return {
    id,
    label,
    category: "local",
    codec: "openai-chat",
    defaultBaseUrl: baseUrl,
    auth: bearer(true),
    fields: [F.baseUrl(baseUrl, true), F.apiKey(false), F.supportsTools(o.tools ?? false), ...(o.embeddings ? EMBED_FIELDS : []), ...COMMON_TAIL()],
    capabilities: caps({ tools: o.tools ?? false, vision: true, reasoning: true, embeddings: o.embeddings ?? false, jsonSchema: true }),
    params: LOCAL_SAMPLING,
    quirks: o.quirks,
    help_zh: o.help_zh,
    docsUrl: o.docsUrl,
  };
}

// ---------------------------------------------------------------- registry API

const registry = new Map<string, ProviderEntry>(entries.map((e) => [e.id, e]));

/** Extension point (OAuth subscription providers, tests): add or replace an entry. */
export function registerProvider(entry: ProviderEntry) {
  registry.set(entry.id, entry);
}

export function getProvider(id: string): ProviderEntry | undefined {
  return registry.get(id);
}

export function listProviders(): ProviderEntry[] {
  return [...registry.values()];
}

/** JSON-safe descriptors for the admin UI (hooks and error mappers removed). */
export function publicProviders(): PublicProviderEntry[] {
  return listProviders().map(toPublic);
}

export function toPublic(e: ProviderEntry): PublicProviderEntry {
  const { resolveBaseUrl: _a, codecFor: _b, resolveHeaders: _c, resolveQuirks: _d, quirks, ...rest } = e;
  const { mapError: _e, ...q } = quirks;
  return { ...rest, quirks: q };
}

/** Keys of fields whose values are secrets (stored encrypted, passed in `secrets`). */
export function secretKeys(e: ProviderEntry): string[] {
  return e.fields.filter((f) => f.type === "secret").map((f) => f.key);
}

export interface ValidationIssue {
  key: string;
  message_zh: string;
}

function visible(f: FormField, values: Record<string, unknown>) {
  if (!f.showIf) return true;
  return f.showIf.equals.includes(values[f.showIf.key]);
}

/**
 * Validates an account form. Returns the config with defaults applied (secrets excluded)
 * and a list of issues (繁中). `secrets` may contain only the keys being changed when
 * `existingSecretKeys` lists the ones already stored.
 */
export function validateAccount(
  e: ProviderEntry,
  config: Record<string, unknown>,
  secrets: Record<string, string>,
  existingSecretKeys: string[] = [],
): { config: Record<string, unknown>; issues: ValidationIssue[] } {
  const out = applyDefaults(e, config);
  const all = { ...out, ...secrets };
  const issues: ValidationIssue[] = [];
  for (const f of e.fields) {
    if (!visible(f, all)) continue;
    const v = f.type === "secret" ? secrets[f.key] : out[f.key];
    const empty = v === undefined || v === null || v === "";
    if (empty) {
      if (f.required && !(f.type === "secret" && existingSecretKeys.includes(f.key))) issues.push({ key: f.key, message_zh: `請填寫「${f.label.zh}」。` });
      continue;
    }
    switch (f.type) {
      case "url":
        if (typeof v !== "string" || !/^https?:\/\/[^\s]+$/i.test(v)) issues.push({ key: f.key, message_zh: `「${f.label.zh}」必須是 http(s) 網址。` });
        break;
      case "number":
        if (typeof v !== "number" || !Number.isFinite(v)) issues.push({ key: f.key, message_zh: `「${f.label.zh}」必須是數字。` });
        break;
      case "boolean":
        if (typeof v !== "boolean") issues.push({ key: f.key, message_zh: `「${f.label.zh}」必須是開或關。` });
        break;
      case "select":
        if (f.options && !f.options.some((o) => o.value === v)) issues.push({ key: f.key, message_zh: `「${f.label.zh}」的選項不正確。` });
        break;
      case "json":
        // Objects or arrays (e.g. an ASR server's accepted formats); never a bare scalar.
        if (typeof v !== "object" || v === null) issues.push({ key: f.key, message_zh: `「${f.label.zh}」必須是 JSON 物件或陣列。` });
        break;
      default:
        if (typeof v !== "string") issues.push({ key: f.key, message_zh: `「${f.label.zh}」格式不正確。` });
    }
  }
  if (e.auth.type === "google_service_account" && secrets.serviceAccountJson) {
    try {
      const sa = JSON.parse(secrets.serviceAccountJson) as Record<string, unknown>;
      if (sa.type !== "service_account" || !sa.client_email || !sa.private_key) throw new Error();
    } catch {
      issues.push({ key: "serviceAccountJson", message_zh: "服務帳戶 JSON 格式不正確（需要 type=service_account、client_email、private_key）。" });
    }
  }
  // Drop unknown / secret keys from the stored config.
  const known = new Set(e.fields.filter((f) => f.type !== "secret").map((f) => f.key));
  for (const k of Object.keys(out)) if (!known.has(k)) delete out[k];
  return { config: out, issues };
}

export function applyDefaults(e: ProviderEntry, config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config };
  for (const f of e.fields) if (f.type !== "secret" && out[f.key] === undefined && f.default !== undefined) out[f.key] = f.default;
  return out;
}
