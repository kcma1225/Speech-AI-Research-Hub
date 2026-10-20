import { describe, expect, it } from "vitest";
import { buildManifest, notesHtml, notesText, pageImageName, parsePdfInfo, type NotesNode } from "../src/pages.js";

describe("page manifest", () => {
  it("builds a versioned manifest with relative keys and cleaned notes", () => {
    const manifest = buildManifest("quarto", { width: 1050, height: 700 }, [
      { index: 1, h: 0, thumb: pageImageName(1, "thumb"), title: "Intro", notes: { text: "  hello\r\n\r\n\r\n\r\nworld  ", html: "<p>hello</p><p>world</p>" } },
      { index: 2, h: 1, v: 1, thumb: pageImageName(2, "thumb"), notes: { text: "   " } },
    ]);
    expect(manifest).toEqual({
      version: 1,
      sourceType: "quarto",
      width: 1050,
      height: 700,
      pages: [
        { index: 1, h: 0, title: "Intro", thumb: "_hub/pages/1-thumb.webp", notes: { text: "hello\n\nworld", html: "<p>hello</p><p>world</p>" } },
        { index: 2, h: 1, v: 1, thumb: "_hub/pages/2-thumb.webp" },
      ],
    });
    expect(buildManifest("pdf", { width: 0, height: 0 }, []).width).toBe(16);
  });

  it("parses pdfinfo output", () => {
    const info = parsePdfInfo("Title: x\nPages:          12\nEncrypted:      no\nPage size:      720 x 405 pts\n");
    expect(info).toEqual({ pages: 12, width: 720, height: 405, encrypted: false });
    expect(parsePdfInfo("Encrypted: yes (print:yes)\n").encrypted).toBe(true);
  });
});

describe("speaker notes", () => {
  const tree: NotesNode[] = [
    { tag: "p", children: ["Say ", { tag: "strong", children: ["this"] }, " & ", { tag: "b", children: ["that"] }] },
    { tag: "ul", children: [{ tag: "li", children: ["one"] }, { tag: "li", children: [{ tag: "code", children: ["x<y"] }] }] },
    { tag: "p", children: [{ tag: "a", href: "https://example.org/?a=1&b=\"2\"", children: ["link"] }, { tag: "br", children: [] }, { tag: "a", href: "javascript:alert(1)", children: ["bad"] }] },
    { tag: "script", children: ["alert(1)"] },
    { tag: "img", children: [] },
    { tag: "div", children: [{ tag: "span", children: ["<img src=x onerror=alert(1)>"] }] },
  ];

  it("keeps only the allowed tags and escapes everything else", () => {
    const html = notesHtml(tree);
    expect(html).toBe(
      '<p>Say <strong>this</strong> &amp; <strong>that</strong></p><ul><li>one</li><li><code>x&lt;y</code></li></ul>' +
      '<p><a href="https://example.org/?a=1&amp;b=&quot;2&quot;">link</a><br>bad</p>alert(1)&lt;img src=x onerror=alert(1)&gt;',
    );
    expect(html).not.toMatch(/<(script|img|span|div)/);
    expect(notesHtml([{ tag: "p", children: "nope" } as unknown as NotesNode, 42 as unknown as NotesNode])).toBe("");
  });

  it("produces plain text with paragraph breaks", () => {
    expect(notesText(tree)).toBe("Say this & that\n\n• one\n• x<y\n\nlink\nbad\n\nalert(1)\n\n<img src=x onerror=alert(1)>");
  });
});
