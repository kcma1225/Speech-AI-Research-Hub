import { createDocument, type DomElement } from "@mixmark-io/domino";
import TurndownService from "turndown";
import { gfmTable, isSafeUrl, TABLE_CAPS } from "./markdown.js";

/** Elements whose content is never document text. */
const REMOVED = ["script", "style", "noscript", "iframe", "object", "embed", "template", "svg", "canvas", "img", "picture", "video", "audio", "map", "head", "title", "meta", "link", "base", "math"] as const;

let current: { warnings: Set<string> } | null = null;

function createService(): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
    strongDelimiter: "**",
    hr: "---",
  });
  const baseEscape = td.escape.bind(td);
  // Turndown leaves "<" alone; escape it so document text can never turn into raw HTML.
  td.escape = (s: string) => baseEscape(s).replace(/</g, "\\<");
  // addRule rules take precedence over turndown's built-ins (its own image rule would win over remove()).
  td.addRule("removed", { filter: [...REMOVED] as TurndownService.Filter, replacement: () => "" });
  td.addRule("listItem", {
    filter: "li",
    replacement: (content, node) => {
      const el = node as unknown as DomElement;
      const parent = el.parentNode;
      let prefix = "- ";
      if (parent?.nodeName === "OL") {
        const start = Number(parent.getAttribute("start") || 1);
        prefix = `${(Number.isFinite(start) ? start : 1) + Array.prototype.indexOf.call(parent.children, el)}. `;
      }
      const body = content.replace(/^\n+/, "").replace(/\n+$/, "\n").replace(/\n/gm, "\n" + " ".repeat(prefix.length));
      return prefix + body.trimEnd() + (el.nextSibling ? "\n" : "");
    },
  });
  td.addRule("safeLink", {
    filter: "a",
    replacement: (content, node) => {
      const href = (node as unknown as DomElement).getAttribute("href");
      const text = content.trim();
      if (!text) return "";
      return isSafeUrl(href) ? `[${text}](${href!.trim().replace(/[()<>\s]/g, (c: string) => encodeURIComponent(c))})` : text;
    },
  });
  td.addRule("strike", { filter: ["del", "s", "strike"] as TurndownService.Filter, replacement: (c) => (c.trim() ? `~~${c}~~` : "") });
  td.addRule("table", {
    filter: "table",
    replacement: (_content, node) => {
      const table = node as unknown as DomElement;
      const rows = Array.from(table.rows ?? []).filter((r) => r.closest("table") === table);
      if (rows.length > TABLE_CAPS.maxRows) current?.warnings.add(`表格超過 ${TABLE_CAPS.maxRows} 列，只匯入前 ${TABLE_CAPS.maxRows} 列。`);
      const data = rows.slice(0, TABLE_CAPS.maxRows).map((row) => {
        const cells = Array.from(row.cells ?? []);
        if (cells.length > TABLE_CAPS.maxCols) current?.warnings.add(`表格超過 ${TABLE_CAPS.maxCols} 欄，只匯入前 ${TABLE_CAPS.maxCols} 欄。`);
        return cells.slice(0, TABLE_CAPS.maxCols).map((cell) => td.turndown(cell as unknown as TurndownService.Node));
      });
      const md = gfmTable(data, { escape: false });
      return md ? `\n\n${md}\n\n` : "";
    },
  });
  // Table parts are handled by the table rule; inside it they only contribute their text.
  td.addRule("tableParts", { filter: ["caption", "colgroup", "col"] as TurndownService.Filter, replacement: () => "" });
  return td;
}

let service: TurndownService | null = null;

export type HtmlResult = { markdown: string; title: string | null };

/** HTML document/fragment → Markdown (scripts, styles, media and unsafe links removed). */
export function htmlToMarkdown(html: string, warnings: Set<string>): HtmlResult {
  const doc = createDocument(html);
  const title = (doc.title || doc.querySelector("h1")?.textContent || "").replace(/\s+/g, " ").trim() || null;
  service ??= createService();
  current = { warnings };
  try {
    const body = doc.body ?? doc.documentElement;
    const markdown = body ? service.turndown(body as unknown as TurndownService.Node) : "";
    return { markdown, title };
  } finally {
    current = null;
  }
}
