/**
 * Speech-to-text by a multimodal chat model: prompt building and parsing of the model's answer into a chunk result.
 * Pure (no I/O); the adapter lives in adapters/llm.ts.
 *
 * The model is asked for strict JSON `{language, segments[{start, end, speaker?, text}]}` with times in seconds
 * relative to the clip. Models do not always comply, so parsing is defensive: code fences / think blocks are
 * stripped, truncated JSON is repaired (cut at the last complete segment), `[MM:SS] S1: text` lines are accepted,
 * and a plain-text answer becomes one segment spanning the clip (`no_timestamps`). Timestamps are then made
 * monotonic and clamped to the clip; LLM timestamps are estimates, so every result carries `timestamps_approximate`.
 * Hallucinated loops (the same line again and again, or one phrase repeated inside a line) are trimmed.
 */
import { r3 } from "./normalize.js";
import type { ChunkResult, Segment, TranscriptWarning } from "./types.js";

export type LlmPromptInput = {
  durationSec: number;
  language?: string;
  extraLanguages?: string[];
  diarize: boolean;
  keyterms: string[];
  /** Free-text context: the member's prompt template (glossary) + the tail of the previous chunk. */
  prompt?: string;
};

const LANG_NAME: Record<string, string> = { zh: "Mandarin Chinese", en: "English", ja: "Japanese", ko: "Korean", nan: "Taiwanese Hokkien" };

const isZh = (lang?: string) => !lang || lang === "auto" || /^(zh|cmn)/i.test(lang);

/** System + user text for one clip. */
export function buildTranscribePrompt(input: LlmPromptInput): { system: string; user: string } {
  const dur = r3(input.durationSec);
  const langs = [input.language, ...(input.extraLanguages ?? [])].filter((l): l is string => !!l && l !== "auto");
  const langHint = langs.length ? langs.map((l) => `${LANG_NAME[l.split(/[-_]/)[0]!.toLowerCase()] ?? l} (${l})`).join(", ") : "auto-detect";
  const rules = [
    "You are a professional speech-to-text transcriber for an academic research lab (meetings, talks, voice notes).",
    "Transcribe the audio clip verbatim. Rules:",
    "1. Write exactly what is said, in the language it is spoken. Never translate, summarize, paraphrase, answer questions, or add words that were not spoken.",
    isZh(input.language)
      ? "2. Write Mandarin Chinese in Traditional Chinese characters as used in Taiwan (繁體中文，台灣用字) with full-width punctuation. English words, names, acronyms and technical terms spoken in English stay in English (Mandarin–English code-switching is common)."
      : "2. Keep each language in its own script; keep English technical terms as spoken.",
    `3. Split into segments at sentence or speaker boundaries; a segment should be at most about 15 seconds.`,
    `4. "start" and "end" are seconds (numbers with one decimal) from the beginning of THIS clip, which is ${dur} seconds long. They must increase and stay within 0–${dur}.`,
    input.diarize
      ? '5. "speaker" labels the voice: "S1", "S2", … in order of first appearance in this clip. Keep the same label for the same voice.'
      : '5. Omit "speaker".',
    "6. Do not output segments for silence, music or noise. Write unintelligible speech as [聽不清楚]. Never repeat a phrase more times than it was actually said.",
    '7. Answer with JSON only, no prose and no code fences: {"language":"<BCP-47 code of the main language>","segments":[{"start":0.0,"end":3.2,' +
      (input.diarize ? '"speaker":"S1",' : "") +
      '"text":"…"}]}. If nothing is spoken, answer {"language":null,"segments":[]}.',
  ];
  const user: string[] = [`Expected language(s): ${langHint}.`];
  const terms = input.keyterms.map((t) => t.trim()).filter(Boolean);
  if (terms.length) user.push(`Glossary (use these exact spellings when you hear them): ${terms.join(", ")}`);
  if (input.prompt?.trim()) user.push(`Context (for spelling and continuity only; do NOT transcribe this text):\n${input.prompt.trim()}`);
  user.push("Transcribe the attached audio clip.");
  return { system: rules.join("\n"), user: user.join("\n\n") };
}

// ---------------------------------------------------------------- parsing

type RawSeg = { start?: unknown; end?: unknown; speaker?: unknown; text?: unknown };

/** "83.5", 83.5, "1:23.5", "01:23", "0:01:23.5", "83.5s" → seconds; undefined when unreadable. */
export function parseTime(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? v : undefined;
  if (typeof v !== "string") return undefined;
  const t = v.trim().replace(/s$/i, "");
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:[.,]\d+)?)$/.exec(t);
  if (!m) return undefined;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]!.replace(",", "."));
}

function stripWrappers(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
}

/**
 * Parses (and if needed repairs) a JSON answer. Returns null when there is no JSON at all.
 * Repair: a truncated answer (max tokens) is cut after the last complete segment object and closed.
 */
export function parseJsonAnswer(text: string): { value: unknown; repaired: boolean } | null {
  const s = stripWrappers(text);
  const start = s.search(/[[{]/);
  if (start < 0) return null;
  const body = s.slice(start);
  const lastClose = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
  if (lastClose >= 0) {
    try {
      return { value: JSON.parse(body.slice(0, lastClose + 1)), repaired: false };
    } catch {
      /* repair below */
    }
  }
  // Cut at successive "}" from the end and close the open array/object.
  let idx = body.lastIndexOf("}");
  for (let tries = 0; idx > 0 && tries < 200; tries++) {
    const head = body.slice(0, idx + 1);
    for (const tail of ["]}", "]", "}", "]}}", ""]) {
      try {
        return { value: JSON.parse(head + tail), repaired: true };
      } catch {
        /* next */
      }
    }
    idx = body.lastIndexOf("}", idx - 1);
  }
  return null;
}

const LINE = /^\s*[[(]?\s*((?:\d+:)?\d{1,2}:\d{2}(?:[.,]\d+)?|\d+(?:\.\d+)?s?)\s*(?:[-–~→]+\s*((?:\d+:)?\d{1,2}:\d{2}(?:[.,]\d+)?|\d+(?:\.\d+)?s?))?\s*[\])]?\s*(?:[-–:]\s*)?(?:(S\d+|Speaker\s*\w+|說話者\s*\w+)\s*[:：]\s*)?(.+)$/i;

/** `[00:12] S1: text` / `00:12 - 00:15 Speaker 2: text` lines. */
function parseLines(text: string): RawSeg[] {
  const out: RawSeg[] = [];
  for (const line of stripWrappers(text).split(/\r?\n/)) {
    const m = LINE.exec(line);
    if (m) out.push({ start: m[1], end: m[2], speaker: m[3], text: m[4] });
  }
  return out;
}

function segmentsOf(value: unknown): { segs: RawSeg[]; language: string | null } {
  if (Array.isArray(value)) return { segs: value as RawSeg[], language: null };
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    const arr = o.segments ?? o.transcript ?? o.utterances ?? o.results;
    const language = typeof o.language === "string" ? o.language : null;
    if (Array.isArray(arr)) return { segs: arr as RawSeg[], language };
    if (typeof o.text === "string") return { segs: [{ start: 0, text: o.text }], language };
  }
  return { segs: [], language: null };
}

const norm = (t: string) => t.replace(/[\s，。,.!?！？、]/g, "").toLowerCase();

/** "我們我們我們我們我們我們" → "我們" (a unit of ≥ 2 chars repeated ≥ 5 times in a row). */
export function collapseLoops(text: string): { text: string; changed: boolean } {
  const re = /(.{2,30}?)\1{4,}/gsu;
  const out = text.replace(re, "$1");
  return { text: out, changed: out !== text };
}

const SPEAKER = /^(?:s|speaker\s*|說話者\s*)?(\d+)$/i;
function speakerOf(v: unknown): string | null {
  if (typeof v === "number") return `S${v}`;
  if (typeof v !== "string" || !v.trim()) return null;
  const m = SPEAKER.exec(v.trim());
  return m ? `S${m[1]}` : v.trim().slice(0, 40);
}

export type ParsedLlmTranscript = Pick<ChunkResult, "text" | "segments" | "language" | "warnings"> & {
  /** Seconds of the clip the segments cover (end of the last one). */
  coveredSec: number;
};

/**
 * Model answer → segments relative to the clip. `durationSec` = clip length. Never throws: an unusable answer
 * yields no segments (the caller decides whether that is silence or a failure).
 */
export function parseLlmTranscript(answer: string, durationSec: number, opts: { diarize: boolean }): ParsedLlmTranscript {
  const warnings = new Set<TranscriptWarning>(["timestamps_approximate"]);
  const json = parseJsonAnswer(answer);
  let raw: RawSeg[] = [];
  let language: string | null = null;
  if (json) ({ segs: raw, language } = segmentsOf(json.value));
  if (!raw.length) raw = parseLines(answer);
  if (!raw.length && !json) {
    const plain = stripWrappers(answer);
    if (plain) {
      raw = [{ start: 0, end: durationSec, text: plain }];
      warnings.add("no_timestamps");
    }
  }
  // Text cleanup + loop trimming.
  const items: Array<{ start?: number; end?: number; speaker: string | null; text: string }> = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    let text = typeof r.text === "string" ? r.text.trim() : "";
    if (!text) continue;
    const c = collapseLoops(text);
    if (c.changed) warnings.add("repetition_trimmed");
    text = c.text;
    items.push({ start: parseTime(r.start), end: parseTime(r.end), speaker: opts.diarize ? speakerOf(r.speaker) : null, text });
  }
  // The same line ≥ 3 times in a row is a decoding loop: keep the first two.
  const dedup: typeof items = [];
  for (const it of items) {
    const n = dedup.length;
    if (n >= 2 && norm(dedup[n - 1]!.text) === norm(it.text) && norm(dedup[n - 2]!.text) === norm(it.text) && norm(it.text).length >= 2) {
      warnings.add("repetition_trimmed");
      continue;
    }
    dedup.push(it);
  }
  // Timestamps: a model that counted past the clip (e.g. used the meeting clock) is rescaled onto it.
  const dur = Math.max(0.1, durationSec);
  const maxT = Math.max(0, ...dedup.map((i) => Math.max(i.start ?? 0, i.end ?? 0)));
  const scale = maxT > dur * 1.15 && maxT > 0 ? dur / maxT : 1;
  if (!dedup.some((i) => i.start !== undefined)) {
    // No timestamps at all: spread the segments over the clip by text length.
    const total = dedup.reduce((a, i) => a + i.text.length, 0) || 1;
    let t = 0;
    for (const i of dedup) {
      i.start = t;
      t += (dur * i.text.length) / total;
      i.end = t;
    }
    if (dedup.length > 1 || !warnings.has("no_timestamps")) warnings.add("no_timestamps");
  }
  const segments: Omit<Segment, "id">[] = [];
  let prevStart = 0;
  for (let k = 0; k < dedup.length; k++) {
    const it = dedup[k]!;
    let start = it.start !== undefined ? it.start * scale : prevStart;
    start = Math.min(Math.max(start, prevStart), Math.max(0, dur - 0.1));
    const nextStart = dedup.slice(k + 1).find((n) => n.start !== undefined)?.start;
    let end = it.end !== undefined ? it.end * scale : nextStart !== undefined ? nextStart * scale : start + Math.min(15, Math.max(1, it.text.length * 0.25));
    if (!(end > start)) end = Math.min(dur, start + Math.max(0.5, Math.min(15, it.text.length * 0.25)));
    end = Math.min(end, dur);
    if (end <= start) end = Math.min(dur, start + 0.1);
    segments.push({ start: r3(start), end: r3(end), text: it.text, speaker: it.speaker, confidence: null, language: null });
    prevStart = start;
  }
  const cjk = segments.some((s) => /[㐀-鿿]/.test(s.text));
  return {
    text: segments.map((s) => s.text).join(cjk ? "" : " "),
    segments,
    language: language && /^[a-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/i.test(language) ? language : null,
    warnings: [...warnings],
    coveredSec: segments.length ? segments[segments.length - 1]!.end : 0,
  };
}
