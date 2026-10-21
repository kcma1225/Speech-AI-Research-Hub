/** OpenDocument text / presentation / spreadsheet (content.xml) → Markdown. */
import { corrupt, DocImportError, encrypted } from "./errors.js";
import { gfmTable, heading, inlineText, joinBlocks, TABLE_CAPS, textToMarkdown } from "./markdown.js";
import type { Extracted } from "./types.js";
import { child, childrenNamed, find, parseXml, textOf, type XNode } from "./xml.js";
import { withZip, type ZipArchive } from "./zip.js";

export const ODF_MIME = {
  odt: "application/vnd.oasis.opendocument.text",
  odp: "application/vnd.oasis.opendocument.presentation",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
} as const;
export type OdfKind = keyof typeof ODF_MIME;

const XML_MAX = 48 * 1024 * 1024;

/** Inline text of a paragraph-like element (spans, links, spaces, tabs, line breaks; notes and annotations skipped). */
function inline(node: XNode): string {
  let out = "";
  for (const c of node.children) {
    if (c.tag === "#text") out += c.text ?? "";
    else if (c.tag === "text:s") out += " ".repeat(Math.min(Number(c.attrs["text:c"] ?? 1) || 1, 100));
    else if (c.tag === "text:tab") out += " ";
    else if (c.tag === "text:line-break") out += "\n";
    else if (c.tag === "text:note" || c.tag === "office:annotation" || c.tag === "office:annotation-end" || c.tag === "text:bookmark-ref") continue;
    else if (c.tag === "draw:frame") {
      const box = child(c, "draw:text-box");
      if (box) out += " " + box.children.map(inline).join(" ") + " ";
    } else out += inline(c);
  }
  return out;
}

function paragraphText(node: XNode): string {
  return inline(node).replace(/[ \t]+/g, " ").trim();
}

/** text:list → Markdown list lines (nested lists indented). */
function list(node: XNode, depth: number, out: string[]): void {
  for (const item of node.children) {
    if (item.tag !== "text:list-item" && item.tag !== "text:list-header") continue;
    let first = true;
    for (const c of item.children) {
      if (c.tag === "text:list") list(c, depth + 1, out);
      else if (c.tag === "text:p" || c.tag === "text:h") {
        const t = inlineText(paragraphText(c));
        if (!t) continue;
        out.push(`${"  ".repeat(depth)}${first ? "- " : "  "}${t}`);
        first = false;
      }
    }
  }
}

type Grid = { rows: string[][]; cappedRows: boolean; cappedCols: boolean };

/** table:table → rows of cell texts, honouring number-*-repeated (capped, trailing empties trimmed). */
function tableGrid(table: XNode): Grid {
  const grid: Grid = { rows: [], cappedRows: false, cappedCols: false };
  const rows: XNode[] = [];
  const collect = (n: XNode) => {
    for (const c of n.children) {
      if (c.tag === "table:table-row") rows.push(c);
      else if (c.tag === "table:table-header-rows" || c.tag === "table:table-rows" || c.tag === "table:table-row-group") collect(c);
    }
  };
  collect(table);
  let pendingEmpty = 0;
  for (const row of rows) {
    const cells: string[] = [];
    for (const cell of row.children) {
      if (cell.tag !== "table:table-cell" && cell.tag !== "table:covered-table-cell") continue;
      const text = childrenNamed(cell, "text:p").map(paragraphText).filter(Boolean).join(" ");
      const repeat = Math.max(1, Number(cell.attrs["table:number-columns-repeated"] ?? 1) || 1);
      for (let i = 0; i < repeat && cells.length <= TABLE_CAPS.maxCols; i++) cells.push(text);
      if (cells.length > TABLE_CAPS.maxCols) break;
    }
    while (cells.length && !cells[cells.length - 1]) cells.pop();
    if (cells.length > TABLE_CAPS.maxCols) {
      grid.cappedCols = true;
      cells.length = TABLE_CAPS.maxCols;
    }
    const repeat = Math.max(1, Number(row.attrs["table:number-rows-repeated"] ?? 1) || 1);
    if (!cells.length) {
      pendingEmpty += repeat; // empty rows only count if content follows
      continue;
    }
    for (let i = 0; i < pendingEmpty + repeat; i++) {
      if (grid.rows.length >= TABLE_CAPS.maxRows) {
        grid.cappedRows = true;
        return grid;
      }
      grid.rows.push(i < pendingEmpty ? [] : cells);
    }
    pendingEmpty = 0;
  }
  return grid;
}

function capWarnings(grid: Grid, warnings: Set<string>) {
  if (grid.cappedRows) warnings.add(`表格超過 ${TABLE_CAPS.maxRows} 列，只匯入前 ${TABLE_CAPS.maxRows} 列。`);
  if (grid.cappedCols) warnings.add(`表格超過 ${TABLE_CAPS.maxCols} 欄，只匯入前 ${TABLE_CAPS.maxCols} 欄。`);
}

/** Block-level ODF text content (office:text, text boxes, table cells, sections). */
type Ctx = { warnings: Set<string>; levels: Map<string, number> };

function blocks(node: XNode, out: string[], ctx: Ctx): void {
  const { warnings } = ctx;
  for (const c of node.children) {
    switch (c.tag) {
      case "text:h": {
        const level = Number(c.attrs["text:outline-level"] ?? 1) || 1;
        const h = heading(level, paragraphText(c));
        if (h) out.push(h);
        break;
      }
      case "text:p": {
        const level = ctx.levels.get(c.attrs["text:style-name"] ?? "");
        out.push(level ? heading(level, paragraphText(c)) : textToMarkdown(inline(c)));
        for (const frame of c.children.filter((f) => f.tag === "draw:frame")) {
          const box = child(frame, "draw:text-box");
          if (box) blocks(box, out, ctx);
        }
        break;
      }
      case "text:list": {
        const lines: string[] = [];
        list(c, 0, lines);
        if (lines.length) out.push(lines.join("\n"));
        break;
      }
      case "table:table": {
        const grid = tableGrid(c);
        capWarnings(grid, warnings);
        const md = gfmTable(grid.rows);
        if (md) out.push(md);
        break;
      }
      case "text:tracked-changes":
      case "text:sequence-decls":
      case "office:forms":
      case "text:variable-decls":
      case "office:annotation":
      case "text:table-of-content-source":
      case "text:alphabetical-index-source":
        break;
      default:
        blocks(c, out, ctx);
    }
  }
}

/** Checks the `mimetype` entry and the manifest's encryption data. */
async function openOdf(zip: ZipArchive, kind: OdfKind): Promise<XNode> {
  const mime = (await zip.text("mimetype", { maxBytes: 256 }))?.trim();
  // Variants share the prefix: text-template, text-web (Writer/Web), text-master, presentation-template, …
  if (!mime || !(mime === ODF_MIME[kind] || mime.startsWith(`${ODF_MIME[kind]}-`))) {
    throw new DocImportError(415, "content_mismatch", "檔案內容與副檔名不符。", mime ? `偵測到：${mime}` : "偵測到：ZIP 壓縮檔");
  }
  const manifest = await zip.text("META-INF/manifest.xml", { maxBytes: 4 * 1024 * 1024 });
  if (manifest && /<manifest:encryption-data\b/.test(manifest)) throw encrypted();
  const content = await zip.text("content.xml", { maxBytes: XML_MAX });
  if (!content) throw corrupt();
  return parseXml(content);
}

/** Paragraph style name → heading level (Heading_20_N, Title, default-outline-level, through parent styles). */
async function headingStyles(zip: ZipArchive, content: XNode): Promise<Map<string, number>> {
  const defs = new Map<string, { parent?: string; level?: number }>();
  const collect = (root: XNode | undefined) => {
    if (!root) return;
    for (const st of childrenNamed(root, "style:style")) {
      const name = st.attrs["style:name"];
      if (!name || st.attrs["style:family"] !== "paragraph") continue;
      const outline = Number(st.attrs["style:default-outline-level"]);
      const named = /^Heading_20_(\d)$/.exec(name)?.[1];
      const level = outline > 0 ? outline : named ? Number(named) : name === "Title" ? 1 : undefined;
      defs.set(name, { parent: st.attrs["style:parent-style-name"], level });
    }
  };
  collect(find(content, "office:automatic-styles"));
  const stylesXml = await zip.text("styles.xml", { maxBytes: 16 * 1024 * 1024 }).catch(() => null);
  if (stylesXml) {
    const styles = parseXml(stylesXml);
    collect(find(styles, "office:styles"));
    collect(find(styles, "office:automatic-styles"));
  }
  const levels = new Map<string, number>();
  for (const name of defs.keys()) {
    let cur: string | undefined = name;
    for (let depth = 0; cur && depth < 10; depth++) {
      const d = defs.get(cur);
      if (d?.level) {
        levels.set(name, d.level);
        break;
      }
      cur = d?.parent;
    }
  }
  return levels;
}

async function odfTitle(zip: ZipArchive): Promise<string | null> {
  const meta = await zip.text("meta.xml", { maxBytes: 1024 * 1024 }).catch(() => null);
  if (!meta) return null;
  try {
    const t = find(parseXml(meta), "dc:title");
    return (t && textOf(t).replace(/\s+/g, " ").trim()) || null;
  } catch {
    return null;
  }
}

export function extractOdf(bytes: Uint8Array, kind: OdfKind): Promise<Extracted> {
  return withZip(bytes, async (zip) => {
    const doc = await openOdf(zip, kind);
    const title = await odfTitle(zip);
    const body = find(doc, "office:body");
    if (!body) throw corrupt();
    const warnings = new Set<string>();
    const ctx: Ctx = { warnings, levels: kind === "odt" ? await headingStyles(zip, doc) : new Map() };
    const out: string[] = [];
    if (kind === "odt") {
      blocks(find(body, "office:text") ?? body, out, ctx);
      return { markdown: joinBlocks(out), title, warnings: [...warnings] };
    }
    if (kind === "ods") {
      const sheet = find(body, "office:spreadsheet") ?? body;
      let n = 0;
      for (const table of childrenNamed(sheet, "table:table")) {
        n++;
        const grid = tableGrid(table);
        capWarnings(grid, warnings);
        const md = gfmTable(grid.rows);
        if (md) out.push(joinBlocks([heading(2, table.attrs["table:name"] || `Sheet ${n}`), md]));
      }
      return { markdown: joinBlocks(out), title, warnings: [...warnings] };
    }
    // odp: one section per draw:page, title from the title frame, notes as a quote.
    const pres = find(body, "office:presentation") ?? body;
    let n = 0;
    for (const page of childrenNamed(pres, "draw:page")) {
      n++;
      let slideTitle = "";
      const content: string[] = [];
      const visit = (node: XNode) => {
        for (const c of node.children) {
          if (c.tag === "presentation:notes") continue;
          if (c.tag === "draw:frame" || c.tag === "draw:custom-shape" || c.tag === "draw:rect") {
            const cls = c.attrs["presentation:class"];
            if (cls === "page-number" || cls === "footer" || cls === "date-time" || cls === "header") continue;
            const box = child(c, "draw:text-box") ?? c;
            if (cls === "title" && !slideTitle) {
              slideTitle = textOf(box).replace(/\s+/g, " ").trim();
              continue;
            }
            const table = child(c, "table:table");
            if (table) {
              const grid = tableGrid(table);
              capWarnings(grid, warnings);
              content.push(gfmTable(grid.rows));
              continue;
            }
            const inner: string[] = [];
            blocks(box, inner, ctx);
            // Slide body paragraphs read as bullets.
            content.push(inner.map((b) => (/^(#|- |\||\s)/.test(b) ? b : b.split("\n").map((l) => `- ${l}`).join("\n"))).join("\n"));
          } else if (c.tag === "draw:g") visit(c);
        }
      };
      visit(page);
      const notes: string[] = [];
      const notesNode = child(page, "presentation:notes");
      if (notesNode) {
        for (const frame of childrenNamed(notesNode, "draw:frame")) {
          if (frame.attrs["presentation:class"] !== "notes") continue;
          blocks(child(frame, "draw:text-box") ?? frame, notes, ctx);
        }
      }
      out.push(
        joinBlocks([
          heading(2, slideTitle || `Slide ${n}`),
          ...content,
          notes.length ? notes.join("\n\n").split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n") : null,
        ]),
      );
    }
    return { markdown: joinBlocks(out), title, pages: n, warnings: [...warnings] };
  });
}
