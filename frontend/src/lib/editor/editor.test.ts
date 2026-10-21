import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState, Transaction, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { displayWidth, md, nextFootnote, prefixLines, tableSkeleton } from "./markdown-commands.ts";
import { cellAt, findTable, formatTable, splitRow, table } from "./markdown-table.ts";
import { outline, textStats } from "./markdown-text.ts";
import { filterSlash, type SlashItem } from "./markdown-slash.ts";
import { isRichHtml } from "./markdown-paste.ts";

/** Minimal stand-in for EditorView: the commands only use state, dispatch and focus. */
function fakeView(doc: string, anchor = 0, head = anchor) {
  const view = {
    state: EditorState.create({ doc, selection: EditorSelection.single(anchor, head) }),
    dispatch(...specs: (Transaction | TransactionSpec)[]) {
      const tr = specs[0] instanceof Transaction ? specs[0] : view.state.update(...(specs as TransactionSpec[]));
      view.state = tr.state;
    },
    focus() {},
  };
  return view as unknown as EditorView & { state: EditorState };
}
const text = (v: EditorView) => v.state.doc.toString();
const sel = (v: EditorView) => v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to);

describe("inline formatting", () => {
  it("wraps the selection and toggles it off again", () => {
    const v = fakeView("hello world", 6, 11);
    md.bold(v, "bold");
    expect(text(v)).toBe("hello **world**");
    expect(sel(v)).toBe("world");
    md.bold(v, "bold");
    expect(text(v)).toBe("hello world");
  });
  it("inserts a placeholder without a selection", () => {
    const v = fakeView("a ", 2);
    md.strike(v, "刪除");
    expect(text(v)).toBe("a ~~刪除~~");
    expect(sel(v)).toBe("刪除");
  });
  it("italic does not eat a bold marker", () => {
    const v = fakeView("**x**", 2, 3);
    md.italic(v, "i");
    expect(text(v)).toBe("***x***");
  });
});

describe("line prefixes", () => {
  it("toggles bullets on several lines and keeps indentation", () => {
    const v = fakeView("a\n  b", 0, 5);
    md.list(v);
    expect(text(v)).toBe("- a\n  - b");
    md.list(v);
    expect(text(v)).toBe("a\n  b");
  });
  it("switches list kinds instead of nesting markers", () => {
    const v = fakeView("- a\n- b", 0, 7);
    md.ordered(v);
    expect(text(v)).toBe("1. a\n2. b");
    md.task(v);
    expect(text(v)).toBe("- [ ] a\n- [ ] b");
  });
  it("sets and clears heading levels", () => {
    const v = fakeView("## 標題", 3);
    md.setHeading(v, 3);
    expect(text(v)).toBe("### 標題");
    md.setHeading(v, 3);
    expect(text(v)).toBe("標題");
  });
  it("quote prefix", () => {
    const v = fakeView("x", 0);
    prefixLines(v, "> ", /^\s*>\s?/);
    expect(text(v)).toBe("> x");
  });
});

describe("blocks", () => {
  it("inserts blocks on their own lines", () => {
    const v = fakeView("first line", 5);
    md.hr(v);
    expect(text(v)).toBe("first line\n\n---\n");
  });
  it("replaces an empty line with a fenced code block and selects the body", () => {
    const v = fakeView("a\n\nb", 2);
    md.codeBlock(v, "python");
    expect(text(v)).toBe("a\n\n```python\n\n```\n\nb");
  });
  it("callout marks every line", () => {
    const v = fakeView("one\ntwo", 0, 7);
    md.callout(v, "warning", "x");
    expect(text(v)).toBe("> [!WARNING]\n> one\n> two\n");
  });
  it("footnotes get the next free number and a definition at the end", () => {
    const v = fakeView("見[^1]。\n\n[^1]: 一", 4);
    md.footnote(v, "註");
    expect(text(v)).toContain("[^2]");
    expect(text(v).endsWith("[^2]: 註")).toBe(true);
    expect(sel(v)).toBe("註");
    expect(nextFootnote("[^3] [^10]")).toBe(11);
  });
  it("links and images escape labels and wrap odd URLs", () => {
    const v = fakeView("", 0);
    md.link(v, "link", "https://example.org/a b", "a [b]");
    expect(text(v)).toBe("[a \\[b\\]](<https://example.org/a b>)");
    const w = fakeView("", 0);
    md.image(w, "/api/md-images/1", "圖");
    expect(text(w)).toBe("![圖](/api/md-images/1)");
  });
});

describe("tables", () => {
  const doc = "intro\n\n| 模型 | CER |\n| --- | ---: |\n| Base | 23.4 |\n| Ours | 15.1 |\n\nafter";
  it("splits rows with escaped pipes and code", () => {
    expect(splitRow("| a \\| b | `x|y` | c |")).toEqual(["a \\| b", "`x|y`", "c"]);
  });
  it("finds the table, alignment and cell under the cursor", () => {
    const state = EditorState.create({ doc });
    const pos = doc.indexOf("23.4");
    const t = findTable(state, pos)!;
    expect(t.rows).toEqual([["模型", "CER"], ["Base", "23.4"], ["Ours", "15.1"]]);
    expect(t.align).toEqual(["none", "right"]);
    expect(cellAt(state, t, pos)).toEqual({ row: 1, col: 1 });
    expect(findTable(state, 2)).toBeNull();
  });
  it("formats with CJK-aware widths", () => {
    const out = formatTable([["模型", "CER"], ["Base", "1"]], ["none", "right"]);
    expect(out.split("\n")).toEqual(["| 模型 | CER |", "| ---- | --: |", "| Base |   1 |"]);
    expect(displayWidth("模型")).toBe(4);
  });
  it("Tab selects the next cell's content", () => {
    const v = fakeView(doc, doc.indexOf("模型"));
    table.nextCell(v);
    expect(sel(v)).toBe("CER");
  });
  it("Tab moves to the next cell and adds a row at the end", () => {
    const v = fakeView(doc, doc.indexOf("15.1"));
    table.nextCell(v);
    const t = findTable(v.state, v.state.selection.main.head)!;
    expect(t.rows.length).toBe(4);
    expect(cellAt(v.state, t, v.state.selection.main.head)).toEqual({ row: 3, col: 0 });
  });
  it("adds and deletes columns, sets alignment", () => {
    const v = fakeView(doc, doc.indexOf("Base"));
    table.addColRight(v);
    let t = findTable(v.state, v.state.selection.main.head)!;
    expect(t.rows[0]!.length).toBe(3);
    table.align(v, "center");
    t = findTable(v.state, v.state.selection.main.head)!;
    expect(t.align[1]).toBe("center");
    table.deleteCol(v);
    t = findTable(v.state, v.state.selection.main.head)!;
    expect(t.rows[0]).toEqual(["模型", "CER"]);
    expect(text(v).startsWith("intro\n\n|")).toBe(true);
    expect(text(v).endsWith("\n\nafter")).toBe(true);
  });
  it("builds skeletons", () => {
    expect(tableSkeleton(1, 2, i => `H${i + 1}`)).toBe("| H1  | H2  |\n| --- | --- |\n|     |     |");
  });
});

describe("text stats and outline", () => {
  it("counts CJK characters as words and ignores Markdown syntax", () => {
    const s = textStats("## 研究問題\n\n本研究探討 **ASR** models in low-resource settings.");
    expect(s.cjk).toBe(9);
    expect(s.words).toBe(9 + 6); // ASR, models, in, low, resource, settings
  });
  it("outlines ATX and setext headings outside code fences", () => {
    const h = outline("# 一\n\n```\n# not\n```\n\n## 二 ##\n\nTitle\n=====\n\n$$\n# no\n$$\n### 三 [連結](x)");
    expect(h.map(x => [x.level, x.text, x.line])).toEqual([
      [1, "一", 1],
      [2, "二", 7],
      [1, "Title", 9],
      [3, "三 連結", 15],
    ]);
  });
});

describe("slash menu and paste", () => {
  const items: SlashItem[] = [
    { id: "table", label: "表格", keywords: "table grid 表格", section: "", run: () => true },
    { id: "h1", label: "標題 1", keywords: "h1 heading 標題", section: "", run: () => true },
    { id: "mathblock", label: "數學式區塊", keywords: "math block equation 數學", section: "", run: () => true },
  ];
  it("filters by label, id and keywords in both languages", () => {
    expect(filterSlash(items, "").length).toBe(3);
    expect(filterSlash(items, "tab").map(i => i.id)).toEqual(["table"]);
    expect(filterSlash(items, "數學").map(i => i.id)).toEqual(["mathblock"]);
    expect(filterSlash(items, "head").map(i => i.id)).toEqual(["h1"]);
    expect(filterSlash(items, "zzz")).toEqual([]);
  });
  it("only converts structured HTML", () => {
    expect(isRichHtml("<p>plain</p>", "plain")).toBe(false);
    expect(isRichHtml("<h2>Title</h2><ul><li>a</li></ul>", "Title\na")).toBe(true);
    expect(isRichHtml('<div class="cm-line"><span>const</span></div><b>x</b>', "const")).toBe(false);
  });
});
