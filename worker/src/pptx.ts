import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import yauzl from "yauzl";
import { JobInputError, tail } from "./errors.js";
import { run } from "./process.js";

/** Limits for reading a PPTX package (zip-bomb guard). Only the XML parts named below are ever inflated. */
export const PPTX_LIMITS = { entries: 10_000, totalBytes: 2 * 1024 * 1024 * 1024, xmlBytes: 20 * 1024 * 1024 };
const CONVERT_TIMEOUT_MS = 240_000;

/** Parts of a PPTX package the notes extractor reads, keyed by their zip path. */
export type PptxParts = Map<string, string>;

const WANTED = /^(\[Content_Types\]\.xml|ppt\/presentation\.xml|ppt\/_rels\/presentation\.xml\.rels|ppt\/slides\/slide\d+\.xml|ppt\/slides\/_rels\/slide\d+\.xml\.rels|ppt\/notesSlides\/notesSlide\d+\.xml)$/;

/**
 * Reads and validates a PPTX package: must be a ZIP with `[Content_Types].xml` and `ppt/presentation.xml`,
 * no macros (`vbaProject.bin` / macroEnabled content type), no encrypted entries, within PPTX_LIMITS.
 * Returns the XML parts needed for notes and titles.
 */
export async function readPptx(file: string): Promise<PptxParts> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(file, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: false }, (error, opened) =>
      error || !opened ? reject(new JobInputError("PPTX 檔案無法讀取（可能已加密或不是 .pptx）。")) : resolve(opened),
    ),
  );
  const parts: PptxParts = new Map();
  let entries = 0;
  let bytes = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (error: unknown) => reject(error instanceof JobInputError ? error : new JobInputError("PPTX 檔案損毀或無法讀取。"));
      zip.on("error", fail);
      zip.on("end", resolve);
      zip.on("entry", (entry: yauzl.Entry) => {
        void (async () => {
          entries += 1;
          bytes += entry.uncompressedSize;
          if (entries > PPTX_LIMITS.entries || bytes > PPTX_LIMITS.totalBytes) throw new JobInputError("PPTX 超過檔案數量或容量限制。");
          const name = entry.fileName;
          if (/(^|\/)vbaProject\.bin$/i.test(name)) throw new JobInputError("不支援含巨集的簡報。");
          if (entry.isEncrypted()) throw new JobInputError("PPTX 不可加密。");
          if (!WANTED.test(name)) return;
          if (entry.uncompressedSize > PPTX_LIMITS.xmlBytes) throw new JobInputError("PPTX 內容過大。");
          const stream = await new Promise<NodeJS.ReadableStream>((ok, ko) => zip.openReadStream(entry, (error, readable) => (error || !readable ? ko(error) : ok(readable))));
          const chunks: Buffer[] = [];
          for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
          parts.set(name, Buffer.concat(chunks).toString("utf8"));
        })().then(() => zip.readEntry(), error => {
          zip.close();
          fail(error);
        });
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
  const types = parts.get("[Content_Types].xml");
  if (!types || !parts.has("ppt/presentation.xml")) throw new JobInputError("檔案不是有效的 PPTX 簡報。");
  if (/macroEnabled/i.test(types)) throw new JobInputError("不支援含巨集的簡報。");
  return parts;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const point = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "";
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

const attr = (tag: string, name: string) => {
  const match = new RegExp(`\\s${name.replace(":", "\\:")}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(tag);
  return match ? decodeXml(match[2] ?? match[3] ?? "") : undefined;
};

/** Relationship id → { target, type } of a `.rels` part. */
export function parseRelationships(xml: string): Map<string, { target: string; type: string }> {
  const map = new Map<string, { target: string; type: string }>();
  for (const match of xml.matchAll(/<(?:\w+:)?Relationship\b[^>]*>/g)) {
    const id = attr(match[0], "Id");
    const target = attr(match[0], "Target");
    if (id && target) map.set(id, { target, type: attr(match[0], "Type") ?? "" });
  }
  return map;
}

/** Resolves a relationship target relative to the directory of the part that owns the `.rels`. */
export function resolveTarget(baseDir: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = baseDir.split("/").filter(Boolean);
  for (const segment of target.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment && segment !== ".") parts.push(segment);
  }
  return parts.join("/");
}

/** Slide part paths in presentation order (from `p:sldIdLst`). */
export function slideOrder(parts: PptxParts): string[] {
  const presentation = parts.get("ppt/presentation.xml") ?? "";
  const rels = parseRelationships(parts.get("ppt/_rels/presentation.xml.rels") ?? "");
  const list = /<p:sldIdLst\b[^>]*>([\s\S]*?)<\/p:sldIdLst>/.exec(presentation)?.[1] ?? "";
  const slides: string[] = [];
  for (const match of list.matchAll(/<p:sldId\b[^>]*>/g)) {
    const rel = rels.get(attr(match[0], "r:id") ?? "");
    if (rel) slides.push(resolveTarget("ppt", rel.target));
  }
  return slides;
}

/** Paragraphs of a shape's text body: `<a:t>` runs joined, `<a:br/>` → newline. */
function paragraphs(xml: string): string[] {
  const result: string[] = [];
  for (const paragraph of xml.matchAll(/<a:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/a:p>)/g)) {
    let text = "";
    for (const token of (paragraph[1] ?? "").matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<a:t\s*\/>|<a:br\b[^>]*\/>/g)) {
      text += token[0].startsWith("<a:br") ? "\n" : decodeXml(token[1] ?? "");
    }
    result.push(text);
  }
  return result;
}

/** Shapes (`p:sp`) with their placeholder type (`undefined` when not a placeholder). */
function shapes(xml: string): { type: string | undefined; placeholder: boolean; body: string }[] {
  return [...xml.matchAll(/<p:sp\b[^>]*>([\s\S]*?)<\/p:sp>/g)].map(match => {
    const ph = /<p:ph\b[^>]*\/?>/.exec(match[1] ?? "")?.[0];
    return { type: ph ? attr(ph, "type") : undefined, placeholder: Boolean(ph), body: match[1] ?? "" };
  });
}

/** Plain-text notes of a notes slide: the body placeholder's paragraphs (slide image and number excluded). */
export function notesFromXml(xml: string): string {
  const bodies = shapes(xml).filter(shape => shape.placeholder && (shape.type === "body" || shape.type === undefined));
  const lines = bodies.flatMap(shape => paragraphs(shape.body));
  return lines.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Text of the slide's title placeholder (`title` / `ctrTitle`), single line. */
export function titleFromXml(xml: string): string | undefined {
  const title = shapes(xml).find(shape => shape.type === "title" || shape.type === "ctrTitle");
  const text = title ? paragraphs(title.body).join(" ").replace(/\s+/g, " ").trim() : "";
  return text || undefined;
}

/** `<p:sld show="0">` slides are hidden; LibreOffice does not export them to PDF. */
export const isHiddenSlide = (xml: string) => /<p:sld\b[^>]*\sshow\s*=\s*["'](0|false)["']/.test(xml);

export type PptxSlideInfo = { title?: string; notes?: string };

/** Title and speaker notes of every visible slide, in presentation order (matches the exported PDF pages). */
export function pptxSlides(parts: PptxParts): PptxSlideInfo[] {
  const slides: PptxSlideInfo[] = [];
  for (const slidePath of slideOrder(parts)) {
    const xml = parts.get(slidePath);
    if (xml === undefined) continue;
    if (isHiddenSlide(xml)) continue;
    const dir = path.posix.dirname(slidePath);
    const rels = parseRelationships(parts.get(`${dir}/_rels/${path.posix.basename(slidePath)}.rels`) ?? "");
    const notesRel = [...rels.values()].find(rel => rel.type.endsWith("/notesSlide"));
    const notesXml = notesRel ? parts.get(resolveTarget(dir, notesRel.target)) : undefined;
    const info: PptxSlideInfo = {};
    const title = titleFromXml(xml);
    if (title) info.title = title;
    const notes = notesXml ? notesFromXml(notesXml) : "";
    if (notes) info.notes = notes;
    slides.push(info);
  }
  return slides;
}

/**
 * Converts `pptxFile` to PDF with LibreOffice headless in an isolated profile/HOME under `workDir`
 * (the worker has no network). Returns the PDF path and LibreOffice's version line.
 */
export async function convertPptx(pptxFile: string, workDir: string, signal: AbortSignal): Promise<{ pdf: string; version: string }> {
  const home = path.join(workDir, "lo-home");
  const outDir = path.join(workDir, "lo-out");
  await mkdir(home, { recursive: true });
  await mkdir(outDir, { recursive: true });
  // A fixed ASCII name: LibreOffice derives the output name from the input.
  const input = path.join(workDir, "deck.pptx");
  if (path.resolve(pptxFile) !== input) await copyFile(pptxFile, input);
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: home, LANG: "C.UTF-8", SAL_USE_VCLPLUGIN: "svp", FONTCONFIG_PATH: "/etc/fonts" };
  const result = await run("soffice", [
    `-env:UserInstallation=file://${home}/profile`,
    "--headless", "--invisible", "--nologo", "--nodefault", "--norestore", "--nolockcheck", "--nofirststartwizard",
    "--convert-to", "pdf:impress_pdf_Export", "--outdir", outDir, input,
  ], { timeoutMs: CONVERT_TIMEOUT_MS, signal, env });
  if (result.timedOut) throw new JobInputError(`PPTX 轉換逾時（${CONVERT_TIMEOUT_MS / 1000} 秒）。`);
  const produced = (await readdir(outDir)).find(name => name.toLowerCase().endsWith(".pdf"));
  if (result.code !== 0 || !produced) throw new JobInputError(`PPTX 轉換失敗：${tail(result.log, 1000) || "LibreOffice 沒有輸出 PDF。"}`);
  await rm(input, { force: true });
  const version = await run("soffice", [`-env:UserInstallation=file://${home}/profile`, "--version"], { timeoutMs: 30_000, signal, env, keepLog: 200 })
    .then(r => r.log.trim().split("\n")[0] ?? "", () => "");
  return { pdf: path.join(outDir, produced), version };
}
