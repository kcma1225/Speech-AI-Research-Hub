/** Markdown building blocks shared by the format extractors. Output never contains raw HTML. */

// C0/C1 controls except \t \n, plus zero-width/bidi-override characters that only hide or reorder text.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b\u202a-\u202e\u2066-\u2069\ufeff\ufffe\uffff]/g;

/** Removes control characters and normalises line endings / odd spaces. */
export function cleanText(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[\u000b\u000c\u2028\u2029]/g, "\n")
    .replace(CONTROL, "")
    .replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, (c) => (c === "\u3000" ? c : " "));
}

/** Escapes inline Markdown syntax (and `<`, so text can never become HTML) in plain document text. */
export function escapeInline(s: string): string {
  return s.replace(/[\\`*_[\]<>]/g, "\\$&");
}

/** Escapes characters that would start a block construct at the beginning of a (trimmed) line. */
function escapeLineStart(line: string): string {
  if (/^(#{1,6}|[-+])(\s|$)/.test(line) || /^(=+|-{2,})$/.test(line) || line.startsWith("|")) return "\\" + line;
  const m = /^(\d{1,9})([.)])(\s|$)/.exec(line);
  return m ? m[1] + "\\" + line.slice(m[1]!.length) : line;
}

/** Plain text (one paragraph, may contain newlines) → safe Markdown paragraph. */
export function textToMarkdown(s: string): string {
  return cleanText(s)
    .split("\n")
    .map((line) => escapeLineStart(escapeInline(line.replace(/[ \t]+/g, " ").trim())))
    .join("\n")
    .trim();
}

/** Single-line text for headings, list items and table cells. */
export function inlineText(s: string): string {
  return escapeInline(cleanText(s).replace(/\s+/g, " ").trim());
}

export function heading(level: number, text: string): string {
  const t = inlineText(text);
  return t ? `${"#".repeat(Math.min(Math.max(level, 1), 6))} ${t}` : "";
}

export type TableCaps = { maxRows: number; maxCols: number };
export const TABLE_CAPS: TableCaps = { maxRows: 200, maxCols: 30 };

/**
 * Rows of cell texts (already Markdown-safe inline text, or raw when `raw`) → GFM table. The first row is the header.
 * Trailing empty rows/columns are dropped; returns "" for a table without content.
 */
export function gfmTable(rows: string[][], opts: { escape?: boolean } = {}): string {
  const esc = opts.escape !== false;
  const cells = rows.map((r) => r.map((c) => {
    const t = esc ? inlineText(c) : cleanText(c).replace(/\s*\n\s*/g, " ").trim();
    return esc ? t.replace(/\|/g, "\\|") : t.replace(/(?<!\\)\|/g, "\\|");
  }));
  while (cells.length && cells[cells.length - 1]!.every((c) => !c)) cells.pop();
  if (!cells.length) return "";
  let width = Math.max(...cells.map((r) => r.length));
  while (width > 0 && cells.every((r) => !r[width - 1])) width--;
  if (width === 0) return "";
  const line = (r: string[]) => "| " + Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ") + " |";
  return [line(cells[0]!), "|" + " --- |".repeat(width), ...cells.slice(1).map(line)].join("\n");
}

/** Final pass: clean, trim trailing spaces, collapse blank lines. */
export function finalizeMarkdown(md: string): string {
  return cleanText(md)
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const LIST_ITEM = /^(\s*)(- |\d{1,9}\. )/;

/** Joins consecutive single-line list-item blocks into one tight list. */
export function mergeLists(blocks: string[]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    const last = out[out.length - 1];
    if (last !== undefined && LIST_ITEM.test(b) && LIST_ITEM.test(last.split("\n").pop() ?? "")) out[out.length - 1] = `${last}\n${b}`;
    else out.push(b);
  }
  return out;
}

/** Joins blocks with blank lines, skipping empty ones. */
export function joinBlocks(blocks: Array<string | null | undefined | false>): string {
  return blocks.filter((b): b is string => !!b && !!b.trim()).join("\n\n");
}

const SAFE_URL = /^(https?:|mailto:)/i;
export const isSafeUrl = (href: string | null | undefined) => !!href && SAFE_URL.test(href.trim());

/**
 * Markdown that came from the user (a .md file): keeps it as written but neutralises raw HTML outside code — removes
 * script/style/iframe/object blocks and comments, escapes the `<` of every other tag. Autolinks (<https://…>) stay.
 */
export function neutralizeHtml(md: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (!buffer.length) return;
    let text = buffer.join("\n");
    text = text
      .replace(/<!--[\s\S]*?(-->|$)/g, "")
      .replace(/<(script|style|iframe|object|embed|template|noscript)\b[\s\S]*?(<\/\1\s*>|$)/gi, "");
    // Escape tags outside inline code spans.
    text = text
      .split(/(`+[^`]*`+)/)
      .map((part, i) => (i % 2 ? part : part.replace(/<(?!(https?:\/\/|mailto:)[^\s<>]*>)(?=[a-zA-Z/!?])/g, "\\<")))
      .join("");
    out.push(text);
    buffer = [];
  };
  for (const line of md.split("\n")) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      out.push(line);
      if (m && m[1]!.startsWith(fence)) fence = null;
      continue;
    }
    if (m) {
      flush();
      fence = m[1]!;
      out.push(line);
      continue;
    }
    buffer.push(line);
  }
  flush();
  return out.join("\n");
}

/** Cuts `md` to at most `max` characters, at a paragraph/line boundary when one is near. */
export function truncateMarkdown(md: string, max: number): { text: string; truncated: boolean } {
  if (md.length <= max) return { text: md, truncated: false };
  let cut = md.lastIndexOf("\n\n", max);
  if (cut < max * 0.8) cut = md.lastIndexOf("\n", max);
  if (cut < max * 0.8) cut = max;
  // Never split a surrogate pair.
  const code = md.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut--;
  return { text: md.slice(0, cut).trimEnd(), truncated: true };
}
