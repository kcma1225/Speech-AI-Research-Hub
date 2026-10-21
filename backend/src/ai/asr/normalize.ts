/** Pure helpers shared by adapters: units, language mapping, segmentation, speaker ids. */
import type { ChunkResult, Segment, Speaker, Word } from "./types.js";

export const r3 = (n: number) => Math.round(n * 1000) / 1000;
export const msToSec = (ms: number | string | null | undefined) => r3(Number(ms ?? 0) / 1000);

/** Google Duration strings "1.500s" or {seconds,nanos}. */
export function durationToSec(d: unknown): number {
  if (d == null) return 0;
  if (typeof d === "number") return r3(d);
  if (typeof d === "string") return r3(parseFloat(d.replace(/s$/, "")) || 0);
  const o = d as { seconds?: string | number; nanos?: number };
  return r3(Number(o.seconds ?? 0) + Number(o.nanos ?? 0) / 1e9);
}

export type LangDialect =
  | "bcp47" // zh-TW (Deepgram, Azure, AWS)
  | "iso1" // zh (OpenAI, Groq, AssemblyAI, Whisper)
  | "iso3" // zho (ElevenLabs)
  | "google"; // cmn-Hant-TW

/** Maps a BCP-47 hint ("zh-TW", "en", "auto") to a vendor dialect; undefined = let vendor detect. */
export function mapLanguage(lang: string | undefined, dialect: LangDialect): string | undefined {
  if (!lang || lang === "auto") return undefined;
  const [base = lang, region] = lang.split(/[-_]/);
  const b = base.toLowerCase();
  switch (dialect) {
    case "bcp47":
      return lang;
    case "iso1":
      return b;
    case "iso3":
      return ({ zh: "zho", en: "eng", ja: "jpn", ko: "kor", nan: "nan" } as Record<string, string>)[b] ?? b;
    case "google":
      if (b === "zh" || b === "cmn") {
        const r = (region ?? "").toUpperCase();
        if (r === "TW" || r === "HANT" || r === "HK") return "cmn-Hant-TW";
        return "cmn-Hans-CN";
      }
      if (b === "en" && !region) return "en-US";
      return lang;
  }
}

const CJK = /[㐀-鿿豈-﫿　-〿＀-￯]/;

/** Joins word tokens: no space between CJK tokens, one space between Latin tokens. */
export function joinTokens(tokens: string[]): string {
  let out = "";
  for (const raw of tokens) {
    const t = raw.trim();
    if (!t) continue;
    if (!out) {
      out = t;
      continue;
    }
    const prev = out[out.length - 1]!;
    const isPunct = /^[,.;:!?%)\]}。，、；：！？）」』]/.test(t);
    if (CJK.test(prev) || CJK.test(t[0]!) || isPunct) out += t;
    else out += " " + t;
  }
  return out;
}

/**
 * Builds segments from words: split on speaker change, pause ≥ pauseSec, sentence punctuation,
 * or a max length (maxSec / maxChars).
 */
export function segmentsFromWords(
  words: Word[],
  opts: { pauseSec?: number; maxSec?: number; maxChars?: number } = {},
): Omit<Segment, "id">[] {
  const pause = opts.pauseSec ?? 0.8;
  const maxSec = opts.maxSec ?? 30;
  const maxChars = opts.maxChars ?? 120;
  const out: Omit<Segment, "id">[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (!cur.length) return;
    const confs = cur.map((w) => w.confidence).filter((c): c is number => typeof c === "number");
    out.push({
      start: r3(cur[0]!.start),
      end: r3(cur[cur.length - 1]!.end),
      text: joinTokens(cur.map((w) => w.text)),
      speaker: cur[0]!.speaker ?? null,
      confidence: confs.length ? r3(confs.reduce((a, b) => a + b, 0) / confs.length) : null,
    });
    cur = [];
  };
  for (const w of words) {
    const last = cur[cur.length - 1];
    if (last) {
      const text = joinTokens(cur.map((x) => x.text));
      if (
        (w.speaker ?? null) !== (last.speaker ?? null) ||
        w.start - last.end >= pause ||
        w.end - cur[0]!.start > maxSec ||
        text.length >= maxChars
      )
        flush();
    }
    cur.push(w);
    const t = w.text.trim();
    if (/[。？！?!]$/.test(t) || (/\.$/.test(t) && !/^(e\.g|i\.e|etc|mr|dr|vs|al)\.$/i.test(t))) flush();
  }
  flush();
  return out;
}

/** Assigns each word the id of the segment that contains its start time. */
export function linkWords(words: Word[], segments: Segment[]): Word[] {
  let i = 0;
  for (const w of words) {
    while (i < segments.length - 1 && w.start >= segments[i]!.end && w.start >= segments[i + 1]!.start) i++;
    w.segmentId = segments[i]?.id;
  }
  return words;
}

/**
 * Renames raw vendor speaker labels ("A", "0", "spk_0", "speaker_1") to "S1", "S2"… in order of
 * first appearance, across segments and words. Returns the speaker table.
 */
export function normaliseSpeakers(segments: { speaker?: string | null }[], words: { speaker?: string | null }[] = []): Speaker[] {
  const map = new Map<string, string>();
  const speakers: Speaker[] = [];
  const idFor = (raw: string) => {
    let id = map.get(raw);
    if (!id) {
      id = `S${map.size + 1}`;
      map.set(raw, id);
      speakers.push({ id, label: raw });
    }
    return id;
  };
  for (const s of segments) if (s.speaker != null && s.speaker !== "") s.speaker = idFor(String(s.speaker));
  for (const w of words) if (w.speaker != null && w.speaker !== "") w.speaker = idFor(String(w.speaker));
  return speakers;
}

/** Single text-only segment when the vendor returns no timestamps. */
export function textOnlyResult(text: string, durationSec: number | undefined, extra: Partial<ChunkResult> = {}): ChunkResult {
  const t = text.trim();
  return {
    text: t,
    segments: t ? [{ start: 0, end: r3(durationSec ?? 0), text: t, speaker: null }] : [],
    warnings: ["no_timestamps"],
    ...extra,
  };
}
