// Brand marks for provider vendors (registry `kind` ids of the LLM and ASR registries, plus the subscription kinds).
// SVGs live in ./provider-svgs (LobeHub Icons, MIT; deepgram from simple-icons, CC0 — see NOTICE.md). Only the
// files listed there ship. Vendors without a published mark (llama.cpp, SGLang, LocalAI, speaches, whisper.cpp,
// WhisperX) get a monogram tile; generic OpenAI-compatible endpoints get a plug glyph.
import { toneFor, type Tone } from "#lib/components/ui/Pill.svelte";

const SVGS = import.meta.glob<string>("./provider-svgs/*.svg", { query: "?raw", import: "default", eager: true });
const svg = (name: string) => SVGS[`./provider-svgs/${name}.svg`] ?? "";

/**
 * `bg` / `fg` colour the tile and any `currentColor` glyph; `dark` overrides them in dark mode
 * (used for black brand tiles, which would vanish on the dark surface).
 */
export type VendorMark =
  | { kind: "brand"; svg: string; bg: string; fg: string; darkBg: string; darkFg: string }
  | { kind: "mono"; text: string; tone: Tone }
  | { kind: "generic" };

type Spec = { file: string; bg: string; fg?: string; dark?: { bg: string; fg: string } };

const WHITE = "#ffffff";
// Colour marks sit on a white tile in both themes (several carry dark parts: AWS, Voyage, Hugging Face).
const color = (file: string): Spec => ({ file, bg: WHITE });
// Black brand tiles become a raised neutral tile with an ink glyph in dark mode.
const onBlack = (file: string): Spec => ({ file, bg: "#000000", fg: WHITE, dark: { bg: "var(--surface-3)", fg: "var(--ink)" } });
const onTile = (file: string, bg: string, fg = WHITE): Spec => ({ file, bg, fg });

const OPENAI = onBlack("openai");
const SPECS: Record<string, Spec> = {
  openai: OPENAI,
  chatgpt: OPENAI,
  anthropic: onTile("anthropic", "#f0eee6", "#141413"),
  "claude-oauth": onTile("claude", "#d97757"),
  "claude-cli": onTile("claudecode-color", "#f0eee6"),
  gemini: color("gemini-color"),
  vertex: color("vertexai-color"),
  google_stt: color("googlecloud-color"),
  azure: color("azureai-color"),
  azure_openai: color("azureai-color"),
  azure_speech: color("azure-color"),
  bedrock: color("bedrock-color"),
  aws_transcribe: color("aws-color"),
  mistral: color("mistral-color"),
  deepseek: color("deepseek-color"),
  xai: onBlack("xai"),
  groq: onTile("groq", "#f55036"),
  cohere: color("cohere-color"),
  together: color("together-color"),
  fireworks: color("fireworks-color"),
  openrouter: onTile("openrouter", "#6467f2"),
  perplexity: color("perplexity-color"),
  cerebras: color("cerebras-color"),
  "dashscope-intl": color("bailian-color"),
  "dashscope-cn": color("bailian-color"),
  zhipu: color("zhipu-color"),
  moonshot: { file: "kimi-color", bg: "#000000", dark: { bg: "var(--surface-3)", fg: "var(--ink)" } },
  voyage: color("voyage-color"),
  jina: onBlack("jina"),
  vllm: color("vllm-color"),
  ollama: onTile("ollama", WHITE, "#000000"),
  lmstudio: onTile("lmstudio", "#4f46e5"),
  tgi: color("huggingface-color"),
  tei: color("huggingface-color"),
  nim: color("nvidia-color"),
  deepgram: { file: "deepgram", bg: "#101010", fg: "#13ef93", dark: { bg: "var(--surface-3)", fg: "#13ef93" } },
  assemblyai: color("assemblyai-color"),
  elevenlabs: onBlack("elevenlabs"),
};

/** Hand-picked monograms (1–2 letters) for vendors without a published mark. */
const MONOGRAMS: Record<string, string> = { llamacpp: "ll", sglang: "SG", localai: "LA", speaches: "Sp", whispercpp: "wc", whisperx: "WX" };
/** Generic OpenAI-compatible endpoints get a neutral plug glyph instead of a vendor mark. */
const GENERIC = new Set(["openai-compatible", "openai_compatible"]);

const cache = new Map<string, VendorMark>();

/** Mark for a registry vendor id; `label` seeds the monogram of an unknown vendor. */
export function vendorMark(kind: string | null | undefined, label = ""): VendorMark {
  const k = kind ?? "";
  const key = `${k}\u0000${label}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let mark: VendorMark;
  const spec = SPECS[k];
  const markup = spec ? svg(spec.file) : "";
  if (spec && markup) {
    const fg = spec.fg ?? "#141414";
    mark = { kind: "brand", svg: markup, bg: spec.bg, fg, darkBg: spec.dark?.bg ?? spec.bg, darkFg: spec.dark?.fg ?? fg };
  } else if (GENERIC.has(k)) {
    mark = { kind: "generic" };
  } else {
    const words = (label || k).replace(/[（(].*?[）)]/g, "").trim().split(/[\s._-]+/).filter(Boolean);
    const text = MONOGRAMS[k] ?? ((words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? "?").slice(0, 2)) || "?");
    mark = { kind: "mono", text, tone: toneFor(k || label) };
  }
  cache.set(key, mark);
  return mark;
}

let seq = 0;
/** Gradient / clip ids inside an inlined SVG must be unique per instance (a hidden first copy breaks later references). */
export function scopeSvgIds(markup: string): string {
  if (!markup.includes('id="')) return markup;
  const suffix = `-p${++seq}`;
  return markup.replace(/id="([^"]+)"/g, `id="$1${suffix}"`).replace(/url\(#([^)]+)\)/g, `url(#$1${suffix})`).replace(/href="#([^"]+)"/g, `href="#$1${suffix}"`);
}
