/** Plain text, Markdown and delimited text (CSV/TSV). */
import { cleanText, gfmTable, neutralizeHtml, TABLE_CAPS } from "./markdown.js";
import type { Extracted } from "./types.js";

export type DecodedText = { text: string; encoding: string };

function tryDecode(label: string, bytes: Uint8Array): string | null {
  try {
    return new TextDecoder(label, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** UTF-8 (BOM aware), UTF-16 with BOM, else Big5, else GB18030 (never fails). */
export function decodeText(bytes: Uint8Array): DecodedText {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), encoding: "utf-8" };
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), encoding: "utf-16le" };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder("utf-16be").decode(bytes.subarray(2)), encoding: "utf-16be" };
  const utf8 = tryDecode("utf-8", bytes);
  if (utf8 !== null) return { text: utf8, encoding: "utf-8" };
  const big5 = tryDecode("big5", bytes);
  if (big5 !== null && !big5.includes("\ufffd")) return { text: big5, encoding: "big5" };
  return { text: new TextDecoder("gb18030").decode(bytes), encoding: "gb18030" };
}

/** Plain text: kept as written (paragraphs and line breaks), only `<` is escaped so it can never become HTML. */
export function extractTxt(text: string): Extracted {
  const md = cleanText(text)
    .split("\n")
    .map((l) => l.replace(/</g, "\\<"))
    .join("\n");
  return { markdown: md, title: null, warnings: [] };
}

/** Markdown: kept as written; raw HTML outside code is neutralised. Title from the first ATX heading. */
export function extractMarkdown(text: string): Extracted {
  let md = cleanText(text);
  // YAML front matter → title only.
  let title: string | null = null;
  const fm = /^---\n([\s\S]*?)\n(---|\.\.\.)\n/.exec(md);
  if (fm) {
    title = /^title:\s*["']?(.+?)["']?\s*$/m.exec(fm[1]!)?.[1] ?? null;
    md = md.slice(fm[0].length);
  }
  return { markdown: neutralizeHtml(md), title, warnings: [] };
}

/** RFC 4180-style parser (quoted fields, doubled quotes, newlines in quotes). Stops after `maxRows` rows. */
export function parseDelimited(text: string, delimiter: string, maxRows: number): { rows: string[][]; more: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const n = text.length;
  const endRow = () => {
    row.push(field);
    field = "";
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };
  while (i < n) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === "") {
      quoted = true;
      i++;
    } else if (c === delimiter) {
      row.push(field);
      field = "";
      i++;
    } else if (c === "\n" || c === "\r") {
      endRow();
      if (c === "\r" && text[i + 1] === "\n") i++;
      i++;
      if (rows.length >= maxRows) return { rows, more: /\S/.test(text.slice(i)) };
    } else {
      field += c;
      i++;
    }
  }
  if (field !== "" || row.length) endRow();
  return { rows, more: false };
}

export function extractDelimited(text: string, delimiter: "," | "\t" | ";"): Extracted {
  const warnings: string[] = [];
  const { rows, more } = parseDelimited(cleanText(text), delimiter, TABLE_CAPS.maxRows);
  if (more) warnings.push(`表格超過 ${TABLE_CAPS.maxRows} 列，只匯入前 ${TABLE_CAPS.maxRows} 列。`);
  if (rows.some((r) => r.length > TABLE_CAPS.maxCols)) warnings.push(`表格超過 ${TABLE_CAPS.maxCols} 欄，只匯入前 ${TABLE_CAPS.maxCols} 欄。`);
  return { markdown: gfmTable(rows.map((r) => r.slice(0, TABLE_CAPS.maxCols))), title: null, warnings };
}

/** Picks the CSV delimiter: "," unless ";" is clearly more common in the first lines (European locales). */
export function sniffCsvDelimiter(text: string): "," | ";" {
  const head = text.split("\n", 5).join("\n");
  const commas = (head.match(/,/g) ?? []).length;
  const semis = (head.match(/;/g) ?? []).length;
  return semis > commas ? ";" : ",";
}
