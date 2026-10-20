export type Cue = { start: number; end: number; text: string };

const time = (value: string) => {
  const match = /^(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(value.trim());
  if (!match) return NaN;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]!.padEnd(3, "0")) / 1000;
};

/** Parses SubRip text into cues sorted by start time; malformed blocks are skipped and markup stripped. */
export function parseSrt(source: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of source.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
    const lines = block.split("\n").filter(Boolean);
    const at = lines.findIndex(line => line.includes("-->"));
    if (at < 0) continue;
    const [a = "", b = ""] = lines[at]!.split("-->");
    const start = time(a);
    const end = time(b.trim().split(/\s+/)[0] ?? "");
    const text = lines.slice(at + 1).join("\n").replace(/<[^>]+>/g, "").replace(/\{\\[^}]*\}/g, "").trim();
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start && text) cues.push({ start, end, text: text.slice(0, 2000) });
  }
  return cues.sort((x, y) => x.start - y.start);
}
