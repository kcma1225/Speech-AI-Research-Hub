# ASR library and subscription OAuth (`backend/src/ai/asr`, `backend/src/ai/oauth`)

Libraries only: no routes, tables, or jobs. The AI platform (routes, `ai_provider_accounts`, role routing, ai-worker jobs) calls these. Vendor research: `docs/research/asr.md`, `docs/research/oauth-subscriptions.md`.

## ASR

### Calling it

```ts
import { transcribe, probeAsr, startLiveSession, cancelAsrJob, ASR_REGISTRY } from "../ai/asr/index.js";

const cfg: AsrProviderConfig = { kind: "assemblyai", model: "universal-3-5-pro", fields: { ...accountConfig, ...decryptedSecrets }, pollIntervalMs: 10_000 };
const t: Transcript = await transcribe(cfg, {
  audio: { path: "/tmp/meeting.m4a" },        // or { stream, mime, filename } (spooled to /tmp)
  language: "zh-TW", extraLanguages: ["en"], diarize: true, speakers: { expected: 4 },
  keyterms: glossary, prompt: "以下是繁體中文的實驗室會議逐字稿…", convertScript: "s2twp",
  signal, resume: job.progress?.asr, onCheckpoint: (cp) => saveJobProgress({ asr: cp }), onProgress,
});
```

- `cfg.fields` is the account form (config and secrets merged) plus the route-member params. `cfg.kind` is a registry id.
- Output `Transcript` contains:
  - `segments[{id,start,end,text,speaker?,confidence?,language?}]`
  - `speakers[{id:"S1",label:<vendor raw>}]`
  - optional `words[]`: store these in S3 as `words.json`, not in the row
  - `language`, `languages?`, `durationSec`, `warnings[]`
  - `vendorJobId?`
  - `source{kind,model,requestIds,chunks,scriptConversion}`
- Times are seconds (3 dp). Speaker labels are normalised to `S1…` in order of first appearance.
- Errors are always `AiError` (`../errors.js`). ASR-specific causes are on `asrReasonOf(e)`: `too_large | too_long | unsupported_format | job_failed | network`.
- Retries:
  - Each chunk is retried up to 3 times on `rate_limited`, `overloaded`, `unavailable` or `timeout`, honouring Retry-After.
  - On `too_large` / `too_long`, the orchestrator re-plans at half the chunk length.
  - Failing over to another route member is the caller's job (see `docs/research/asr.md` §5).
- **Resume.** `onCheckpoint` gets `{vendorJobs, done, plan}`. Persist it in the job row and pass it back as `resume` on retry.
  - Async vendors poll the saved job id instead of resubmitting.
  - Finished chunks are not redone.
  - A remote job that failed is dropped from the checkpoint, so the next attempt resubmits it.
- **Chunking.**
  - A file is chunked when it is over the adapter's `maxBytes` or `maxDurationSec` (also checked after transcoding).
  - Cut points come from ffmpeg `silencedetect` (-35 dB, 0.5 s): the longest silence in the last 3 min before the limit. With no silence it hard-cuts with a 2 s overlap and de-duplicates on merge.
  - Chunks run sequentially. Each prompt is `prompt + tail(previous text)`.
  - Without `speakers.references`, labels are namespaced per chunk (`c{n}:A`) and you get the warning `speaker_labels_per_chunk`. OpenAI `-diarize` with references keeps names consistent.
  - Unsupported input formats are transcoded to the smallest accepted format (mono 16 kHz).
  - Needs `ffmpeg`/`ffprobe` in the process image (ai-worker). Tests inject `MediaTools`.
- **Script.** `convertScript: none|s2tw|s2twp` uses `opencc-js` (MIT; Apache-2.0 dictionaries). The default comes from the registry entry: `s2twp` for vendors without a Traditional locale.
- **Health.** `probeAsr(cfg)` never throws and returns `{ok, latencyMs, detail_zh, error?}`. `cancelAsrJob(cfg, vendorJobId)` cleans up remote jobs on a best-effort basis.

### Vendors (`ASR_REGISTRY`, `publicAsrRegistry()` for the UI)

| kind | mode | notes / limits |
|---|---|---|
| `openai` | sync multipart | Models: `gpt-transcribe` (`languages[]`, `keywords[]`), `gpt-4o(-mini)-transcribe`, `gpt-4o-transcribe-diarize` (`diarized_json`, `known_speaker_*`, no prompt), `whisper-1` (`verbose_json` + word timestamps). 25 MB; ~1500 s; chunks of 20 min |
| `azure_openai` | sync | `{endpoint}/openai/deployments/{deployment}/audio/transcriptions`, `api-key` |
| `groq` | sync | Whisper `verbose_json`; 25 MB free tier / 100 MB dev tier |
| `speaches` | sync | `{base}/v1/audio/transcriptions`, `hotwords`; health `/health` |
| `whisperx` | sync | Our wrapper (below): diarization + words |
| `nim` | sync | NVIDIA HTTP `/v1/audio/transcriptions`: text only (no timestamps or speakers; that needs gRPC, not implemented). Health `/v1/health/ready` |
| `openai_compatible` | sync | Configurable path and capabilities. Falls back from `verbose_json` to `json` once |
| `whispercpp` | sync | `inference_path` (default `/inference`), WAV input, no auth |
| `deepgram` | sync raw body | `Token` auth, `language=zh-TW`, `diarize_model=latest`, `keyterm`, utterances. Native Traditional |
| `assemblyai` | async | upload → submit → poll; transcript deleted after fetch (`delete_after`). Times in ms |
| `google_stt` | sync / async | Service-account JWT. **Without `gcs_bucket`:** inline `Recognize` only (≤ 1 min / 10 MB), so long audio becomes many 55 s chunks. **With a bucket:** GCS upload → `BatchRecognize` op polled (op name and gs:// URI saved) → object deleted. `chirp_3`, `cmn-Hant-TW` (Preview) |
| `azure_speech` | sync | Fast transcription (`definition` JSON, `phraseList`, diarization). Batch (blob URLs) not implemented |
| `aws_transcribe` | async | **Needs `s3_bucket` (same region).** SigV4 PUT to `s3://bucket/<s3_prefix><job>.<ext>` → `StartTranscriptionJob` → poll → service-managed result URI → delete job + object. The object is kept if aborted so a resumed attempt still has it |
| `elevenlabs` | sync | Scribe v2; words → segments. Regional URLs are unverified; use `base_url` |

Taiwanese Hokkien (台語) is not reliably supported by any vendor. Every entry's `help_zh` says so.

### WhisperX wrapper contract (`deploy/whisperx/`)

- `GET /health` returns 200 `{status:"ok"}`, or 503 while loading.
- `GET /v1/models[/{id}]`.
- `POST /v1/audio/transcriptions` is OpenAI multipart plus these fields: `diarize`, `min_speakers`, `max_speakers`, `hotwords`.
  - The `verbose_json` response adds `speaker` on segments and words, and `score` on words.
  - For Chinese, each character is a "word".
- Optional Bearer `API_KEY`. Diarization needs `HF_TOKEN`.
- Not built by default:
  ```
  docker compose -f compose.yaml -f deploy/whisperx/compose.whisperx.yaml --profile whisperx up -d whisperx
  ```
  It needs a GPU (~10 GB).

### Live captions (`asr_live`)

```ts
const s = await startLiveSession(cfg, { sampleRate: 16000, language: "zh-TW", diarize, keyterms, convertScript, onEvent, signal });
s.sendAudio(pcm16Buffer); s.commit(); await s.close();
// events: partial{itemId,text} | final{itemId,text,start?,end?,speaker?} | speech{started|stopped} | error{error} | closed
```

- The backend opens the vendor WebSocket with the account key. The browser only talks to our own WS endpoint, so it never sees a vendor key.
- **OpenAI** (`wss://…/v1/realtime?intent=transcription`):
  - transcription session; audio is resampled to 24 kHz
  - server VAD, or manual commits for `*live-transcribe*` models
- **Deepgram** (`/v1/listen`, linear16): interim and final results; KeepAlive every 8 s; `CloseStream` on close.
- Other kinds return `unsupported` (`liveKinds()`).
- Live text is ephemeral. The stored transcript comes from batch `asr`.

## Subscription OAuth (EXPERIMENTAL, POC only)

Show the warning constants in the UI: `CHATGPT_WARNINGS_ZH`, `CLAUDE_OAUTH_WARNINGS_ZH`, `CLAUDE_CLI_WARNINGS_ZH` and `OAUTH_REAUTH_ZH`. They cover the ToS risk and the fact that Claude third-party usage has been billed as extra usage since 2026-04-04.

`OAuthTokens = {provider, accessToken, refreshToken?, idToken?, expiresAt?, obtainedAt, scope?, accountId?, email?, planType?}` (epoch ms).

Storing the tokens (AES-GCM with `PROVIDER_TOKEN_KEY`) is the caller's job. Errors are `AiError`. `isReauthRequired(e)` means the credential is dead: mark the account `needs_reauth`. Token-endpoint bodies never go into error messages.

### ChatGPT (Codex device code, private endpoint)

1. `startChatgptDeviceLogin()` returns `{deviceAuthId, userCode, verificationUrl, intervalSec, expiresAt}`.
   - A 404 means `unsupported`: the admin has to enable device-code login in ChatGPT security settings.
2. Call `pollChatgptDeviceLogin(login)` every `intervalSec`. It returns `pending | expired | complete{tokens}`.
   - Completion exchanges the code with `redirect_uri=https://auth.openai.com/deviceauth/callback`.
   - The account id comes from id_token `["https://api.openai.com/auth"].chatgpt_account_id`.
3. `refreshChatgptTokens` (rotating). Policy: refresh within 5 min of expiry, or when the token is older than 8 days.
4. `decorateCodexRequest({tokens, body, sessionId})` returns `{url, headers, body}` for `chatgpt.com/backend-api/codex/responses`.
   - Body: `store:false`, `stream:true`, `include += reasoning.encrypted_content`.
   - Strips `max_output_tokens` and the other rejected fields.
   - Headers: `ChatGPT-Account-ID`, `originator`, `session-id`.
5. Helpers:
   - `codexModelsUrl()` / `parseCodexModels()` (only `visibility=="list"`)
   - `parseCodexRateLimits(headers)`
   - `mapCodexError(status, body)`: `usage_limit_reached` maps to `quota_exhausted` with `retryAfterMs` taken from `resets_at`
   - `revokeChatgpt`

### Claude (copy-code PKCE)

1. `startClaudeLogin()` returns `{state, verifier, createdAt, authorizeUrl}`.
   - Keep `state` and `verifier` server-side, bound to the admin session, for at most 10 min.
   - The URL uses `code=true` and the redirect `https://platform.claude.com/oauth/code/callback`.
2. The admin pastes `code#state`, or the callback URL. Call `exchangeClaudeCode(pasted, pending)`. It validates `state` before calling the token endpoint.
3. `refreshClaudeTokens` (rotating; sends no `scope`).
4. `claudeSetupToken(token)` accepts a pasted `claude setup-token` value (`sk-ant-oat…`, ~1 year, no refresh).
5. `decorateClaudeRequest({accessToken, body, headers})`:
   - Bearer auth; removes `x-api-key`
   - `anthropic-beta: claude-code-20250219,oauth-2025-04-20` merged with the betas already present
   - `user-agent: claude-cli/<ver>`, `x-app: cli`
   - first system block is exactly `You are Claude Code, Anthropic's official CLI for Claude.`

### Refresh: single flight

`refreshIfNeeded(tokens, now, {key, http, force?, skewMs?, maxAgeMs?})` returns `{tokens, refreshed}`.

- In-process, concurrent calls with the same `key` share one HTTP refresh.
- Across processes, the caller wraps the whole read → refresh → write in a Postgres row lock:
  1. `SELECT … FOR UPDATE`
  2. Re-read the tokens under the lock.
  3. Call `refreshIfNeeded`.
  4. `UPDATE` in the same transaction.
- The refresh request takes no AbortSignal, so it is never cancelled midway. Rotating tokens break if a refresh is interrupted.
- After a 401 from the API, call it once with `force: true`.

### Claude Code CLI adapter

`runClaudeCli(chatRequest, {oauthToken, command?, maxBudgetUsd?, timeoutMs?})` is an `AsyncGenerator<ChatEvent>`.

- **Invocation:**
  ```
  claude -p --output-format stream-json --verbose --include-partial-messages --input-format stream-json --tools "" --no-session-persistence --strict-mcp-config --disable-slash-commands --permission-mode dontAsk --model <m> [--system-prompt] [--effort] [--json-schema]
  ```
- **Environment:**
  - The token goes in `CLAUDE_CODE_OAUTH_TOKEN` (env only, never argv).
  - HOME and the cwd are a scratch directory that is deleted after the run.
  - The API key is not inherited.
- **Input:** earlier turns are flattened into `<conversation_history>`. The last user turn is sent as content blocks, images included.
- **Output:** `parseClaudeStreamJson` / `createClaudeStreamParser` turn the CLI's output into ChatEvents:
  - partial `stream_event` lines become `text_delta` / `reasoning_delta`
  - `result` becomes `usage` + `done`
  - errors are classified with `classifyCliError`, and tokens are redacted
- **Limits:** text only. Requests with tools throw `unsupported`. Runs in ai-worker, which needs internet and the `claude` binary.
