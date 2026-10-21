/** Word (.docx via mammoth, .doc via word-extractor) and the OLE (CFB) helpers shared with the legacy formats. */
import CFB from "cfb";
import { corrupt, DocImportError, encrypted } from "./errors.js";
import { htmlToMarkdown } from "./html.js";
import { gfmTable, joinBlocks, TABLE_CAPS, textToMarkdown } from "./markdown.js";
import type { Extracted } from "./types.js";
import { parseXml, find, textOf, local } from "./xml.js";
import { ZipArchive } from "./zip.js";

export const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
export const isOle = (b: Uint8Array) => OLE_MAGIC.every((v, i) => b[i] === v);
export const isZip = (b: Uint8Array) => b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05) ;

export function readCfb(bytes: Uint8Array): CFB.CFB$Container {
  try {
    return CFB.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), { type: "buffer" });
  } catch {
    throw corrupt();
  }
}

export function cfbStream(container: CFB.CFB$Container, name: string): Buffer | null {
  const entry = CFB.find(container, name);
  if (!entry?.content) return null;
  return Buffer.from(entry.content as Uint8Array);
}

/** An OOXML file saved with a password is an OLE container holding `EncryptedPackage` (MS-OFFCRYPTO). */
export function isEncryptedOoxml(bytes: Uint8Array): boolean {
  if (!isOle(bytes)) return false;
  try {
    const c = CFB.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), { type: "buffer" });
    return !!CFB.find(c, "EncryptedPackage") || !!CFB.find(c, "EncryptionInfo");
  } catch {
    return false;
  }
}

/** `docProps/core.xml` dc:title (OOXML). */
export async function ooxmlTitle(zip: ZipArchive): Promise<string | null> {
  const xml = await zip.text("docProps/core.xml", { maxBytes: 1024 * 1024 }).catch(() => null);
  if (!xml) return null;
  try {
    const node = find(parseXml(xml), (n) => local(n.tag) === "title");
    const t = node ? textOf(node).replace(/\s+/g, " ").trim() : "";
    return t || null;
  } catch {
    return null;
  }
}

export async function extractDocx(bytes: Uint8Array): Promise<Extracted> {
  const zip = await ZipArchive.open(bytes);
  let title: string | null;
  try {
    if (!zip.has("word/document.xml")) {
      throw new DocImportError(415, "content_mismatch", "檔案內容與副檔名不符。", "偵測到：ZIP 壓縮檔（不是 Word 文件）");
    }
    // mammoth (jszip) trusts the central directory; inflate everything once with size validation first.
    await zip.verifyAll((name) => /^word\/media\//.test(name));
    title = await ooxmlTitle(zip);
  } finally {
    zip.close();
  }
  const mammoth = (await import("mammoth")).default;
  let html: string;
  try {
    const result = await mammoth.convertToHtml(
      { buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) },
      // Images are not imported: emit nothing instead of base64 data.
      { convertImage: mammoth.images.imgElement(async () => ({ src: "" })), ignoreEmptyParagraphs: true },
    );
    html = result.value;
  } catch {
    throw corrupt("Word 文件");
  }
  const warnings = new Set<string>();
  const { markdown, title: htmlTitle } = htmlToMarkdown(`<body>${html}</body>`, warnings);
  return { markdown, title: title ?? htmlTitle, warnings: [...warnings] };
}

/** Word 97–2003 (.doc): text only (word-extractor); encrypted files are detected from the FIB. */
export async function extractDoc(bytes: Uint8Array): Promise<Extracted> {
  const cfb = readCfb(bytes);
  const wd = cfbStream(cfb, "WordDocument");
  if (!wd || wd.length < 12) throw corrupt("Word 文件");
  // FIB: wIdent 0xA5EC, flags at offset 0x0A, fEncrypted = bit 8.
  if (wd.readUInt16LE(0) !== 0xa5ec) throw corrupt("Word 文件");
  if (wd.readUInt16LE(0x0a) & 0x0100) throw encrypted();
  const WordExtractor = (await import("word-extractor")).default;
  let body: string;
  let boxes = "";
  try {
    const doc = await new WordExtractor().extract(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    body = doc.getBody();
    try {
      boxes = doc.getTextboxes({ includeHeadersAndFooters: false, includeBody: true });
    } catch {
      boxes = "";
    }
  } catch {
    throw corrupt("Word 文件");
  }
  // word-extractor ends every table cell with a tab and every row with a newline: runs of such lines are tables.
  const lines = body.split("\n");
  const blocks: string[] = [];
  let table: string[][] = [];
  const flushTable = () => {
    if (table.length) blocks.push(gfmTable(table.slice(0, TABLE_CAPS.maxRows).map((r) => r.slice(0, TABLE_CAPS.maxCols))));
    table = [];
  };
  for (const line of lines) {
    if (line.endsWith("\t")) {
      table.push(line.slice(0, -1).split("\t"));
      continue;
    }
    flushTable();
    blocks.push(textToMarkdown(line.replace(/\t/g, " ")));
  }
  flushTable();
  if (boxes.trim()) blocks.push(...boxes.split("\n").map((p) => textToMarkdown(p.replace(/\t/g, " "))));
  const title = lines.map((l) => l.trim()).find((l) => l && !l.includes("\t"))?.slice(0, 200) ?? null;
  return { markdown: joinBlocks(blocks), title, warnings: [] };
}
