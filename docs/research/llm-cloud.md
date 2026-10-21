# Cloud LLM vendors: adapter research

Checked: **2026-10-21** against official vendor docs (URLs per section). Scope: chat (streaming + tools), embeddings, model listing, health probe, error mapping, and admin form fields for a Node/TS provider-adapter registry.

Legend: **[doc]** = read in official docs on the check date. **[mem]** = long-standing behaviour I did not re-read this time; verify before relying on it. Model IDs change monthly, so treat every model name here as an example. Never hard-code a list; always fetch it from `listModels`.

---

## 0. Cross-cutting findings that shape the design

1. **Three wire protocols cover all 19 vendors.**
   - **OpenAI Chat Completions** (`POST {base}/chat/completions`, SSE `data:` chunks, `data: [DONE]`). This is the lingua franca.
   - **OpenAI Responses** (`POST {base}/responses`, typed SSE events). OpenAI, Azure v1, xAI, Groq, Bedrock (`/openai/v1`) and Perplexity's Agent API now prefer it.
   - **Vendor native** (Anthropic Messages, Gemini generateContent/Interactions, Bedrock Converse, Cohere v2).
2. **OpenAI-the-vendor needs the Responses API.** The official reasoning guide says Chat Completions **does not support function calling with GPT-6 Astra / GPT-6.1 Sol** [doc]. An OpenAI adapter that only speaks Chat Completions breaks tools on flagship models.
3. **Reasoning controls diverge.**

   | Vendor | Reasoning control |
   |---|---|
   | Anthropic | `thinking.type` (`adaptive` \| `enabled`+`budget_tokens` \| `disabled` \| `between_tools`) + `output_config.effort` |
   | OpenAI | `reasoning.effort` (`none`…`max`) + `reasoning.mode` |
   | Gemini | `thinkingConfig.thinkingLevel` / `thinkingBudget` (or `thinking_level` in Interactions) |
   | DeepSeek / GLM / Kimi | `thinking: {type}` + `reasoning_effort` |
   | Cohere | `thinking: {type, token_budget}` |
   | DashScope | `enable_thinking` + `thinking_budget` |

   Expose a **unified `reasoning: { effort?: 'none'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max'; budgetTokens?: number; show?: boolean }`** and let each adapter translate and clamp it. Use the model capability metadata where it exists. Anthropic `GET /v1/models` returns `capabilities.thinking.types.*` and `capabilities.effort.*`.
4. **Reasoning content must round-trip on tool loops.**
   - Anthropic: `thinking` / `redacted_thinking` blocks unchanged. Otherwise you get a 400.
   - DeepSeek: `reasoning_content` on every prior turn when `tools` is set. Otherwise you get a 400.
   - Kimi: `reasoning_content` must be kept in history.
   - Together: the `reasoning` / `reasoning_content` field must go back under the same key.
   - OpenAI / xAI: `encrypted_content` reasoning items when `store:false`.
   - Gemini: `thoughtSignature` / `signature`.

   So the unified message type needs an opaque **`providerState`** per assistant turn that the adapter re-emits verbatim.
5. **Several flagship models reject classic sampling params.**
   - Anthropic Opus 5.5 / Sonnet 5.5 / Fable 5.1 reject forced `tool_choice` (`any` / `tool`).
   - Anthropic thinking models restrict `temperature` / `top_k`.
   - xAI reasoning models reject `presencePenalty`, `frequencyPenalty` and `stop`.
   - OpenAI reasoning models reject `temperature` / `top_p` [mem].
   - DeepSeek thinking mode silently ignores `temperature` / penalties.

   The params form therefore needs a **capability-driven "send only if supported" filter**, plus a "strip unsupported and retry once on 400" fallback.
6. **Errors can arrive inside a 200.** In streaming, the HTTP status is already 200 when the failure happens:
   - Anthropic sends `event: error`.
   - OpenRouter puts `error` in a chunk with `finish_reason:"error"`, even on non-streaming 200s.
   - Bedrock sends exception events inside the event stream.
   - Zhipu reports via `finish_reason`.
   - Gemini Interactions sends `event_type:"error"`.

   The error mapper must run on stream events as well as on HTTP status.

---

## 1. OpenAI

Docs: <https://developers.openai.com/api/docs/guides/reasoning>, <https://developers.openai.com/api/docs/guides/error-codes>, <https://developers.openai.com/api/docs/guides/streaming-responses>, <https://developers.openai.com/api/docs/guides/embeddings>

| Item | Detail |
|---|---|
| Auth | `Authorization: Bearer sk-...`; optional `OpenAI-Organization`, `OpenAI-Project` headers [mem] |
| Base URL | `https://api.openai.com/v1` |
| API to use | **Responses** (`POST /v1/responses`) is recommended [doc]. Chat Completions is still available, but there are **no tools on GPT-6 Astra / GPT-6.1 Sol** [doc] |
| Models | `GET /v1/models`. Returns `{object:"list", data:[{id, object:"model", created, owned_by}]}` with no capability info [mem] |
| Streaming | Responses SSE, typed `type` events: `response.created`, `response.in_progress`, `response.output_item.added/done`, `response.content_part.added/done`, `response.output_text.delta` (`delta`), `response.function_call_arguments.delta/done`, `response.reasoning_summary_text.delta` [mem], `response.completed`, `response.failed`, `error` [doc]. Chat Completions: `data: {chunk}` … `data: [DONE]`; usage only with `stream_options:{include_usage:true}` [mem] |
| Tools | Responses: `tools:[{type:"function", name, description, parameters, strict}]`; outputs are `function_call` items with `call_id`. Results go back as `{type:"function_call_output", call_id, output}`. `parallel_tool_calls` bool [mem] |
| Structured output | Responses `text.format:{type:"json_schema", name, schema, strict:true}`; Chat `response_format:{type:"json_schema"…}` or `json_object` [mem] |
| Vision | `input_image` content part (URL or data URL) [mem] |
| Reasoning | `reasoning.effort`: `none\|minimal\|low\|medium\|high\|xhigh\|max`, varies by model. GPT-6 Astra rejects `none` (400); GPT-6.1 Sol rejects `none`/`minimal`. `reasoning.mode: standard\|pro`; `reasoning.summary:"auto"`; `reasoning.context: auto\|current_turn\|all_turns`. With `store:false`, reasoning items carry `encrypted_content`, which must be round-tripped (`include:["reasoning.encrypted_content"]`). Chat equivalent: `reasoning_effort` [doc] |
| Max tokens | Responses `max_output_tokens` (includes reasoning; reserve ≥25k) [doc]. Chat `max_completion_tokens` (`max_tokens` is rejected by reasoning models) [mem] |
| Prompt caching | Automatic for prefixes ≥1024 tokens; optional `prompt_cache_key`; usage `input_tokens_details.cached_tokens` [mem] |
| Embeddings | `POST /v1/embeddings` with `text-embedding-3-small` (1536 default), `text-embedding-3-large` (3072), and `ada-002`. `dimensions` param (v3 only), `encoding_format: float\|base64`, 8192 max input tokens [doc] |
| Params form | `temperature`, `top_p` (non-reasoning only), `max_output_tokens`, `reasoning.effort`, `reasoning.summary`, `parallel_tool_calls`, `service_tier`, `seed` (Chat), `presence_penalty`/`frequency_penalty` (Chat, non-reasoning), `store` (default to **false** for privacy) |
| Probe | `GET /v1/models` (free) |

**Errors:**
- Body shape: `{error:{message, type, param, code}}`.
- 401: bad key, not in the org, or IP not allowlisted.
- 403: unsupported region.
- 429: either `type: rate_limit_error` with `code: slow_down`/rate, or billing codes `insufficient_quota`, `credit_balance_exhausted`, `*_spend_limit_exceeded`. **Do not retry the billing ones.**
- 500: server error.
- 503: `service_unavailable_error` / `server_is_overloaded`. Honour `Retry-After` on 429/503 [doc].
- Context too long: 400 `code: context_length_exceeded` [mem].
- Content filter: Responses `status:"incomplete"` with reason `content_filter`, or a `refusal` content part; Chat `finish_reason:"content_filter"` [mem].
- Rate-limit headers: `x-ratelimit-limit-requests`, `x-ratelimit-remaining-tokens`, `x-ratelimit-reset-*` [mem].

**Form:** `apiKey` (password, required, secret), `baseUrl` (url, default `https://api.openai.com/v1`), `organization` (text, optional), `project` (text, optional).

---

## 2. Anthropic (Claude API)

Docs: <https://platform.claude.com/docs/en/api/errors>, <https://platform.claude.com/docs/en/build-with-claude/extended-thinking>, <https://platform.claude.com/docs/en/build-with-claude/prompt-caching>, <https://platform.claude.com/docs/en/api/models/list> (old `docs.claude.com` / `docs.anthropic.com` URLs redirect here)

| Item | Detail |
|---|---|
| Auth | `x-api-key: <key>` plus `anthropic-version: 2023-06-01`; `anthropic-beta: a,b` for betas; optional `anthropic-workspace-id` [doc] |
| Base URL | `https://api.anthropic.com/v1`. The OpenAI-compat layer exists but drops thinking, caching and other features; **use native** |
| Models | `GET /v1/models?limit=1000&lifecycle=active`. Returns `{data:[{id, display_name, created_at, lifecycle, line, max_input_tokens, max_tokens, capabilities:{thinking:{types:{adaptive,enabled,disabled,between_tools}}, effort:{low..max,xhigh}, image_input, pdf_input, structured_outputs, batch, citations, server_tools…}}], has_more, first_id, last_id}`. **The best capability metadata of any vendor; drive the params form from it** [doc] |
| Chat | `POST /v1/messages` with `{model, max_tokens (required), system, messages, tools, tool_choice, thinking, output_config, cache_control, stream}` |
| Streaming | SSE `event:` + `data:`: `message_start`, `content_block_start` (`text`\|`tool_use`\|`thinking`), `content_block_delta` (`text_delta`, `input_json_delta`, `thinking_delta`, `signature_delta`), `content_block_stop`, `message_delta` (stop_reason, usage incl. `output_tokens_details.thinking_tokens`), `message_stop`, `ping`, `error` [mem + doc] |
| Tools | `tools:[{name, description, input_schema, strict?}]`. Response `tool_use` blocks `{id, name, input}`; results come back as user `tool_result` blocks `{tool_use_id, content, is_error}`. Parallel by default; `disable_parallel_tool_use` lives inside `tool_choice`. **Opus 5.5, Sonnet 5.5, Fable 5.1 and Mythos 5.1 reject `tool_choice` `any` / `tool` (400); only `auto` / `none` work** [doc] |
| Structured output | `output_config.format` (JSON schema); strict tool use. **Prefill is rejected on 4.6+ models (400)** [doc] |
| Vision | `image` blocks (base64/url/file); `document` blocks for PDFs |
| Reasoning | **4.7+ and 5.x:** `thinking:{type:"adaptive", display?:"omitted"}` + `output_config:{effort: low\|medium\|high\|xhigh\|max}`. `type:"enabled"` is a 400 there. **≤4.5:** `thinking:{type:"enabled", budget_tokens ≥1024 and < max_tokens}`; `adaptive` is a 400. Some models cannot disable thinking (Opus 5.5, Fable 5.x, Mythos 5.x → `disabled` is a 400). Sonnet 5.5 uses `type:"between_tools"` as its "off". Haiku 5.5 accepts `disabled`. Default effort is `medium` on Opus 5.5 / Haiku 5.5 and `high` elsewhere. Thinking blocks must be returned unmodified [doc] |
| Prompt caching | Either top-level `cache_control:{type:"ephemeral", ttl?:"5m"\|"1h"}` (automatic) or per-block breakpoints (max 4). Minimum 512–4096 tokens depending on model. Usage: `cache_creation_input_tokens`, `cache_read_input_tokens`. Changing thinking config or effort invalidates the cache [doc] |
| Embeddings | **None.** Anthropic points to Voyage AI; the admin must pick another provider for embeddings |
| Params form | `max_tokens` (required, int), `temperature` / `top_p` / `top_k` (non-thinking only), `stop_sequences`, `thinking.mode`, `effort`, `cacheTtl` (`off\|5m\|1h`), `betas` (string[]) |
| Probe | `GET /v1/models?limit=1` |

**Errors:**
- Body shape: `{type:"error", error:{type, message}, request_id}`.

| Status | Error type | Unified code |
|---|---|---|
| 400 | `invalid_request_error` (also returned for a **spend limit you set**) | bad_request |
| 401 | `authentication_error` | auth_failed |
| 402 | `billing_error` | auth_failed / billing |
| 403 | `permission_error` | auth_failed |
| 404 | `not_found_error` | bad_request |
| 413 | `request_too_large` (32 MB) | bad_request |
| 429 | `rate_limit_error` (`retry-after`; a tier spend-cap 429 has **no** retry-after → don't retry) | rate_limited |
| 500 | `api_error` | unavailable |
| 504 | `timeout_error` | timeout |
| 529 | `overloaded_error` | overloaded |

- Context too long: 400 with "prompt is too long" [mem], or `stop_reason: "model_context_window_exceeded"` [mem].
- Content filter: `stop_reason:"refusal"` [mem].
- Mid-stream errors arrive as `event: error` [doc].
- Rate-limit headers: `anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-{limit,remaining,reset}` [mem].

**Form:** `apiKey` (secret, required), `baseUrl` (default `https://api.anthropic.com`), `anthropicVersion` (default `2023-06-01`), `betas` (tags, optional), `workspaceId` (optional).

---

## 3. Google Gemini (AI Studio / Gemini Developer API)

Docs: <https://ai.google.dev/gemini-api/docs/interactions-overview>, <https://ai.google.dev/api/generate-content>, <https://ai.google.dev/gemini-api/docs/openai>, <https://ai.google.dev/gemini-api/docs/api-errors>, <https://ai.google.dev/gemini-api/docs/troubleshooting>, <https://ai.google.dev/gemini-api/docs/embeddings>

| Item | Detail |
|---|---|
| Auth | `x-goog-api-key: <key>` header (or `?key=`) [doc] |
| Base URL | `https://generativelanguage.googleapis.com/v1beta` |
| APIs | Three options. **Interactions API** (`POST /v1beta/interactions`) is "recommended for all new projects", and new models and features launch there first; it is stateful by default (`store:true`, `previous_interaction_id`), so **set `store:false` and resend history** [doc]. **generateContent** (`models/{m}:generateContent`, `:streamGenerateContent?alt=sse`) "remains fully supported" [doc]. **OpenAI-compat** `https://generativelanguage.googleapis.com/v1beta/openai/` (beta) supports chat, stream, tools, vision, structured output, embeddings and models list; `reasoning_effort` maps to thinking; Gemini-only fields go via `extra_body:{google:{thinking_config, cached_content}}` [doc] |
| Models | `GET /v1beta/models?pageSize=1000` → `{models:[{name:"models/…", displayName, inputTokenLimit, outputTokenLimit, supportedGenerationMethods:[…]}], nextPageToken}` [mem]. Filter by `generateContent` / `embedContent` |
| Streaming | generateContent SSE: each `data:` is a full `GenerateContentResponse` (candidates[].content.parts[] deltas, `usageMetadata`, `finishReason` on the last chunk). Interactions streaming: `step.delta` events (`thought_summary`, `thought_signature`), `step.stop`, error events `event_type:"error"` [doc] |
| Tools | `tools:[{functionDeclarations:[{name, description, parameters}]}]`; `toolConfig.functionCallingConfig.mode: AUTO\|ANY\|NONE` (+ `allowedFunctionNames`). Calls come back as `functionCall` parts and results go as `functionResponse` parts. Parallel calls appear as multiple parts. **Keep `thoughtSignature` on parts** [doc + mem] |
| Structured output | `generationConfig.responseMimeType:"application/json"` + `responseSchema` (OpenAPI subset) or `responseJsonSchema` [doc + mem] |
| Vision | `inlineData {mimeType, data}` / `fileData` parts |
| Reasoning | generateContent: `generationConfig.thinkingConfig:{thinkingLevel: minimal\|low\|medium\|high` (Gemini 3+) or `thinkingBudget: int` (2.5; `0` = off, `-1` = dynamic), `includeThoughts: bool}`. Thought parts have `thought:true` [mem]. Interactions: `generation_config.thinking_level`, `thinking_summaries:"auto"`. Levels vary by model (e.g. 3.8-flash supports low/medium/high, default medium). 2.5 Pro and 3.x cannot turn thinking off. `max_output_tokens` **includes** thinking [doc] |
| Prompt caching | Implicit caching (automatic) plus explicit `cachedContents` resource (`cachedContent: "cachedContents/…"`) [doc + mem] |
| Embeddings | `models/{m}:embedContent`, `:batchEmbedContents`. Models: `gemini-embedding-2` (multimodal, 8192 tokens) and `gemini-embedding-001` (text, 2048). `outputDimensionality` 128–3072, default 3072 (recommend 768/1536/3072); 001 must be re-normalised when truncated. `taskType` (`RETRIEVAL_QUERY`, `RETRIEVAL_DOCUMENT`, …) on 001 only; 2 uses text prefixes. The two spaces are incompatible [doc] |
| Params form | `temperature`, `topP`, `topK`, `maxOutputTokens`, `stopSequences`, `thinkingLevel` / `thinkingBudget`, `includeThoughts`, `safetySettings` (per-category threshold), `candidateCount` (fix to 1) |
| Probe | `GET /v1beta/models?pageSize=1` |

**Errors:**
- generateContent uses the google.rpc shape `{error:{code, message, status, details:[…RetryInfo{retryDelay}…]}}` [mem].
- Interactions uses `{error:{code:"rate_limit_exceeded", message}}` [doc].

| Status | Code / meaning | Unified code |
|---|---|---|
| 400 | `INVALID_ARGUMENT` / `invalid_request` / `failed_precondition` (billing) | bad_request |
| 401 / 403 | `authentication` / `PERMISSION_DENIED`; also "API key reported as leaked" | auth_failed |
| 402 | `payment_required` (prepay depleted) | auth_failed / billing |
| 404 | `model_not_found` | bad_request |
| 429 | `RESOURCE_EXHAUSTED` / `rate_limit_exceeded` / `quota_exceeded` (daily: don't spin) / `too_many_requests` | rate_limited |
| 500 | `api_error` | unavailable |
| 503 | `UNAVAILABLE` / `service_unavailable` | overloaded |
| 504 | `deadline_exceeded` | timeout |

- Context too long: 400 `INVALID_ARGUMENT` with a token-count message [mem].
- Content filter: either `promptFeedback.blockReason` (`SAFETY`, `PROHIBITED_CONTENT`, `BLOCKLIST`, `OTHER`, `IMAGE_SAFETY`) with no candidates, or `finishReason: SAFETY\|RECITATION\|PROHIBITED_CONTENT\|SPII\|BLOCKLIST`. Interactions blocked codes are `safety`, `recitation`, `prohibited_content`, `spii`, `blocklist`, `content_blocked` [doc].

**Form:** `apiKey` (secret, required), `apiFlavor` (select `generateContent` | `interactions` | `openai`, default `generateContent` until Interactions is proven), `baseUrl` (default above).

---

## 4. Google Vertex AI

Docs: <https://docs.cloud.google.com/vertex-ai/generative-ai/docs/migrate/openai/auth-and-credentials>, <https://docs.cloud.google.com/vertex-ai/generative-ai/docs/model-reference/inference>, <https://platform.claude.com/docs/en/build-with-claude/claude-on-vertex-ai>. The Google docs navigation now brands this as "Gemini Enterprise Agent Platform"; REST paths are unchanged (`aiplatform.googleapis.com`).

| Item | Detail |
|---|---|
| Auth | **Service-account JSON** → OAuth2 JWT-bearer → access token with scope `https://www.googleapis.com/auth/cloud-platform`, valid **1 h**; send as `Authorization: Bearer <token>` [doc]. In Node, use `google-auth-library` `GoogleAuth({credentials, scopes}).getAccessToken()` and cache until ~5 min before expiry. Vertex "express mode" API keys exist for a subset (`…/express-mode/rest/v1/publishers.models/generateContent`) [doc nav] |
| Host | Regional: `https://{LOCATION}-aiplatform.googleapis.com`. **Global**: `https://aiplatform.googleapis.com` with `locations/global` [doc search + Anthropic doc] |
| Gemini native | `POST {host}/v1/projects/{P}/locations/{L}/publishers/google/models/{model}:generateContent` / `:streamGenerateContent?alt=sse`. Same body as AI Studio generateContent (thinkingConfig, tools, cachedContent = `projects/…/cachedContents/…`) [mem] |
| OpenAI-compat | `{host}/v1/projects/{P}/locations/{L}/endpoints/openapi` (also `v1beta1`) + `/chat/completions`; model names are prefixed: `google/gemini-…`. Also serves MaaS open models (Llama, DeepSeek, Qwen…) [doc] |
| Claude on Vertex | `POST {host}/v1/projects/{P}/locations/{L}/publishers/anthropic/models/{model}:rawPredict` / `:streamRawPredict`. Body is the Anthropic Messages body **without `model`**, plus `"anthropic_version":"vertex-2023-10-16"` in the body. Global endpoint supported for Sonnet 4.5+; regional costs +10%. SSE is identical to Anthropic. Errors are Anthropic-shaped inside Google HTTP codes [doc] |
| Models | `GET {host}/v1beta1/publishers/google/models` (Model Garden) [mem]. In practice, let the admin type model IDs or use a curated list plus a probe; publisher listing is noisy |
| Embeddings | `…/publishers/google/models/{gemini-embedding-001\|text-embedding-005…}:predict` with `instances:[{content, task_type}]`, `parameters:{outputDimensionality}` [mem]; or the OpenAI-compat `/embeddings` |
| Probe | Obtaining a token proves the SA JSON is valid. Then do a minimal `countTokens` on the configured model (`…/models/{m}:countTokens`, free) [mem] to prove project/location/model access |

**Errors:** google.rpc shape (see Gemini); 403 `PERMISSION_DENIED` covers API-not-enabled and IAM; 429 `RESOURCE_EXHAUSTED` covers quota / DSQ.

**Form:** `serviceAccountJson` (textarea, secret, required; validate `type=service_account`, `client_email`, `private_key`), `projectId` (text, default from JSON `project_id`), `location` (select/text, default `global`), `publisher` (select `google` | `anthropic` | `openapi`-MaaS, default `google`), `apiKey` (secret, optional, express mode only).

---

## 5. Azure OpenAI / Azure AI Foundry

Docs: <https://learn.microsoft.com/en-us/azure/ai-foundry/openai/api-version-lifecycle> (now canonical at `/azure/foundry/openai/…`, updated 2026-06-05)

| Item | Detail |
|---|---|
| v1 API (use this) | Base `https://{resource}.openai.azure.com/openai/v1/` **or** `https://{resource}.services.ai.azure.com/openai/v1/`. **No `api-version` needed**; use the plain OpenAI client [doc] |
| Auth | Either `api-key: <key>` header or Entra `Authorization: Bearer <token>`. The token scope is **`https://ai.azure.com/.default`**; the role is `Cognitive Services OpenAI User`. For a service principal, use client-credentials against `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token` [doc + mem] |
| Model field | `model` = **deployment name**, not the model name [doc] |
| Endpoints | `/responses` (recommended for Azure OpenAI models), `/chat/completions` (also for Foundry partner models: DeepSeek, Grok, MAI-DS-R1…), `/embeddings`, `/models` [doc + mem]. Preview features use per-feature headers or `alpha` paths |
| Legacy (pre-v1) | `https://{resource}.openai.azure.com/openai/deployments/{deployment}/chat/completions?api-version=2024-10-21`. Only support this when an admin has an old resource |
| Reasoning | Same as OpenAI: `reasoning_effort` / `reasoning.effort`; `max_completion_tokens` (`max_tokens` doesn't work on o-series) [doc changelog] |
| Embeddings | `text-embedding-3-*` deployments with `dimensions` |
| Probe | `GET {base}/models` [mem]. It lists models available to the resource, not deployments, so also do a 1-token chat against the configured deployment |

**Errors:**
- OpenAI shape.
- 401 bad key or token; 403 RBAC; 404 `DeploymentNotFound`; 429 with `retry-after` / `retry-after-ms` [mem]; 503.
- **Content filter:** 400 with `error.code:"content_filter"` and `innererror:{code:"ResponsibleAIPolicyViolation", content_filter_result:{hate,self_harm,sexual,violence,jailbreak:{filtered,severity}}}` on the prompt. On output it is `finish_reason:"content_filter"`, and responses carry `prompt_filter_results` / `content_filter_results` [mem; the content-filter doc URL 404'd on the check date].

**Form:** `endpoint` (url, required, e.g. `https://myres.openai.azure.com`), `authMode` (select `apiKey` | `entra`), `apiKey` (secret, if apiKey), `tenantId` / `clientId` / `clientSecret` (secret) (if entra), `apiStyle` (select `v1` | `legacy`, default `v1`), `apiVersion` (text, legacy only), `deployments` (list of `{deploymentName, modelFamily}`, because `/models` doesn't reveal deployments).

---

## 6. AWS Bedrock

Docs: <https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html>, <https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html>, <https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-mantle.html>

| Item | Detail |
|---|---|
| Auth | **SigV4** (`accessKeyId`, `secretAccessKey`, optional `sessionToken`, `region`; service `bedrock`). **Or Bedrock API keys**: `Authorization: Bearer <key>` (env `AWS_BEARER_TOKEN_BEDROCK`). Short-term keys last ≤12 h and inherit the IAM principal (recommended); long-term keys are tied to an IAM user and are **region-scoped**; a wrong region gives `Credential should be scoped to a valid region`. IAM action: `bedrock:CallWithBearerToken` [doc] |
| Native (use) | `POST https://bedrock-runtime.{region}.amazonaws.com/model/{modelId}/converse` and `/converse-stream`. `modelId` is a model ID, **inference profile** (`us.` / `eu.` / `global.` prefix, required for most newer models), or an ARN [doc] |
| Request | `messages[{role, content:[{text}\|{image}\|{document}\|{toolUse}\|{toolResult}\|{reasoningContent}\|{cachePoint}]}]`, `system[]`, `inferenceConfig{maxTokens, temperature, topP, stopSequences}`, `toolConfig{tools:[{toolSpec:{name, description, inputSchema:{json}}}], toolChoice:{auto\|any\|tool}}`, `outputConfig.textFormat` (structured output), `additionalModelRequestFields` (pass-through, e.g. Anthropic `thinking`, `top_k`), `guardrailConfig`, `performanceConfig.latency`, `serviceTier` [doc] |
| Streaming | **AWS event-stream binary framing** (`application/vnd.amazon.eventstream`), **not SSE**. Use `@aws-sdk/client-bedrock-runtime` `ConverseStreamCommand`. Events: `messageStart`, `contentBlockStart` (toolUse start: `toolUseId`, `name`), `contentBlockDelta` (`text` \| `toolUse.input` partial JSON \| `reasoningContent{text, signature}`), `contentBlockStop`, `messageStop{stopReason}`, `metadata{usage{inputTokens, outputTokens, cacheReadInputTokens, cacheWriteInputTokens}, metrics}`. In-stream exceptions: `internalServerException`, `modelStreamErrorException`, `serviceUnavailableException`, `throttlingException`, `validationException` [doc] |
| stopReason | `end_turn`, `tool_use`, `max_tokens`, `stop_sequence`, `guardrail_intervened`, `content_filtered`, `model_context_window_exceeded` [mem] |
| Prompt caching | `{cachePoint:{type:"default"}}` blocks in system/messages/tools [mem]; usage `cacheRead/WriteInputTokens` [doc] |
| OpenAI-compat | **bedrock-runtime** `https://bedrock-runtime.{region}.amazonaws.com/openai/v1` (Responses and Chat Completions; synchronous; **no `GET /models`**; `model` must be an inference profile such as `global.openai.gpt-5.6-sol`; `store` defaults to true, so send `store:false`). **bedrock-mantle** `https://bedrock-mantle.{region}.api.aws/v1` (has `/models`; some models are under `/openai/v1`). Both take the Bedrock API key as a Bearer token [doc] |
| Models | Control plane: `GET https://bedrock.{region}.amazonaws.com/foundation-models` (ListFoundationModels: `modelSummaries[{modelId, inputModalities, outputModalities, responseStreamingSupported, inferenceTypesSupported}]`) **and** `ListInferenceProfiles` (`/inference-profiles`). Merge them, because newer models are only invocable via profiles [doc + mem] |
| Embeddings | `InvokeModel` (`/model/{id}/invoke`), not Converse. Model-specific bodies: Titan v2 `{inputText, dimensions: 256\|512\|1024, normalize}`; Cohere `{texts, input_type, embedding_types}` [mem] |
| Probe | `ListFoundationModels` (control plane; proves the creds). Note that API keys may **not** cover the control plane; then probe with a 1-token `Converse` [mem] |

**Errors:**
- JSON `{message}` plus header `x-amzn-ErrorType`.

| Status | Exception | Unified code |
|---|---|---|
| 400 | `ValidationException` (also returned for context too long; message contains "too long" / "Input is too long") | bad_request / context_too_long |
| 403 | `AccessDeniedException` (also when model access is not granted) | auth_failed |
| 403 | `UnrecognizedClientException` / signature errors [mem] | auth_failed |
| 404 | `ResourceNotFoundException` | bad_request |
| 408 | `ModelTimeoutException` | timeout |
| 424 | `ModelErrorException` | unavailable |
| 429 | `ThrottlingException` | rate_limited |
| 429 | `ModelNotReadyException` (retry) | overloaded |
| 500 | `InternalServerException` | unavailable |
| 503 | `ServiceUnavailableException` | overloaded |

- Content filter: `stopReason: guardrail_intervened` / `content_filtered`.

**Form:** `region` (select, required, default `us-east-1`), `authMode` (select `sigv4` | `apiKey`), `accessKeyId`, `secretAccessKey` (secret), `sessionToken` (secret, optional), `apiKey` (secret), `useOpenAICompat` (bool, default false), `defaultInferenceProfilePrefix` (select `us` | `eu` | `apac` | `global` | none).

---

## 7. Mistral

Docs: <https://docs.mistral.ai/api/>, <https://docs.mistral.ai/capabilities/embeddings/overview>

| Item | Detail |
|---|---|
| Auth / base | `Authorization: Bearer`; `https://api.mistral.ai/v1` [doc] |
| Compat | OpenAI-shaped Chat Completions; **the OpenAI-compat adapter is enough**, with extras: `random_seed` (not `seed`), `safe_prompt`, `prompt_mode:"reasoning"`, `reasoning_effort: none\|minimal\|low\|medium\|high\|xhigh`, `parallel_tool_calls` (default true), `response_format` `json_object` / `json_schema` [doc] |
| Streaming | SSE, ends with `data: [DONE]` [doc] |
| Models | `GET /v1/models` (includes `capabilities{completion_chat, function_calling, vision…}`, `max_context_length`) [mem] |
| Embeddings | `POST /v1/embeddings`: `mistral-embed` (1024-d); `codestral-embed` with `output_dimension` / `output_dtype` [mem] |
| Errors | OpenAI-like; 401, 422 validation, 429 [mem] |
| Probe | `GET /v1/models` |

**Form:** `apiKey`, `baseUrl` (default above).

## 8. DeepSeek

Docs: <https://api-docs.deepseek.com/>, <https://api-docs.deepseek.com/guides/thinking_mode>, <https://api-docs.deepseek.com/quick_start/error_codes>

| Item | Detail |
|---|---|
| Auth / base | Bearer; OpenAI format at `https://api.deepseek.com` (also `/v1`); **Anthropic format** at `https://api.deepseek.com/anthropic` [doc] |
| Models | Current models are `deepseek-flash` (served by V4.1-Flash) and `deepseek-v4-pro`; the legacy names `deepseek-v4-flash*` are aliased [doc]. Old `deepseek-chat` / `deepseek-reasoner` are not mentioned any more. `GET /models` and `GET /user/balance` [mem] |
| Thinking | On by default. `thinking:{type:"enabled"\|"disabled"}` (via `extra_body`); `reasoning_effort: low\|high\|max` (default high; others are mapped). Stream field `delta.reasoning_content`. **With `tools`, all prior `reasoning_content` must be resent or the API returns 400.** In thinking mode `temperature` and penalties are ignored and `top_p` is model-dependent [doc] |
| Caching | Automatic disk context cache; usage `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` [mem] |
| Embeddings | None |

**Errors:**

| Status | Meaning | Unified code |
|---|---|---|
| 400 | Format | bad_request |
| 401 | Auth | auth_failed |
| 402 | **Insufficient balance** | auth_failed / billing |
| 422 | Params | bad_request (context too long also shows up here or as 400 with a message) |
| 429 | Rate / concurrency | rate_limited |
| 500 | Server | unavailable |
| 503 | **Overloaded** | overloaded |

**Probe:** `GET /models`.

## 9. xAI

Docs: <https://docs.x.ai/docs/api-reference>, <https://docs.x.ai/docs/guides/reasoning>

| Item | Detail |
|---|---|
| Auth / base | Bearer; `https://api.x.ai/v1` [doc] |
| APIs | **Responses** (`/v1/responses`, stored 30 days; send `store:false`), `/v1/chat/completions` (OpenAI-compatible) [doc + mem], `/v1/models` and `/v1/language-models` (richer: modalities, pricing) [mem], `GET /v1/api-key` (key info, a good probe) [mem] |
| Reasoning | `reasoning.effort` (or `reasoning_effort`) on grok-4.5 / 4.6 / 4.7: `low\|medium\|high` (default high), plus `xhigh` on ≥4.6. **Reasoning cannot be disabled.** **`presencePenalty`, `frequencyPenalty` and `stop` return an error on reasoning models.** `include:["reasoning.encrypted_content"]` (always on for 4.7); Chat Completions can't carry encrypted reasoning. Reasoning stream events are `response.reasoning_text.delta` / `response.reasoning_summary_text.delta` [doc]. Logprobs are ignored on grok-4.20+ |
| Structured output | `text.format` (Responses) / `response_format` (Chat) |
| Embeddings | Not offered [mem] |
| Errors | OpenAI-like; 400/401/403/404/429/5xx [mem] |
| Probe | `GET /v1/api-key` or `/v1/models` |

## 10. Groq

Docs: <https://console.groq.com/docs/openai>, <https://console.groq.com/docs/errors>

| Item | Detail |
|---|---|
| Base | `https://api.groq.com/openai/v1`, Bearer [doc] |
| Compat | Chat Completions plus **Responses API** (text/image input, function calling, `previous_response_id`) [doc]. **These return 400:** `logprobs`, `top_logprobs`, `logit_bias`, `messages[].name`, `n≠1`. `temperature:0` is coerced to 1e-8 [doc]. Reasoning models: `reasoning_format: parsed\|raw\|hidden`, `reasoning_effort`, `include_reasoning` [mem] |
| Models | `GET /openai/v1/models` (`context_window`, `active`) [mem] |
| Embeddings | Not offered [mem] |

**Errors:**
- Body shape: `{error:{message, type, code?}}`.

| Status | Meaning | Unified code |
|---|---|---|
| 400 | Bad request | bad_request |
| 401 | Bad key | auth_failed |
| 403 | Forbidden | auth_failed |
| 404 | Not found | bad_request |
| 413 | Too large | bad_request (context_too_long) |
| 422 | Semantic error / "hallucination" | bad_request |
| 424 | Remote MCP auth failed | bad_request |
| 429 | Rate limit (`retry-after`, `x-ratelimit-*`) | rate_limited |
| **498** | Flex capacity exceeded | overloaded |
| 499 | Cancelled | — |
| 500 | Server error | unavailable |
| 502 | Bad gateway | unavailable |
| 503 | Busy / maintenance | overloaded |

Groq does not charge for 5xx [doc].

## 11. Cohere

Docs: <https://docs.cohere.com/reference/chat-stream>, <https://docs.cohere.com/reference/embed>, <https://docs.cohere.com/docs/compatibility-api>

| Item | Detail |
|---|---|
| Auth / base | `Authorization: Bearer`; native `https://api.cohere.com/v2`; compat `https://api.cohere.ai/compatibility/v1` [doc] |
| Native chat | `POST /v2/chat`. Params: `temperature` (0.3), `p` (0.75), `k`, `max_tokens`, `stop_sequences` ≤5, `seed`, `frequency_penalty` / `presence_penalty` (0–1), `tools`, `strict_tools`, `tool_choice: REQUIRED\|NONE`, `response_format` (json_object + json_schema; **not combinable with tools or documents**), `documents`, `citation_options`, **`thinking:{type, token_budget}`**, `safety_mode: CONTEXTUAL\|STRICT\|OFF`, `priority` [doc] |
| Native stream | SSE with `event:` names `message-start`, `content-start`, `content-delta`, `content-end`, `tool-plan-delta`, `tool-call-start` / `-delta` / `-end`, `citation-start` / `-end`, `message-end` (`finish_reason: COMPLETE\|STOP_SEQUENCE\|MAX_TOKENS\|TOOL_CALL\|ERROR\|TIMEOUT`, usage), `debug` [doc] |
| Compat caveats | Supports chat, embeddings and transcription. `reasoning_effort` accepts **only `none` / `high`**. Unsupported: `parallel_tool_calls`, `n`, `logit_bias`, `store`, `service_tier`…; embeddings drop `dimensions` and `input_type`, which loses retrieval quality [doc] |
| Embeddings (native) | `POST /v2/embed`: `model` (`embed-v4.0`, `embed-v5.0-fast`…), **`input_type` required** (`search_document\|search_query\|classification\|clustering\|image`), `output_dimension` (v4+), `embedding_types` (`float`, `int8`, `uint8`, `binary`, `ubinary`, `base64`), max 96 texts per call, `truncate: NONE\|START\|END` [doc] |
| Models | `GET /v1/models?endpoint=chat\|embed` [mem] |
| Errors | 400, 401, 403, 404, 422, 429, **498 / 499**, 500, 501, 503, 504 [doc]; body `{message}` [mem] |

**Verdict:** the compat adapter is fine for chat. **Use native for embeddings** (`input_type`, `output_dimension`).

## 12. Together AI

Docs: <https://docs.together.ai/docs/openai-api-compatibility>

- Base `https://api.together.ai/v1` with Bearer; serves `/chat/completions`, `/embeddings` and `/models` [doc].
- Model IDs are namespaced (`org/model`); OpenAI names return 404.
- `reasoning_effort` works on GPT-OSS only. The `reasoning:{enabled}` toggle and `chat_template_kwargs` are Together-specific.
- Reasoning comes back in `reasoning` **or** `reasoning_content` depending on the model, and must be resent under the same key [doc].
- `n` and `logit_bias` support is spotty.
- `/models` returns a bare array with `type` (`chat`, `embedding`, …), `context_length`, `pricing` [mem].
- Errors are OpenAI-like [mem].
- **Verdict:** compat adapter.

## 13. Fireworks

Docs: <https://docs.fireworks.ai/tools-sdks/openai-compatibility>

- Base `https://api.fireworks.ai/inference/v1` with Bearer [doc].
- Model IDs look like `accounts/fireworks/models/<name>`.
- `context_length_exceeded_behavior: truncate` (**default, silently lowers max_tokens**) | `error`. **Set `error`** so the context_too_long mapping works [doc].
- Usage arrives in the final stream chunk.
- Extra params: `top_k`, `reasoning_effort`, `prompt_cache_max_len` [mem].
- Embeddings: `/embeddings` [mem].
- Models: `GET /v1/accounts/fireworks/models` on `api.fireworks.ai` (control plane) [mem].
- An Anthropic-SDK endpoint also exists [doc].
- **Verdict:** compat adapter.

## 14. OpenRouter

Docs: <https://openrouter.ai/docs/api/reference/overview>, <https://openrouter.ai/docs/api/reference/errors-and-debugging>

| Item | Detail |
|---|---|
| Base / auth | `https://openrouter.ai/api/v1`, Bearer. Optional `HTTP-Referer`, `X-OpenRouter-Title` (or `X-Title`), `X-OpenRouter-Categories` [doc] |
| Extras | `models` (fallback list), `route:"fallback"`, `provider` (routing prefs: order, `allow_fallbacks`, `require_parameters`, `data_collection:"deny"`, `zdr`), `plugins`, `reasoning:{effort\|max_tokens, exclude}` [doc + mem]. The stream contains **SSE comment lines** (`: OPENROUTER PROCESSING`); ignore them. Usage with cost arrives in the final chunk [doc] |
| Models | `GET /api/v1/models` → `data[{id, name, context_length, pricing, supported_parameters[], architecture{input_modalities}}]`. **Use `supported_parameters` to drive the params form** [mem] |
| Key info / probe | `GET /api/v1/key` (limit, usage, rate limit) [mem] |
| Embeddings | `POST /api/v1/embeddings` [mem] |

**Errors:**
- Body shape: `{error:{code:<int>, message, metadata?}}`.

| Status | Meaning | Unified code |
|---|---|---|
| 400 | Bad request | bad_request |
| 401 | Invalid credentials | auth_failed |
| 402 | Credits (only retry if `Retry-After` present) | billing |
| 403 | **Moderation / guardrail**; `metadata.reasons`, `flagged_input`, `provider_name` | content_filtered |
| 408 | Timed out | timeout |
| 429 | Rate limited (`Retry-After`) | rate_limited |
| 502 | Upstream model down or bad response | unavailable |
| 503 | No provider meets routing requirements | unavailable |

- **Errors also arrive inside 200 responses**: non-streaming bodies with `error` and no `choices`, and in streams as a chunk with `error` plus `finish_reason:"error"`.
- If a reasoning model spends the whole `max_tokens` on thinking, you get 200 with `finish_reason:"length"` and empty content [doc].

## 15. Perplexity

Docs: <https://docs.perplexity.ai/api-reference/chat-completions-post>

- Bearer auth on `https://api.perplexity.ai`.
- **Sonar Chat Completions** (`/v1/sonar`, older `/chat/completions`; models `sonar`, `sonar-pro`, `sonar-reasoning-pro`, `sonar-deep-research`) is being **migrated to the Agent API**. Sonar Chat Completions support ends **2026-09-27**, i.e. it has already lapsed on the check date [doc].
- **Agent API**: `POST /v1/agent`, Open-Responses-compatible (`input` → typed `output`).
  - Multi-vendor models (e.g. `openai/gpt-5.6-luna`) plus `preset: fast\|low\|medium\|high\|xhigh`.
  - Built-in web search, fetch and MCP tools plus custom functions; structured outputs; streaming [doc].
- Sonar responses carry `citations[]` and `search_results[]`. The Agent API returns a `search_results` output item, and the answer text contains `[n]` markers [doc].
- No embeddings [mem].
- **Verdict:** treat as a Responses-protocol adapter with `baseUrl=https://api.perplexity.ai/v1` and path `/agent`. Expose `preset` and search options. There is no documented model list, so use a static list or free-text input.

## 16. Cerebras

Docs: <https://inference-docs.cerebras.ai/resources/openai>

- Base `https://api.cerebras.ai/v1` with Bearer [doc].
- Only `n:1` is supported.
- `service_tier` and `prediction` depend on the model.
- Reasoning settings by model:

  | Model | `reasoning_effort` | `reasoning_format` | `clear_thinking` |
  |---|---|---|---|
  | `qwen-3.8-27b` | `none\|low\|medium\|high` (default high) | `hidden` unsupported | supported (default false) |
  | `kimi-k2.7-code` | ignored (always on) | `parsed` (default) / `raw` | — |

  Send `reasoning_format` and `clear_thinking` via `extra_body` (i.e. top-level JSON).
- `gpt-oss-120b` rejects `tools` + `response_format` together [doc].
- Models: `GET /v1/models` [mem].
- No embeddings [mem].
- Errors are OpenAI-like, 429 with `retry-after` [mem].
- **Verdict:** compat adapter.

## 17. Alibaba Cloud Model Studio / DashScope (Qwen)

Docs: <https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope>, <https://www.alibabacloud.com/help/en/model-studio/deep-thinking>, <https://www.alibabacloud.com/help/en/model-studio/base-url> (overview dated 2026-10-11, via search)

| Item | Detail |
|---|---|
| Base URLs (OpenAI-compat) | **Recommended: workspace-dedicated** `https://{WorkspaceId}.{region}.maas.aliyuncs.com/compatible-mode/v1`. Regions: `ap-southeast-1` (Singapore / intl), `us-east-1` (Virginia), `cn-beijing` (China), `cn-hongkong`, `ap-northeast-1` (Tokyo). **Legacy shared (still works):** `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` (intl) and `https://dashscope.aliyuncs.com/compatible-mode/v1` (CN). Native DashScope API: `…/api/v1` [doc] |
| Auth | Bearer `sk-…`. **Keys are region-bound**: the wrong region gives 401 `invalid_api_key`. A workspace domain needs a key from that workspace [doc] |
| Thinking | `enable_thinking: bool` (hybrid models) and `thinking_budget` (1–32768; console default 4000) as **top-level JSON** (`extra_body` in Python). Stream `delta.reasoning_content` arrives before `content`. Thinking-only models (e.g. `qwen3.8-2.4t-a95b`, `glm-5.3`, `kimi-k2.7-code`) ignore the toggle [doc]. Model Studio also hosts DeepSeek, GLM, Kimi and MiniMax models |
| Caveats | The compat page says `tools` cannot be combined with `stream=true` and that `n` is limited [doc]. That conflicts with Qwen3 streaming-tool examples elsewhere; **verify per model** and fall back to non-streaming for tool turns if needed. `parallel_tool_calls` and `response_format` (`json_object`) are supported on newer Qwen models [mem] |
| Embeddings | `POST /compatible-mode/v1/embeddings`: `text-embedding-v4` with `dimensions` (e.g. 64–2048, default 1024) [mem] |
| Models | `GET /compatible-mode/v1/models` [mem]; if it is unavailable in a region, fall back to a manual list |
| Errors | OpenAI-shaped `{error:{code, message, type}}`. 400 `data_inspection_failed` = **content filter** [mem]; 401 `invalid_api_key`; 429 `Throttling` / `limit_requests`; 500 / 503 [mem] |

**Form:** `apiKey` (secret), `region` (select: `intl-sg`, `us-va`, `cn-bj`, `cn-hk`, `jp-tyo`), `workspaceId` (text, optional; when empty, use the legacy shared domain), `baseUrl` (computed, overridable).

## 18. Zhipu AI (GLM): z.ai (intl) / bigmodel.cn (CN)

Docs: <https://docs.z.ai/api-reference/introduction>, <https://docs.z.ai/api-reference/api-code>, <https://docs.z.ai/guides/capabilities/thinking>

- **Base URLs and auth.** Bearer auth on all of them.
  - Intl: `https://api.z.ai/api/paas/v4` (`/chat/completions`) [doc].
  - CN: `https://open.bigmodel.cn/api/paas/v4` [mem].
  - GLM Coding Plan has a dedicated endpoint (`https://api.z.ai/api/coding/paas/v4`) [mem].
  - Anthropic-compatible endpoint: `https://api.z.ai/api/anthropic` [mem].
- **Thinking.**
  - `thinking:{type:"enabled"\|"disabled"}`, default enabled.
  - `reasoning_effort: max\|high\|low` (GLM-5.2+, default max).
  - GLM-5.3 / 5.3-FLASH **cannot disable thinking** (returns an error).
  - Stream field `delta.reasoning_content` [doc].
- **Embeddings.** `/embeddings` with `embedding-3` (`dimensions` 256–2048) [mem].
- **Models.** No documented list endpoint [doc], so use a static or free-text list.
- **Probe.** A 1-token chat on a cheap flash model.
- **Errors.** Body shape `{error:{code:"<business code>", message}}` [doc]:

  | Status | Business code | Meaning | Unified code |
  |---|---|---|---|
  | 401 | 1000 / 1001 / 1003 | Auth / missing header / token expired | auth_failed |
  | 429 | **1113** | Insufficient balance | billing |
  | 400 | 1210 / 1211 | Bad param / unknown model | bad_request |
  | 400 | **1261** | Prompt too long | context_too_long |
  | 400 | **1301** | Unsafe content | content_filtered |
  | 429 | **1302** | Rate limit | rate_limited |
  | 429 | **1305** | Overloaded | overloaded |
  | 429 | 1308 / 1310 | Usage limit reached | rate_limited (non-retryable until reset) |
  | 500 | 1234 | Network error | unavailable |

  - **Map by business code, not by HTTP status** (429 is overloaded).
  - Mid-stream failures appear only in `finish_reason` (e.g. `sensitive`, `network_error`) [doc + mem].

## 19. Moonshot AI (Kimi)

Docs: <https://platform.kimi.ai/docs/api/chat> (`platform.moonshot.ai` redirects here)

- **Base URLs and auth.** Bearer auth.
  - Intl: `https://api.moonshot.ai/v1` [doc].
  - CN: `https://api.moonshot.cn/v1` [mem].
- **Models.**
  - `kimi-k3`: always reasons; `reasoning_effort: low\|high\|max`, default max.
  - `kimi-k2.7-code` (+ `-highspeed`): thinking forced; history `keep:"all"`.
  - `kimi-k2.6`: `thinking:{type: enabled\|disabled, keep: null\|"all"}`.
  - Preserve `reasoning_content` in history [doc].
- **Tools and output.**
  - `tool_choice: auto\|none\|required\|{function}`.
  - `response_format: text\|json_object\|json_schema`; JSON mode must not be combined with Partial Mode.
  - `prompt_cache_breakpoint` exists, but putting it in `content` returns 400 [doc].
- **Other endpoints.** `GET /v1/models`, `GET /v1/users/me/balance`, `POST /v1/tokenizers/estimate-token-count` [mem].
- **Embeddings.** None [mem].
- **Errors.**
  - Documented: 400 invalid params, 401 bad key, 500 [doc].
  - Also: 429 `rate_limit_reached_error` / `exceeded_current_quota_error`, 403 `permission_denied`, 400 `content_filter` with message "high risk" [mem].
- **Probe.** `GET /v1/models`.

---

## 20. Summary: native vs OpenAI-compatible

| Vendor | Chat adapter | Embeddings adapter | Why native (if native) |
|---|---|---|---|
| OpenAI | **native-ish: `openai-responses`** | openai-compat | Tools on flagship models only via Responses; encrypted reasoning |
| Anthropic | **native `anthropic`** | n/a | thinking/effort, caching, refusal, 529, capability-rich `/models` |
| Gemini (AI Studio) | **native `gemini`** (compat as fallback) | native (`taskType`, `outputDimensionality`) | thinking signatures, safety blocks, cachedContent; compat is beta |
| Vertex AI | **native `vertex`**: Gemini body + SA token; Claude via `anthropic` codec on rawPredict | native | OAuth from SA JSON; publisher routing |
| Azure OpenAI / Foundry | **`openai-responses` / openai-compat with Azure auth plugin** | openai-compat | Only auth (api-key / Entra) and deployment naming differ |
| AWS Bedrock | **native `bedrock-converse`** (or compat on `/openai/v1` with API key) | native InvokeModel | SigV4, event-stream framing, inference profiles, guardrails |
| Mistral | openai-compat | openai-compat | — |
| DeepSeek | openai-compat (+ reasoning round-trip) | n/a | — |
| xAI | `openai-responses` (compat Chat also OK) | n/a | encrypted reasoning; penalty/stop rejection |
| Groq | openai-compat | n/a | — (strip `logprobs`, `n`, `name`) |
| Cohere | openai-compat for chat; **native for embeddings** | **native** | `input_type` / `output_dimension` missing in compat |
| Together | openai-compat | openai-compat | — |
| Fireworks | openai-compat (`context_length_exceeded_behavior:"error"`) | openai-compat | — |
| OpenRouter | openai-compat + OpenRouter extras | openai-compat | in-200 errors, routing fields |
| Perplexity | `openai-responses` (Agent API path `/v1/agent`) | n/a | Sonar Chat Completions EOL 2026-09-27 |
| Cerebras | openai-compat | n/a | — |
| DashScope | openai-compat (+ `enable_thinking`, region/workspace URL) | openai-compat | — |
| Zhipu GLM | openai-compat + **business-code error mapper** | openai-compat | — |
| Moonshot Kimi | openai-compat | n/a | — |

So the plan is **6 codecs**: `openai-chat`, `openai-responses`, `anthropic-messages`, `gemini`, `bedrock-converse`, `cohere-embed`. Add **auth strategies** (`bearer`, `header:<name>`, `google-sa`, `azure-entra`, `sigv4`) and **per-vendor "quirk" profiles**. A profile is data (default base URL, param deny-list, reasoning-field mapping, extra-body keys, error code table, model-list path), not code.

---

## 21. Proposed TypeScript interface

```ts
// ---------- registry ----------
export type FieldType = 'text' | 'password' | 'url' | 'select' | 'textarea' | 'number' | 'boolean' | 'tags';
export interface FormField {
  name: string; label: string /* 繁中 */; type: FieldType;
  required?: boolean; secret?: boolean; default?: unknown;
  options?: { value: string; label: string }[];
  showIf?: Record<string, unknown>;          // e.g. { authMode: 'entra' }
  validate?: (v: unknown, all: Record<string, unknown>) => string | null; // 繁中 error
}

export interface ProviderDescriptor {
  id: string;                                // 'openai' | 'anthropic' | 'vertex' | ...
  displayName: string;
  configFields: FormField[];                 // admin form (credentials, endpoints)
  capabilities: { chat: boolean; embed: boolean; listModels: boolean };
  create(config: ProviderConfig): ProviderAdapter;
}
export type ProviderConfig = Record<string, unknown>; // secrets decrypted only inside create()

// ---------- unified messages ----------
export type Part =
  | { type: 'text'; text: string }
  | { type: 'image'; mime: string; data?: Uint8Array; url?: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; callId: string; content: string | Part[]; isError?: boolean }
  | { type: 'reasoning'; text?: string; opaque?: unknown }; // signature / encrypted_content / reasoning_content

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  parts: Part[];
  /** vendor state to replay verbatim next turn (thinking blocks, thoughtSignature, encrypted reasoning) */
  providerState?: { provider: string; model: string; data: unknown };
}

export interface ToolDef { name: string; description?: string; parameters: JSONSchema; strict?: boolean }

export interface ChatParams {                // per-member "params" form, all optional
  maxOutputTokens?: number;
  temperature?: number; topP?: number; topK?: number;
  stop?: string[]; seed?: number;
  presencePenalty?: number; frequencyPenalty?: number;
  reasoning?: { effort?: 'none'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max'; budgetTokens?: number; show?: boolean };
  responseFormat?: { type: 'text' } | { type: 'json' } | { type: 'json_schema'; name: string; schema: JSONSchema; strict?: boolean };
  toolChoice?: 'auto' | 'none' | 'required' | { name: string };
  parallelToolCalls?: boolean;
  cache?: { mode: 'off' | 'auto'; ttl?: '5m' | '1h' };
  extra?: Record<string, unknown>;           // raw vendor passthrough (admin-only)
}

export interface ChatRequest {
  model: string; messages: Message[]; tools?: ToolDef[]; params?: ChatParams;
  signal: AbortSignal; timeoutMs?: number;
}

export type ChatEvent =
  | { type: 'start'; model: string; requestId?: string }
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_call_start'; index: number; id: string; name: string }
  | { type: 'tool_call_delta'; index: number; argsJson: string }  // partial JSON
  | { type: 'tool_call_end'; index: number; args: unknown }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; reasoningTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  | { type: 'end'; finish: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error'; providerState?: Message['providerState'] }
  | { type: 'error'; error: ProviderError };  // mid-stream error (after HTTP 200)

// ---------- models / embeddings / probe ----------
export interface ModelInfo {
  id: string; displayName?: string; kind: 'chat' | 'embedding' | 'other';
  contextWindow?: number; maxOutputTokens?: number;
  supports?: { tools?: boolean; vision?: boolean; jsonSchema?: boolean;
               reasoning?: { efforts?: string[]; canDisable?: boolean; budget?: boolean } ;
               params?: string[] };            // e.g. OpenRouter supported_parameters
  deprecated?: boolean;
}

export interface EmbedRequest {
  model: string; inputs: string[];
  dimensions?: number;
  purpose?: 'query' | 'document' | 'classification' | 'clustering'; // → input_type / taskType
  signal: AbortSignal;
}
export interface EmbedResult { vectors: Float32Array[]; dimensions: number; inputTokens?: number; normalized: boolean }

export interface ProbeResult { ok: boolean; latencyMs: number; error?: ProviderError; detail?: string /* 繁中 */ }

// ---------- errors ----------
export type UnifiedErrorCode =
  | 'auth_failed' | 'billing' | 'rate_limited' | 'overloaded' | 'context_too_long'
  | 'content_filtered' | 'bad_request' | 'model_not_found' | 'unavailable' | 'timeout' | 'cancelled';

export class ProviderError extends Error {
  constructor(
    public code: UnifiedErrorCode,
    public retryable: boolean,
    public provider: string,
    public httpStatus?: number,
    public vendorCode?: string,          // e.g. 'overloaded_error', '1305', 'ThrottlingException'
    public retryAfterMs?: number,        // Retry-After / retry-after-ms / RetryInfo.retryDelay
    public requestId?: string,
    message?: string,                    // vendor message (log only; UI shows 繁中 by code)
  ) { super(message); }
}

// ---------- adapter ----------
export interface ProviderAdapter {
  listModels(signal: AbortSignal): Promise<ModelInfo[]>;
  chat(req: ChatRequest): AsyncIterable<ChatEvent>;     // always streaming; non-stream = collect
  embed?(req: EmbedRequest): Promise<EmbedResult>;      // batches internally (Cohere 96, etc.)
  probe(signal: AbortSignal): Promise<ProbeResult>;     // cheap: GET /models, /v1/api-key, countTokens
  mapError(input: { status?: number; headers?: Headers; body?: unknown; streamEvent?: unknown; cause?: unknown }): ProviderError;
  /** drop/rename params the model rejects; used before send and for one strip-and-retry on 400 */
  sanitizeParams(model: string, params: ChatParams): { params: ChatParams; dropped: string[] };
}
```

**Error-mapping rules (shared helper, applied after the vendor table):**

| Unified code | When | Retry? |
|---|---|---|
| `auth_failed` | 401 / 403 | no |
| `billing` | 402; OpenAI `insufficient_quota` / `credit_balance_exhausted` / `*_spend_limit_exceeded`; Anthropic 429 without `retry-after`; DeepSeek 402; Zhipu 1113 | no |
| `rate_limited` | 429 | yes, with `retryAfterMs` |
| `overloaded` | 503 / 529 / Groq 498 / Zhipu 1305 / Bedrock `ModelNotReadyException` | yes, with backoff |
| `context_too_long` | 400 whose code or message matches `context_length_exceeded\|prompt is too long\|too many tokens\|maximum context\|Input is too long\|1261`, or finish/stop reason `model_context_window_exceeded` | no |
| `content_filtered` | Azure `content_filter`; DashScope `data_inspection_failed`; Zhipu 1301; OpenRouter 403 moderation; Gemini `blockReason` / `finishReason SAFETY`; Anthropic `stop_reason: refusal`; Bedrock `guardrail_intervened` | no |
| `timeout` | 408 / 504 / Bedrock `ModelTimeoutException` / our own `AbortSignal` timeout | yes, once |
| `unavailable` | 500 / 502 / 424 / network errors | yes, with backoff |
| `bad_request` | everything else 4xx | no |

**Params form tip:** render the per-member params form from `ModelInfo.supports` (Anthropic `capabilities`, OpenRouter `supported_parameters`, Mistral `capabilities`) when present. Otherwise fall back to the vendor profile's static deny-list (xAI reasoning: no penalties/stop; Groq: no `logprobs`/`n`; OpenAI reasoning: no `temperature`/`top_p`; Anthropic 5.x: no forced `tool_choice`).
