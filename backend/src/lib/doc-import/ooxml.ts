/** PowerPoint (.pptx) and Excel (.xlsx) → Markdown, reading the package parts directly. */
import { ooxmlTitle } from "./office.js";
import { corrupt, DocImportError } from "./errors.js";
import { gfmTable, heading, inlineText, joinBlocks, TABLE_CAPS } from "./markdown.js";
import type { Extracted } from "./types.js";
import { findAll, local, parseXml, textOf, type XNode } from "./xml.js";
import { resolvePath, withZip, type ZipArchive } from "./zip.js";

const XML_MAX = 48 * 1024 * 1024;
const MAX_SLIDES = 1000;

const is = (name: string) => (n: XNode) => local(n.tag) === name;
const kids = (n: XNode, name: string) => n.children.filter(is(name));
const kid = (n: XNode, name: string) => n.children.find(is(name));
/** The relationship id attribute (r:id, whatever the prefix). */
const relId = (n: XNode) => Object.entries(n.attrs).find(([k]) => k.includes(":") && local(k) === "id")?.[1];

async function xml(zip: ZipArchive, name: string): Promise<XNode | null> {
  const text = await zip.text(name, { maxBytes: XML_MAX });
  return text === null ? null : parseXml(text);
}

/** `<part>.rels` → Id → absolute part path (+ type). */
async function rels(zip: ZipArchive, part: string): Promise<Map<string, { target: string; type: string }>> {
  const dir = part.split("/").slice(0, -1).join("/");
  const file = part.split("/").pop()!;
  const doc = await xml(zip, `${dir ? dir + "/" : ""}_rels/${file}.rels`);
  const map = new Map<string, { target: string; type: string }>();
  if (!doc) return map;
  for (const r of findAll(doc, is("Relationship"))) {
    if (r.attrs.TargetMode === "External" || !r.attrs.Id || !r.attrs.Target) continue;
    map.set(r.attrs.Id, { target: resolvePath(part, r.attrs.Target), type: r.attrs.Type ?? "" });
  }
  return map;
}

const mismatch = (what: string) => new DocImportError(415, "content_mismatch", "檔案內容與副檔名不符。", `偵測到：ZIP 壓縮檔（不是${what}）`);

// ---------------------------------------------------------------- pptx

/** DrawingML paragraph text (runs, fields, line breaks). */
function paragraph(p: XNode): string {
  let out = "";
  for (const c of p.children) {
    const name = local(c.tag);
    if (name === "r" || name === "fld") out += textOf(kid(c, "t") ?? { tag: "", attrs: {}, children: [] });
    else if (name === "br") out += "\n";
  }
  return out.replace(/[ \t]+/g, " ").trim();
}

function placeholderType(sp: XNode): string | undefined {
  const nv = kid(sp, "nvSpPr") ?? kid(sp, "nvGraphicFramePr");
  const nvPr = nv && kid(nv, "nvPr");
  const ph = nvPr && kid(nvPr, "ph");
  return ph ? (ph.attrs.type ?? "body") : undefined;
}

function textBody(body: XNode, bullets: boolean): string {
  const lines: string[] = [];
  for (const p of kids(body, "p")) {
    const t = paragraph(p);
    if (!t) continue;
    const pPr = kid(p, "pPr");
    const lvl = Math.min(Number(pPr?.attrs.lvl ?? 0) || 0, 8);
    const text = t.split("\n").map(inlineText).join(" ");
    lines.push(bullets ? `${"  ".repeat(lvl)}- ${text}` : text);
  }
  return lines.join(bullets ? "\n" : "\n\n");
}

function drawingTable(tbl: XNode, warnings: Set<string>): string {
  const rows = kids(tbl, "tr");
  if (rows.length > TABLE_CAPS.maxRows) warnings.add(`表格超過 ${TABLE_CAPS.maxRows} 列，只匯入前 ${TABLE_CAPS.maxRows} 列。`);
  return gfmTable(
    rows.slice(0, TABLE_CAPS.maxRows).map((tr) =>
      kids(tr, "tc")
        .slice(0, TABLE_CAPS.maxCols)
        .map((tc) => {
          const body = kid(tc, "txBody");
          return body ? kids(body, "p").map(paragraph).filter(Boolean).join(" ") : "";
        }),
    ),
  );
}

/** Shapes of a slide's spTree in document order → { title, blocks }. */
function shapes(tree: XNode, warnings: Set<string>, state: { title: string; blocks: string[] }): void {
  for (const node of tree.children) {
    const name = local(node.tag);
    if (name === "sp") {
      const type = placeholderType(node);
      if (type && ["sldNum", "dt", "ftr", "hdr", "sldImg"].includes(type)) continue;
      const body = kid(node, "txBody");
      if (!body) continue;
      if ((type === "title" || type === "ctrTitle") && !state.title) {
        state.title = kids(body, "p").map(paragraph).filter(Boolean).join(" ");
        continue;
      }
      const md = textBody(body, true);
      if (md) state.blocks.push(md);
    } else if (name === "graphicFrame") {
      for (const tbl of findAll(node, is("tbl"))) {
        const md = drawingTable(tbl, warnings);
        if (md) state.blocks.push(md);
      }
    } else if (name === "grpSp") {
      shapes(node, warnings, state);
    } else if (name === "AlternateContent") {
      const choice = kid(node, "Choice") ?? kid(node, "Fallback");
      if (choice) shapes(choice, warnings, state);
    }
  }
}

export function extractPptx(bytes: Uint8Array): Promise<Extracted> {
  return withZip(bytes, async (zip) => {
    const pres = await xml(zip, "ppt/presentation.xml");
    if (!pres) throw mismatch(" PowerPoint 簡報");
    const presRels = await rels(zip, "ppt/presentation.xml");
    const ids = findAll(pres, is("sldId")).map((s) => relId(s));
    const warnings = new Set<string>();
    if (ids.length > MAX_SLIDES) warnings.add(`簡報超過 ${MAX_SLIDES} 張投影片，只匯入前 ${MAX_SLIDES} 張。`);
    const sections: string[] = [];
    let n = 0;
    for (const rid of ids.slice(0, MAX_SLIDES)) {
      n++;
      const target = rid ? presRels.get(rid)?.target : undefined;
      const slide = target ? await xml(zip, target) : null;
      if (!slide) continue;
      const state = { title: "", blocks: [] as string[] };
      const tree = findAll(slide, is("spTree"))[0];
      if (tree) shapes(tree, warnings, state);
      // Speaker notes: the notes slide's body placeholder, as a quote.
      let notes = "";
      const notesPart = [...(await rels(zip, target!)).values()].find((r) => r.type.endsWith("/notesSlide"))?.target;
      const notesDoc = notesPart ? await xml(zip, notesPart) : null;
      const notesTree = notesDoc && findAll(notesDoc, is("spTree"))[0];
      if (notesTree) {
        for (const sp of findAll(notesTree, is("sp"))) {
          if (placeholderType(sp) !== "body") continue;
          const body = kid(sp, "txBody");
          if (body) notes += textBody(body, false);
        }
      }
      sections.push(
        joinBlocks([
          heading(2, state.title || `Slide ${n}`),
          ...state.blocks,
          notes ? notes.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n") : null,
        ]),
      );
    }
    return { markdown: joinBlocks(sections), title: await ooxmlTitle(zip), pages: n, warnings: [...warnings] };
  });
}

// ---------------------------------------------------------------- xlsx

/** "BC12" → 54 (0-based column). */
function columnIndex(ref: string | undefined): number | null {
  const m = ref ? /^([A-Z]{1,3})\d*$/i.exec(ref) : null;
  if (!m) return null;
  let n = 0;
  for (const ch of m[1]!.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Shared/inline rich text: concatenated <t> of runs, phonetic runs (rPh) skipped. */
function richText(si: XNode): string {
  let out = "";
  for (const c of si.children) {
    const name = local(c.tag);
    if (name === "t") out += textOf(c);
    else if (name === "r") out += textOf(kid(c, "t") ?? { tag: "", attrs: {}, children: [] });
  }
  return out;
}

/** Cuts a worksheet's XML after its `maxRows`-th row so huge sheets are never fully parsed. */
function clipRows(sheetXml: string, maxRows: number): { xml: string; clipped: boolean } {
  let idx = 0;
  for (let i = 0; i < maxRows; i++) {
    const next = sheetXml.indexOf("</row>", idx);
    if (next < 0) return { xml: sheetXml, clipped: false };
    idx = next + 6;
  }
  if (!/<row[\s>]/.test(sheetXml.slice(idx))) return { xml: sheetXml, clipped: false };
  const open = /<([A-Za-z0-9_]+:)?sheetData[\s>]/.exec(sheetXml);
  const prefix = open?.[1] ?? "";
  const rootOpen = /<([A-Za-z0-9_]+:)?worksheet[\s>]/.exec(sheetXml);
  return { xml: `${sheetXml.slice(0, idx)}</${prefix}sheetData></${rootOpen?.[1] ?? ""}worksheet>`, clipped: true };
}

export function extractXlsx(bytes: Uint8Array): Promise<Extracted> {
  return withZip(bytes, async (zip) => {
    const book = await xml(zip, "xl/workbook.xml");
    if (!book) throw mismatch(" Excel 試算表");
    const bookRels = await rels(zip, "xl/workbook.xml");
    const sharedPart = [...bookRels.values()].find((r) => r.type.endsWith("/sharedStrings"))?.target ?? "xl/sharedStrings.xml";
    const sstDoc = await xml(zip, sharedPart);
    const shared = sstDoc ? findAll(sstDoc, is("si")).map(richText) : [];
    const warnings = new Set<string>();
    const sections: string[] = [];
    const sheets = findAll(book, is("sheet"));
    let n = 0;
    for (const sheet of sheets) {
      n++;
      const rid = relId(sheet);
      const part = rid ? bookRels.get(rid) : undefined;
      if (!part || !part.type.endsWith("/worksheet")) continue; // chartsheets, dialogs
      const raw = await zip.read(part.target, { maxBytes: XML_MAX, prefix: true });
      if (!raw) continue;
      let text = raw.data.toString("utf8");
      let clipped = raw.partial;
      const cut = clipRows(text, TABLE_CAPS.maxRows);
      if (cut.clipped) clipped = true;
      text = cut.xml;
      let doc: XNode;
      try {
        doc = parseXml(text);
      } catch {
        if (raw.partial) {
          warnings.add(`工作表「${sheet.attrs.name ?? n}」太大，略過。`);
          continue;
        }
        throw corrupt("Excel 試算表");
      }
      const rows: string[][] = [];
      let lastRow = 0;
      for (const row of findAll(doc, is("row"))) {
        const r = Number(row.attrs.r) || lastRow + 1;
        // Keep empty rows between data rows (up to the cap).
        while (rows.length < r - 1 && rows.length < TABLE_CAPS.maxRows) rows.push([]);
        lastRow = r;
        if (rows.length >= TABLE_CAPS.maxRows) {
          clipped = true;
          break;
        }
        const cells: string[] = [];
        let col = 0;
        for (const c of kids(row, "c")) {
          const idx = columnIndex(c.attrs.r) ?? col;
          col = idx + 1;
          if (idx >= TABLE_CAPS.maxCols) {
            warnings.add(`表格超過 ${TABLE_CAPS.maxCols} 欄，只匯入前 ${TABLE_CAPS.maxCols} 欄。`);
            continue;
          }
          const t = c.attrs.t;
          const v = kid(c, "v");
          let value = "";
          if (t === "s") value = shared[Number(v ? textOf(v) : -1)] ?? "";
          else if (t === "inlineStr") value = richText(kid(c, "is") ?? { tag: "", attrs: {}, children: [] });
          else if (t === "b") value = v && textOf(v) === "1" ? "TRUE" : "FALSE";
          else value = v ? textOf(v) : "";
          while (cells.length < idx) cells.push("");
          cells[idx] = value;
        }
        rows.push(cells);
      }
      if (clipped) warnings.add(`工作表超過 ${TABLE_CAPS.maxRows} 列，只匯入前 ${TABLE_CAPS.maxRows} 列。`);
      const md = gfmTable(rows);
      if (md) sections.push(joinBlocks([heading(2, sheet.attrs.name || `Sheet ${n}`), md]));
    }
    return { markdown: joinBlocks(sections), title: await ooxmlTitle(zip), warnings: [...warnings] };
  });
}
