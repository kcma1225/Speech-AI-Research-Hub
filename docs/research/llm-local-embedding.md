# Research: local LLM servers, embedding vendors, pgvector

Status: research input for the provider adapter registry spec. Compiled 2026-10-21 from official docs (URLs inline and in "Sources").
Items marked **(unverified)** were not confirmed against an official page during this pass. Check them before relying on them.

Versions at time of writing (GitHub latest release): vLLM v0.32.0 (2026-10-18), SGLang v0.5.22 (2026-10-19), Ollama v0.40.6 (2026-10-16), llama.cpp v0.7.0 (2026-10-15), LocalAI v4.11.0 (2026-10-02), TEI v1.9.4 (2026-09-15), TGI v3.3.7 (2025-12-19, maintenance mode), pgvector 0.8.7 (2026-10-01).

---

## 0. Takeaways for the adapter design

1. **One "OpenAI-compatible chat" adapter covers all of Part A.** Every server exposes `POST {base}/v1/chat/completions` with SSE streaming and `GET {base}/v1/models`. Only Ollama's native API (`/api/*`, NDJSON) needs its own adapter. Each vendor entry is a **preset** that sets the default base URL, auth, health path, reasoning field, and known quirks.
2. **Reasoning field is not uniform.** Normalise on read, in priority order: `reasoning` (vLLM current, LM Studio gpt-oss), then `reasoning_content` (llama.cpp, SGLang, LocalAI, older vLLM, DeepSeek style), then Ollama native `message.thinking`. vLLM renamed `reasoning_content` to `reasoning`, so code that reads only the old name silently gets nothing.
3. **Tool calling is a server-launch property for vLLM, SGLang, and LocalAI-on-vLLM**, not a request property. The server only parses tool calls if it was started with the right parser flags. The admin form should have a "supports tools" toggle plus a "Test tools" button that sends a trivial tool request and checks for `tool_calls`. Do not infer support from the model name.
4. **`tool_choice` support varies.** Ollama `/v1` ignores `tool_choice`. LM Studio supports `required` only on llama.cpp engines. vLLM `required` needs v0.8.3+. TGI uses grammar-forced tools. The registry should record a capability set per provider: `{tools, toolChoiceRequired, toolChoiceNamed, parallelToolCalls}`.
5. **Thinking on/off** is sent differently per server. vLLM, SGLang, and llama.cpp use `chat_template_kwargs: {enable_thinking: false}` in the body. Ollama native uses `think: false\|true\|"low"…`. Ollama `/v1` and LM Studio use `reasoning_effort`. Gemini `/openai` uses `reasoning_effort` or `extra_body.google.thinking_config`. Store this as a per-provider "thinking control" strategy enum.
6. **Embedding "space" = (provider, model, dimensions, normalisation, instruction/input_type convention).** Changing any of these makes old vectors incomparable. Model it as a first-class row (`embedding_spaces`) and never mix spaces in one index.
7. **pgvector:** store as untyped-dimension `halfvec` (or `vector`) plus a `space_id`, and create a **partial expression HNSW index per space** cast to `halfvec(N)`. This indexes up to 4000 dims (covers 3072-dim OpenAI and Gemini, and 2560-dim Qwen3-Embedding-4B), and switching models becomes "add a space, backfill, flip pointer, drop old index" with no `ALTER COLUMN TYPE`.
8. **Repo note:** `compose.yaml` uses `postgres:17.6-alpine3.22`, which does not ship pgvector. You would need `pgvector/pgvector:0.8.7-pg17` (Debian based) or to build the extension into the `postgres/` image.
9. **Network note:** the worker runs on an internal network without internet. External vendors (Part B) must therefore be called from the backend, or the worker needs a dedicated egress path. Local servers (Part A) can sit on the internal network.

---

## Part A: Local / self-hosted LLM servers

### A1. Overview matrix

| Server | Default base URL | Auth | List models | Chat + stream | Health | Embeddings | Notes |
|---|---|---|---|---|---|---|---|
| **vLLM** | `http://localhost:8000/v1` | none; `--api-key` / `VLLM_API_KEY` → `Authorization: Bearer`. Only protects `/v1`, `/v2`, `/inference` (not `/invocations`, `/health`, `/metrics`) | `GET /v1/models` | `/v1/chat/completions` SSE; also `/v1/completions`, `/v1/responses` | `GET /health` (200 when up), `/version`, `/metrics` | `/v1/embeddings` (OpenAI), `/v2/embed` (Cohere v2 shape), `/pooling`, `/score`, `/rerank`, `/v1/rerank`, `/v2/rerank`; needs a pooling model (`--runner pooling`) | One model per server (multi-model needs a router in front). Sampling defaults come from the model's `generation_config.json` unless `--generation-config vllm` |
| **Ollama native** | `http://localhost:11434/api` | none locally (binds 127.0.0.1). Cloud `https://ollama.com/api` uses `Authorization: Bearer $OLLAMA_API_KEY` | `GET /api/tags` (installed), `GET /api/ps` (loaded), `POST /api/show` (details, capabilities, think values) | `POST /api/chat`, NDJSON stream (`application/x-ndjson`), `stream` default **true** | `GET /` returns "Ollama is running" (unverified on current docs), `GET /api/version` | `POST /api/embed` (`input` string or array, `truncate`, `dimensions`) | Many models per server, loaded on demand |
| **Ollama OpenAI-compat** | `http://localhost:11434/v1` | key required by clients but ignored locally (use `ollama`) | `GET /v1/models`, `/v1/models/{model}` | `/v1/chat/completions` SSE, `/v1/completions`, `/v1/responses` (v0.13.3+, stateless) | as native | `/v1/embeddings` | **Unsupported:** `tool_choice`, logprobs, `logit_bias`, `n`, `user`; image URLs (base64 only); no context-size field |
| **LM Studio** | `http://localhost:1234/v1` | off by default; optional API tokens (0.4.0+) → `Authorization: Bearer` | `GET /v1/models`; richer `GET /api/v1/models` (`type: llm\|embedding\|decision`, `max_context_length`, `loaded_instances`, `capabilities.trained_for_tool_use`, `capabilities.reasoning.allowed_options`) | `/v1/chat/completions` SSE, `/v1/responses` (stateful, 0.3.29+), `/v1/messages` (Anthropic, 0.4.1+), native `/api/v1/chat` | no dedicated health endpoint documented; use `GET /v1/models` | `/v1/embeddings` | JIT model load; `POST /api/v1/models/load\|unload` |
| **llama.cpp `llama-server`** | `http://127.0.0.1:9931/v1` (**new default port 9931**; Docker examples still map 8080) | `--api-key` (comma list) / `LLAMA_API_KEY`, `--api-key-file`; `/health` is public | `GET /v1/models`; router mode `GET /models` | `/v1/chat/completions` SSE, `/v1/responses`, `/v1/messages` (Anthropic), `/completion` (native) | `GET /health` or `/v1/health`: 503 `{"error":{"code":503,"message":"Loading model","type":"unavailable_error"}}` while loading, 200 when ready | `/v1/embeddings`, `/embedding`, `/embeddings`; `/reranking` (`/rerank`, `/v1/rerank`); start with `--embeddings --pooling {none,mean,cls,last,rank}` | Router mode (no `-m`; `--models-dir`, `--models-max` default 4) loads models on demand; `model` field is required in router mode |
| **SGLang** | `http://127.0.0.1:30000/v1` | `--api-key` (default none) → Bearer | `GET /v1/models` | `/v1/chat/completions` SSE, `/v1/completions` | `GET /health`, `GET /health_generate` (runs a generation) (unverified; native API page timed out) | `/v1/embeddings` with `--is-embedding` (encoder models are auto-detected) | One model per server |
| **HF TGI** | Docker `-p 8080:80` → `http://localhost:8080/v1` (docs examples also use `:3000`) | none by default (unverified flag) | `GET /v1/models` (unverified); `GET /info` | `/v1/chat/completions` (Messages API) SSE; `/generate`, `/generate_stream` | `GET /health` | no (use TEI) | **Maintenance mode**: HF recommends vLLM / SGLang / llama.cpp. Do not invest beyond the generic preset |
| **LocalAI** | `http://localhost:8080/v1` (`--address`, `LOCALAI_ADDRESS`) | `--api-keys` / `LOCALAI_API_KEY` / `API_KEY` → Bearer (unverified, mirrored CLI reference) | `GET /v1/models` | `/v1/chat/completions` SSE | `GET /readyz` (unverified; used by its Docker HEALTHCHECK) | `/v1/embeddings` | Multi-backend (llama.cpp, vLLM, MLX…); behaviour depends on the backend configured per model YAML |
| **Generic OpenAI-compatible** | admin-supplied | Bearer optional | `GET {base}/models`, with a fallback to a manually entered model id | `{base}/chat/completions` SSE | `GET {base}/models` as health | optional `{base}/embeddings` | Catch-all for OpenRouter, LiteLLM proxy, Xinference, etc. |

### A2. Tool calling

| Server | How to enable | `tool_choice` | Caveats |
|---|---|---|---|
| vLLM | Launch flags `--enable-auto-tool-choice --tool-call-parser <p>` (+ `--chat-template` if the model's template lacks tools; `--tool-parser-plugin` for custom). Parsers: `hermes`, `qwen3_xml` (Qwen/Hermes), `llama3_json`, `llama4_pythonic`, `pythonic`, `mistral`, `deepseek_v3`, `deepseek_v31`, `glm45`, `glm47`, `granite`, `granite4`, `kimi_k2`, `openai` (gpt-oss), `cohere_command3/4`, `internlm`, `jamba`, `xlam`, `hunyuan_a13b`, `longcat`, `functiongemma`, `mimo`, `olmo3`, `step3p5`, `gigachat3`, `apertus`, `muse`, `hf`, `beam` | `auto`, `none`, `required` (v0.8.3+), named | `required`/named use structured outputs (first call slow while grammar compiles). With `none`, tools still go into the prompt unless `--exclude-tools-when-tool-choice-none`. With `auto`, arguments may be malformed unless the tool has `strict: true` or `--tool-strict-level` is set. `llama3_json` has no parallel calls. Pythonic parsers cannot mix text and tool calls |
| Ollama native | `tools` array in `/api/chat`; the model must have the `tools` capability (`/api/show`) | n/a | `message.tool_calls[].function.arguments` is a **JSON object, not a string** (unlike OpenAI). Normalise to a string or object in the adapter |
| Ollama `/v1` | `tools` supported | **ignored / unsupported** | Cannot force a tool. Emulate with prompt or schema (`format`) on the native API |
| LM Studio | `tools` on `/v1/chat/completions`; per-model `capabilities.trained_for_tool_use` | `auto`, `none`, `required` (`required` only on llama.cpp engine; 0.3.15+) | Streaming sets `finish_reason: "tool_calls"` |
| llama.cpp | `--jinja` (now **default enabled**); may need `--chat-template-file` with a tool-capable template (fallback `--chat-template chatml`) | `auto`/`none`/`required` (unverified beyond docs mention); `parallel_tool_calls` request flag (template dependent) | Quality depends on the GGUF's embedded template |
| SGLang | Launch `--tool-call-parser <p>`: `llama3`, `llama4`, `pythonic`, `mistral`, `qwen` (Qwen series), `qwen3_coder`, `deepseekv3`, `deepseekv31`, `deepseekv32`, `glm`, `gpt-oss`, `kimi_k2`, `step3`, `apertus2509` (some need `--chat-template`) | `auto`, `required`, named (via the Xgrammar backend, the default) | Stream argument fragments must be concatenated. gpt-oss content may be empty, so return tool results as `role:"tool"` |
| TGI | `tools` on `/v1/chat/completions` (grammar-constrained via outlines) | `auto` (default with tools), `none`, `required`, name string, or object | Response shape is historically non-standard: doc example shows `tool_calls` as an object (not array), `function.parameters`/`arguments` as an object, `id: 0` (int). Defensive parsing is needed |
| LocalAI | `tools` on `/v1/chat/completions`. llama.cpp backend uses grammar-based extraction with no config. vLLM backend needs `tool_parser:<name>` in the model YAML. MLX auto-detects | `auto` documented | Parallel calls are experimental (`function.parallel_calls`) |

### A3. Reasoning / thinking

| Server | Response field (non-stream / stream) | Server flag | Per-request on/off |
|---|---|---|---|
| vLLM | `message.reasoning` / `delta.reasoning` (**renamed from `reasoning_content`**) | `--reasoning-parser {deepseek_r1, deepseek_v3, qwen3, glm45, gemma4, granite, …}`. Qwen3 uses `qwen3`, QwQ uses `deepseek_r1` | `chat_template_kwargs: {"enable_thinking": false}` (top-level body field; `extra_body` in OpenAI SDK). Server-wide: `--default-chat-template-kwargs '{"enable_thinking": false}'` |
| SGLang | `message.reasoning_content` | `--reasoning-parser {deepseek-r1, deepseek-v3, qwen3, qwen3-thinking, kimi, gpt-oss}` | `chat_template_kwargs.enable_thinking=false` (not for Qwen3-Thinking). `separate_reasoning` (default true) |
| llama.cpp | `message.reasoning_content` (when `--reasoning-format deepseek`, default `auto`) | `--reasoning-format {none, deepseek, deepseek-legacy}`; `--chat-template-kwargs` | Request `chat_template_kwargs: {"enable_thinking": false}`; request `reasoning_format` |
| Ollama native | `message.thinking` (stream: partial `message.thinking`) | — | `think: true\|false\|null\|"<model-defined string>"`; valid values from `/api/show` |
| Ollama `/v1` | reasoning field on message (unverified name; treat both `reasoning` and `reasoning_content`) | — | `reasoning_effort` / `reasoning.effort` (`minimal`→`low`, `xhigh`/`ultra`→`max`, `"none"` disables) |
| LM Studio | `message.reasoning` / `delta.reasoning` (0.3.23+, gpt-oss; other models when "separate reasoning_content" is enabled in Developer settings; field name varies, so accept both) | — | `reasoning_effort` (0.4.8+); allowed values per model in `/api/v1/models` `capabilities.reasoning` |
| LocalAI | `reasoning_content` (from `<think>` blocks) | — | backend dependent |
| TGI | none (raw `<think>` in content) | — | — |

**Adapter rule:** if no structured field is present and content starts with `<think>`, optionally split it out (a "strip think tags" option, default off).

### A4. Notable request parameters

| Server | Parameter | Meaning |
|---|---|---|
| Ollama | `keep_alive` (`"5m"` default, `0` unload now, `-1` forever); env `OLLAMA_KEEP_ALIVE` | Model residency |
| Ollama | `options.num_ctx` (native only; default context **4096**, env `OLLAMA_CONTEXT_LENGTH`); `options.num_predict`, `temperature`, `top_k`, `top_p`, `min_p`, `seed`, `stop` | `/v1` has no context-size field. You need a Modelfile `PARAMETER num_ctx` or the env var. **This matters: a 4096 default silently truncates long RAG prompts** |
| Ollama | `format: "json" \| <JSON schema>` | Structured output (native) |
| Ollama env | `OLLAMA_HOST` (127.0.0.1:11434), `OLLAMA_NUM_PARALLEL` (1), `OLLAMA_MAX_LOADED_MODELS` (3×GPUs) | Deployment |
| vLLM | `top_k`, `min_p`, `repetition_penalty`, `structured_outputs: {choice\|json\|regex\|grammar}`, `chat_template_kwargs`, `priority` / header `X-Vllm-Priority` | `extra_body` in the OpenAI SDK; plain fields over raw HTTP |
| llama.cpp | `chat_template_kwargs`, `reasoning_format`, `parallel_tool_calls`; server `-c/--ctx-size` (0 = from model) | |
| SGLang | `separate_reasoning`, `chat_template_kwargs` | |
| LM Studio | native `/api/v1/chat` accepts a context length per request | |

### A5. Error shapes

| Server | HTTP error body | Mid-stream error |
|---|---|---|
| vLLM | `{"object":"error","message":"…","type":"BadRequestError","param":null,"code":400}` (as shown in the pooling docs; newer builds may wrap it in `{"error":{…}}`, so parse both) | SSE `data: {"error":{…}}` (unverified) |
| Ollama native | `{"error":"<message>"}`; 400 / 404 (model not found) / 429 / 500 / 502 (cloud unreachable) | final NDJSON line `{"error":"…"}` with HTTP 200. **Must check every line** |
| llama.cpp | `{"error":{"code":503,"message":"Loading model","type":"unavailable_error"}}` (OpenAI style) | — |
| OpenAI-style generic | `{"error":{"message","type","param","code"}}` | — |
| TEI | `{"error":"…","error_type":"…"}` | — |
| Voyage | 4xx `{"detail":"…"}` | — |

**Normaliser:** `msg = body.error?.message ?? (typeof body.error === 'string' ? body.error : undefined) ?? body.message ?? body.detail ?? text`. Map HTTP 401/403 → auth, 404 → model missing, 429 → rate limit (retry with backoff), 503 → loading (retry), 5xx → infra.

### A6. Admin form fields: chat providers

Common to every chat provider (rendered once):

| Field | Type | Req | Default | Secret | Notes |
|---|---|---|---|---|---|
| `displayName` | string | yes | vendor name | no | |
| `kind` | enum | yes | — | no | registry key, e.g. `vllm` |
| `group` | enum `external\|local` | derived | from kind | no | |
| `enabled` | bool | yes | true | no | |
| `defaultModel` | string (dropdown from list-models, free text fallback) | yes | — | no | |
| `requestTimeoutMs` | int | no | 120000 | no | First token on a cold model load can take a long time |
| `maxConcurrency` | int | no | 4 | no | Local GPUs are a shared lab resource |
| `contextWindow` | int | no | from model listing if available | no | Used for prompt budgeting |
| `capabilities` | multiselect `tools, toolChoiceRequired, parallelTools, vision, reasoning, jsonSchema` | no | preset | no | Overridable; "Test" button probes |

Per vendor:

| Kind | Field | Type | Req | Default | Secret |
|---|---|---|---|---|---|
| `vllm` | `baseUrl` | url | yes | `http://vllm:8000/v1` | no |
| | `apiKey` | string | no | — | **yes** |
| | `thinkingControl` | enum `chat_template_kwargs\|none` | no | `chat_template_kwargs` | no |
| | `enableThinkingDefault` | bool | no | true | no |
| | `extraBody` | JSON | no | `{}` | no |
| | (info only) launch flags hint: `--enable-auto-tool-choice --tool-call-parser …`, `--reasoning-parser …` | | | | |
| `ollama` (native) | `baseUrl` | url | yes | `http://ollama:11434` | no |
| | `apiKey` | string | no (yes for ollama.com cloud) | — | **yes** |
| | `numCtx` | int | no | 8192 (recommend over the 4096 default) | no |
| | `keepAlive` | string | no | `"5m"` | no |
| | `think` | enum `default\|true\|false\|low\|medium\|high` | no | default | no |
| | `options` | JSON | no | `{}` | no |
| `ollama_openai` | `baseUrl` | url | yes | `http://ollama:11434/v1` | no |
| | `apiKey` | string | no | `ollama` | yes |
| | `reasoningEffort` | enum | no | — | no |
| `lmstudio` | `baseUrl` | url | yes | `http://host:1234/v1` | no |
| | `apiToken` | string | no | — | **yes** |
| | `reasoningEffort` | enum | no | — | no |
| `llamacpp` | `baseUrl` | url | yes | `http://llama:9931/v1` (9931 is the new upstream default) | no |
| | `apiKey` | string | no | — | **yes** |
| | `routerMode` | bool | no | false | no |
| | `reasoningFormat` | enum `auto\|deepseek\|none` | no | `auto` | no |
| | `chatTemplateKwargs` | JSON | no | `{}` | no |
| `sglang` | `baseUrl` | url | yes | `http://sglang:30000/v1` | no |
| | `apiKey` | string | no | — | **yes** |
| | `chatTemplateKwargs` | JSON | no | `{}` | no |
| `tgi` | `baseUrl` | url | yes | `http://tgi:80/v1` | no |
| | `apiKey` | string | no | — | yes |
| `localai` | `baseUrl` | url | yes | `http://localai:8080/v1` | no |
| | `apiKey` | string | no | — | **yes** |
| `openai_compatible` | `baseUrl` | url | yes | — | no |
| | `apiKey` | string | no | — | **yes** |
| | `extraHeaders` | key/value list | no | — | values secret |
| | `reasoningField` | enum `auto\|reasoning\|reasoning_content\|none` | no | `auto` | no |
| | `supportsStreamUsage` | bool | no | true | no | (`stream_options.include_usage`) |
| | `modelsEndpoint` | bool | no | true | no | if false, model is free text |

Health probe per kind: vLLM `GET {root}/health`; Ollama `GET /api/version`; llama.cpp `GET /health` (503 = loading, not down); LM Studio and others `GET /v1/models`; LocalAI `GET /readyz`; TGI `GET /health`. Note: `{root}` = base URL minus `/v1`.

---

## Part B: Embeddings

### B1. Vendor matrix

| Vendor | Endpoint | Auth | Models (dims; max input tokens) | Batch limits | Dimension param | Query/doc param | Normalised |
|---|---|---|---|---|---|---|---|
| **OpenAI** | `POST https://api.openai.com/v1/embeddings` | Bearer | `text-embedding-3-small` (1536), `text-embedding-3-large` (3072), `text-embedding-ada-002` (1536, fixed); 8192 tokens/input | ≤2048 inputs, ≤300k tokens total/request; no empty strings | `dimensions` (v3 only; MRL) | none | yes (unit length) |
| **Cohere** | `POST https://api.cohere.com/v2/embed` | Bearer | `embed-v5.0-pro` / `embed-v5.0-fast` (256–2048, default 2048; 128k ctx), `embed-v4.0` (256/512/1024/1536, default 1536; 128k), `embed-english-v3.0` / `multilingual-v3.0` (1024; 512), `*-light-v3.0` (384; 512) | ≤96 texts/call | `output_dimension` (v4+) | **`input_type` required** (v3+): `search_document`, `search_query`, `classification`, `clustering`, `image` | not stated; normalise defensively |
| | | | | | `max_tokens` per input, `truncate: NONE\|START\|END` (default END), `embedding_types: float\|int8\|uint8\|binary\|ubinary\|base64` | | |
| **Gemini** | `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:embedContent` / `:batchEmbedContents`; OpenAI-compat `…/v1beta/openai/embeddings` | `x-goog-api-key` | `gemini-embedding-2` (multimodal; 8192 tokens), `gemini-embedding-001` (text; 2048 tokens); both default 3072, range 128–3072, recommended 768/1536/3072 | not stated (100/batch commonly cited; unverified); Batch API at 50% price | `output_dimensionality` (now in `embedContentConfig`) | `task_type` (001 only): `RETRIEVAL_QUERY`, `RETRIEVAL_DOCUMENT`, `SEMANTIC_SIMILARITY`, `CLASSIFICATION`, `CLUSTERING`, `CODE_RETRIEVAL_QUERY`, `QUESTION_ANSWERING`, `FACT_VERIFICATION`; `title` for docs. **embedding-2: no task_type; use a text prefix such as `task: search result \| query: …`** | 001: **only at 3072, so normalise yourself below that**; 2: auto-normalised |
| **Mistral** | `POST https://api.mistral.ai/v1/embeddings` | Bearer | `mistral-embed` (1024, fixed; 8k ctx unverified), `codestral-embed` (default 1536, max 3072) | not stated | `output_dimension` (codestral-embed) | none | not stated |
| | | | | | `output_dtype: float\|int8\|uint8\|binary\|ubinary`, `encoding_format` | | |
| **Voyage AI** | `POST https://api.voyageai.com/v1/embeddings` | Bearer | `voyage-4-large`, `voyage-4`, `voyage-4-lite`, `voyage-code-4` (1024 default; 256/512/2048; 32k), `voyage-4-nano` (open weights, same dims), `voyage-finance-2` (1024; 32k), `voyage-law-2` (1024; 16k); legacy `voyage-3.5(-lite)`, `voyage-3-large`, `voyage-code-3` | ≤1000 texts; total tokens: 1M (4-lite, 3.5-lite), 320k (4, 3.5), 120k (4-large, 3-large, code-3, finance-2, law-2) | `output_dimension`; `output_dtype: float\|int8\|uint8\|binary\|ubinary` | `input_type: null\|query\|document`. Prepends "Represent the query for retrieving supporting documents: " / "Represent the document for retrieval: " | yes (unit length) |
| | | | | | `truncation` (default true), `encoding_format: base64` | | |
| **Jina AI** | `POST https://api.jina.ai/v1/embeddings` (OpenAI-like) | Bearer | `jina-embeddings-v5-text-small` (dims 1–1024; 32k), `-v5-text-nano` (8k), `-v5-omni-small` (1024; 32k), `-v5-omni-nano` (768; 8k), `-v4` (1–2048; 32k; **non-commercial licence**), `-v3` (1–1024; 8k), `jina-code-embeddings-*` | no hard item limit (batched by tokens internally); one PDF per request; rate limit 100 RPM / 100k TPM free, 500 / 2M paid | `dimensions` (MRL) | `task`: `retrieval.query`, `retrieval.passage`, `text-matching` (default v4/v5), `classification`, `clustering`/`separation`; v4 also `code.query`/`code.passage` | `normalized` default **true** |
| | | | | | `truncate` (default false → error), `late_chunking`, `embedding_type: float\|base64\|binary\|ubinary`, v4 `return_multivector` | | |
| **HF TEI** | `POST {base}/embed` (native) or `/v1/embeddings` (OpenAI) | `--api-key` / `API_KEY` → Bearer (default open) | any supported HF model, one per server; `GET /info` returns `model_id`, `max_input_length`, `max_client_batch_size`, `max_batch_tokens` | `--max-client-batch-size` default **32** inputs/request; `--max-batch-tokens` default 16384; `--max-batch-requests` | `dimensions` (both endpoints; MRL models) | native `prompt_name` (from `config_sentence_transformers.json` prompts, e.g. `query`); server `--default-prompt-name` / `--default-prompt` | native `normalize` default **true**; `truncate` default false; `truncation_direction` default right; server `--auto-truncate` default true |
| | | | | | Port: binary default 3000, Docker image listens on 80 (`-p 8080:80`). Also `/rerank`, `/embed_sparse`, `/health`, `/metrics`. Error `{"error","error_type"}` | | |
| **Ollama** | `POST {base}/api/embed` (`/api/embeddings` is legacy) or `/v1/embeddings` | none locally | e.g. `embeddinggemma`, `qwen3-embedding`, `nomic-embed-text`, `bge-m3`, `mxbai-embed-large` | not stated | `dimensions` | none (prefix manually) | not stated (normalise defensively); `truncate` default true; `keep_alive`, `options.num_ctx` |
| **vLLM** | `POST {base}/v1/embeddings` (OpenAI), `/v2/embed` (Cohere v2 shape), `/pooling` | as A1 | any pooling model (`--runner pooling`; decoder LLMs auto-converted with `--convert embed`). Qwen3-Embedding supported | engine batching; no documented per-request cap | `dimensions`; errors 400 if the model is not Matryoshka (enable via `--hf-overrides '{"matryoshka_dimensions":[…]}'` or `is_matryoshka`) | `/v2/embed` `input_type` maps to the model's `task_instructions` or ST `prompts` (e.g. `query`); otherwise rejected. `output_dimension`, `truncate: END\|START\|NONE`, `embedding_types` | per ST config (Normalize module); toggle `use_activation` (`--pooler-config '{"use_activation":false}'` → unnormalised). Also `truncate_prompt_tokens` (unverified in current docs) |
| SGLang | `POST {base}/v1/embeddings` with `--is-embedding` | as A1 | gte-Qwen2, embeddinggemma, encoder models | — | not documented | none | model dependent |
| LM Studio / llama.cpp / LocalAI | `/v1/embeddings` | as A1 | GGUF embedding models (llama.cpp needs `--embeddings --pooling …`) | — | not documented | none | llama.cpp `/v1/embeddings` normalises (unverified) |

### B2. Instruction-aware open models (query prefix conventions)

The embedder must apply these itself when the provider does not (OpenAI-compat endpoints of Ollama, LM Studio, llama.cpp, TEI `/v1`). **The convention is part of the embedding space. Changing it requires re-embedding.**

| Model family | Query side | Document side | Dims / ctx | Notes |
|---|---|---|---|---|
| **Qwen3-Embedding** 0.6B / 4B / 8B | `Instruct: {task}\nQuery:{q}` (the HF example omits the space after "Query:"; the TEI example uses "Query: ") e.g. task = "Given a web search query, retrieve relevant passages that answer the query" | **no instruction** | 1024 / 2560 / 4096; 32k ctx; MRL 32→full | last-token pooling, left padding, L2 normalise. Omitting the query instruction costs 1–5%. ST `prompt_name="query"`; TEI `prompt_name: "query"`. vLLM ≥0.8.5. **8B (4096) exceeds the halfvec index limit (4000), so truncate via MRL to ≤4000 (e.g. 2048 or 3072)** |
| **multilingual-e5-*-instruct** | `Instruct: {task}\nQuery: {q}` | none | 1024; 512 tokens | instruction required |
| **e5 (non-instruct: e5-*-v2, multilingual-e5-small/base/large)** | `query: {q}` | `passage: {d}` | 384–1024; 512 | Use `query: ` on both sides for symmetric tasks (unverified on this pass; from the e5 model cards) |
| **bge-*-en-v1.5** | `Represent this sentence for searching relevant passages: {q}` (short queries; optional in v1.5) | none | 384/768/1024; 512 | |
| **bge-m3** | **no instruction** | none | 1024; 8192 | dense + sparse + ColBERT |
| **nomic-embed-text** | `search_query: ` | `search_document: ` | 768 (MRL) | (unverified on this pass) |
| **snowflake-arctic-embed** | `Represent this sentence for searching relevant passages: ` (ST prompt `query`) | none | | vLLM `/v2/embed input_type:"query"` applies it |
| **Gemini embedding-2** | `task: search result \| query: {q}` style prefix | doc prefix per Google docs | | replaces `task_type` |
| **Voyage / Cohere / Jina** | server-side via `input_type` / `task` | | | Cohere **requires** it |

**Registry abstraction:** `embed(texts, { purpose: 'query' | 'document' })`. Each preset maps `purpose` to one of three things: (a) a vendor param (`input_type`, `task`, `task_type`, `prompt_name`), (b) a template string applied client-side (`queryTemplate`, `documentTemplate` with `{text}` and `{task}` placeholders), or (c) nothing.

### B3. Admin form fields: embedding providers

Common fields:

| Field | Type | Req | Default | Secret | Notes |
|---|---|---|---|---|---|
| `displayName` | string | yes | | no | |
| `kind` | enum | yes | | no | |
| `model` | string | yes | preset | no | |
| `dimensions` | int | yes | model native | no | **Immutable once vectors exist** (changing it creates a new space). Validate against the model's allowed list and ≤4000 for halfvec indexing |
| `normalize` | bool | no | true | no | Client-side L2 normalise (always safe; required for Gemini-001 below 3072 and for unknown local servers) |
| `batchSize` | int | no | preset (see below) | no | |
| `maxInputTokens` | int | no | preset | no | Chunker budget |
| `truncate` | bool | no | true | no | Mapped to the vendor's truncate flag |
| `queryTemplate` / `documentTemplate` | string | no | preset for known open models | no | only for kinds without a server-side input_type |
| `taskInstruction` | string | no | Qwen3 default | no | fills `{task}` |

Per vendor (beyond common):

| Kind | Fields (type, req, default, secret) | Preset batchSize |
|---|---|---|
| `openai` | `apiKey` (str, req, **secret**); `baseUrl` (url, no, `https://api.openai.com/v1`); `organization` (str, no) | 512 (hard max 2048 / 300k tokens) |
| `cohere` | `apiKey` (req, **secret**); `baseUrl` (no, `https://api.cohere.com`); `embeddingType` (enum, no, `float`) | 96 |
| `gemini` | `apiKey` (req, **secret**); `baseUrl` (no, `https://generativelanguage.googleapis.com/v1beta`); `useOpenAICompat` (bool, no, false) | 100 (unverified) |
| `mistral` | `apiKey` (req, **secret**); `baseUrl` (no, `https://api.mistral.ai/v1`); `outputDtype` (no, `float`) | 128 (no documented cap; conservative) |
| `voyage` | `apiKey` (req, **secret**); `baseUrl` (no, `https://api.voyageai.com/v1`); `outputDtype` (no, `float`) | 128, plus a token budget per model (120k / 320k / 1M) |
| `jina` | `apiKey` (req, **secret**); `baseUrl` (no, `https://api.jina.ai/v1`); `lateChunking` (bool, no, false) | 64 |
| `tei` | `baseUrl` (req, `http://tei:80`); `apiKey` (no, **secret**); `useNativeEndpoint` (bool, no, true → `/embed` with `prompt_name`) | read `max_client_batch_size` from `GET /info` (default 32) |
| `ollama` | `baseUrl` (req, `http://ollama:11434`); `keepAlive` (no, `"30m"`); `numCtx` (no) | 32 |
| `vllm` | `baseUrl` (req, `http://vllm-embed:8000`); `apiKey` (no, **secret**); `useCohereV2Endpoint` (bool, no, false → `/v2/embed` with `input_type`) | 64 |
| `openai_compatible` | `baseUrl` (req); `apiKey` (no, **secret**); `sendDimensions` (bool, no, false, because many servers reject the field) | 32 |

Batching rule: split by both count (`batchSize`) and estimated tokens (`maxTokensPerRequest`, optional field). On 413/400 "too many tokens", halve the batch and retry.

---

## Part C: pgvector

### C1. Facts (pgvector 0.8.7, 2026-10-01)

| Type | Element | Max dims stored | Max dims **indexable** (HNSW / IVFFlat) | Opclasses |
|---|---|---|---|---|
| `vector(n)` | float4 | 16,000 | **2,000** | `vector_l2_ops`, `vector_ip_ops`, `vector_cosine_ops`, `vector_l1_ops` (HNSW) |
| `halfvec(n)` | float2 | 16,000 | **4,000** | `halfvec_*_ops` |
| `bit(n)` | 1 bit | — | 64,000 | `bit_hamming_ops`, `bit_jaccard_ops` |
| `sparsevec(n)` | float4, sparse | 16,000 non-zero | 1,000 non-zero (HNSW only) | `sparsevec_*_ops` |

| Index | Build params (default) | Query params (default) | When |
|---|---|---|---|
| **HNSW** | `m` (16), `ef_construction` (64) | `hnsw.ef_search` (40); `hnsw.iterative_scan = strict_order\|relaxed_order`, `hnsw.max_scan_tuples` (20,000), `hnsw.scan_mem_multiplier` (1) | **Default choice.** Can be built on an empty table, better speed/recall, more memory, slower build |
| **IVFFlat** | `lists` (rows/1000 up to 1M rows; sqrt(rows) above) | `ivfflat.probes` (1; start with sqrt(lists)); `ivfflat.iterative_scan = relaxed_order`, `ivfflat.max_probes` | Build only after data exists. Faster build, less memory. Not worth it at lab scale |

Other points:

- Half-precision indexing over a full-precision column uses an expression index: `CREATE INDEX ON items USING hnsw ((embedding::halfvec(3072)) halfvec_cosine_ops);`. The query must use the same expression: `ORDER BY embedding::halfvec(3072) <=> $1::halfvec(3072)`.
- Binary quantisation uses an expression index on `binary_quantize(embedding)::bit(n)` with `bit_hamming_ops`, then re-ranks by exact distance.
- Iterative scans (0.8+) fix the "filtered HNSW returns too few rows" problem when you add `WHERE note_id = …` / ACL filters. Enable `hnsw.iterative_scan = relaxed_order` for filtered RAG queries.
- Distance operators: `<->` L2, `<#>` negative inner product, `<=>` cosine, `<+>` L1, `<~>` Hamming, `<%>` Jaccard. For unit-normalised vectors, `<#>` (inner product) is fastest and ranks the same as cosine.
- Mixed dimensions in one column: declare the column **without** a typmod (`embedding halfvec`). You can only index rows of one dimension, using **expression + partial indexes** (README FAQ pattern).
- `ALTER TABLE … ALTER COLUMN embedding TYPE vector(1024)` only succeeds if every existing row already has 1024 dims. It cannot shrink or grow vectors. Changing models always means re-embedding. Dropping or recreating a large HNSW index is the expensive part, so set `maintenance_work_mem` high, and `max_parallel_maintenance_workers` for parallel builds.

### C2. Recommended schema (survives model switches)

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE embedding_spaces (
  id            bigserial PRIMARY KEY,
  provider_id   bigint NOT NULL REFERENCES ai_providers(id),
  model         text   NOT NULL,
  dimensions    int    NOT NULL CHECK (dimensions BETWEEN 1 AND 4000),
  normalized    boolean NOT NULL DEFAULT true,
  query_conv    text   NOT NULL,   -- e.g. 'voyage:input_type', 'template:Instruct: {task}\nQuery:{text}'
  doc_conv      text   NOT NULL,
  distance      text   NOT NULL DEFAULT 'cosine', -- cosine|ip|l2
  status        text   NOT NULL DEFAULT 'building', -- building|active|retired
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chunk_embeddings (
  chunk_id   bigint NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  space_id   bigint NOT NULL REFERENCES embedding_spaces(id) ON DELETE CASCADE,
  embedding  halfvec NOT NULL,          -- no typmod: any dims up to 16000 stored
  PRIMARY KEY (space_id, chunk_id)
);

-- One partial expression index per space (created by the backend when a space is created):
CREATE INDEX CONCURRENTLY chunk_emb_space_7_hnsw
  ON chunk_embeddings USING hnsw ((embedding::halfvec(1024)) halfvec_cosine_ops)
  WHERE space_id = 7;

-- Query (planner uses the index only if expression + predicate match exactly):
SELECT chunk_id FROM chunk_embeddings
WHERE space_id = 7
ORDER BY embedding::halfvec(1024) <=> $1::halfvec(1024)
LIMIT 20;
```

Why `halfvec`: it halves storage, indexes up to 4000 dims (covering OpenAI-large 3072, Gemini 3072, Qwen3-4B 2560, Voyage/Cohere 2048), and the recall loss from fp16 is negligible for retrieval. Models above 4000 (Qwen3-Embedding-8B at 4096) must use MRL truncation. Model-switch flow: create a new space (`building`) → a backfill job (Postgres `jobs`, worker or backend) → `CREATE INDEX CONCURRENTLY` → flip the active space → retire the old one (drop its index, delete its rows). Index DDL via a migration is not possible here because space ids are runtime data. Create these indexes from the backend under the migration advisory lock or a dedicated lock. Note: `CREATE INDEX CONCURRENTLY` cannot run inside a transaction.

Image: replace `postgres:17.6-alpine3.22` with `pgvector/pgvector:0.8.7-pg17` (or `-pg17-trixie`), or compile pgvector into the existing `postgres/` image. Add the extension in a new migration (`CREATE EXTENSION vector` needs superuser or a trusted-extension setup; the backend's DB role may not have that, so run it from `postgres/init`).

---

## Sources

Local servers
- vLLM OpenAI-compatible server: https://docs.vllm.ai/en/latest/serving/online_serving/ and source https://github.com/vllm-project/vllm/blob/main/docs/serving/online_serving/openai_compatible_server.md
- vLLM tool calling: https://docs.vllm.ai/en/latest/features/tool_calling.html
- vLLM reasoning outputs: https://docs.vllm.ai/en/latest/features/reasoning_outputs.html
- vLLM pooling / embeddings: https://github.com/vllm-project/vllm/blob/main/docs/models/pooling_models/README.md, https://github.com/vllm-project/vllm/blob/main/docs/models/pooling_models/embed.md
- Ollama API intro / chat / embed / errors / OpenAI compat / FAQ: https://docs.ollama.com/api/introduction, https://docs.ollama.com/api/chat, https://docs.ollama.com/api/embed, https://docs.ollama.com/api/errors, https://docs.ollama.com/api/openai-compatibility, https://docs.ollama.com/faq
- LM Studio: https://lmstudio.ai/docs/developer/openai-compat, https://lmstudio.ai/docs/developer/core/authentication, https://lmstudio.ai/docs/developer/rest, https://lmstudio.ai/docs/developer/rest/list, https://lmstudio.ai/docs/developer/api-changelog
- llama.cpp server README: https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
- SGLang: https://docs.sglang.io/basic_usage/openai_api_completions.html, https://docs.sglang.io/advanced_features/server_arguments.html, https://docs.sglang.io/advanced_features/tool_parser.html, https://docs.sglang.io/basic_usage/openai_api_embeddings.html
- TGI: https://huggingface.co/docs/text-generation-inference/en/index, https://huggingface.co/docs/text-generation-inference/en/basic_tutorials/using_guidance
- LocalAI: https://localai.io/docs/features/openai-functions/ (port/auth/readyz from the CLI reference mirror; unverified)

Embeddings
- OpenAI: https://developers.openai.com/api/docs/guides/embeddings, https://developers.openai.com/api/reference/resources/embeddings.md
- Cohere: https://docs.cohere.com/reference/embed, https://docs.cohere.com/docs/cohere-embed
- Gemini: https://ai.google.dev/gemini-api/docs/embeddings, https://ai.google.dev/api/embeddings, https://ai.google.dev/gemini-api/docs/openai
- Mistral: https://docs.mistral.ai/api/endpoint/embeddings, https://docs.mistral.ai/studio/knowledge-rag/embeddings/text_embeddings, https://docs.mistral.ai/studio/knowledge-rag/embeddings/code_embeddings
- Voyage: https://docs.voyageai.com/docs/embeddings, https://docs.voyageai.com/reference/embeddings-api, https://docs.voyageai.com/docs/faq
- Jina: https://jina.ai/embeddings/, https://api.jina.ai/openapi.json
- TEI: https://huggingface.co/docs/text-embeddings-inference/en/quick_tour, https://github.com/huggingface/text-embeddings-inference/blob/main/docs/source/en/cli_arguments.md, https://github.com/huggingface/text-embeddings-inference/blob/main/docs/openapi.json
- Models: https://huggingface.co/Qwen/Qwen3-Embedding-0.6B, https://huggingface.co/intfloat/multilingual-e5-large-instruct, https://huggingface.co/BAAI/bge-m3

pgvector
- https://github.com/pgvector/pgvector (README, CHANGELOG)
