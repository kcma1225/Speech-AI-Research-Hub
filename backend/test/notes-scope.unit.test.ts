// Note edits scoped to the parts the user names (「把第二段刪掉」「第三節改短」「『結論』那段」): the outline and its numbering,
// the reference resolver, the suggest_note_edit guards, 「繼續改」 section patches, language keeping, meeting-draft task
// edits and the note.continue_scoped invariant.
import { describe, expect, it } from "vitest";
import { findSection, mergeRefs, noteOutline, noteRefs, outlineView, wholeNoteAsk } from "../src/lib/notes/outline.js";
import { continuePatch, fullTextRefusal, scopeRefusal, SHORT_NOTE } from "../src/lib/notes/edit-scope.js";
import { draftMessages, languageLine, partMessages, rewriteMessages } from "../src/lib/notes/ai.js";
import { applyTaskEdits, droppedTasks } from "../src/agent/tools/more-writes.js";
import { computeHunks } from "../src/lib/suggestions/diff.js";
import { checkRun } from "../src/workflows/invariants.js";

const NOTE = [
  "# 實驗週記",
  "",
  "本週重點：baseline 與資料前處理。",
  "",
  "## 背景",
  "",
  "我們用 wav2vec2 做中文情緒辨識。",
  "",
  "## 方法",
  "",
  "第一步：抽特徵。",
  "",
  "### 資料前處理",
  "",
  "切成 4 秒片段。",
  "",
  "```python",
  "# not a heading",
  "",
  "x = 1",
  "```",
  "",
  "## 結果",
  "",
  "準確率 70%。",
  "",
  "## 結論",
  "",
  "SpecAugment 有幫助。",
  "",
].join("\n");

const slice = (text: string, r: { from: number; to: number }) => text.slice(r.from, r.to);

describe("note outline", () => {
  const o = noteOutline(NOTE);
  it("numbers sections the way they read: title not counted, ## → 1…, ### → 2.1; code fences are not headings", () => {
    expect(o.title).toBe("實驗週記");
    expect(o.sections.map((s) => `${s.n} ${s.title}`)).toEqual(["1 背景", "2 方法", "2.1 資料前處理", "3 結果", "4 結論"]);
    expect(slice(NOTE, o.sections[1]!)).toMatch(/^## 方法[\s\S]*x = 1\n```\n\n$/);
    expect(slice(NOTE, o.sections[4]!)).toBe("## 結論\n\nSpecAugment 有幫助。\n");
  });
  it("numbers paragraphs through the whole note (a code block is one paragraph)", () => {
    expect(o.paragraphs.map((p) => slice(NOTE, p).trim().split("\n")[0])).toEqual(["本週重點：baseline 與資料前處理。", "我們用 wav2vec2 做中文情緒辨識。", "第一步：抽特徵。", "切成 4 秒片段。", "```python", "準確率 70%。", "SpecAugment 有幫助。"]);
    expect(outlineView(o)[1]).toEqual({ n: "2", level: 2, title: "方法", chars: o.sections[1]!.to - o.sections[1]!.from, paragraphs: "3–5" });
  });
  it("a banner above the only # heading keeps it the title", () => {
    const b = noteOutline("> 這份筆記尚未通過驗收\n\n# 標題\n\n## A\n\na\n\n## B\n\nb\n");
    expect(b.title).toBe("標題");
    expect(b.sections.map((s) => s.n)).toEqual(["1", "2"]);
  });
  it("finds a section by number, Chinese numeral or heading", () => {
    expect(findSection(o, "2.1")?.title).toBe("資料前處理");
    expect(findSection(o, "三")?.title).toBe("結果");
    expect(findSection(o, "第四節")?.title).toBe("結論");
    expect(findSection(o, "結論")?.title).toBe("結論");
    expect(findSection(o, "不存在")).toBeNull();
  });
});

describe("what a request names", () => {
  const o = noteOutline(NOTE);
  const names = (w: string) => noteRefs(w, o, NOTE).map((r) => r.label);
  it("numbers in any order, Chinese numerals, ranges", () => {
    expect(names("把第三節改短")).toEqual(["第 3 節「結果」"]);
    expect(names("第三節幫我改短一點")).toEqual(["第 3 節「結果」"]);
    expect(names("第二到第三節")).toEqual(["第 2 節「方法」", "第 3 節「結果」"]);
    expect(names("第2.1節補充說明")).toEqual(["第 2.1 節「資料前處理」"]);
    expect(names("section 4 is too long")).toEqual(["第 4 節「結論」"]);
    expect(names("rewrite the second section")).toEqual(["第 2 節「方法」"]);
  });
  it("「第N段」 is the N-th paragraph (and, as people also say 段 for a section, the N-th section)", () => {
    expect(names("把第二段刪掉")).toEqual(["第 2 段", "第 2 節「方法」"]);
    expect(names("paragraph 6")).toEqual(["第 6 段"]);
    expect(names("最後一段改一下")).toEqual(["第 7 段"]);
  });
  it("by heading: quoted, 「X那段」, 「把X…」, English", () => {
    expect(names("『結論』那段寫得更具體")).toEqual(["第 4 節「結論」"]);
    expect(names("結論那段改成三點")).toEqual(["第 4 節「結論」"]);
    expect(names("把結論改短")).toEqual(["第 4 節「結論」"]);
    expect(names("資料前處理寫詳細一點")).toEqual(["第 2.1 節「資料前處理」"]);
    const en = noteOutline("# Notes\n\n## Method\n\nm\n\n## Conclusion\n\nc\n");
    expect(noteRefs("shorten the conclusion section", en).map((r) => r.label)).toEqual(["第 2 節「Conclusion」"]);
  });
  it("quoted body text names its paragraph", () => {
    expect(names("把「準確率 70%」那句改成 72%")).toEqual(["第 6 段"]);
  });
  it("whole-note words and nothing named", () => {
    expect(wholeNoteAsk("整篇重寫")).toBe(true);
    expect(wholeNoteAsk("翻成英文")).toBe(true);
    expect(wholeNoteAsk("rewrite the whole note")).toBe(true);
    expect(wholeNoteAsk("把第二段刪掉")).toBe(false);
    expect(names("幫我潤飾一下")).toEqual([]);
    expect(names("用別的方式說")).toEqual([]);
  });
  it("merges a paragraph inside a named section", () => {
    expect(mergeRefs(noteRefs("把第二段刪掉", o, NOTE)).map((r) => r.label)).toEqual(["第 2 段", "第 2 節「方法」"]);
    expect(mergeRefs(noteRefs("section 2 and paragraph 4", o, NOTE)).map((r) => r.label)).toEqual(["第 2 節「方法」"]);
  });
});

describe("suggest_note_edit guards", () => {
  const long = `${NOTE}\n${"補充說明。".repeat(400)}\n`;
  it("a long note's local change must use edits; a whole-note ask may send content_md once the whole note was read", () => {
    expect(long.length).toBeGreaterThan(SHORT_NOTE);
    const proposed = long.replace("準確率 70%。", "準確率 72%。");
    expect(fullTextRefusal({ text: long, proposed, words: "第三節數字改成 72%", readAll: true })).toContain("edits");
    expect(fullTextRefusal({ text: long, proposed, words: "整篇重寫得通順一點", readAll: true })).toBeNull();
    expect(fullTextRefusal({ text: long, proposed, words: "整篇重寫", readAll: false })).toContain("還沒有讀完整篇");
    expect(fullTextRefusal({ text: NOTE, proposed: NOTE.replace("70%", "72%"), words: "改數字", readAll: true })).toBeNull();
  });
  it("a whole-text proposal that drops most of the note needs a removal ask", () => {
    expect(fullTextRefusal({ text: long, proposed: NOTE, words: "整篇重寫", readAll: true })).toContain("沒有要求刪減");
    expect(fullTextRefusal({ text: long, proposed: NOTE, words: "整篇精簡", readAll: true })).toBeNull();
  });
  it("hunks outside the named parts are refused; inside them pass", () => {
    const touchConclusion = computeHunks(NOTE, NOTE.replace("SpecAugment 有幫助。", "SpecAugment 有明顯幫助。"));
    const touchBoth = computeHunks(NOTE, NOTE.replace("SpecAugment 有幫助。", "SpecAugment 有明顯幫助。").replace("準確率 70%。", ""));
    expect(scopeRefusal(NOTE, touchConclusion, "『結論』那段寫具體一點")).toBeNull();
    const r = scopeRefusal(NOTE, touchBoth, "『結論』那段寫具體一點");
    expect(r).toContain("第 3 節「結果」");
    expect(r).toContain("edits");
    expect(scopeRefusal(NOTE, touchBoth, "整篇潤飾")).toBeNull();
    expect(scopeRefusal(NOTE, touchBoth, "幫我改一下")).toBeNull();
    expect(scopeRefusal(NOTE, touchBoth, null)).toBeNull();
    // 「把第二段刪掉」: deleting paragraph 2 passes, deleting the conclusion does not.
    const p2 = noteOutline(NOTE).paragraphs[1]!;
    expect(scopeRefusal(NOTE, [{ from: p2.from, to: p2.to }], "把第二段刪掉")).toBeNull();
    expect(scopeRefusal(NOTE, touchConclusion, "把第二段刪掉")).toContain("第 4 節「結論」");
  });
});

describe("「繼續改」 proposes only the re-run sections, on the live note", () => {
  const prevDoc = "# 閱讀筆記\n\n## 摘要\n\n舊摘要。\n\n## 方法\n\n舊方法。\n\n## 結論\n\n舊結論。\n";
  const doc = prevDoc.replace("舊方法。", "新方法，含公式。");
  const prevBody = `> banner\n\n${prevDoc.replace("## 摘要", "## Summary").replace("## 方法", "## Method").replace("## 結論", "## Conclusion")}`;
  const body = `${doc.replace("## 摘要", "## Summary").replace("## 方法", "## Method").replace("## 結論", "## Conclusion")}`;
  // The user edited the summary and the conclusion since; headings are localized; the banner is there.
  const live = prevBody.replace("舊摘要。", "我自己改過的摘要。").replace("舊結論。", "我的結論。");
  it("one hunk, inside the changed section, with the localized heading; the user's edits and the banner untouched", () => {
    const p = continuePatch({ prevDoc, doc, prevBody, body, live });
    expect(p.sections).toEqual(["方法"]);
    expect(p.hunks).toHaveLength(1);
    expect(p.hunks[0]!.before).toBe("## Method\n\n舊方法。\n\n");
    expect(p.hunks[0]!.after).toBe("## Method\n\n新方法，含公式。\n\n");
    const applied = live.slice(0, p.hunks[0]!.from) + p.hunks[0]!.after + live.slice(p.hunks[0]!.to);
    expect(applied).toContain("我自己改過的摘要。");
    expect(applied).toContain("我的結論。");
    expect(applied.startsWith("> banner")).toBe(true);
  });
  it("nothing re-run → no hunks; a new section is inserted after its predecessor; a section the user deleted is reported", () => {
    expect(continuePatch({ prevDoc, doc: prevDoc, prevBody, body: prevBody, live }).hunks).toEqual([]);
    const added = prevDoc.replace("## 結論", "## 限制\n\n新段落。\n\n## 結論");
    const p = continuePatch({ prevDoc, doc: added, prevBody: prevDoc, body: added, live: prevDoc });
    expect(p.sections).toEqual(["限制"]);
    expect(p.hunks[0]).toMatchObject({ before: "", after: "## 限制\n\n新段落。\n\n" });
    expect(prevDoc.slice(0, p.hunks[0]!.from).endsWith("舊方法。\n\n")).toBe(true);
    const gone = continuePatch({ prevDoc, doc, prevBody: prevDoc, body: doc, live: prevDoc.replace("## 方法\n\n舊方法。\n\n", "") });
    expect(gone).toMatchObject({ hunks: [], unmapped: ["方法"] });
  });
  it("invariant note.continue_scoped flags an unchanged section in the patch", () => {
    const run = (sections: string[]) => ({ run: { id: "r", status: "done", state: { continue_prev_doc: prevDoc, doc, continue_sections: sections } } });
    expect(checkRun(run(["方法"]), ["note.continue_scoped"])).toEqual([]);
    const bad = checkRun(run(["方法", "摘要"]), ["note.continue_scoped"]);
    expect(bad.map((f) => f.evidence)).toEqual([{ sections: ["摘要"] }]);
  });
});

describe("note AI keeps the note's language", () => {
  const userOf = (m: { content: unknown }[]) => String(m[1]!.content);
  it("English text stays English unless the instruction asks otherwise", () => {
    expect(languageLine("We fine-tune wav2vec2 on the corpus.")).toContain("英文");
    expect(languageLine("我們微調 wav2vec2。")).toContain("繁體中文");
    expect(languageLine("We fine-tune wav2vec2 on the corpus.", "翻成中文")).toContain("繁體中文");
    expect(languageLine("我們微調 wav2vec2。", "translate into English")).toContain("英文");
    expect(String(rewriteMessages({ selection: "Teh results was good.", mode: "fix", noteTitle: "Log", context: "" })[0]!.content)).not.toContain("一律使用繁體中文");
    expect(userOf(rewriteMessages({ selection: "Teh results was good and we will try more data.", mode: "fix", noteTitle: "Log", context: "" }))).toContain("不要翻譯成中文");
    expect(userOf(draftMessages({ study: { title: "S", summary_md: "" }, note: { title: "Weekly log", content: "## Results\n\nWER dropped from 12% to 9% after augmentation.\n", event_date: null }, template: null }))).toContain("輸出也用英文");
    expect(userOf(partMessages({ part: "## Conclusion\n\nIt works well in our setting.\n", label: "第 2 節", instruction: "shorten", noteTitle: "N", before: "", after: "" }))).toContain("輸出也用英文");
  });
});

describe("meeting draft task edits", () => {
  const tasks = [
    { id: "a", title: "補 whisper 對照", detail: "", assignee_id: null, due: null },
    { id: "b", title: "畫 CER 表格", detail: "", assignee_id: null, due: null },
    { id: "c", title: "整理資料集", detail: "", assignee_id: null, due: null },
  ];
  const me = (v: string | null | undefined) => (v === "me" ? "u1" : null);
  it("removes / updates only the named task; every other task is kept as it was", () => {
    const r = applyTaskEdits(tasks, [{ op: "remove", match: "CER" }, { op: "update", index: 3, task: { due: "2026-11-01" } }, { op: "add", task: { title: "寫週報", assignee: "me" } }], me);
    expect(r.removed).toEqual(["畫 CER 表格"]);
    expect(r.tasks.map((t) => t.title)).toEqual(["補 whisper 對照", "整理資料集", "寫週報"]);
    expect(r.tasks[0]).toEqual(tasks[0]);
    expect(r.tasks[1]).toMatchObject({ id: "c", due: "2026-11-01" });
    expect(r.tasks[2]!.assignee_id).toBe("u1");
    expect(() => applyTaskEdits(tasks, [{ op: "remove", index: 9 }], me)).toThrow(/第 9 項/);
    expect(() => applyTaskEdits(tasks, [{ op: "remove", match: "不存在" }], me)).toThrow(/沒有/);
  });
  it("a full list that leaves tasks out names them", () => {
    expect(droppedTasks(tasks, [{ title: "補 whisper 對照" }, { title: "整理 資料集" }])).toEqual(["畫 CER 表格"]);
    expect(droppedTasks(tasks, [...tasks, { title: "新" }])).toEqual([]);
  });
});
