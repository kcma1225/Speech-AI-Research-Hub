# Research: using ChatGPT and Claude subscriptions as LLM provider accounts

Status: research note for a spec. Written 2026-10-21. Nothing here is implemented.

Goal: an admin of the hub connects **their own** ChatGPT Plus/Pro and Claude Pro/Max subscription through an OAuth sign-in. The hub (backend on a remote server) then makes LLM calls with those credentials. The owner accepted the terms-of-service risk. This note still records what each vendor officially allows, because that decides which path is least likely to break.

Legend: **[src]** read in source code; **[doc]** read in official vendor docs; **[2nd]** secondary reporting only; **[unverified]** inferred or remembered, not confirmed.

## Sources examined

| Source | Revision | Notes |
|---|---|---|
| `github.com/openai/codex` (Rust CLI) | `cb00a67`, 2026-10-20 | `codex-rs/login/`, `codex-rs/codex-api/`, `codex-rs/core/src/client.rs`, `codex-rs/models-manager/models.json` |
| `github.com/sst/opencode` (now `anomalyco/opencode`) | `772e2ae`, 2026-10-20 | `packages/core/src/plugin/provider/openai.ts` (legacy Codex OAuth), `packages/core/src/plugin/provider/chatgpt.ts` (official token sharing) |
| `github.com/badlogic/pi-mono` (pi coding agent) | `9df819d`, 2026-10-20 | `packages/ai/src/auth/oauth/anthropic.ts`, `packages/ai/src/api/anthropic-messages.ts`, `packages/coding-agent/CHANGELOG.md` |
| `github.com/numman-ali/opencode-openai-codex-auth` | `bec2ad6`, 2026-01-09 (last commit) | Older third-party plugin for the ChatGPT Codex backend, useful for breakage history |
| `sst/opencode-anthropic-auth` | **gone** (404 on GitHub, also under `anomalyco/`) | Removed. opencode also removed its "Claude Pro/Max" UI copy in `54f235616` (2026-09-17) |
| OpenAI docs | fetched 2026-10-21 | `developers.openai.com/siwc/...` (Sign in with ChatGPT, open-source token sharing), `learn.chatgpt.com/docs/auth` (Codex auth) |
| Anthropic docs | fetched 2026-10-21 | `code.claude.com/docs/en/legal-and-compliance`, `code.claude.com/docs/en/authentication` |

---

## 1. ChatGPT (Plus/Pro)

There are now **two different OAuth paths**. Pick one deliberately.

- **Path A, "Codex CLI login" (legacy, unofficial for third parties).** Reuse the Codex CLI's public client id and call the private `chatgpt.com/backend-api/codex` endpoint. This is what Codex itself does and what opencode labels "Codex browser (legacy)" / "Codex device code (legacy)".
- **Path B, "Sign in with ChatGPT" token sharing (official).** OpenAI launched it around 2026-09-29. It uses dynamic client registration, issues tokens for `https://api.openai.com/v1`, and calls the **public** Responses API. opencode added it in `4d9090790` (2026-09-29) as its default "Sign in with ChatGPT" method. pi-mono added it too (`packages/ai/CHANGELOG.md`, "Added Sign in with ChatGPT to the `openai` provider").

### 1A. Path A: Codex CLI OAuth (legacy)

**Flow** [src: `codex-rs/login/src/server.rs`]
- Authorization code + PKCE (S256), plus `state`.
- Issuer `https://auth.openai.com`. Authorize URL `https://auth.openai.com/oauth/authorize`, token URL `https://auth.openai.com/oauth/token`, revoke URL `https://auth.openai.com/oauth/revoke` (`manager.rs:220-221`).
- Client id `app_EMoamEEZ73f0CkXaXp7hrann` (`codex-rs/login/src/auth/manager.rs:1741`; also hard-coded in opencode `openai.ts`).
- Scopes: Codex sends `openid profile email offline_access api.connectors.read api.connectors.invoke`. opencode sends only `openid profile email offline_access`, which is enough for inference.
- Extra authorize params: `id_token_add_organizations=true`, `codex_cli_simplified_flow=true`, `originator=<codex_cli_rs|opencode>`, and optionally `allowed_workspace_id`.
- Redirect URI: loopback only. Codex binds `127.0.0.1:1455` (fallback `1457`) and uses `http://127.0.0.1:<port>/auth/callback`. opencode uses `http://localhost:<port>/auth/callback`. Only these two ports appear to be registered: both clients refuse other ports and print "needs local port 1455 or 1457".
- Code exchange: form-encoded `grant_type=authorization_code, code, redirect_uri, client_id, code_verifier`. The response contains `id_token`, `access_token`, `refresh_token` (and `expires_in` per opencode).
- Optional extra step in Codex: a token exchange (`grant_type=urn:ietf:params:oauth:grant-type:token-exchange`, `requested_token=openai-api-key`, subject = id_token) mints an API-key-style token (`obtain_api_key`). This isn't needed for subscription usage and can fail for accounts without a Platform org.

**Device code flow (best fit for a remote server)** [src: `codex-rs/login/src/device_code_auth.rs`; doc: `learn.chatgpt.com/docs/auth`]
1. `POST https://auth.openai.com/api/accounts/deviceauth/usercode` with JSON `{"client_id": "..."}`. The response is `{device_auth_id, user_code, interval}`. `interval` is a string.
2. Show the admin `https://auth.openai.com/codex/device` and the `user_code`. The code expires in 15 min.
3. Poll `POST .../api/accounts/deviceauth/token` with `{device_auth_id, user_code}`. 403/404 means pending. 200 returns `{authorization_code, code_challenge, code_verifier}`.
4. Exchange at `/oauth/token` with `redirect_uri=https://auth.openai.com/deviceauth/callback` and the returned verifier.
- Caveat [doc]: the user must first "Enable device code login in your ChatGPT security settings". A 404 on step 1 means device login isn't enabled for this server/client.
- This works from a remote server without any loopback trick. The backend polls, and the admin only types a code into chatgpt.com.

**Remote-server alternative without device code.** The admin opens the authorize URL. After login the browser is redirected to `http://localhost:1455/auth/callback?code=...&state=...`, which fails to load on the admin's machine. The admin then pastes that full URL back into the hub, and the backend exchanges the code. **[unverified]** No source implements paste-back for ChatGPT, but it follows from the protocol: the code is in the URL, and the exchange only has to send the identical `redirect_uri`.

**Tokens, lifetime, refresh** [src: `manager.rs`, `token_data.rs`]
- Stored by Codex (`~/.codex/auth.json` or OS keyring): `id_token` (raw JWT plus parsed claims), `access_token` (JWT), `refresh_token`, `account_id`, `last_refresh`, and OAuth provenance (`issuer`, `client_id`).
- Account id: read from the id_token claim `["https://api.openai.com/auth"].chatgpt_account_id`. opencode falls back to the top-level `chatgpt_account_id` claim or `organizations[0].id`. The same claim namespace carries `chatgpt_plan_type` (`free|plus|pro|business|enterprise|edu`), `chatgpt_user_id`, and `chatgpt_account_is_fedramp`.
- Access token lifetime: read the JWT `exp`. opencode assumes `expires_in ?? 3600`. **[unverified]** The exact lifetime for this client isn't documented.
- Refresh policy in Codex: refresh when the access token expires within 5 min (`CHATGPT_ACCESS_TOKEN_REFRESH_WINDOW_MINUTES`), or when `last_refresh` is older than 8 days (`TOKEN_REFRESH_INTERVAL`). On a 401 from the API, Codex refreshes once and retries (the `UnauthorizedRecovery` state machine).
- Refresh request: `POST https://auth.openai.com/oauth/token` with `{client_id, grant_type: "refresh_token", refresh_token}`. Codex sends JSON; opencode sends form-encoded, and both work. The response may contain new `id_token`, `access_token`, `refresh_token`.
- **Refresh tokens rotate.** Permanent failure codes: `refresh_token_expired`, `refresh_token_reused`, `refresh_token_invalidated`, or 400 `invalid_grant`, or a 401. Treat these as "re-login required" and cache the failure. Anything else is transient. pi-mono fixed a bug where cancelling a request mid-refresh caused `refresh_token_invalidated` (`coding-agent/CHANGELOG.md:232`). A refresh therefore must not be aborted after it has been sent, and it must be serialized (see §3).

**API calls** [src: `model-provider-info/src/lib.rs:80`, `codex-api/src/endpoint/responses.rs`, `model-provider/src/bearer_auth_provider.rs`, `core/src/client.rs`, opencode `openai.ts`]
- Base URL `https://chatgpt.com/backend-api/codex`. Inference: `POST /responses` (OpenAI **Responses API** shape) with `Accept: text/event-stream`. Codex also supports a WebSocket transport (`OpenAI-Beta: responses_websockets=2026-02-06`), but HTTP SSE is enough.
- Models: `GET /models?client_version=<ver>` returns `{models:[{slug, display_name, visibility, supported_in_api, context_window, ...}]}`. Show the models with `visibility == "list"`.
- Headers:
  - `Authorization: Bearer <access_token>`
  - `ChatGPT-Account-ID: <account_id>`
  - `originator: codex_cli_rs` (Codex default) or your own string (opencode sends `opencode`)
  - `User-Agent`
  - `session-id` / `thread-id` / `x-client-request-id`. ChatGPT derives prompt-cache affinity from `session-id` (opencode comment).
  - `X-OpenAI-Fedramp: true` only for FedRAMP accounts.
  - opencode also sends `x-codex-beta-features: remote_compaction_v2`.
  - The old `OpenAI-Beta: responses=experimental` header from 2025 third-party plugins is **not** sent by current Codex over HTTP.
- Body (Codex `ResponsesApiRequest`): `model, stream: true, input[], tools[], tool_choice: "auto", parallel_tool_calls, reasoning {effort, summary}, store: false, include: ["reasoning.encrypted_content"], prompt_cache_key, text {verbosity, format}`.
  - **`store` must be false.** Because nothing is stored server-side, send the full history each turn and include encrypted reasoning items back.
  - Current Codex sends its base instructions as a prefix input item, not as `instructions`. Older third-party plugins had to send Codex's exact `instructions` text (fetched from Codex GitHub releases), which broke every time Codex changed its prompt. **[unverified]** Whether arbitrary `instructions` are accepted today.
  - Do **not** send `max_output_tokens`: opencode deletes it ("The ChatGPT backend rejects a requested output limit").
  - Bodies over ~1 MiB uncompressed are rejected. The backend accepts zstd (`Content-Encoding: zstd`) (opencode comment, `5673bfa4a` 2026-10-12).
- Tool calling: Responses-API function tools (`type: "function"`, plus `custom` tools). Results go back as `function_call_output` input items.
- Model names (bundled Codex catalog `models-manager/models.json` at `cb00a67`): `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5` (listed), plus hidden ones. The list changes often: opencode notes "ChatGPT accounts lost gpt-5.4 and gpt-5.4-mini in Codex on 2026-08-31". Always discover models via `/models`; never hard-code them.
- Rate limits [src: `codex-api/src/rate_limits.rs`, `api_bridge.rs`]:
  - Response headers `x-codex-primary-used-percent`, `x-codex-primary-window-minutes`, `x-codex-primary-reset-at`, the same set with `secondary`, `x-codex-credits-has-credits|unlimited|balance`, and `x-codex-rate-limit-reached-type`. The `codex` prefix can be another limit id named by an active-limit header.
  - HTTP 429 body `{"error": {"type": "usage_limit_reached", "plan_type", "resets_at" (unix s), "limit_window_minutes"}}`. Other `type`/`code` values: `usage_not_included`, `insufficient_quota`.
  - Stream-level failure arrives as an SSE `response.failed` event with `response.error.code`, e.g. `context_length_exceeded`.

### 1B. Path B: Sign in with ChatGPT, open-source token sharing (official)

[doc: `developers.openai.com/siwc/token-sharing-open-source/{sign-in,token-reference,models-and-inference,errors-and-recovery,preview-limitations,self-hosted-vms}`; src: opencode `chatgpt.ts`]

**Flow**
- Authorize URL `https://auth.openai.com/api/accounts/authorize`, token URL `https://auth.openai.com/api/accounts/oauth/token`. PKCE S256, plus fresh `state` and `nonce`.
- First sign-in uses `client_id=dynamic_agent_client` with `agent_name_hint=<app name>`. The callback returns the **issued** client id (`oaiapp_...`) as a `client_id` query param. Persist it and use it for the exchange, for refreshes, and for every later sign-in. There is no client secret.
- `ext_agent_host_id`: required. Use a stable random `urn:uuid:` per host.
- Scope: `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`. Also send `resource=https://api.openai.com/v1` on authorize, exchange, and refresh.
- After the exchange, check that the granted `scope` contains `chatgpt.tokens.use.direct`. The user can decline token sharing. Verify the id_token against `https://auth.openai.com/.well-known/jwks.json` (iss, aud = issued client id, exp, nonce, sub).
- Redirect URI: **HTTP loopback on `127.0.0.1` only, any port** ("Only the port may vary… Do not substitute `localhost`").
- No device code flow is documented for Path B.
- Docs say the flow is for "open-source and locally hosted apps". **A "paid or remotely hosted app" must complete the interest form** (openai.com/form/sign-in-with-chatgpt-interest/). A hub web app on a remote server fits "remotely hosted", so officially Path B is not self-serve for this hub.
- The "Self-hosted VMs" page tells you to complete OAuth locally with the same tool, then move the credential file to the VM over SSH. Paste-back of the loopback redirect URL into a remote web app would work at the protocol level **[unverified]**, but it isn't a documented pattern.

**Tokens** [doc]
- Access token: 1 h (`expires_in: 3600`), `aud=https://api.openai.com/v1`. Refresh token: 30 days and rotating; each refresh returns a new 30-day token.
- The token response also includes `earliest_refresh_at`.
- Replace access token, expiry, scopes, and refresh token together.
- Refresh errors (`invalid_grant`, `invalid_refresh_token`, `token_expired`, `refresh_token_expired|invalidated|reused`) mean the tokens must be cleared and OAuth re-run with the saved client id.

**API calls** [doc + src]
- Public API: `POST https://api.openai.com/v1/responses` and `GET https://api.openai.com/v1/models`, with `Authorization: Bearer <access_token>`. No `chatgpt-account-id` header is needed. Docs: "do not point it at ChatGPT's backend-api endpoints".
- Request rules: `store: false` and `stream: true` are required. Use `instructions` or developer messages; `role: "system"` items are rejected. `previous_response_id` doesn't work over HTTP, so send the full history.
- These request fields are rejected: `background, conversation, max_output_tokens, max_tool_calls, metadata, moderation, prompt, prompt_cache_retention, safety_identifier, temperature, top_p, top_logprobs, truncation, user`.
- Tools: function/custom tools must be grouped in namespaces or sent as `additional_tools` input items. Web search works. Image generation, file search, code interpreter, computer use, hosted MCP, and `tool_search` don't. Audio input and the Files/transcription APIs are unsupported (so Whisper-style transcription through this path isn't possible).
- opencode also sends `session-id`/`thread-id`/`x-client-request-id`, zstd bodies, and disables mid-session effort changes (`903ec2bb3`, 2026-10-09).
- opencode had to stop trusting `/models` for this path "due to openai bugs" (`209346a0f`, 2026-10-05) and falls back to a hard-coded allowlist.
- Errors (JSON `error.code`, also inside `response.failed`):
  - `subscription_sharing_user_not_eligible` (403): don't retry
  - `subscription_sharing_usage_limit_exceeded` (429): pause and link to ChatGPT Settings → Usage; don't guess the reset time
  - `subscription_sharing_usage_unavailable` (503): back off
  - `subscription_sharing_unsupported_capability` (400): check `error.param`
  - `subscription_sharing_route_not_supported` (403)
  - `subscription_sharing_invalid_user` (401)
  - `subscription_sharing_user_unavailable` (503)
  - `chatpass_v2_scope_not_authorized` and `chatpass_v2_invalid_authorization_context` (403)
  - Admission errors can also be a bare 401/403/503 with `{"detail": "..."}`.
  - No rate-limit headers are documented.
- Users can set a per-app weekly usage limit in ChatGPT settings [2nd: help.openai.com/articles/20001542 returned 403 to the fetcher; content known only from search snippets].
- Error code names changed within a day of launch (`0f8303825`, 2026-09-29, dropped the `_v2_` infix), so match error codes loosely.

### 1C. Fragility (ChatGPT)
- Path A depends on a private endpoint and on Codex's client id and registered ports. Codex changes request details frequently (instructions handling, `include`, compaction, WebSocket beta, zstd), and the model set shifts monthly.
- opencode renamed its Path A methods to "(legacy)" on 2026-10-05 (`d318cf412`, `48b295aef`). Expect OpenAI to steer third parties to Path B.
- Detection in other projects:
  - classify refresh errors as permanent vs transient (Codex)
  - map 429 `usage_limit_reached` to a user-facing "limit reached, resets at" message
  - mark non-retryable error codes (opencode `nonRetryableSharingCodes`)
  - surface `response.failed` codes
  - re-fetch `/models` and hide models that disappear

---

## 2. Claude (Pro/Max)

### 2.1 Policy reality (read first)
- [doc: `code.claude.com/docs/en/legal-and-compliance`, "Authentication and credential use"] "OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications… Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials… developers may not collect, store, or intermediate Claude.ai credentials or session tokens… Anthropic reserves the right to take measures to enforce these restrictions… without prior notice."
- The same page explicitly **allows** "an end user signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code".
- Enforcement history:
  - [src: pi-mono changelog] Anthropic OAuth was removed from pi at 0.40.x and came back in 0.41.0 (both 2026-01-09).
  - [2nd] Server-side blocking of non-Claude-Code OAuth use started 2026-01-09. A ToS revision in Feb 2026 reserved OAuth for Claude Code/Claude.ai. Anthropic reportedly sent opencode a legal demand in March 2026; the `opencode-anthropic-auth` repo is now gone, and opencode stripped the "Claude Pro/Max" copy on 2026-09-17.
  - From **2026-04-04**, third-party harness usage on a subscription is billed as **"extra usage"** (pay-as-you-go per token), not against plan limits [2nd, confirmed by pi's in-app warning, `coding-agent/src/modes/interactive/interactive-mode.ts:322`: "Third-party harness usage draws from extra usage and is billed per token, not your Claude plan limits. Manage extra usage at https://claude.ai/settings/usage", added in pi 0.66.0, 2026-04-08].
- **Practical consequence for the spec:** a hub that calls the Messages API directly with a Claude Pro/Max OAuth token will most likely be billed as extra usage rather than consume the subscription. It also violates the credential-use terms and can be cut off without notice. The owner accepted the ToS risk, but should know the cost benefit may be gone. **[unverified]** Exactly how Anthropic classifies a request as "third-party harness" (headers, system prompt, tool names, client fingerprint) isn't public.

### 2.2 Option C1: direct OAuth (what pi-mono does today)

**Flow** [src: `pi-mono/packages/ai/src/auth/oauth/anthropic.ts`]
- Authorization code + PKCE (S256). pi uses the PKCE verifier as `state`, and the token endpoint also wants `state`.
- Authorize URL `https://claude.ai/oauth/authorize`, token URL `https://platform.claude.com/v1/oauth/token` (JSON body). **[unverified]** Older tools used `https://console.anthropic.com/v1/oauth/token`, and the domain moved with the Console → platform.claude.com rename.
- Client id: Claude Code's public client `9d1c250a-e61b-44d9-88ed-5944d1962f5e` (base64-obfuscated in pi).
- Scopes: `org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload`. `user:inference` is the one needed for model calls.
- Extra authorize param: `code=true`.
- Redirect URIs:
  - Loopback: `http://localhost:<any port>/callback`. pi prefers 53692 and says "Anthropic accepts any loopback port".
  - **Copy-code**: `https://platform.claude.com/oauth/code/callback`. Anthropic's page then shows a code formatted `code#state`, which the user pastes back. **This is the natural fit for a remote web app**: the admin signs in on claude.ai, copies the displayed code, and pastes it into the hub. pi also accepts the full redirect URL pasted from the address bar.
- Exchange body: `{grant_type: "authorization_code", client_id, code, state, redirect_uri, code_verifier}`. The response is `{access_token, refresh_token, expires_in, scope?}`.
- No device code flow exists for this client **[unverified: none found in any source]**.

**Tokens**
- Access tokens look like `sk-ant-oat...`; pi detects OAuth by that substring. Refresh tokens look like `sk-ant-ort...` **[unverified]**.
- Refresh: `{grant_type: "refresh_token", client_id, refresh_token}` to the same token URL. **Omit `scope`**, otherwise it fails (pi fix #2169). The response returns a new refresh token, so treat it as rotating.
- pi stores `{refresh, access, expires}` with `expires = now + expires_in - 5 min`. The access token lifetime is whatever `expires_in` says **[unverified: observed values not documented in source]**.
- Long-lived alternative [doc]: `claude setup-token` runs the same browser flow and prints a **one-year** OAuth token meant for `CLAUDE_CODE_OAUTH_TOKEN`. "It can only make model requests." There's no refresh to manage. The admin would have to run Claude Code once somewhere to mint it.

**API calls** [src: `pi-mono/packages/ai/src/api/anthropic-messages.ts`]
- Base URL `https://api.anthropic.com`, `POST /v1/messages` (**Messages API**), `stream: true` (SSE).
- Headers:
  - `Authorization: Bearer <sk-ant-oat…>` (not `x-api-key`)
  - `anthropic-version: 2023-06-01` (SDK default)
  - `anthropic-beta: claude-code-20250219,oauth-2025-04-20` plus any feature betas (interleaved thinking, fine-grained tool streaming, ...)
  - `user-agent: claude-cli/<version>` (pi pins `2.1.280` and had to bump it once because a stale version was flagged: "Fixed inherited Anthropic OAuth requests reporting an outdated Claude Code version")
  - `x-app: cli`
  - `anthropic-dangerous-direct-browser-access: true` (SDK artifact)
- **Required system prompt prefix**: the first system block must be exactly `You are Claude Code, Anthropic's official CLI for Claude.`. Your real system prompt goes in a second block. pi comments "For OAuth tokens, we MUST include Claude Code identity".
- Tool names: pi's "stealth mode" re-cases tool names to Claude Code's canonical names (`Read, Write, Edit, Bash, Grep, Glob, WebFetch, WebSearch, TodoWrite, Task, ...`) and maps them back on output. This suggests Anthropic checks tool names **[unverified]**. Tool calling otherwise follows the standard Messages API (`tools[]`, `tool_use` / `tool_result` blocks).
- Models: standard Anthropic model ids (pi's catalog includes `claude-opus-4-7`). **[unverified]** Whether `GET /v1/models` accepts OAuth bearer tokens; prefer a configured list.
- Errors and limits: standard Anthropic error JSON `{"type":"error","error":{"type":"rate_limit_error"|"overloaded_error"|"authentication_error"|"permission_error",...}}` with HTTP 429/529/401/403. **[unverified]** The exact error body when a non-Claude-Code client is rejected, or when extra usage is exhausted. Reports from early 2026 quote a message like "This credential is only authorized for use with Claude Code and cannot be used for other API requests", but this note could not confirm it from source.

### 2.3 Option C2: run the unmodified Claude Code CLI (the officially tolerated way)
- The docs explicitly allow a platform to host the unmodified Claude Code binary for an end user who signs in with their own subscription.
- In this hub the admin is that end user. The backend (or a dedicated container) would run `claude -p --output-format stream-json ...` with `CLAUDE_CODE_OAUTH_TOKEN=<setup-token>` or a `CLAUDE_CONFIG_DIR` holding `.credentials.json`.
- Login on a server: `claude` / `claude setup-token` print a URL. When the browser can't reach the local callback, the page shows a code to paste at "Paste code here if prompted" [doc]. The hub could proxy that paste step, or the admin runs `setup-token` locally and pastes the one-year token into the hub.
- Trade-offs:
  - It needs Node and the `claude` binary in an image with internet egress. The current `worker` has no internet, so this would need a new service or network.
  - The output is agent-shaped (stream-json events) rather than raw Messages API.
  - Tool calling goes through Claude Code's own tools/MCP, not arbitrary JSON tools. **[unverified]** Whether `-p` usage counts against plan limits or extra usage; the docs say plan limits "assume ordinary, individual usage of Claude Code and the Agent SDK".

### 2.4 Fragility (Claude)
- High fragility. The client id, the identity system prompt, the `oauth-2025-04-20` beta, the user-agent version, and tool-name casing are all fingerprints Anthropic can change or check. Breakage happened at least on 2026-01-09 (block, then a workaround the same day) and with the stale-version fix (in the pi release after 0.87.0 of 2026-09-21). The billing switch came on 2026-04-04.
- Detection in other projects:
  - pi refreshes before each call and warns about extra usage
  - pi treats `sk-ant-oat` as the OAuth discriminator
  - pi tracks Claude Code's prompts and tool names through the `badlogic/cchistory` project
  - none of the sources examined has a dedicated "you were blocked" classifier, so surface 401/403 bodies verbatim to the admin

---

## 3. Server-side storage and security (both providers)

Design notes for the hub, based on the above and on the existing architecture (`docs/architecture.md`):

1. **Encrypt at rest.** Store refresh token, access token, id_token, and the issued client id in a `provider_accounts` table as AES-256-GCM ciphertext. Use a dedicated key (e.g. `PROVIDER_TOKEN_KEY`, 32 random bytes in `.env` via `scripts/gen-env.sh`), not `AUTH_SECRET`, so rotating session signing doesn't destroy credentials. Use a random 96-bit nonce per write. Use AAD = `provider || account_row_id`, so ciphertext can't be swapped between rows. Store a `key_version` column for rotation. Keep non-secret metadata in plaintext: provider, email, plan type, account id, expiry, granted scopes, status, last error.
2. **Rotating refresh tokens need single-flight refresh.** Take `SELECT … FOR UPDATE` (or `pg_advisory_xact_lock(hash(account_id))`) around refresh. Re-read after acquiring the lock in case another request already refreshed. Persist the new refresh token in the same transaction. Never abort an in-flight refresh request (pi's `refresh_token_invalidated` bug). If you persist after the HTTP call, keep both tokens until the write commits.
3. **Classify failures.**
   - Permanent (`refresh_token_*`, `invalid_grant`, 401 on refresh, `*_invalid_user`): mark the account `needs_reauth` and stop using it.
   - Usage-limit 429: mark it `limited_until` from `resets_at` when it's given (Path A). Path B docs say don't guess the reset time.
   - Transient 5xx: keep the tokens and back off.
4. **Never log tokens.** Redact `Authorization`, `ChatGPT-Account-ID`, request and response bodies of token endpoints, and pasted callback URLs (they contain the code). Codex itself logs only the status of token calls because "the IdP… may echo credential material" (`manager.rs`).
5. **PKCE/state for paste-back flows.** Keep the verifier, state, and nonce server-side, bound to the admin's session, with a 10-minute TTL. Never put them in the URL you show the admin. Validate `state` on paste. Verify the OpenAI id_token signature (Path B) before trusting `sub`/email.
6. **Scope access.** Only Owner/admin can create, view, or delete provider accounts. Other members only get "use this account" through server-side jobs. Never return tokens to the frontend. Offer "disconnect", which deletes the ciphertext and calls the revoke endpoint where one exists (`https://auth.openai.com/oauth/revoke` for Path A). **[unverified]** No Anthropic revoke endpoint was found.
7. **Network placement.** LLM calls need internet egress. Run them in the backend, or in a new egress-enabled service, not in the internet-less `worker` or as the `hub_worker` DB role (which can only touch `jobs`). Decrypt tokens only in that process.
8. **Backups.** `scripts/backup.sh` dumps Postgres. Ciphertext in the dump is safe only if `PROVIDER_TOKEN_KEY` is not stored with the dump.

---

## 4. Recommendation sketch for the spec

| | ChatGPT | Claude |
|---|---|---|
| Lowest-friction remote-server login | Path A device code (admin enables device login in ChatGPT security settings, then enters a code), or paste-back of the `localhost:1455` redirect URL | C1 copy-code flow (`platform.claude.com/oauth/code/callback`, paste `code#state`), or paste a one-year `claude setup-token` token |
| API shape | Responses API (SSE), `store:false` | Messages API (SSE) with Claude Code identity prefix and headers |
| Officially sanctioned? | Path B (public API) is, but remotely hosted apps need OpenAI's interest form; Path A isn't | Only the unmodified Claude Code binary (C2); C1 is prohibited and billed as extra usage since 2026-04-04 |
| Expected stability | Path B medium (new, codes still shifting); Path A low-medium | C1 low; C2 medium |

Build a provider-adapter interface with per-provider "login method" plugins (device code, paste-back, paste token). Each provider will likely need patching within months, as every project examined here did.
