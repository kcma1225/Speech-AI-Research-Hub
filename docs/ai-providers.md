# AI providers library (`backend/src/ai/`)

A pure TypeScript library (Node 22 `fetch`, no vendor SDKs, no npm deps) that talks to every chat and embedding vendor in spec §8. It has no routes and no database code. The routing/DB/admin layer sits on top and only uses `backend/src/ai/providers/index.ts`.

```
ai/types.ts            unified messages, tools, ChatRequest, ChatEvent, ChatResult, Embed*, ModelInfo, ProbeResult
ai/errors.ts           AiError + codes (message_zh / hint_zh / retryable), HTTP classifier, Retry-After parsing
ai/providers/
  index.ts             public barrel (import from here)
  registry.ts          vendor entries + validateAccount / publicProviders / registerProvider
  entry.ts             ProviderEntry / FormField / ParamSpec / Quirks / AuthSpec types
  client.ts            createClient(), aggregateChat()
  auth.ts              api-key, Google SA JWT, Azure (api-key | Entra), AWS (SigV4 | Bedrock key), OAuth hook
  http.ts              fetch wrapper: timeout + idle timeout, abort, error mapping, SSE / NDJSON readers
  eventstream.ts       AWS binary event-stream decoder (CRC-checked)
ai/codecs/             one file per wire protocol
```

## Codecs

| Codec | Used by | Chat | Embed | Models | Probe |
|---|---|---|---|---|---|
| `openai-chat` | Mistral, DeepSeek, Groq, Together, Fireworks, OpenRouter, Cerebras, DashScope, Zhipu, Moonshot, every local server, generic endpoint; OpenAI / Azure when `apiStyle=chat` | `/chat/completions` SSE | `/embeddings` | `/models` (or a static list) | health path, then `/models` (1-token chat when there is no list) |
| `openai-responses` | OpenAI, Azure v1, xAI, Perplexity Agent API (`/agent`) | `/responses` typed SSE, `store:false` | `/embeddings` | `/models` | `/models` |
| `anthropic-messages` | Anthropic; Claude on Vertex (`:streamRawPredict`) | `/messages` SSE | — | `/models` (paged) | `/models?limit=1` |
| `gemini` | Gemini AI Studio; Vertex (`publisher=google`) | `:streamGenerateContent?alt=sse` | `:batchEmbedContents` / Vertex `:predict` | `/models` (AI Studio only) | `/models`, or Vertex `countTokens` |
| `bedrock-converse` | AWS Bedrock | `/model/{id}/converse-stream` (binary event-stream) | `/model/{id}/invoke` (Titan, Cohere) | `foundation-models` + `inference-profiles` | list, falling back to a 1-token Converse |
| `ollama-native` | Ollama | `/api/chat` NDJSON, `options.num_ctx` | `/api/embed` | `/api/tags` | `/api/version` |
| `cohere` | Cohere | `/v2/chat` SSE | `/v2/embed` (`input_type`, `output_dimension`) | `/v1/models` | `/v1/models` |
| `voyage-embed`, `jina-embed`, `tei-embed` | Voyage, Jina, HF TEI | — | yes | static list / TEI `/info` | 1-input embed / TEI `/health` |

**Stream contract.** If a call fails before the stream starts (HTTP error, bad config, an unsupported feature), `chatStream()` throws an `AiError`, so a router can fall back cleanly. If it fails after the stream started (an error inside an HTTP 200: Anthropic `event: error`, OpenRouter `finish_reason:"error"`, Bedrock exception frames, Zhipu `network_error`, Ollama `{"error"}` lines, truncated streams), the stream yields one final `{type:"error", error}` event with `error.midStream === true`. A successful stream always ends with `{type:"done", stopReason, providerState?}`.

**providerState.** Each assistant turn carries opaque vendor state. Store it and send it back unchanged:

| Codec | State replayed |
|---|---|
| openai-chat | `reasoning_content` / `reasoning`, sent back under the same key |
| openai-responses | encrypted reasoning items |
| anthropic | thinking blocks and their signatures |
| gemini | the raw parts, including `thoughtSignature` |
| bedrock | `reasoningContent` |
| ollama | `thinking` |
| cohere | `tool_plan` / thinking |

A codec ignores state whose `codec` field differs from its own, so falling back across vendors is safe.

**Errors.** Every failure is an `AiError` with a `code`:

`auth_failed`, `rate_limited`, `overloaded`, `context_too_long`, `content_filtered`, `bad_request`, `unavailable`, `timeout`, `quota_exhausted`, `model_not_found`, `unsupported`, `cancelled`

Each error also carries `retryable`, `retryAfterMs`, `status`, `vendorCode`, `vendorMessage` (log only), `providerId`, `midStream`, `message_zh` and `hint_zh`. `toResponse()` returns the API body `{ error, code, hint }`. `toLog()` returns a log-safe object that contains no prompt or response content.

Mapping runs in this order: the entry's `quirks.mapError` (Zhipu business codes, DashScope `data_inspection_failed`, OpenRouter moderation), then the codec's table, then the generic `classifyHttpError`.

## Registry entry (`ProviderEntry`)

| Field | Meaning |
|---|---|
| `id`, `label{zh,en}`, `category` (`external`\|`local`), `docsUrl`, `help_zh` | Identity and admin help text |
| `codec`, `embedCodec?`, `codecFor?(config)` | Wire protocol. `codecFor` covers cases where the account config picks the codec: OpenAI/Azure `apiStyle`, Vertex `publisher` |
| `defaultBaseUrl`, `resolveBaseUrl?(config, secrets)` | Endpoint. Some are computed: Azure `/openai/v1`, Vertex project/location, Bedrock region, DashScope workspace/region, Zhipu/Moonshot region |
| `auth: AuthSpec` | One of `none`; `api_key` (header, scheme, optional); `google_service_account`; `azure` (`authMode` `api_key`\|`entra`); `aws` (`authMode` `sigv4`\|`bedrock_api_key`); `oauth` (token from `ClientOptions.oauthTokenProvider` or `secrets.accessToken`) |
| `fields: FormField[]` | Admin form: `key`, `label{zh,en}`, `type` (`text`\|`url`\|`secret`\|`select`\|`number`\|`boolean`\|`json`), `required`, `default`, `help_zh`, `options`, `showIf`, `multiline`. Values of `secret` fields go in `secrets`; all other values go in `accountConfig` |
| `capabilities` | `chat`, `tools`, `vision`, `reasoning`, `embeddings`, `listModels`, `jsonSchema`. On local servers the account's `supportsTools` overrides `tools` |
| `params: ParamSpec[]` | Whitelist of passthrough request params (`key`, which may be dotted like `options.num_ctx`; `type`; `default`; `sendDefault`). `ChatRequest.params` keys that are not in the whitelist are dropped |
| `quirks` | Data-only vendor differences (see below) |
| `resolveHeaders?`, `resolveQuirks?` | Headers and quirks computed from the config (OpenAI org/project, OpenRouter referer, toggles on the generic endpoint) |

`quirks` covers:

- **Paths:** `chatPath`, `modelsPath` (`null` means the vendor has no listing), `healthPath`, `staticModels`.
- **Body and headers:** `fixedBody`, `fixedHeaders`, `stripFields`, `maxTokensField`.
- **Reasoning and streaming:** `reasoningStyle`, `reasoningFields`, `streamUsage`, and `responsesStore` / `includeEncryptedReasoning` for the Responses codec.
- **Embeddings:** `embedBatchSize`, `sendDimensions`.
- **Errors and probing:** `mapError`, `finishReasonErrors`, `probeModel`.
- **Admin warnings:** `warnings_zh`.

`reasoningStyle` sets how `ChatRequest.reasoning` is sent on `openai-chat`:

| Value | Sent as | Vendors |
|---|---|---|
| `openai_effort` | `reasoning_effort` | OpenAI and most compatible servers |
| `thinking_type` | `thinking.type` + `reasoning_effort` | DeepSeek, Zhipu, Moonshot |
| `dashscope` | `enable_thinking` + `thinking_budget` | DashScope |
| `chat_template_kwargs` | `chat_template_kwargs.enable_thinking` | vLLM, SGLang, llama.cpp |
| `reasoning_object` | `reasoning` object | OpenRouter, Together |
| `none` | nothing | |

The common account fields are `timeoutMs` (default 120 s; it bounds both the time to first byte and the gap between stream chunks), `extraHeaders` and `extraBody` (both JSON). Embedding vendors also take `queryTemplate` / `documentTemplate` (with `{text}` and `{task}` placeholders), `taskInstruction`, `normalize` (L2, default on) and `batchSize`.

## Public API

```ts
import { createClient, aggregateChat, getProvider, listProviders, publicProviders, validateAccount,
         registerProvider, registerAuthStrategy, AiError } from "../ai/providers/index.js";

const client = createClient("deepseek", accountConfig, decryptedSecrets, { fetch?, oauthTokenProvider?, now? });
client.capabilities; client.codecId; client.warnings_zh;
await client.listModels({ signal });
for await (const ev of client.chatStream({ model, messages, tools, toolChoice, maxTokens, reasoning, signal })) …
const result = await client.chat(req);          // ChatResult; result.message goes straight back into history
await client.embed({ model, inputs, inputType: "query" | "document", dimensions });
await client.probe();                           // never throws: { ok, latencyMs, detail_zh, modelCount?, error? }
```

## Adding a vendor

1. **OpenAI-compatible vendor:** add an entry to `entries` in `providers/registry.ts`.
   - Set `codec: "openai-chat"`, `defaultBaseUrl`, `auth: bearer()`, the fields (`OPENAI_COMPAT_FIELDS(url)`), the capabilities, the param whitelist and the quirks.
   - Add a `mapError` if the vendor uses business codes.
   - No codec code is needed.
2. **New wire protocol:** add `codecs/<name>.ts` implementing `Codec` (`listModels`, `chatStream?`, `embed?`, `probe`, `mapError?`).
   - Reuse `send` / `sendJson` / `sseEvents` / `guardStream` from `providers/http.ts`, and `ToolCalls` / `finishBody` / `makeState` from `codecs/shared.ts`.
   - Add the id to `CodecId` in `types.ts` and to `CODECS` in `codecs/index.ts`.
3. **New auth scheme** (e.g. subscription OAuth): call `registerAuthStrategy(type, factory)`, then use `registerProvider(entry)`, or add the entry here.
   - The `oauth` type already accepts a caller-supplied `oauthTokenProvider`. The caller owns token refresh and its locking.
4. Add mock-server tests in `backend/test/ai-providers-*.test.ts` (helpers are in `ai-providers-mock.ts`). The registry integrity test checks every entry automatically.

## Tests

- **Mock tests:** `npx vitest run test/ai-providers` runs local mock-server replays of recorded-shape responses for every codec.
- **Live smoke test:** `test/ai-providers-live.test.ts` runs the generic OpenAI-compatible codec against a real endpoint (list models, a short streamed reply, a tool call round trip).
  - It is skipped unless `TEST_LLM_BASE_URL` and `TEST_LLM_API_KEY` are set.
  - It uses the cheapest model: `TEST_LLM_MODEL`, default `glm/glm-5.3-flash` with `glm/glm-5-turbo` as fallback.
  - Embeddings run only when `TEST_LLM_EMBED_MODEL` is set.

## Known gaps

- **Bedrock:** `responseFormat: json_schema` throws `unsupported`. Images must be base64.
- **DashScope:** tools combined with streaming may fail on some models (a vendor limitation). There is no automatic non-stream fallback.
- **Gemini:** history from another vendor carries no `thoughtSignature`, so Gemini 3 tool loops should stay on one vendor per conversation.
- **Not implemented:** the Gemini Interactions API, Azure legacy (pre-v1) deployments, and the Bedrock OpenAI-compatible endpoints.
