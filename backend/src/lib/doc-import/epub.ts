/** EPUB 2/3: container.xml → OPF → spine order → XHTML through turndown. */
import { corrupt, DocImportError, encrypted } from "./errors.js";
import { htmlToMarkdown } from "./html.js";
import { joinBlocks } from "./markdown.js";
import type { Extracted } from "./types.js";
import { find, findAll, local, parseXml, textOf } from "./xml.js";
import { resolvePath, withZip } from "./zip.js";

const MAX_SPINE = 2000;
const HTML_MAX = 16 * 1024 * 1024;

export function extractEpub(bytes: Uint8Array): Promise<Extracted> {
  return withZip(bytes, async (zip) => {
    const mime = (await zip.text("mimetype", { maxBytes: 256 }))?.trim();
    if (mime !== "application/epub+zip") {
      throw new DocImportError(415, "content_mismatch", "檔案內容與副檔名不符。", "偵測到：ZIP 壓縮檔（不是 EPUB 電子書）");
    }
    const container = await zip.text("META-INF/container.xml", { maxBytes: 1024 * 1024 });
    const rootfile = container ? find(parseXml(container), (n) => local(n.tag) === "rootfile") : undefined;
    const opfPath = rootfile?.attrs["full-path"];
    const opfText = opfPath ? await zip.text(opfPath, { maxBytes: 8 * 1024 * 1024 }) : null;
    if (!opfPath || !opfText) throw corrupt("EPUB ");
    const opf = parseXml(opfText);
    const manifest = new Map<string, { href: string; type: string }>();
    for (const item of findAll(opf, (n) => local(n.tag) === "item")) {
      if (item.attrs.id && item.attrs.href) manifest.set(item.attrs.id, { href: resolvePath(opfPath, item.attrs.href), type: item.attrs["media-type"] ?? "" });
    }
    const spine = findAll(opf, (n) => local(n.tag) === "itemref")
      .filter((r) => r.attrs.linear !== "no")
      .map((r) => manifest.get(r.attrs.idref ?? ""))
      .filter((m): m is { href: string; type: string } => !!m && /x?html/.test(m.type));
    // DRM: encryption.xml listing content documents (font obfuscation only lists fonts).
    const enc = await zip.text("META-INF/encryption.xml", { maxBytes: 4 * 1024 * 1024 });
    if (enc) {
      const encrypted_ = new Set(findAll(parseXml(enc), (n) => local(n.tag) === "CipherReference").map((c) => resolvePath("", c.attrs.URI ?? "")));
      if (spine.some((s) => encrypted_.has(s.href))) throw encrypted();
    }
    const titleNode = find(opf, (n) => local(n.tag) === "title");
    const title = (titleNode && textOf(titleNode).replace(/\s+/g, " ").trim()) || null;
    const warnings = new Set<string>();
    if (spine.length > MAX_SPINE) warnings.add(`電子書章節過多，只匯入前 ${MAX_SPINE} 個。`);
    const parts: string[] = [];
    for (const item of spine.slice(0, MAX_SPINE)) {
      const html = await zip.text(item.href, { maxBytes: HTML_MAX });
      if (html) parts.push(htmlToMarkdown(html, warnings).markdown);
    }
    return { markdown: joinBlocks(parts), title, pages: spine.length, warnings: [...warnings] };
  });
}
