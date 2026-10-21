/**
 * Text from uploaded files: transcripts (SRT / WebVTT / TXT / DOCX) and feedback documents (TXT / MD / DOCX / PDF).
 * Pure parsing, no I/O except reading a DOCX zip from a buffer.
 */
import yauzl from "yauzl";
import { extractPdfText, isPdf } from "../library/pdf.js";
import type { Segment } from "./store.js";

export type ParsedTranscript = { segments: Segment[]; speakers: { id: string; label: string | null }[]; warnings: string[]; durationSec: number | null };

const MAX_SEGMENTS = 20000;
const MAX_TEXT = 4000;

const clock = (value: string): number => {
  const m = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})(?:[,.](\d{1,3}))?$/.exec(value.trim());
  if (!m) return NaN;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number((m[4] ?? "0").padEnd(3, "0")) / 1000;
};

const cleanText = (text: string) => text.replace(/<[^>]+>/g, "").replace(/\{\\[^}]*\}/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();

/** "林雅婷：…" / "Speaker 1: …" prefixes. */
const SPEAKER_PREFIX = /^([^\s:：\[\]()（）]{1,20}(?: \d{1,2})?)\s*[:：]\s*(.+)$/s;

type Cue = { start: number; end: number; text: string; speaker: string | null };

/** Uses "名字：" prefixes as speakers only when most cues have one (avoids treating "注意：" as a person). */
function applySpeakerPrefixes(cues: Cue[]) {
  if (!cues.length || cues.some(c => c.speaker)) return;
  const hits = cues.map(c => SPEAKER_PREFIX.exec(c.text));
  const count = hits.filter(Boolean).length;
  if (count / cues.length < 0.5) return;
  const names = new Set(hits.filter(Boolean).map(h => h![1]!));
  if (names.size > Math.max(12, cues.length / 2)) return;
  cues.forEach((c, i) => {
    const h = hits[i];
    if (h) {
      c.speaker = h[1]!.trim();
      c.text = h[2]!.trim();
    }
  });
}

function toTranscript(cues: Cue[], warnings: string[]): ParsedTranscript {
  applySpeakerPrefixes(cues);
  const segments: Segment[] = cues
    .filter(c => c.text)
    .slice(0, MAX_SEGMENTS)
    .map((c, i) => ({ id: i, start: Math.round(c.start * 1000) / 1000, end: Math.round(Math.max(c.end, c.start) * 1000) / 1000, text: c.text.slice(0, MAX_TEXT), ...(c.speaker ? { speaker: c.speaker.slice(0, 40) } : {}) }));
  const speakers: { id: string; label: string | null }[] = [];
  for (const s of segments) if (s.speaker && !speakers.some(x => x.id === s.speaker)) speakers.push({ id: s.speaker, label: s.speaker });
  return { segments, speakers, warnings, durationSec: segments.length ? segments[segments.length - 1]!.end : null };
}

/** SubRip and WebVTT (cue timing lines with `-->`; VTT `<v Name>` voice tags become speakers). */
export function parseCues(source: string): ParsedTranscript {
  const cues: Cue[] = [];
  const blocks = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n").filter(l => l.trim());
    const at = lines.findIndex(l => l.includes("-->"));
    if (at < 0) continue;
    const [a = "", b = ""] = lines[at]!.split("-->");
    const start = clock(a);
    const end = clock(b.trim().split(/\s+/)[0] ?? "");
    let raw = lines.slice(at + 1).join("\n");
    let speaker: string | null = null;
    const voice = /<v(?:\.[^ >]+)?\s+([^>]{1,40})>/.exec(raw);
    if (voice) speaker = voice[1]!.trim();
    raw = cleanText(raw);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start && raw) cues.push({ start, end, text: raw, speaker });
  }
  cues.sort((x, y) => x.start - y.start);
  return toTranscript(cues, []);
}

/**
 * Plain text: one utterance per line or paragraph, optionally `[00:01:02] 名字：…` / `00:01 名字: …`.
 * Without timestamps the times are estimated from text length (≈ 4 chars/s) and `no_timestamps` is set.
 */
export function parsePlainText(source: string): ParsedTranscript {
  const lines = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n").map(l => l.trim()).filter(Boolean);
  const TIME = /^\[?\(?((?:\d{1,3}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)\)?\]?\s*[-–]?\s*(.*)$/s;
  const timed = lines.map(l => TIME.exec(l));
  const hasTimes = timed.filter(Boolean).length >= Math.max(1, lines.length * 0.5);
  const cues: Cue[] = [];
  if (hasTimes) {
    let pending: Cue | null = null;
    for (const [i, line] of lines.entries()) {
      const m = timed[i];
      if (m) {
        const start = clock(m[1]!);
        if (pending) {
          pending.end = Math.max(pending.start, start);
          cues.push(pending);
        }
        pending = { start, end: start, text: m[2]!.trim(), speaker: null };
      } else if (pending) pending.text = `${pending.text}\n${line}`.trim();
    }
    if (pending) {
      pending.end = pending.start + Math.max(2, Math.min(30, pending.text.length / 4));
      cues.push(pending);
    }
    return toTranscript(cues.filter(c => c.text && Number.isFinite(c.start)), []);
  }
  let t = 0;
  for (const line of lines) {
    const dur = Math.max(1.5, Math.min(60, line.length / 4));
    cues.push({ start: t, end: t + dur, text: line, speaker: null });
    t += dur;
  }
  return toTranscript(cues, ["no_timestamps"]);
}

// ---------------------------------------------------------------- DOCX / PDF / text

function readZipEntry(buffer: Buffer, name: string, maxBytes = 20 * 1024 * 1024): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) return reject(error ?? new Error("zip"));
      let found = false;
      zip.on("entry", (entry: yauzl.Entry) => {
        if (entry.fileName !== name) return zip.readEntry();
        found = true;
        if (entry.uncompressedSize > maxBytes) {
          zip.close();
          return reject(new Error("too large"));
        }
        zip.openReadStream(entry, (err, stream) => {
          if (err || !stream) return reject(err ?? new Error("stream"));
          const chunks: Buffer[] = [];
          stream.on("data", (c: Buffer) => chunks.push(c));
          stream.on("end", () => {
            zip.close();
            resolve(Buffer.concat(chunks));
          });
          stream.on("error", reject);
        });
      });
      zip.on("end", () => {
        if (!found) resolve(null);
      });
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}

const decodeXml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, "&");

/** Paragraph text of a .docx (word/document.xml): one line per paragraph, tabs and breaks kept. */
export async function docxText(buffer: Buffer): Promise<string> {
  const xml = await readZipEntry(buffer, "word/document.xml");
  if (!xml) throw new Error("not a docx");
  return xml
    .toString("utf8")
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:br[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .split("\n")
    .map(line => decodeXml(line).trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type FileKind = "srt" | "vtt" | "txt" | "md" | "docx" | "pdf";
export function fileKindOf(name: string): FileKind | null {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  if (ext === "srt" || ext === "vtt" || ext === "txt" || ext === "md" || ext === "docx" || ext === "pdf") return ext;
  if (ext === "markdown") return "md";
  return null;
}

/** UTF-8 text (BOM stripped); UTF-16 with BOM is decoded too (Windows exports). */
export function decodeText(buffer: Buffer): string {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString("utf16le");
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return Buffer.from(buffer.subarray(2)).swap16().toString("utf16le");
  return buffer.toString("utf8").replace(/^\uFEFF/, "");
}

export class UnreadableFile extends Error {}

/** Transcript upload → segments. SRT/VTT by cue syntax (also when a .txt contains cues), TXT/DOCX as plain text. */
export async function parseTranscriptFile(name: string, buffer: Buffer): Promise<ParsedTranscript> {
  const kind = fileKindOf(name);
  if (!kind || kind === "pdf" || kind === "md") throw new UnreadableFile("逐字稿請上傳 SRT、VTT、TXT 或 DOCX 檔。");
  let text: string;
  try {
    text = kind === "docx" ? await docxText(buffer) : decodeText(buffer);
  } catch {
    throw new UnreadableFile("無法讀取這個檔案。");
  }
  const cues = kind === "srt" || kind === "vtt" || /\d:\d{2}[,.]\d{1,3}\s*-->/.test(text);
  const parsed = cues ? parseCues(text) : parsePlainText(text);
  if (!parsed.segments.length) throw new UnreadableFile("檔案裡沒有可用的逐字稿內容。");
  return parsed;
}

/** Feedback document → plain text (≤ 200 000 chars). */
export async function feedbackFileText(name: string, buffer: Buffer): Promise<string> {
  const kind = fileKindOf(name);
  if (!kind) throw new UnreadableFile("回饋檔案請上傳 TXT、MD、DOCX 或 PDF。");
  let text: string;
  try {
    if (kind === "docx") text = await docxText(buffer);
    else if (kind === "pdf") {
      if (!isPdf(buffer)) throw new Error("not pdf");
      text = (await extractPdfText(new Uint8Array(buffer), { maxPages: 40 })).pages.join("\n\n");
    } else if (kind === "srt" || kind === "vtt") text = parseCues(decodeText(buffer)).segments.map(s => s.text).join("\n");
    else text = decodeText(buffer);
  } catch {
    throw new UnreadableFile("無法讀取這個檔案。");
  }
  return text.trim().slice(0, 200_000);
}
