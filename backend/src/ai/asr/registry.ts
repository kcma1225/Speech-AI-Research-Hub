/**
 * ASR provider registry: one entry per vendor kind (data for the admin form + capability badges)
 * and the adapter that implements it. Same idea as the LLM registry (`providers/`).
 */
import type { Bilingual, FormField } from "../providers/entry.js";
import { assemblyaiAdapter } from "./adapters/assemblyai.js";
import { awsTranscribeAdapter } from "./adapters/aws.js";
import { azureSpeechAdapter } from "./adapters/azure.js";
import { deepgramAdapter } from "./adapters/deepgram.js";
import { elevenlabsAdapter } from "./adapters/elevenlabs.js";
import { googleSttAdapter } from "./adapters/google.js";
import {
  azureOpenaiAdapter,
  groqAdapter,
  nimAdapter,
  openaiAdapter,
  openaiCompatibleAdapter,
  speachesAdapter,
  whisperxAdapter,
} from "./adapters/openai.js";
import { whispercppAdapter } from "./adapters/whispercpp.js";
import type { AsrAdapter, AsrCapabilities, AsrProviderConfig, ScriptConversion } from "./types.js";

export type AsrRegistryEntry = {
  id: string;
  label: Bilingual;
  category: "external" | "local";
  fields: FormField[];
  /** Suggested models (free text is allowed). */
  models: string[];
  defaultModel: string;
  /** Default `convert_script` for route members using this kind. */
  defaultConvertScript: ScriptConversion;
  /** Kinds with a live (streaming) implementation for `asr_live`. */
  live: boolean;
  help_zh?: string;
  docsUrl?: string;
  adapter: AsrAdapter;
};

const f = (key: string, zh: string, en: string, type: FormField["type"], extra: Partial<FormField> = {}): FormField => ({
  key,
  label: { zh, en },
  type,
  ...extra,
});

const apiKey = (required = true) => f("api_key", "API 金鑰", "API key", "secret", { required });
const baseUrl = (dflt?: string, required = !dflt) => f("base_url", "服務網址", "Base URL", "url", { required, default: dflt });
const opt = (value: string, zh: string, en = zh) => ({ value, label: { zh, en } });

const TAIWANESE_NOTE = "台語（閩南語）目前沒有任何廠商能可靠辨識，台語段落可能會是亂碼。";

export const ASR_REGISTRY: AsrRegistryEntry[] = [
  {
    id: "openai",
    label: { zh: "OpenAI", en: "OpenAI" },
    category: "external",
    fields: [apiKey(), f("organization", "組織 ID", "Organization", "text"), f("project", "專案 ID", "Project", "text"), baseUrl("https://api.openai.com/v1")],
    models: ["gpt-transcribe", "gpt-4o-transcribe", "gpt-4o-mini-transcribe", "gpt-4o-transcribe-diarize", "whisper-1"],
    defaultModel: "gpt-transcribe",
    defaultConvertScript: "s2twp",
    live: true,
    help_zh: `上傳上限 25 MB；長錄音會在靜音處切成約 20 分鐘一段。只有 gpt-4o-transcribe-diarize 支援語者分離（不支援提示詞），只有 whisper-1 有逐字時間戳。${TAIWANESE_NOTE}`,
    docsUrl: "https://developers.openai.com/api/docs/guides/speech-to-text",
    adapter: openaiAdapter,
  },
  {
    id: "azure_openai",
    label: { zh: "Azure OpenAI（語音轉文字）", en: "Azure OpenAI (transcription)" },
    category: "external",
    fields: [
      f("endpoint", "資源端點", "Endpoint", "url", { required: true, placeholder: "https://<name>.openai.azure.com" }),
      apiKey(),
      f("deployment", "部署名稱", "Deployment", "text", { required: true }),
      f("api_version", "API 版本", "API version", "text", { default: "2025-04-01-preview" }),
    ],
    models: ["whisper", "gpt-4o-transcribe"],
    defaultModel: "whisper",
    defaultConvertScript: "s2twp",
    live: false,
    help_zh: "「模型」請填部署所用的模型名稱（用來判斷請求格式）。",
    adapter: azureOpenaiAdapter,
  },
  {
    id: "deepgram",
    label: { zh: "Deepgram", en: "Deepgram" },
    category: "external",
    fields: [apiKey(), baseUrl("https://api.deepgram.com")],
    models: ["nova-3", "nova-2"],
    defaultModel: "nova-3",
    defaultConvertScript: "none",
    live: true,
    help_zh: `zh-TW 直接輸出繁體；語者分離已含在費用內。中文不支援 multi 混語模式，英文術語請放進詞彙表（keyterm）。${TAIWANESE_NOTE}`,
    docsUrl: "https://developers.deepgram.com/reference/speech-to-text/listen-pre-recorded",
    adapter: deepgramAdapter,
  },
  {
    id: "assemblyai",
    label: { zh: "AssemblyAI", en: "AssemblyAI" },
    category: "external",
    fields: [apiKey(), f("region", "區域", "Region", "select", { default: "us", options: [opt("us", "美國", "US"), opt("eu", "歐洲", "EU")] }), f("delete_after", "完成後刪除廠商端逐字稿", "Delete transcript at vendor afterwards", "boolean", { default: true })],
    models: ["universal-3-5-pro", "universal-2"],
    defaultModel: "universal-3-5-pro",
    defaultConvertScript: "s2twp",
    live: false,
    help_zh: `非同步：上傳後輪詢結果（重新啟動會接續，不重送）。支援中英混講、語者分離與詞彙表。${TAIWANESE_NOTE}`,
    docsUrl: "https://www.assemblyai.com/docs/api-reference/transcripts/submit",
    adapter: assemblyaiAdapter,
  },
  {
    id: "google_stt",
    label: { zh: "Google Cloud Speech-to-Text v2", en: "Google Cloud Speech-to-Text v2" },
    category: "external",
    fields: [
      f("service_account_json", "服務帳戶 JSON", "Service account JSON", "secret", { required: true, multiline: true }),
      f("project_id", "專案 ID", "Project ID", "text", { help_zh: "留空則使用服務帳戶 JSON 內的 project_id。" }),
      f("location", "區域", "Location", "select", { default: "us", options: [opt("us", "us"), opt("eu", "eu"), opt("global", "global")] }),
      f("gcs_bucket", "GCS 暫存 bucket", "GCS staging bucket", "text", { help_zh: "長錄音必須透過 GCS（BatchRecognize）。留空則只能用同步辨識，每段最多 1 分鐘 / 10 MB，系統會自動切成很多小段。" }),
      f("staging_prefix", "暫存路徑前綴", "Staging prefix", "text", { default: "asr-tmp/" }),
      f("use_dynamic_batch", "動態批次（便宜但最慢 24 小時）", "Dynamic batching", "boolean", { default: false }),
    ],
    models: ["chirp_3", "chirp_2", "long"],
    defaultModel: "chirp_3",
    defaultConvertScript: "none",
    live: false,
    help_zh: `cmn-Hant-TW 在 chirp_3 仍是預覽版。需要服務帳戶；長錄音需要 GCS bucket（服務帳戶要有該 bucket 的讀寫權限）。${TAIWANESE_NOTE}`,
    docsUrl: "https://docs.cloud.google.com/speech-to-text/v2/docs/chirp_3-model",
    adapter: googleSttAdapter,
  },
  {
    id: "azure_speech",
    label: { zh: "Azure AI Speech（快速轉錄）", en: "Azure AI Speech (fast transcription)" },
    category: "external",
    fields: [
      f("endpoint", "資源端點", "Endpoint", "url", { required: true, placeholder: "https://<name>.cognitiveservices.azure.com" }),
      apiKey(),
      f("api_version", "API 版本", "API version", "text", { default: "2025-10-15" }),
    ],
    models: ["fast"],
    defaultModel: "fast",
    defaultConvertScript: "none",
    live: false,
    help_zh: `同步快速轉錄，單檔上限約 2 小時 / 300 MB（超過會自動切段）。zh-TW 直接輸出繁體；英文術語請放詞彙表（phrase list）。批次轉錄（blob URL）未實作。${TAIWANESE_NOTE}`,
    docsUrl: "https://learn.microsoft.com/en-us/azure/ai-services/speech-service/fast-transcription-create",
    adapter: azureSpeechAdapter,
  },
  {
    id: "aws_transcribe",
    label: { zh: "AWS Transcribe", en: "AWS Transcribe" },
    category: "external",
    fields: [
      f("region", "區域", "Region", "text", { required: true, placeholder: "ap-northeast-1" }),
      f("access_key_id", "Access key ID", "Access key ID", "secret", { required: true }),
      f("secret_access_key", "Secret access key", "Secret access key", "secret", { required: true }),
      f("session_token", "Session token", "Session token", "secret"),
      f("s3_bucket", "S3 暫存 bucket", "S3 staging bucket", "text", { required: true, help_zh: "必須與 Transcribe 同區域；金鑰需要此 bucket 的 PutObject/DeleteObject 權限。轉錄完成後會刪除暫存檔。" }),
      f("s3_prefix", "暫存路徑前綴", "Staging prefix", "text", { default: "asr-tmp/" }),
      f("vocabulary_name", "自訂詞彙表名稱", "Custom vocabulary", "text"),
    ],
    models: ["default"],
    defaultModel: "default",
    defaultConvertScript: "none",
    live: false,
    help_zh: `非同步：先上傳到你的 S3 bucket，再輪詢結果。zh-TW 直接輸出繁體。${TAIWANESE_NOTE}`,
    docsUrl: "https://docs.aws.amazon.com/transcribe/latest/dg/how-input.html",
    adapter: awsTranscribeAdapter,
  },
  {
    id: "elevenlabs",
    label: { zh: "ElevenLabs Scribe", en: "ElevenLabs Scribe" },
    category: "external",
    fields: [apiKey(), f("region", "區域", "Region", "select", { default: "us", options: [opt("us", "us"), opt("eu", "eu"), opt("in", "in"), opt("sg", "sg")] }), f("base_url", "服務網址（覆寫）", "Base URL override", "url")],
    models: ["scribe_v2", "scribe_v1"],
    defaultModel: "scribe_v2",
    defaultConvertScript: "s2twp",
    live: false,
    help_zh: `單檔最長 10 小時，支援語者分離（最多 32 人）與詞彙表（會加價約 20%）。${TAIWANESE_NOTE}`,
    docsUrl: "https://elevenlabs.io/docs/api-reference/speech-to-text/convert",
    adapter: elevenlabsAdapter,
  },
  {
    id: "groq",
    label: { zh: "Groq（Whisper）", en: "Groq (Whisper)" },
    category: "external",
    fields: [apiKey(), f("tier", "方案", "Tier", "select", { default: "free", options: [opt("free", "免費（25 MB）", "Free (25 MB)"), opt("dev", "Dev（100 MB）", "Dev (100 MB)")] }), baseUrl("https://api.groq.com/openai/v1")],
    models: ["whisper-large-v3", "whisper-large-v3-turbo"],
    defaultModel: "whisper-large-v3",
    defaultConvertScript: "s2twp",
    live: false,
    help_zh: "便宜快速，適合當備援；不支援語者分離。每次請求最少以 10 秒計費。",
    docsUrl: "https://console.groq.com/docs/speech-to-text",
    adapter: groqAdapter,
  },
  {
    id: "speaches",
    label: { zh: "speaches（faster-whisper）", en: "speaches (faster-whisper)" },
    category: "local",
    fields: [baseUrl(undefined, true), apiKey(false)],
    models: ["Systran/faster-whisper-large-v3", "deepdml/faster-whisper-large-v3-turbo-ct2"],
    defaultModel: "Systran/faster-whisper-large-v3",
    defaultConvertScript: "s2twp",
    live: false,
    help_zh: "OpenAI 相容的自架伺服器；網址填伺服器根目錄（例如 http://gpu-box:8000）。建議設定 PRELOAD_MODELS 避免第一次很慢。不支援語者分離。",
    docsUrl: "https://speaches.ai/",
    adapter: speachesAdapter,
  },
  {
    id: "whispercpp",
    label: { zh: "whisper.cpp server", en: "whisper.cpp server" },
    category: "local",
    fields: [baseUrl(undefined, true), f("inference_path", "辨識路徑", "Inference path", "text", { default: "/inference" }), f("api_key", "API 金鑰（反向代理）", "API key (reverse proxy)", "secret")],
    models: ["(server)"],
    defaultModel: "(server)",
    defaultConvertScript: "s2twp",
    live: false,
    help_zh: "whisper.cpp 本身沒有驗證，請只放在內網。語言與模型由伺服器啟動參數決定；音檔會先轉成 16 kHz WAV。",
    docsUrl: "https://github.com/ggml-org/whisper.cpp/blob/master/examples/server/README.md",
    adapter: whispercppAdapter,
  },
  {
    id: "whisperx",
    label: { zh: "WhisperX（本專案包裝服務）", en: "WhisperX (hub wrapper)" },
    category: "local",
    fields: [baseUrl(undefined, true), apiKey(false), f("max_upload_mb", "上傳上限（MB）", "Max upload (MB)", "number", { default: 500 })],
    models: ["large-v3", "large-v3-turbo"],
    defaultModel: "large-v3",
    defaultConvertScript: "s2twp",
    live: false,
    help_zh: "deploy/whisperx/ 的小型 HTTP 服務（compose profile whisperx，需要 GPU 與 HF_TOKEN）。支援逐字時間戳與 pyannote 語者分離；中文每個字是一個「詞」。",
    adapter: whisperxAdapter,
  },
  {
    id: "nim",
    label: { zh: "NVIDIA Riva / ASR NIM", en: "NVIDIA Riva / ASR NIM" },
    category: "local",
    fields: [baseUrl(undefined, true), apiKey(false), f("max_upload_mb", "上傳上限（MB）", "Max upload (MB)", "number", { default: 100 })],
    models: ["parakeet-ctc-0.6b-zh-tw", "parakeet-ctc-0.6b-zh-cn", "canary-1b", "whisper-large-v3"],
    defaultModel: "parakeet-ctc-0.6b-zh-tw",
    defaultConvertScript: "none",
    live: false,
    help_zh: "HTTP 介面（port 9000）只回傳文字，沒有時間戳與語者；這兩項需要 gRPC，目前未實作。parakeet-ctc-0.6b-zh-tw 專為台灣華語＋英文訓練。",
    docsUrl: "https://docs.nvidia.com/nim/speech/latest/reference/api-references/asr/http-asr.html",
    adapter: nimAdapter,
  },
  {
    id: "openai_compatible",
    label: { zh: "通用 OpenAI 相容端點", en: "Generic OpenAI-compatible" },
    category: "local",
    fields: [
      baseUrl(undefined, true),
      apiKey(false),
      f("transcription_path", "轉錄路徑", "Transcription path", "text", { default: "/audio/transcriptions" }),
      f("supports_verbose_json", "支援 verbose_json", "Supports verbose_json", "boolean", { default: true }),
      f("supports_word_timestamps", "支援逐字時間戳", "Supports word timestamps", "boolean", { default: false }),
      f("supports_diarization", "回傳語者（speaker 欄位）", "Returns speakers", "boolean", { default: false }),
      f("max_upload_mb", "上傳上限（MB）", "Max upload (MB)", "number", { default: 25 }),
      f("max_duration_sec", "單段長度上限（秒）", "Max duration per request (s)", "number"),
      f("accepted_formats", "接受的格式", "Accepted formats", "json", { default: ["mp3", "m4a", "wav", "ogg", "flac", "webm"] }),
    ],
    models: ["whisper-1"],
    defaultModel: "whisper-1",
    defaultConvertScript: "s2twp",
    live: false,
    help_zh: "LocalAI、vLLM（Whisper）等。能力請照伺服器實際支援勾選，系統不會猜。",
    adapter: openaiCompatibleAdapter,
  },
];

/** Per-use params on a route member (not per account). */
export const ASR_MEMBER_PARAMS: FormField[] = [
  f("model", "模型", "Model", "text", { required: true }),
  f("language", "語言", "Language", "text", { default: "zh-TW", help_zh: "BCP-47，例如 zh-TW、en；auto 代表自動偵測。" }),
  f("extra_languages", "其他語言", "Extra languages", "json", { default: ["en"] }),
  f("diarization", "語者分離", "Diarization", "boolean", { default: true }),
  f("word_timestamps", "逐字時間戳", "Word timestamps", "boolean", { default: true }),
  f("prompt_template", "提示詞範本", "Prompt template", "text", { multiline: true, default: "以下是繁體中文的實驗室會議逐字稿，可能夾雜英文術語。{glossary}" }),
  f("use_glossary_keyterms", "使用研究詞彙表", "Use study glossary", "boolean", { default: true }),
  f("convert_script", "簡轉繁", "Convert script", "select", { options: [opt("none", "不轉換", "None"), opt("s2tw", "簡→繁（台灣字形）", "s2tw"), opt("s2twp", "簡→繁（台灣用語）", "s2twp")] }),
  f("max_chunk_sec", "切段長度上限（秒）", "Max chunk (s)", "number"),
  f("timeout_ms", "逾時（毫秒）", "Timeout (ms)", "number", { default: 900000 }),
  f("poll_interval_ms", "輪詢間隔（毫秒）", "Poll interval (ms)", "number", { default: 10000 }),
  f("drop_low_confidence", "移除低信心片段", "Drop low-confidence segments", "boolean", { default: true }),
];

const byId = new Map(ASR_REGISTRY.map((e) => [e.id, e]));

export function getAsrEntry(kind: string): AsrRegistryEntry | undefined {
  return byId.get(kind);
}

export function asrAdapterFor(kind: string): AsrAdapter | undefined {
  return byId.get(kind)?.adapter;
}

/** Capability badges for a configured member (kind + model + fields). */
export function asrCapabilities(cfg: AsrProviderConfig): AsrCapabilities | undefined {
  return byId.get(cfg.kind)?.adapter.capabilities(cfg);
}

/** JSON-safe registry for the admin UI (no adapter functions); capabilities computed for the default model. */
export function publicAsrRegistry() {
  return ASR_REGISTRY.map(({ adapter, ...e }) => ({
    ...e,
    capabilities: adapter.capabilities({ kind: e.id, model: e.defaultModel, fields: { gcs_bucket: e.id === "google_stt" ? "x" : undefined } }),
  }));
}
