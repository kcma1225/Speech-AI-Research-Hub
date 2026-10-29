import { describe, expect, it } from "vitest";
import { makeZip } from "./slides-fixtures.js";
import { docxText, feedbackFileText, parseCues, parsePlainText, parseTranscriptFile, UnreadableFile } from "../src/lib/meetings/files.js";
import { buildRefs, extractJson, parseTime, toResult, transcriptLines, windows, type AnalysisInput } from "../src/lib/meetings/analysis.js";
import { composeNote } from "../src/lib/meetings/drafts.js";
import { speakerNames } from "../src/lib/meetings/store.js";

async function docx(paragraphs: string[]): Promise<Buffer> {
  const body = paragraphs.map(p => `<w:p><w:r><w:t>${p.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</w:t></w:r></w:p>`).join("");
  return makeZip([{ name: "word/document.xml", data: `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>` }]);
}

describe("transcript files", () => {
  it("parses WebVTT with voice tags and short timestamps", () => {
    const t = parseCues("WEBVTT\n\n00:01.000 --> 00:04.500\n<v 林雅婷>大家好</v>\n\nNOTE x\n\n1:00:02.000 --> 1:00:03.000 align:start\n<v.loud 王教授>好</v>");
    expect(t.segments).toEqual([
      { id: 0, start: 1, end: 4.5, text: "大家好", speaker: "林雅婷" },
      { id: 1, start: 3602, end: 3603, text: "好", speaker: "王教授" },
    ]);
    expect(t.speakers.map(s => s.id)).toEqual(["林雅婷", "王教授"]);
  });
  it("uses name prefixes only when most cues have one", () => {
    const srt = "1\n00:00:01,000 --> 00:00:02,000\n注意：這不是語者\n\n2\n00:00:03,000 --> 00:00:04,000\n一般內容\n\n3\n00:00:05,000 --> 00:00:06,000\n又一句";
    expect(parseCues(srt).segments.every(s => !s.speaker)).toBe(true);
  });
  it("parses timestamped plain text and estimates times for untimed text", () => {
    const timed = parsePlainText("[00:00:05] 林雅婷：第一句\n接續\n[00:00:12] 陳柏宇：第二句");
    expect(timed.segments).toEqual([
      { id: 0, start: 5, end: 12, text: "第一句\n接續", speaker: "林雅婷" },
      expect.objectContaining({ id: 1, start: 12, text: "第二句", speaker: "陳柏宇" }),
    ]);
    expect(timed.warnings).toEqual([]);
    const untimed = parsePlainText("第一段內容很長\n第二段");
    expect(untimed.warnings).toEqual(["no_timestamps"]);
    expect(untimed.segments[1]!.start).toBeGreaterThan(0);
  });
  it("reads DOCX transcripts and feedback, rejects unknown types", async () => {
    const file = await docx(["王教授：實驗要加 baseline", "林雅婷：好的 & 收到"]);
    expect(await docxText(file)).toBe("王教授：實驗要加 baseline\n林雅婷：好的 & 收到");
    const t = await parseTranscriptFile("會議.docx", file);
    expect(t.segments.map(s => s.speaker)).toEqual(["王教授", "林雅婷"]);
    expect(await feedbackFileText("回饋.docx", file)).toContain("baseline");
    expect(await feedbackFileText("note.md", Buffer.from("﻿# 回饋\n- 好"))).toBe("# 回饋\n- 好");
    await expect(parseTranscriptFile("x.pdf", Buffer.from("%PDF"))).rejects.toBeInstanceOf(UnreadableFile);
    await expect(parseTranscriptFile("x.srt", Buffer.from("garbage"))).rejects.toThrow("沒有可用");
    await expect(feedbackFileText("x.exe", Buffer.from("MZ"))).rejects.toBeInstanceOf(UnreadableFile);
  });
});

describe("analysis helpers", () => {
  const input: AnalysisInput = {
    title: "週會", heldAt: "2026-10-20 14:00", notes: "", language: "zh-TW",
    studies: [
      { id: "sA", title: "研究A", owner: "雅婷", summary: "", stage: null, members: [{ id: "u1", name: "雅婷", role: "owner" }], decks: [] },
      { id: "sC", title: "研究C", owner: "柏宇", summary: "", stage: null, members: [{ id: "u2", name: "柏宇", role: "owner" }, { id: "u3", name: "教授", role: "advisor" }], decks: [] },
    ],
    participants: [{ id: "u3", name: "教授" }],
    segments: [
      { id: 0, start: 0, end: 4, text: "我先報告", speaker: "S2" },
      { id: 1, start: 65, end: 70, text: "好", speaker: "S1" },
    ],
    speakerNames: new Map([["S2", "雅婷"], ["S1", null]]),
    feedback: [],
    summary: "",
  };
  it("builds refs and transcript lines without ids", () => {
    const refs = buildRefs(input);
    expect([...refs.person.entries()]).toEqual([["P1", "u3"], ["P2", "u1"], ["P3", "u2"]]);
    expect(transcriptLines(input, refs)).toEqual(["[0:00] #1 雅婷：我先報告", "[1:05] #2：好"]);
    expect(windows(["aaaa", "bbbb", "cccc"], 9)).toEqual([["aaaa"], ["bbbb"], ["cccc"]]);
    expect(windows(["aa", "bb", "cc"], 6)).toEqual([["aa", "bb"], ["cc"]]);
  });
  it("parses times and JSON replies with fences / stray [DONE]", () => {
    expect(parseTime("1:05")).toBe(65);
    expect(parseTime("[01:02:03]")).toBe(3723);
    expect(parseTime("12.5")).toBe(12.5);
    expect(Number.isNaN(parseTime("soon"))).toBe(true);
    expect(extractJson('好的：\n```json\n{"a":1}\n```\ndata: [DONE]')).toEqual({ a: 1 });
    expect(() => extractJson("none")).toThrow();
  });
  it("never assigns tasks to advisors or members of another study", () => {
    const refs = buildRefs(input);
    const r = toResult(
      {
        studies: [{ study: "r2", summary_md: "x", feedback_md: "", tasks: [{ title: "給教授", detail: "", assignee: "P1", due: "2026-02-30" }, { title: "給柏宇", detail: "", assignee: "p3", due: "2026-11-01" }], evidence: [{ time: "1:06", quote: "" }] }],
        other_md: "", speakers: [{ speaker: "#2", person: "P3", name: null, reason: "r" }, { speaker: "#9", person: "P1", name: null, reason: "" }],
      },
      input,
      refs,
    );
    const c = r.drafts.find(d => d.studyId === "sC")!;
    expect(c.tasks.map(t => [t.assignee_id, t.due])).toEqual([[null, null], ["u2", "2026-11-01"]]);
    expect(c.evidence).toEqual([{ start: 65, end: 70, quote: "好" }]);
    expect(r.drafts.find(d => d.studyId === "sA")!.summary_md).toBe("");
    expect(r.speaker_guesses).toEqual([{ label: "S1", user_id: "u2", name: null, reason: "r" }]);
  });
  it("numbers unmapped speakers in order of appearance and composes the note", () => {
    const names = speakerNames(input.segments, [{ speaker_label: "S2", user_id: "u1", name: null, user_name: "雅婷" }]);
    expect([...names.entries()]).toEqual([["S2", "雅婷"], ["S1", "語者 2"]]);
    const md = composeNote({ id: "m1", title: "週會", held_at: "2026-10-20T06:00:00Z" }, {
      summary: "- 進度", feedback: "", tasks: [{ id: "t", title: "做表", detail: "", assignee_id: "u1", due: "2026-10-27" }],
      evidence: [{ start: 65, end: 70, quote: "好" }], names: new Map([["u1", "雅婷"]]),
    });
    expect(md).toContain("（2026-10-20 14:00）");
    expect(md).toContain("## 回饋\n\n（無）");
    expect(md).toContain("- [ ] 做表（負責：雅婷，期限：2026-10-27）");
    expect(md).toContain("- [1:05](/meetings/m1?t=65) 「好」");
  });
});
