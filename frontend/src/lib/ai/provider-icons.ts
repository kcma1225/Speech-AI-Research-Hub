// Brand marks for provider vendors (registry `kind` ids of both the LLM and the ASR registries).
// Paths come from simple-icons (CC0-1.0, https://simpleicons.org); named imports keep the bundle to these few.
// Vendors simple-icons does not carry (OpenAI, Microsoft/Azure, AWS, Groq, Cohere, …) get a monogram tile.
import {
  siAlibabacloud,
  siAnthropic,
  siClaude,
  siDeepgram,
  siDeepseek,
  siElevenlabs,
  siGooglecloud,
  siGooglegemini,
  siHuggingface,
  siLmstudio,
  siMistralai,
  siMoonshotai,
  siNvidia,
  siOllama,
  siOpenrouter,
  siPerplexity,
  siVllm,
  siZdotai,
  type SimpleIcon,
} from "simple-icons";
import { toneFor, type Tone } from "#lib/components/ui/Pill.svelte";

export type VendorMark = { kind: "brand"; path: string; bg: string; fg: string; title: string } | { kind: "mono"; text: string; tone: Tone } | { kind: "generic" };

const BRANDS: Record<string, SimpleIcon> = {
  anthropic: siAnthropic,
  "claude-oauth": siClaude,
  "claude-cli": siClaude,
  gemini: siGooglegemini,
  vertex: siGooglecloud,
  google_stt: siGooglecloud,
  mistral: siMistralai,
  deepseek: siDeepseek,
  openrouter: siOpenrouter,
  perplexity: siPerplexity,
  "dashscope-intl": siAlibabacloud,
  "dashscope-cn": siAlibabacloud,
  zhipu: siZdotai,
  moonshot: siMoonshotai,
  vllm: siVllm,
  ollama: siOllama,
  lmstudio: siLmstudio,
  tgi: siHuggingface,
  tei: siHuggingface,
  nim: siNvidia,
  deepgram: siDeepgram,
  elevenlabs: siElevenlabs,
};

/** Hand-picked monograms (1–2 letters) for vendors without a bundled mark. */
const MONOGRAMS: Record<string, string> = {
  openai: "OA",
  chatgpt: "GP",
  azure: "Az",
  azure_openai: "Az",
  azure_speech: "Az",
  bedrock: "AW",
  aws_transcribe: "AW",
  xai: "xA",
  groq: "Gq",
  cohere: "Co",
  together: "To",
  fireworks: "Fw",
  cerebras: "Ce",
  voyage: "Vo",
  jina: "Ji",
  llamacpp: "ll",
  sglang: "SG",
  localai: "LA",
  assemblyai: "AA",
  speaches: "Sp",
  whispercpp: "wc",
  whisperx: "WX",
};
/** Generic OpenAI-compatible endpoints get a neutral plug glyph instead of a vendor mark. */
const GENERIC = new Set(["openai-compatible", "openai_compatible"]);
// Monogram tones keyed so related vendors share a colour (all Azure entries, both AWS entries).
const TONE_KEY: Record<string, string> = { azure_openai: "azure", azure_speech: "azure", aws_transcribe: "bedrock" };

function luminance(hex: string): number {
  const c = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}

const cache = new Map<string, VendorMark>();

/** Mark for a registry vendor id; `label` seeds the monogram of an unknown vendor. */
export function vendorMark(kind: string | null | undefined, label = ""): VendorMark {
  const k = kind ?? "";
  const hit = cache.get(`${k}\u0000${label}`);
  if (hit) return hit;
  let mark: VendorMark;
  const brand = BRANDS[k];
  if (brand) {
    // Glyph colour: whichever of white / near-black contrasts better with the brand tile.
    const L = luminance(brand.hex);
    const fg = (1.05 / (L + 0.05)) >= ((L + 0.05) / 0.05) ? "#ffffff" : "#141414";
    mark = { kind: "brand", path: brand.path, bg: `#${brand.hex}`, fg, title: brand.title };
  } else if (GENERIC.has(k)) {
    mark = { kind: "generic" };
  } else {
    const words = (label || k).replace(/[（(].*?[）)]/g, "").trim().split(/[\s._-]+/).filter(Boolean);
    const text = MONOGRAMS[k] ?? ((words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? "?").slice(0, 2)) || "?");
    mark = { kind: "mono", text, tone: toneFor(TONE_KEY[k] ?? (k || label)) };
  }
  cache.set(`${k}\u0000${label}`, mark);
  return mark;
}
