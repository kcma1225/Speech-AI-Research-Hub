# ASR vendor research (for v3 spec, `asr` / `asr_live` roles)

Researched 2026-10-21 from official docs (links in §9). Items marked **(unverified)** came from memory or forum reports and were not on the fetched official page. Check them before relying on them.

Workload: lab meetings (Taiwanese Mandarin with English code-switching, 30–120 min, sometimes the audio track of an online-meeting video) plus short voice notes (< 2 min). Output must be Traditional Chinese.

Context in this repo: the existing `media_transcode` produces mono 24 kHz AAC 48 kbps `.m4a`, about 21.6 MB/h. The current worker has no internet access. The v3 spec puts ASR calls in the backend and ai-worker (`src/ai/`), so whatever process runs batch ASR needs egress to cloud vendors, or LAN access to self-hosted servers.

---

## 1. Summary matrix

| Vendor / model | Mode | Max input | Diarization | Word ts | zh-TW output | Code-switch zh+en | Live/stream | Bias terms | Rough price |
|---|---|---|---|---|---|---|---|---|---|
| OpenAI `gpt-transcribe` | sync | 25 MB | no | no | via `languages` + prompt | yes | `gpt-live-transcribe` (Realtime) | `prompt`, `keywords`, `languages` | $0.0045/min |
| OpenAI `gpt-4o-transcribe` / `-mini-` | sync (+SSE) | 25 MB; ~1500 s cap **(forum)** | no | no | prompt only | yes | Realtime | `prompt` | $0.006 / ≈$0.003 **(unverified)** /min |
| OpenAI `gpt-4o-transcribe-diarize` | sync (+SSE) | 25 MB | **yes** (`diarized_json`, ≤4 known speakers) | segment only | no prompt support | yes | no | none | ≈$0.006/min **(unverified)** |
| OpenAI `whisper-1` | sync | 25 MB | no | **word + segment** | prompt (224 tok) | ok | no | `prompt` | $0.006/min |
| Deepgram Nova-3 | sync or callback | URL or binary body; 2 GB **(unverified)** | yes, included pre-recorded | yes, with speaker | `language=zh-TW` / `zh-Hant` | **no** (`multi` excludes zh) | WS `/v1/listen` | `keyterm` (Nova-3) | $0.0043/min (+$0.0013 keyterm) |
| AssemblyAI Universal-3.5 Pro | async: upload + poll/webhook | upload 2.2 GB; URL 5 GB / 10 h | yes (`speaker_labels`) | yes, ms | `zh` (script not documented, plan OpenCC) | yes, native code-switching | WS v3, `universal-3-6-pro` (32 langs incl. zh) | `keyterms_prompt` (≤1000), `prompt` (≤1500 words) | $0.21/h (+$0.02 diar, +$0.05 keyterms) |
| Google STT v2 `chirp_3` | sync ≤1 min/10 MB; BatchRecognize (GCS only) | 8 h/file (batch); word ts limits batch to 20 min | yes (BatchRecognize; docs inconsistent) | optional, "degradation" | `cmn-Hant-TW` (**Preview**) | multiple `languageCodes` or `auto` | gRPC stream, 5 min/stream | adaptation phrases (≤1000), prompt (Preview) | $0.016/min std, $0.003 dynamic batch **(dated page)** |
| Azure Speech fast transcription | sync | < 500 MB, < 5 h (another page: 300 MB / 2 h) | yes (`maxSpeakers` 2–35, mono) | yes | `zh-TW` supported | multilingual mode lacks zh-TW (zh-CN only) | Speech SDK (JS) | `phraseList` | see pricing **(not fetched)** |
| Azure batch transcription | async (blob URLs + poll/webhook) | diarization caps at 240 min/file | yes | yes | `zh-TW` | LID: one main locale per file | — | custom speech | — |
| AWS Transcribe | async (S3 + poll) | 2 GB; 4 h vs 8 h (sources disagree) | yes (`ShowSpeakerLabels`, ≤30) | yes | `zh-TW` batch + stream | multi-language ID exists (zh-TW not checked) | HTTP/2 or WS (SigV4 presigned) | custom vocabulary | $0.006/min batch, $0.01/min stream |
| ElevenLabs Scribe v2 | sync (or webhook 202) | 3 GB upload; 10 h | yes (≤32 speakers) | word / character | `language_code=zho` (cmn is in the "High Accuracy" tier, 5–10 % WER) | auto-detect | `scribe_v2_realtime` WS | `keyterms` (≤1000, +20 %) | $0.22/h; realtime $0.39/h |
| Groq Whisper large-v3 / -turbo | sync, OpenAI-compatible | 25 MB free tier, 100 MB dev tier (via `url`) | no | word + segment | prompt | ok | no | `prompt` 224 tok | $0.111/h, turbo $0.04/h; 10 s minimum billing |
| speaches (faster-whisper) | sync (+SSE) OpenAI-compatible | server config | no | word + segment | prompt, `hotwords` | ok | `/v1/realtime` | `prompt`, `hotwords` | GPU cost |
| whisper.cpp server | sync | server config | tinydiarize (`-tdrz`, English) / stereo only | via `verbose_json` (+DTW) | prompt | ok | no | `prompt` | CPU/GPU |
| WhisperX | library/CLI (no server) | — | **yes** (pyannote `speaker-diarization-community-1`) | **yes** (wav2vec2 alignment; per character for zh) | prompt | ok | no | prompt | GPU |
| NVIDIA ASR NIM `parakeet-ctc-0.6b-zh-tw` | HTTP sync (text only) / gRPC / WS | — | yes, Sortformer profile (gRPC/stream) | via gRPC | **Taiwanese Mandarin + English model** | **yes** (trained for it) | gRPC / Realtime WS | word boosting (gRPC) | GPU 5.8–12 GB (offline) |

Fit for this lab (Mandarin + English, Traditional output, long files, speakers):
1. **AssemblyAI U-3.5 Pro** gives long files, diarization, code-switching and keyterms in one call. Output needs OpenCC conversion.
2. **ElevenLabs Scribe v2** has 10 h files, diarization and keyterms.
3. **Deepgram Nova-3 zh-TW** is cheap and fast and returns native Traditional script, but has weaker English inside Mandarin speech.
4. **OpenAI**: the `gpt-transcribe` text quality is the cheapest at $0.0045/min, but it gives no timestamps or speakers. `-diarize` gives speakers but needs chunking.

Self-hosted options: **NIM Parakeet zh-TW** (purpose-built, but needs gRPC to get timestamps and speakers) and **WhisperX** (needs a thin HTTP wrapper).

---

## 2. Per-vendor details

### 2.1 OpenAI (`https://api.openai.com/v1`)

- **Auth**: `Authorization: Bearer <key>`, plus optional `OpenAI-Organization` and `OpenAI-Project` headers.
- **Endpoint**: `POST /audio/transcriptions`, multipart. Synchronous. No async job or webhook.
- **Limits and formats**: 25 MB. mp3, mp4, mpeg, mpga, m4a, wav, webm (the guide's list).
  - Forum reports say gpt-4o-* reject audio over **1500 s** ("…longer than 1500 seconds which is the maximum for this model"). The official model page lists 16k context and 2k output tokens. Treat ~20 min as the safe chunk size for gpt-4o-*.
- **Models**:
  - `gpt-transcribe` is the current recommended model. Response is JSON `text` + `languages[]`. It supports `prompt`, `keywords`, and `languages` (array; replaces `language`, so don't send both).
  - `gpt-4o-transcribe` and `gpt-4o-mini-transcribe` are legacy-but-supported. They take `prompt` and `include[]=logprobs`.
  - `gpt-4o-transcribe-diarize`: `response_format=diarized_json`. Requires `chunking_strategy` (`"auto"` or a VAD object) for audio over 30 s.
    - `known_speaker_names[]` and `known_speaker_references[]` take up to 4 speakers, as 2–10 s clips encoded as data URLs.
    - **No prompt support.**
  - `whisper-1`: `response_format` is `json|text|srt|vtt|verbose_json`. `timestamp_granularities[]=word,segment` works with `verbose_json` only, and only on whisper-1. Prompt is ≤ 224 tokens.
- **Response shapes**:
  - `verbose_json`: `{duration, language, text, segments[{id,seek,start,end,text,tokens,temperature,avg_logprob,compression_ratio,no_speech_prob}], words[{word,start,end}], usage}`
  - `diarized_json`: `{task, duration, text, segments[{id,start,end,speaker,text,type:"transcript.text.segment"}], usage}`
  - `usage` is either the tokens variant or the duration variant.
- **Streaming**: `stream=true` on gpt-* models returns SSE events `transcript.text.delta`, then `transcript.text.done`. The diarize model also emits `transcript.text.segment`, and its deltas carry no speaker. Not available on whisper-1.
- **Live**: Realtime transcription session (`session.update`, `type:"transcription"`) over WebSocket, or WebRTC from the browser. The endpoint `wss://api.openai.com/v1/realtime?intent=transcription` and the ephemeral client secrets come from the linked guides **(unverified)**.
  - Model: `gpt-live-transcribe` with `turn_detection:null`. The client commits turns with `input_audio_buffer.commit`. `delay` is `minimal…xhigh`.
  - Input: pcm 24 kHz. Events: `conversation.item.input_audio_transcription.delta/.completed`, matched by `item_id`.
  - Returns no word timestamps, speakers or confidence. $0.017/min.
- **Errors**: `{"error":{"message","type","param","code"}}`. 400 = invalid file or too long. 401 = key. 413 = too large. 429 = `rate_limit_exceeded` or `insufficient_quota` (only the first is retryable). 5xx.
- **Health**: `GET /v1/models/{model}` costs nothing and checks the key, model access and network.
- **Mandarin notes**:
  - Whisper-family `language` only knows `zh` and often outputs Simplified. A Traditional-Chinese prompt (e.g. `以下是繁體中文的會議逐字稿，包含 English 術語。`) biases the script, but you should still run OpenCC `s2twp` afterwards.
  - Whisper hallucinates on long silences, so trim them with VAD.
  - For `gpt-transcribe`, send `languages=["zh","en"]` **(the exact code format is unverified)**.

### 2.2 Deepgram (`https://api.deepgram.com/v1`)

- **Auth**: `Authorization: Token <key>` (or `Bearer <JWT>`).
- **Endpoint**: `POST /listen?model=nova-3&language=zh-TW&smart_format=true&diarize_model=latest&utterances=true&paragraphs=true`.
  - Body is either JSON `{url}` or the raw audio bytes with `Content-Type: audio/*`.
  - Synchronous by default. With `callback=<url>` it returns `{request_id}` only and POSTs the result later.
- **Diarization**: `diarize_model` (`latest|v1|v2`). The old `diarize` parameter is deprecated. Included in the pre-recorded price.
- **Bias terms**: `keyterm=` can repeat (Nova-3 only, no weights). The legacy `keywords` doesn't work on Nova-3.
- **Languages**: Nova-3 lists `zh`/`zh-CN`/`zh-Hans` (Simplified) and `zh-TW`/`zh-Hant` (Traditional). `multi` code-switching **excludes Chinese**. Flux (the voice-agent streaming model) has no Chinese.
- **Response**: `results.channels[].alternatives[]{transcript, confidence, words[{word,start,end,confidence,speaker,speaker_confidence,punctuated_word}], paragraphs}`, plus `results.utterances[{id,start,end,transcript,speaker,words}]`. Times are in seconds.
- **Limits**: the fetched pages don't state file size. 2 GB **(unverified)**. Concurrency (Pay-as-you-go) is 50 pre-recorded and 150 streaming. Diarization is capped at 50 concurrent.
- **Live**: `wss://api.deepgram.com/v1/listen?encoding=…&sample_rate=…&interim_results=true`. Messages are `type:"Results"` with `is_final` and `speech_final`. Also `KeepAlive` and `CloseStream`. Browser auth uses short-lived tokens (`/v1/auth/grant`) **(unverified)**. Streaming costs $0.0048/min, +$0.002 for diarization.
- **Errors**: `{err_code, err_msg, request_id}`:
  - `INVALID_AUTH` 401, `INSUFFICIENT_PERMISSIONS` 403, `ASR_PAYMENT_REQUIRED` 402
  - `PAYLOAD_TOO_LARGE` 413, `UNSUPPORTED_MEDIA_TYPE` 415, `ASR_UNPROCESSABLE_ENTITY` 422, `TOO_MANY_REQUESTS` 429
- **Health**: `GET /v1/projects` **(unverified)** checks the key at no cost.

### 2.3 AssemblyAI (`https://api.assemblyai.com`, EU `https://api.eu.assemblyai.com`)

- **Auth**: `authorization: <key>` with no `Bearer` prefix.
- **Flow** (async):
  1. `POST /v2/upload`, raw `application/octet-stream`, returns `{upload_url}` (≤ 2.2 GB).
  2. `POST /v2/transcript {audio_url, …}` returns `{id, status:"queued"}`.
  3. Poll `GET /v2/transcript/{id}` until `completed|error`, or pass `webhook_url`.
  - A URL source allows 5 GB / 10 h.
- **Parameters**:
  - `speech_models: ["universal-3-5-pro","universal-2"]` is an ordered fallback list, and that pair is the default.
  - `language_code` or `language_detection` (setting both is an error).
  - `speaker_labels`, `speakers_expected` or `speaker_options{min_speakers_expected,max_speakers_expected}`.
  - `keyterms_prompt[]`: ≤ 1000 for U-3.5 Pro, ≤ 200 for U-2, ≤ 6 words each.
  - `prompt`: ≤ 1500 words, U-3.5 Pro only.
  - `multichannel`, `audio_start_from` / `audio_end_at` (ms).
- **Response**: `{id,status,text,words[{text,start,end,confidence,speaker}],utterances[{speaker,start,end,text,confidence,words}]}`. **Times are in ms.**
- **Languages**: U-3.5 Pro lists Mandarin `zh` and markets native code-switching. Traditional-script output isn't documented, so normalise with OpenCC.
- **Live**: Universal-3.6 Pro Realtime (`speech_model=universal-3-6-pro`) covers 32 languages including `zh`, with code-switching and `language_codes` hints. `Turn` messages carry `end_of_turn`, `transcript` and `language_code`.
  - Endpoint `wss://streaming.assemblyai.com/v3/ws`, temporary token `GET /v3/token` **(unverified)**.
  - $0.45/h, +$0.12/h diarization. Billed on session wall time, so close sockets promptly.
- **Errors**: `{"error": "<msg>", "status": "error"}`. 422 on upload returns plain text. 429 includes `Retry-After`. A failed job is HTTP 200 with `status:"error"` and an `error` string, so check the body.
- **Health**: `GET /v2/transcript?limit=1` **(unverified)**.

### 2.4 Google Cloud Speech-to-Text v2 (`https://{location}-speech.googleapis.com/v2`)

- **Auth**: service account. Get an OAuth2 access token via JWT (scope `cloud-platform`), or ADC. Batch also needs GCS access; the agent is `service-<n>@gcp-sa-speech…`.
- **Model**: `chirp_3`, in multi-regions `us` and `eu` only (GA). Recognizer path `projects/{p}/locations/{loc}/recognizers/_` (inline config).
- **Methods**:
  - `Recognize`: ≤ 1 min / 10 MB, inline content or GCS URI.
  - `BatchRecognize`: **GCS URIs only**, ≤ 8 h/file. The Chirp 3 page says ~1 min–1 h, and only 20 min when word timestamps are on.
    - Returns a long-running operation to poll.
    - Output inline or to GCS.
    - `processing_strategy: DYNAMIC_BATCHING` is cheaper, with up to 24 h latency.
  - `StreamingRecognize`: gRPC, 25 KB per message, 5 min per stream.
- **Features**: `languageCodes` (a list or `["auto"]`), `features.enableWordTimeOffsets`, `features.diarizationConfig{minSpeakerCount,maxSpeakerCount}`, adaptation phrase sets (≤ 1000 phrases), denoiser, custom prompt (Preview).
  - The docs conflict on whether diarization and word timestamps work in Recognize vs BatchRecognize. Test before relying on it.
- **Mandarin**: `cmn-Hant-TW` is **Preview** on chirp_3. `cmn-Hans-CN` is GA.
- **Errors**: `google.rpc.Status`, i.e. `{"error":{"code","message","status"}}` (`INVALID_ARGUMENT`, `RESOURCE_EXHAUSTED`, `PERMISSION_DENIED`). Operation errors arrive per file in the batch results.
- **Health**: list recognizers, or `GET locations/{loc}`.
- **Verdict**: highest integration cost. Needs a GCS bucket, a service account and an extra upload step. Use only if the lab already has GCP.

### 2.5 Azure AI Speech (`https://<resource>.cognitiveservices.azure.com`)

- **Auth**: `Ocp-Apim-Subscription-Key: <key>`, or Entra `Authorization: Bearer`.
- **Fast transcription** (sync, recommended): `POST /speechtotext/transcriptions:transcribe?api-version=2025-10-15`, multipart.
  - Parts: `audio` (file) + `definition` (JSON `{locales:["zh-TW"], diarization:{enabled:true,maxSpeakers:N}, phraseList:{phrases:[…]}, profanityFilterMode:"None", channels}`), or `audioUrl` in the definition.
  - Limits < 500 MB and < 5 h. The batch page instead says fast transcription suits files < 2 h / 300 MB; that conflict is in Microsoft's own docs.
  - Formats: WAV, MP3, OPUS/OGG, FLAC, WMA, AAC, AMR, WebM, SPEEX.
  - Response: `{durationMilliseconds, combinedPhrases[{channel,text}], phrases[{channel,speaker,offsetMilliseconds,durationMilliseconds,text,words[{text,offsetMilliseconds,durationMilliseconds}],locale,confidence}]}`.
- **Batch** (async): `POST /speechtotext/transcriptions:submit?api-version=2024-11-15`.
  - Body: `contentUrls` (SAS/blob) + `locale` + `displayName`, plus `properties{diarization, wordLevelTimestampsEnabled, timeToLiveHours (6 h–31 d, required), languageIdentification.candidateLocales (2–10)}`.
  - Poll `self`, then fetch `links.files`. Webhooks exist (validation handshake echoes `validationToken` as plain text).
  - Diarized audio is limited to 240 min per file.
- **Mandarin**: `zh-TW` is supported for fast transcription and custom speech (phrase list). The multilingual (no-locale) mode includes only `zh-CN`. Language ID picks *one main language per file*, so English terms inside zh-TW speech rely on the zh-TW model plus the phrase list.
- **Live**: Speech SDK for JS, with an STS token from `/sts/v1.0/issueToken` (10 min) **(unverified)**.
- **Errors**: `{"error":{"code","message",…}}`. 429 throttling.
- **Health**: `GET /speechtotext/models/base?top=1&api-version=2024-11-15`, or the list-supported-locales call.

### 2.6 AWS Transcribe

- **Auth**: SigV4 (access key, secret, region; optional session token or role).
- **Flow** (async): put the file in **S3**, call `StartTranscriptionJob{TranscriptionJobName, Media.MediaFileUri, LanguageCode:"zh-TW", Settings{ShowSpeakerLabels, MaxSpeakerLabels ≤30, VocabularyName}, OutputBucketName?}`, then poll `GetTranscriptionJob`. The result JSON is in S3, or at a service-managed URI valid for 15 min.
- **Limits**: 2 GB. Duration is 8 h per the FAQ and service card, 4 h per other pages. Formats: AMR, FLAC, M4A, MP3, MP4, Ogg, WebM, WAV. Mono or stereo only. Billed per second with no minimum.
- **Output**: `results.transcripts[0].transcript`, `items[{id,start_time,end_time,alternatives[{content,confidence}],type:pronunciation|punctuation,speaker_label}]`, `audio_segments[]`, `speaker_labels.segments[{speaker_label,start_time,end_time,items}]`. **Times are strings in seconds.**
- **zh-TW**: batch and streaming. No custom language models for it.
- **Live**: WebSocket via a presigned `wss://transcribestreaming.<region>.amazonaws.com:8443/stream-transcription-websocket?…` (presign it in the backend), or HTTP/2. Streaming formats: PCM/FLAC/Ogg-Opus. Speaker labels are supported.
- **Errors**: `{"__type":"BadRequestException|LimitExceededException|…","message"}`. Failed jobs have `FailureReason`.
- **Health**: `ListTranscriptionJobs MaxResults=1`.
- **Verdict**: like Google, it needs a cloud bucket. Medium integration cost.

### 2.7 ElevenLabs Scribe (`https://api.elevenlabs.io/v1`; regional US/EU/IN/SG)

- **Auth**: `xi-api-key`. Browser use goes through single-use tokens (`POST /v1/single-use-token/{batch_scribe|realtime_scribe}`, 15 min).
- **Endpoint**: `POST /speech-to-text`, multipart.
  - Fields: `model_id=scribe_v2`, `file` or `source_url`, `language_code` (ISO 639-1/3; omit to auto-detect), `diarize`, `num_speakers` (≤32), `timestamps_granularity=word|character`, `tag_audio_events`, `keyterms` (≤1000, < 50 chars, ≤ 5 words; +20 % price), `use_multi_channel`, `webhook` (returns 202).
  - Limits: 3 GB upload (2 GB via URL), ≤ 10 h, ≥ 100 ms.
  - Files over 8 min are split internally into ≤ 4 parallel pieces.
- **Response**: `{language_code, language_probability, text, words[{text, type:word|spacing|audio_event, start, end, speaker_id, logprob}]}`. There are no segments, so build them by grouping words on `speaker_id` and pauses.
- **Live**: `wss://api.elevenlabs.io/v1/speech-to-text/realtime`. Send `input_audio_chunk`; receive `partial_transcript` / `committed_transcript`. `commit_strategy` is `manual|vad|turn_prediction`; set it explicitly because the docs disagree on the default. No diarization.
- **Errors**: 422 `{"detail":[{loc,msg,type}]}`. Others return `{"detail":{status,message}}` **(unverified)**.
- **Health**: `GET /v1/user` or `GET /v1/models` **(unverified)**.

### 2.8 Groq (`https://api.groq.com/openai/v1`, OpenAI-compatible)

- **Auth**: Bearer.
- **Endpoint**: `POST /audio/transcriptions` with `whisper-large-v3` or `whisper-large-v3-turbo`. Accepts `file` or `url`.
  - Limits: 25 MB free tier, 100 MB dev tier (through `url`).
  - Formats: flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm.
  - Fields: `response_format=json|verbose_json|text`, `timestamp_granularities[]=segment|word`, `prompt` (224 tokens, written in the audio's language), `language` (ISO-639-1).
  - Audio is downsampled to 16 kHz mono. Minimum billing is 10 s, which matters for voice notes and probes. No diarization.
- **Errors**: OpenAI-style. 429 includes `retry-after`.
- **Health**: `GET /models`.
- **Use**: a cheap, fast fallback member.

### 2.9 speaches (formerly faster-whisper-server), OpenAI-compatible

- **Endpoints**: `POST /v1/audio/transcriptions`. Form fields: `file`, `model` (an HF id such as `Systran/faster-whisper-large-v3`, loaded on demand, unloaded after `STT_MODEL_TTL` = 300 s), `language`, `prompt`, `response_format=text|json|verbose_json|srt|vtt`, `temperature`, `timestamp_granularities[]`, `stream` (SSE), `hotwords`.
  - VAD always runs. Also `/v1/realtime`, `/v1/models`, `/health`.
- **Auth**: optional `API_KEY` env, sent as Bearer. `/health`, `/docs` and the UI stay public.
- **No diarization.**
- **Health**: `GET /health` plus `GET /v1/models` (to confirm the model is listed). `PRELOAD_MODELS` avoids cold starts on the first job.

### 2.10 whisper.cpp `whisper-server`

- **Endpoints**: `POST /inference` (multipart `file`, `response_format=json|text|srt|vtt|verbose_json`, `temperature`, `prompt`; language is fixed at server start with `-l` or sent per request), `POST /load` (swap model), `GET /health`.
  - Health returns 200 `{"status":"ok"}`, or 503 `{"status":"loading model"}` while loading.
- **Not OpenAI-path compatible**: the path is `/inference` unless started with `--inference-path /v1/audio/transcriptions`. Our adapter should take a configurable path.
- **No auth**, so it must sit behind the internal network or a reverse proxy.
- `verbose_json` segments include `words[{word,start,end,probability}]`. `--convert` needs ffmpeg on the server; otherwise send 16 kHz WAV.
- Diarization only via `-tdrz` (tinydiarize, English models) or stereo `-di`. Treat it as none.

### 2.11 WhisperX (self-hosted, Python)

- Batched faster-whisper, then wav2vec2 forced alignment, then pyannote diarization (`speaker-diarization-community-1`; needs an HF token and accepted model terms). CLI: `--diarize --min_speakers --max_speakers --hf_token --language zh`.
- zh alignment model is `jonatasgrosman/wav2vec2-large-xlsr-53-chinese-zh-cn`. `zh` is in `LANGUAGES_WITHOUT_SPACES`, so **each character becomes a "word"**.
- **No HTTP server.** We would ship a small FastAPI wrapper exposing `POST /v1/audio/transcriptions` with `response_format=verbose_json`, plus `speaker` on segments and words and a `/health` route. Then it plugs in as "generic OpenAI-compatible + speaker extension".
- Best self-hosted option for word timestamps plus diarization on long files. Needs a GPU (~10 GB for large-v3 + pyannote).

### 2.12 NVIDIA ASR NIM / Riva (Parakeet, Canary, Whisper)

- **Models**: `parakeet-ctc-0.6b-zh-tw` (Taiwanese Mandarin + English, streaming and offline) and `-zh-cn`. Canary 1b multilingual (offline). Whisper large-v3 (offline).
  - Diarization exists only on the zh-CN/zh-TW Parakeet "VAD + Sortformer" profiles.
  - zh-TW GPU memory: 5.8 GB offline; 12 GB with diarization.
- **HTTP** (port 9000): `POST /v1/audio/transcriptions` (`file` WAV/OPUS/FLAC, `language` (BCP-47 or `multi`) or `model`, `response_format=json|text`). Returns `{text, usage:{type:"duration",seconds}}`.
  - **No timestamps or speakers over HTTP.** Those need gRPC (port 50051, `riva.client`), with word time offsets, boosting and diarization via `--speaker-diarization`.
- **Health**: `GET /v1/health/ready` (200 `ready` / 503 initialising), `/v1/health/live`, `/v1/models`, `/v1/metrics`.
- **Errors**: `{"detail": "…"}` or `{"error":{message,type,code}}`.
- **Verdict**: the best acoustic match for zh-TW code-switching. To get the full feature set the adapter needs a gRPC client (`@grpc/grpc-js` + Riva protos). Phase 1 can use HTTP for text-only voice notes.

### 2.13 Generic OpenAI-compatible `/v1/audio/transcriptions`

Covers OpenAI, Groq, speaches, NIM (HTTP), LocalAI, vLLM (Whisper), Azure OpenAI (different URL and `api-key` header), and the WhisperX wrapper.

- **Request**: multipart `file`, `model`, and optionally `language`, `prompt`, `response_format`, `timestamp_granularities[]`, `temperature`.
- **Parsing**: accept `json` `{text}` and `verbose_json` (`segments[{start,end,text}]`, `words[{word,start,end}]`). Tolerate extra fields `speaker` and `probability`.
- **Capability negotiation**: the admin declares capabilities (formats supported, word timestamps, diarization, max MB). Don't guess. If `verbose_json` returns 400, fall back to `json` and record the capability as missing.

---

## 3. Mandarin / zh-TW quality notes (practical)

- **Script**: only Deepgram (`zh-TW`/`zh-Hant`), Google (`cmn-Hant-TW`), Azure (`zh-TW`), AWS (`zh-TW`) and NIM (zh-TW model) target Traditional output natively.
  - For Whisper-family models, AssemblyAI and ElevenLabs, **always run OpenCC `s2twp`** (Simplified to Taiwan standard, with phrase conversion), e.g. `opencc-js` in Node.
  - Make it a per-provider-member toggle `convert_script: none|s2tw|s2twp`, default `s2twp` for vendors without a Traditional locale. Run it before storing, and record a warning in the transcript.
- **Code-switching** (English ML terms inside Mandarin):
  - Best: models trained for it (NIM zh-TW Parakeet, AssemblyAI U-3.5, OpenAI gpt-*, Whisper).
  - Weaker: single-locale engines (Deepgram zh-TW, Azure zh-TW, AWS zh-TW). Compensate with keyterms / phrase lists built from the study's glossary: paper titles, model names, member names.
- **Taiwanese Hokkien (台語)**: not reliably supported by any of these. Expect garbage in Hokkien stretches. Don't promise it in the UI.
- **Whisper hallucination**: repeated phrases or "字幕由…提供" on silence or music. Mitigate with VAD trimming (speaches does this by default; with the OpenAI API, pre-trim with ffmpeg `silenceremove` or chunk at silences), `temperature=0`, and dropping segments with `no_speech_prob > 0.6 && avg_logprob < -1`.
- **Diarization on meeting-room audio**: one far-field mic and overlapping speech hurt every vendor. Always expose a speaker → member mapping UI (the spec already plans "語者對應"). Pass the expected speaker count (attendee count) when the vendor accepts it.
- **Online-meeting video**: extract with `-vn` (as today). If the recording has separate channels per participant (rare), offer multichannel rather than diarization.

---

## 4. Audio preparation and chunking

**ASR derivative** (separate from the playback `.m4a`, or reuse it when it fits):
`ffmpeg -i in -vn -ac 1 -ar 16000 -c:a libopus -b:a 24k -application voip out.ogg` gives ~10.8 MB/h. Opus/Ogg is accepted by Azure, AWS, Groq, Deepgram and AssemblyAI. For OpenAI (whose list has no ogg), use `-c:a libmp3lame -b:a 32k out.mp3` (~14.4 MB/h, so 25 MB is about 104 min) or the existing 48 kbps m4a (~69 min). Use FLAC/WAV 16 kHz for NIM and whisper.cpp.

**When to chunk.** The adapter declares `maxBytes`, `maxDurationSec` and `maxChunkSecPreferred`:

| Vendor | Chunk? | Recommended chunk size |
|---|---|---|
| OpenAI gpt-4o-* / gpt-transcribe | yes | ≤ 20 min (both the 25 MB limit and the ~1500 s limit) |
| OpenAI whisper-1, Groq free tier | yes, for meetings | ≤ 25 MB; ~20 min |
| OpenAI -diarize | yes | ≤ 20 min, plus speaker stitching (below) |
| Google `Recognize` | always (≤ 1 min); prefer Batch | — |
| Deepgram, AssemblyAI, ElevenLabs, Azure fast, AWS | no for ≤ 2 h meetings | send whole file |
| Self-hosted (speaches / WhisperX / NIM) | optional; ~10 min chunks bound GPU memory and timeouts | — |

**Algorithm**:
1. Run ffmpeg `silencedetect=noise=-35dB:d=0.5` to get silence intervals.
2. Pick cut points greedily: the longest silence inside the window [target−3 min, target], with target = maxChunkSec. If no silence ≥ 0.3 s exists, hard-cut with a 2 s overlap.
3. Cut with `-ss/-to -c copy` (Opus), or re-encode for mp3. Use `-reset_timestamps 1` / `-avoid_negative_ts make_zero`; forum reports say stale duration metadata trips the 1500 s check.
4. Transcribe chunks with concurrency 2–4. For Whisper-family models, sequential is better: pass `prompt = glossary + last ~200 chars of the previous chunk's text` for continuity and consistent script.
5. Merge: add `chunk.offset` to every timestamp. For overlapped hard cuts, drop words from chunk *n+1* whose start < the overlap midpoint (and vice versa), then dedupe identical text at the seam.
6. **Speakers across chunks**: labels restart per chunk.
   - OpenAI -diarize: after chunk 1, cut a 4–8 s clean clip for up to 4 speakers and send them as `known_speaker_references[]` on later chunks. Name them `S1…S4`, mapped to members later in the UI.
   - Otherwise, mark the transcript `warnings:["speaker_labels_per_chunk"]` and namespace labels as `c{n}:A`. That's another reason to put the default `asr` route on a vendor with whole-file diarization.
7. Progress: `progress = done_chunk_seconds / total_seconds`, reported through the existing job heartbeat.

**Retries**: retry each chunk independently (`rate_limited`/`unavailable`/`timeout` use backoff). If a chunk exhausts the member, fail over the **whole job** to the next route member. Mixing vendors inside one transcript breaks speaker consistency. Allow mixing only if the admin enables `allow_mixed_members`.

---

## 5. Unified transcript type (normalise everything to this)

The current spec (`transcripts.segments jsonb [{start,end,text,speaker?}]`) is compatible. Extend it as follows:

```ts
/** Stored in transcripts.segments (jsonb) + optional words sidecar in S3. Times are seconds (float, 3 dp). */
type Transcript = {
  schema: 1;
  language: string | null;            // BCP-47 as returned/requested, e.g. "zh-TW"; detected if available
  languages?: string[];               // multiple detected (gpt-transcribe, AssemblyAI per-turn, Azure per-phrase)
  durationSec: number;
  source: {
    providerId: string; kind: string; model: string; routeId: string | null;
    requestIds: string[];             // vendor request/job ids, one per chunk (support tickets)
    chunks: { index: number; offset: number; duration: number }[];
    scriptConversion: "none" | "s2tw" | "s2twp";
  };
  speakers: { id: string; label: string | null; memberId?: string | null }[]; // id = normalised "S1","S2"…; label = vendor raw
  segments: Segment[];
  wordsKey?: string | null;           // S3 key of words JSON (Word[]), omitted when the vendor gives none
  warnings: TranscriptWarning[];      // "speaker_labels_per_chunk" | "script_converted" | "no_timestamps" | "low_confidence_dropped" | …
};

type Segment = {
  id: number;                         // 0..n, stable within this transcript version
  start: number; end: number;
  text: string;                       // display text (punctuated), already script-converted
  speaker: string | null;             // Transcript.speakers[].id
  confidence?: number | null;         // 0..1 when vendor gives it (Deepgram/AssemblyAI/Azure); else null
  language?: string | null;           // per-segment when vendor gives it
};

type Word = {
  start: number; end: number;
  text: string;                       // a token; for zh often a single character — join with "" between CJK, " " between Latin
  speaker?: string | null;
  confidence?: number | null;
  segmentId: number;
};
```

Rules:
- **Words live outside the row.** 120 min of Mandarin is ~30–40 k characters, so 1–2 MB of word JSON; keep it as `transcripts/<id>/words.json` in S3. Segments stay in jsonb for search, the LLM `get_transcript_excerpt` tool, and the SRT export.
- **Segmentation**: if the vendor returns only words (ElevenLabs, AWS items, Deepgram without utterances), build segments by splitting on speaker change, a pause ≥ 0.8 s, sentence punctuation (。？！.?!), or a max of 30 s or 120 chars.
- **Unit conversion**: AssemblyAI ms → s; Azure `offsetMilliseconds` / `durationMilliseconds` → start/end; AWS string seconds → float; Google `"1.500s"` Duration strings → float.
- **Speaker ids**: `A/B`, `0/1`, `spk_0`, `speaker_1` → `S1, S2…` in order of first appearance; keep the raw label in `speakers[].label`.
- **Live captions** (`asr_live`): ephemeral, not stored as the transcript. The final transcript always comes from the batch `asr` role over the recorded file, so live and batch can use different vendors.

**Adapter interface** (in `src/ai/asr/`):

```ts
interface AsrAdapter {
  kind: string;                                   // registry id
  capabilities(cfg): { maxBytes?: number; maxDurationSec?: number; preferredChunkSec?: number;
    formats: ("ogg"|"mp3"|"m4a"|"wav"|"flac"|"webm")[]; diarization: boolean; wordTimestamps: boolean;
    prompt: boolean; keyterms: number /*max, 0 = none*/; asyncJob: boolean; streaming: boolean };
  transcribe(input: { file: ReadableFile; durationSec: number; language?: string; prompt?: string;
    keyterms?: string[]; speakers?: { min?: number; max?: number; references?: {name:string; clip:Buffer}[] };
    signal: AbortSignal }): Promise<RawResult>;    // async vendors poll internally, honouring signal + heartbeat
  normalise(raw: RawResult, offsetSec: number): Omit<Transcript, "source"|"schema">;
  probe(cfg): Promise<{ ok: boolean; latencyMs: number; error?: AsrErrorCode }>;
}
type AsrErrorCode = "auth" | "quota" | "rate_limited" | "too_large" | "too_long" | "unsupported_format"
  | "bad_request" | "unavailable" | "timeout" | "network" | "job_failed";
```

Error mapping:
- **Fallback to the next member**: `auth`, `quota`, `unavailable`, `timeout`, `network`, `job_failed`.
- **Retry the same member with backoff**: `rate_limited` (honour `Retry-After`).
- **Re-chunk smaller, then retry**: `too_large` / `too_long` (OpenAI 400 "longer than … seconds", HTTP 413).
- **Final failure** (bad input): `bad_request` / `unsupported_format`, after one re-encode attempt to the vendor's first format.

**Async vendors** (AssemblyAI, Azure batch, AWS, Google batch, Deepgram callback): the worker cannot receive webhooks (internal network). **Poll** from inside the job every 5–15 s with backoff, save the vendor job id in the job's progress state so a reaped or restarted job resumes polling instead of resubmitting, and cancel or delete the remote job on cancel. Cleanup: AssemblyAI `DELETE /v2/transcript/{id}`, Azure `DELETE`, AWS `DeleteTranscriptionJob` plus the S3 object.

---

## 6. Live in-browser recording (`asr_live`)

- Record the full file with MediaRecorder (Opus/WebM) in the browser, and upload it in chunks so a crash doesn't lose the meeting. The recorded file is the source of truth for `asr`.
- Live captions are optional. **Proxy the WebSocket through the backend** (`/api/ai/asr-live` WS): the browser sends PCM16 16 kHz (AudioWorklet) and the backend forwards to the vendor.
  - Reasons: no vendor keys or tokens in the browser; CSP `connect-src` stays `'self'`; one protocol for the frontend; usage gets logged.
  - Vendor options: OpenAI `gpt-live-transcribe` (24 kHz PCM, client commits on VAD), Deepgram WS (zh-TW), AssemblyAI U-3.6 Pro Realtime (zh, code-switching), ElevenLabs realtime, AWS WS (zh-TW), NIM gRPC/WS (zh-TW, self-hosted). Google's 5-minute stream limit makes it a poor fit.
- Live sessions are billed on wall time (AssemblyAI, Deepgram streaming), so close the socket when the page hides or the recording pauses.

---

## 7. Health probes

| Kind | Cheap probe (every 60 s) | Notes |
|---|---|---|
| openai / groq / openai-compatible | `GET {base}/models/{model}` (fall back to `GET {base}/models`) | proves key + model visibility |
| deepgram | `GET /v1/projects` **(unverified)** | |
| assemblyai | `GET /v2/transcript?limit=1` **(unverified)** | |
| google | `GET /v2/projects/{p}/locations/{loc}/recognizers?pageSize=1` | OAuth token minting is itself a good check |
| azure | `GET /speechtotext/models/base?top=1&api-version=2024-11-15` | |
| aws | `ListTranscriptionJobs MaxResults=1` | SigV4 |
| elevenlabs | `GET /v1/models` **(unverified)** | |
| speaches | `GET /health` + model listed in `/v1/models` | |
| whisper.cpp | `GET /health` (200 ok / 503 loading) | |
| nim | `GET /v1/health/ready` | |
| whisperx-wrapper | `GET /health` (our wrapper) | |

Optional **deep probe** (manual "Test" button in admin, not periodic): transcribe a bundled 3 s zh+en clip (`今天我們討論 transformer 的 attention`) and show the text, latency and script. Groq bills a 10 s minimum and AWS has none, so the cost is negligible.

---

## 8. Admin form fields (provider = account; route member `params` for per-use settings)

Common provider fields:

| Field | Type | Req | Default | Secret |
|---|---|---|---|---|
| name | string | ✓ | — | |
| kind | enum (registry) | ✓ | — | |
| category | `external`\|`local` | ✓ | from kind | |
| base_url | url | kind-dependent | vendor default | |
| auth_type | enum | ✓ | from kind | |
| enabled | bool | ✓ | true | |

Per kind:

| Kind | Fields (type, req, default, *secret*) |
|---|---|
| `openai` | api_key (*), organization?, project?, base_url=`https://api.openai.com/v1` |
| `azure_openai` | endpoint ✓, api_key (*) or Entra, deployment ✓, api_version ✓ |
| `openai_compatible` | base_url ✓, api_key? (*), transcription_path=`/audio/transcriptions`, supports_verbose_json=true, supports_word_timestamps=false, supports_diarization=false (WhisperX wrapper), max_upload_mb=25, accepted_formats=[mp3,m4a,wav,ogg,flac,webm] |
| `groq` | api_key (*), tier (`free`=25 MB \| `dev`=100 MB) |
| `deepgram` | api_key (*), region base_url=`https://api.deepgram.com` |
| `assemblyai` | api_key (*), region (`us`\|`eu`) = us |
| `google_stt` | service_account_json (*), project_id ✓, location (`us`\|`eu`) = us, gcs_bucket ✓ (staging), staging_prefix=`asr-tmp/`, use_dynamic_batch=false |
| `azure_speech` | resource endpoint ✓ (`https://<name>.cognitiveservices.azure.com`), key (*), mode (`fast`\|`batch`) = fast, api_version=`2025-10-15` |
| `aws_transcribe` | region ✓, access_key_id (*), secret_access_key (*), session_token? (*), s3_bucket ✓, s3_prefix=`asr-tmp/`, vocabulary_name? |
| `elevenlabs` | api_key (*), region (`us`\|`eu`\|`in`\|`sg`) = us |
| `speaches` | base_url ✓, api_key? (*) |
| `whispercpp` | base_url ✓, inference_path=`/inference`, server_language? (informational) |
| `nim_riva` | http_url ✓ (`:9000`), grpc_url? (`:50051`, enables timestamps/diarization), use_tls=false, api_key? (*) (NVCF-hosted: `nvcf_function_id`) |

Route-member `params` (per use, not per account):

| Param | Type | Default | Notes |
|---|---|---|---|
| model | string ✓ | per kind (`gpt-transcribe`, `nova-3`, `universal-3-5-pro`, `chirp_3`, `scribe_v2`, `whisper-large-v3`, `Systran/faster-whisper-large-v3`, `parakeet-ctc-0.6b-zh-tw`) | |
| language | string | `zh-TW` (mapped per vendor: OpenAI/Groq `zh`, Google `cmn-Hant-TW`, ElevenLabs `zho`, AssemblyAI `zh`, AWS/Azure/Deepgram `zh-TW`); `auto` allowed | |
| extra_languages | string[] | `["en"]` | for vendors with multi-language hints |
| diarization | bool | true for meetings | ignored if capability is false |
| min_speakers / max_speakers | int? | from meeting attendees | |
| word_timestamps | bool | true when supported | |
| prompt_template | text | `以下是繁體中文的實驗室會議逐字稿，可能夾雜英文術語。{glossary}` | only for prompt-capable vendors |
| use_glossary_keyterms | bool | true | glossary from study tags/member names → keyterms/phrase list (respect max count) |
| convert_script | `none`\|`s2tw`\|`s2twp` | `s2twp` if vendor lacks Traditional locale, else `none` | |
| max_chunk_sec | int | from capability (1200 for OpenAI) | |
| chunk_concurrency | int | 2 | sequential (1) when chaining prompts |
| timeout_ms | int | 15 min per chunk sync; 3 h total async | |
| poll_interval_ms | int | 10000 | async vendors |
| drop_low_confidence | bool | true for Whisper-family | `no_speech_prob`/`avg_logprob` filter |

Show capability badges (diarization / word timestamps / streaming / Traditional native) next to each member, computed from kind + model, so admins can see why a fallback produces fewer features. Mark the role `degraded` when the active member lacks diarization while the primary had it.

---

## 9. Sources

- OpenAI STT guide: https://developers.openai.com/api/docs/guides/speech-to-text
- OpenAI transcription API reference: https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create
- OpenAI gpt-transcribe model: https://developers.openai.com/api/docs/models/gpt-transcribe
- OpenAI realtime transcription: https://developers.openai.com/api/docs/guides/realtime-transcription
- OpenAI pricing: https://developers.openai.com/api/docs/pricing
- 1500 s reports (forum): https://community.openai.com/t/gpt4-0-transcribe-max-1500-seconds/1306684 and https://community.openai.com/t/gpt-4o-transcribe-audio-length-limits/1148374
- Deepgram pre-recorded: https://developers.deepgram.com/reference/speech-to-text/listen-pre-recorded
- Deepgram languages: https://developers.deepgram.com/docs/models-languages-overview
- Deepgram errors: https://developers.deepgram.com/docs/errors
- Deepgram limits: https://developers.deepgram.com/reference/api-rate-limits
- Deepgram live: https://developers.deepgram.com/docs/live-streaming-audio
- Deepgram pricing: https://deepgram.com/pricing
- AssemblyAI submit: https://www.assemblyai.com/docs/api-reference/transcripts/submit
- AssemblyAI upload: https://www.assemblyai.com/docs/api-reference/files/upload
- AssemblyAI limits: https://www.assemblyai.com/docs/faq/are-there-any-limits-on-file-size-or-file-duration-for-files-submitted-to-the-api
- AssemblyAI languages: https://www.assemblyai.com/docs/pre-recorded-audio/supported-languages
- AssemblyAI multilingual streaming: https://www.assemblyai.com/docs/streaming/universal-streaming/multilingual-transcription
- AssemblyAI pricing: https://www.assemblyai.com/pricing
- Google Chirp 3: https://docs.cloud.google.com/speech-to-text/v2/docs/chirp_3-model
- Google quotas: https://docs.cloud.google.com/speech-to-text/v2/quotas
- Google batch: https://docs.cloud.google.com/speech-to-text/v2/docs/batch-recognize
- Google pricing: https://cloud.google.com/speech-to-text/pricing
- Azure fast transcription: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/fast-transcription-create
- Azure batch: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/batch-transcription-create
- Azure languages: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=stt
- AWS languages: https://docs.aws.amazon.com/transcribe/latest/dg/supported-languages.html
- AWS input/output: https://docs.aws.amazon.com/transcribe/latest/dg/how-input.html
- AWS diarization: https://docs.aws.amazon.com/transcribe/latest/dg/diarization.html
- AWS FAQ: https://aws.amazon.com/transcribe/faqs/
- AWS pricing: https://aws.amazon.com/transcribe/pricing/
- ElevenLabs STT API: https://elevenlabs.io/docs/api-reference/speech-to-text/convert
- ElevenLabs capability page: https://elevenlabs.io/docs/capabilities/speech-to-text
- ElevenLabs realtime: https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime
- ElevenLabs pricing: https://elevenlabs.io/pricing/api
- Groq STT: https://console.groq.com/docs/speech-to-text
- speaches: https://speaches.ai/
- speaches configuration: https://speaches.ai/configuration/
- speaches STT usage: https://speaches.ai/usage/speech-to-text/
- speaches STT router source: https://github.com/speaches-ai/speaches/blob/master/src/speaches/routers/stt.py
- whisper.cpp server README: https://github.com/ggml-org/whisper.cpp/blob/master/examples/server/README.md
- whisper.cpp server source: https://github.com/ggml-org/whisper.cpp/blob/master/examples/server/server.cpp
- WhisperX: https://github.com/m-bain/whisperX
- WhisperX alignment.py: https://github.com/m-bain/whisperX/blob/main/whisperx/alignment.py
- NVIDIA ASR NIM: https://docs.nvidia.com/nim/speech/latest/asr/index.html
- NIM support matrix: https://docs.nvidia.com/nim/speech/latest/reference/support-matrix/asr.html
- NIM HTTP API: https://docs.nvidia.com/nim/speech/latest/reference/api-references/asr/http-asr.html
- NIM customization (diarization): https://docs.nvidia.com/nim/speech/latest/asr/customization/customization.html
