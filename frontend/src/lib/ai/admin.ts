import { t } from "#lib/i18n.svelte.ts";
import type { MessageKey } from "#lib/messages.ts";
import type { AiRole, AiRoleState } from "./status.svelte.ts";

/** Admin AI API client: keeps the backend's `{ error, code, hint, detail }` so the UI can explain failures. */
export type AiErrorBody = { error: string; code?: string; hint?: string; detail?: Record<string, unknown> };

export class AiApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: AiErrorBody,
  ) {
    super(body.error);
  }
  get code() {
    return this.body.code;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin", headers: {} };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, init);
  } catch {
    throw new AiApiError(0, { error: t("common.offline"), code: "offline", hint: t("aiAdmin.err.offlineHint") });
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    if (res.ok) throw new AiApiError(res.status, { error: t("common.error"), code: "bad_response" });
  }
  if (!res.ok) {
    const d = data as Partial<AiErrorBody> | null;
    throw new AiApiError(res.status, {
      error: typeof d?.error === "string" ? d.error : t(res.status >= 500 ? "common.offline" : "common.error"),
      code: d?.code ?? `http_${res.status}`,
      hint: d?.hint,
      detail: d?.detail,
    });
  }
  return data as T;
}

export const aiApi = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body: unknown = {}) => request<T>("POST", path, body),
  put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
};

export const toErrorBody = (e: unknown): AiErrorBody => (e instanceof AiApiError ? e.body : { error: e instanceof Error ? e.message : String(e), code: "client_error" });

// ---------------------------------------------------------------- types (mirror backend/src/ai/platform)

export type Bilingual = { zh: string; en: string };
export type FieldType = "text" | "url" | "secret" | "select" | "number" | "boolean" | "json";
export type FormField = {
  key: string;
  label: Bilingual;
  type: FieldType;
  required?: boolean;
  default?: unknown;
  help_zh?: string;
  placeholder?: string;
  multiline?: boolean;
  options?: Array<{ value: string; label: Bilingual }>;
  showIf?: { key: string; equals: unknown[] };
};
export type ParamField = {
  key: string;
  type: "number" | "integer" | "string" | "boolean" | "json" | "select";
  label: Bilingual;
  help_zh?: string;
  default?: unknown;
  options?: string[];
  min?: number;
  max?: number;
  multiline?: boolean;
  /** Display labels of select options. */
  option_labels?: Record<string, Bilingual>;
  /** Label of the empty ("default") choice. */
  default_label?: Bilingual;
  scope?: "platform" | "vendor";
};
export type Family = "llm" | "asr";
export type Category = "external" | "local" | "subscription";
export type Capability = "chat" | "embedding" | "asr";

export type RegistryEntry = {
  id: string;
  label: Bilingual;
  category: Category;
  subscription: boolean;
  fields: FormField[];
  help_zh?: string;
  docsUrl?: string;
  // llm
  capabilities?: { chat: boolean; tools: boolean; vision: boolean; reasoning: boolean; embeddings: boolean; listModels: boolean };
  params?: ParamField[];
  quirks?: { warnings_zh?: string[]; staticModels?: string[] };
  // asr
  models?: string[];
  defaultModel?: string;
  live?: boolean;
};
export type Registry = {
  llm: RegistryEntry[];
  asr: RegistryEntry[];
  roles: Array<{ role: AiRole; capability: Capability; label_zh: string }>;
  /** `asr_llm`: options for a multimodal chat model transcribing audio (subset of `asr`). */
  platform_params: { chat: ParamField[]; embedding: ParamField[]; asr: ParamField[]; asr_llm?: ParamField[] };
  live_kinds: string[];
  secrets_key_configured: boolean;
};

export type OAuthMeta = { status: "none" | "connected" | "needs_reauth"; email?: string; planType?: string; expiresAt?: number; connectedAt?: number };
export type ProbeSummary = { ok: boolean; latencyMs: number; detail_zh: string; code?: string; modelCount?: number; hint_zh?: string };
export type Provider = {
  id: string;
  family: Family;
  kind: string;
  category: Category;
  name: string;
  base_url: string | null;
  auth_type: string;
  config: Record<string, unknown>;
  secret_keys: string[];
  secrets_set: Record<string, boolean>;
  oauth_meta: OAuthMeta;
  enabled: boolean;
  last_probe: ProbeSummary | null;
  last_probe_at: string | null;
  models_synced_at: string | null;
  label: Bilingual | null;
  used_by: UsageRef[];
  model_count: number;
  warnings_zh: string[];
  created_at: string;
  updated_at: string;
};

export type ModelCapability = "chat" | "embedding" | "asr";
export type FieldSource = "manual" | "provider_api" | "catalog";
export type ProfileFields = {
  display_name?: string;
  capability?: ModelCapability;
  context_window?: number;
  max_output_tokens?: number;
  vision?: boolean;
  /** Accepts audio content (speech-to-text by a multimodal chat model). */
  audio_input?: boolean;
  tools?: boolean;
  reasoning?: boolean;
  json_schema?: boolean;
  embedding_dims?: number;
  input_price?: number;
  output_price?: number;
};
export type ProfileField = keyof ProfileFields;
export const PROFILE_FIELDS: ProfileField[] = ["display_name", "capability", "context_window", "max_output_tokens", "vision", "audio_input", "tools", "reasoning", "json_schema", "embedding_dims", "input_price", "output_price"];

export type UsageRef = { kind: "group" | "role"; id: string; name: string };
export type VisionSource = "override" | "model_list" | "catalog" | "name" | "vendor" | "unknown";
export type MemberVision = { vision: boolean; detected: boolean; source: VisionSource; overridden: boolean };
/** Audio input of a chat model; `codec_ok` = the account's protocol can send audio at all (OpenAI-compatible chat, Gemini). */
export type MemberAudio = { audio: boolean; detected: boolean; source: VisionSource; overridden: boolean; codec_ok: boolean };

/** A model profile (per account + model id). */
export type ModelProfile = {
  id: string;
  provider_id: string;
  provider_name: string | null;
  provider_kind: string | null;
  provider_family: Family | null;
  model_id: string;
  origin: "sync" | "manual";
  listed: boolean;
  enabled: boolean;
  refreshed_at: string | null;
  updated_at: string;
  fields: ProfileFields & { capability: ModelCapability };
  sources: Partial<Record<ProfileField, FieldSource>>;
  api: ProfileFields;
  overrides: ProfileFields;
  catalog: ProfileFields;
  catalog_id: string | null;
  vision: MemberVision | null;
  audio?: MemberAudio | null;
  used_by: UsageRef[];
};

export type GroupStrategy = "fallback" | "load_balance" | "round_robin";
export type GroupMember = {
  id?: string;
  position?: number;
  model_ref: string | null;
  child_group_id: string | null;
  weight: number;
  params: Record<string, unknown>;
  enabled: boolean;
  model_id?: string | null;
  provider_id?: string | null;
  provider_name?: string | null;
  provider_kind?: string | null;
  child_group_name?: string | null;
};
export type Group = {
  id: string;
  name: string;
  capability: Capability;
  strategy: GroupStrategy;
  description: string;
  members: GroupMember[];
  bound_roles: AiRole[];
  used_by: Array<{ id: string; name: string }>;
  created_at: string;
  updated_at: string;
};

export type Target = { type: "model"; model_id: string; name: string | null } | { type: "group"; group_id: string; name: string | null };
export type TargetInput = { model_id: string } | { group_id: string };

export type MemberHealth = {
  memberId: string;
  modelRef: string;
  groupId: string | null;
  providerId: string;
  providerName: string;
  model: string;
  health: "up" | "down" | "unknown";
  reason?: string;
  vision?: boolean;
  vision_source?: VisionSource;
};
export type RoleStatusDetail = {
  role: AiRole;
  state: AiRoleState;
  message_zh: string;
  detail: { target?: "model" | "group"; groupId?: string; groupName?: string; modelRef?: string; members?: MemberHealth[]; activeIndex?: number; error?: string; vision?: boolean };
};
export type Binding = { role: AiRole; target: Target | null; params: Record<string, unknown>; updated_at: string | null; status: RoleStatusDetail | null };

export type TestResult = {
  probe: ProbeSummary;
  models: Array<{ id: string; label?: string; kind?: string }>;
  models_error: AiErrorBody | null;
  models_synced?: number | null;
  check: { ok: boolean; latencyMs: number; detail_zh: string; dims?: number; error?: AiErrorBody } | null;
};

export type StatRow = {
  role?: AiRole;
  provider_id?: string;
  provider_name?: string | null;
  provider_kind?: string | null;
  model?: string | null;
  model_ref?: string | null;
  last_used?: string | null;
  calls: number;
  ok: number;
  success_rate: number | null;
  p50_ms: number | null;
  p95_ms: number | null;
  ttft_p50_ms: number | null;
  tokens_in: number;
  tokens_out: number;
  retries: number;
  fallbacks?: number;
};
export type LiveStats = { window: string; models: StatRow[]; roles: StatRow[] };
export type Stats = { window: string; roles: StatRow[]; members: StatRow[]; errors: Array<{ error_code: string; count: number }>; series: Array<{ bucket: string; calls: number; ok: number }> };
export type CallRow = {
  id: string;
  call_id: string;
  final: boolean;
  role: AiRole | null;
  capability: string;
  group_id: string | null;
  group_name: string | null;
  model_ref: string | null;
  provider_id: string | null;
  provider_name: string | null;
  provider_kind: string | null;
  model: string | null;
  stream: boolean;
  started_at: string;
  latency_ms: number;
  ttft_ms: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  ok: boolean;
  error_code: string | null;
  retries: number;
  fallback_index: number;
  user_name: string | null;
  job_id: string | null;
};

export type EmbeddingSpace = {
  id: string;
  label: string;
  model_ref: string | null;
  group_id: string | null;
  provider_kind: string;
  model: string;
  dims: number;
  status: "building" | "ready" | "active" | "retired" | "failed";
  items_total: number;
  items_done: number;
  error: string | null;
  created_at: string;
  ready_at: string | null;
  activated_at: string | null;
};
export type EmbeddingOverview = { mode: "semantic" | "keyword_only"; reason_zh: string | null; activeSpaceId: string | null; spaces: EmbeddingSpace[] };
export type Comparison = { same: boolean; sameDims: boolean; dims: [number, number]; minCosine: number; meanCosine: number };
export type Precheck = {
  same_identity: boolean;
  action: "bind" | "switch";
  comparison: Comparison | null;
  active_space: EmbeddingSpace | null;
  candidate: { routeId: string; dims: number | null; consistent: boolean; members: Array<{ memberId: string; providerName: string; model: string; ok: boolean; dims?: number; error?: { code: string; message_zh: string }; comparison?: Comparison }> };
};

export const ROLE_KEYS: Record<AiRole, { label: MessageKey; hint: MessageKey }> = {
  assistant: { label: "aiAdmin.role.assistant", hint: "aiAdmin.role.assistant.hint" },
  writing: { label: "aiAdmin.role.writing", hint: "aiAdmin.role.writing.hint" },
  slides: { label: "aiAdmin.role.slides", hint: "aiAdmin.role.slides.hint" },
  analysis: { label: "aiAdmin.role.analysis", hint: "aiAdmin.role.analysis.hint" },
  fast: { label: "aiAdmin.role.fast", hint: "aiAdmin.role.fast.hint" },
  embedding: { label: "aiAdmin.role.embedding", hint: "aiAdmin.role.embedding.hint" },
  asr: { label: "aiAdmin.role.asr", hint: "aiAdmin.role.asr.hint" },
  asr_live: { label: "aiAdmin.role.asr_live", hint: "aiAdmin.role.asr_live.hint" },
};

export const STATE_KEYS: Record<AiRoleState, MessageKey> = {
  ok: "aiStatus.state.ok",
  degraded: "aiStatus.state.degraded",
  unavailable: "aiStatus.state.unavailable",
  unconfigured: "aiStatus.state.unconfigured",
};
