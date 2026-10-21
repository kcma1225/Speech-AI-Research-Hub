import { describe, expect, it } from "vitest";
import { markdownExcerpt } from "../src/lib/text/excerpt.js";
import { parseSrt } from "../src/lib/media/srt.js";

describe("parseSrt", () => {
  it("parses cues, strips markup and sorts", () => {
    const cues = parseSrt("﻿2\r\n00:00:05,500 --> 00:00:07,000\r\n<i>second</i>\r\n\r\n1\n00:00:01.2 --> 00:00:02,000 X1:0\nfirst {\\an8}line\nnext\n\nbad\n00:00:09 --> nope\ntext\n");
    expect(cues).toEqual([
      { start: 1.2, end: 2, text: "first line\nnext" },
      { start: 5.5, end: 7, text: "second" },
    ]);
  });
  it("returns nothing for non-SRT text", () => {
    expect(parseSrt("hello world")).toEqual([]);
  });
});

describe("markdownExcerpt", () => {
  it("reduces Markdown to plain text", () => {
    expect(markdownExcerpt("# Title\n\n- **bold** [link](http://x) `code`\n\n```js\nhidden()\n```\n> quote")).toBe("Title bold link code quote");
    expect(markdownExcerpt("a".repeat(500), 10)).toHaveLength(10);
    expect(markdownExcerpt("- [ ] todo\n- [x] done\n\nArea $x^2$ and\n$$\n\\sum a\n$$")).toBe("todo done Area x^2 and \\sum a");
  });
});
