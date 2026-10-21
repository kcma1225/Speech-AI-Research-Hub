import yauzl from "yauzl";
import { corrupt, DocImportError, encrypted } from "./errors.js";

/** Zip-bomb limits for office/EPUB containers. */
export const ZIP_IMPORT_LIMITS = { entries: 5000, totalBytes: 150 * 1024 * 1024, entryBytes: 64 * 1024 * 1024 };

const tooBig = () => new DocImportError(422, "corrupt", "檔案解壓縮後過大或格式異常，無法匯入。");

/** An in-memory ZIP read with yauzl (entry sizes validated against the stream; reads share one byte budget). */
export class ZipArchive {
  private budget = ZIP_IMPORT_LIMITS.totalBytes;
  private constructor(private readonly zip: yauzl.ZipFile, private readonly entries: Map<string, yauzl.Entry>) {}

  static open(bytes: Uint8Array): Promise<ZipArchive> {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return new Promise((resolve, reject) => {
      yauzl.fromBuffer(buffer, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: false }, (error, zip) => {
        if (error || !zip) return reject(corrupt());
        const entries = new Map<string, yauzl.Entry>();
        zip.on("entry", (entry: yauzl.Entry) => {
          if (entries.size >= ZIP_IMPORT_LIMITS.entries) {
            zip.close();
            return reject(tooBig());
          }
          entries.set(entry.fileName, entry);
          zip.readEntry();
        });
        zip.on("end", () => resolve(new ZipArchive(zip, entries)));
        zip.on("error", () => reject(corrupt()));
        zip.readEntry();
      });
    });
  }

  get names(): string[] {
    return [...this.entries.keys()];
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** Case-insensitive lookup (some writers vary the case of OOXML part names). */
  resolve(name: string): string | undefined {
    if (this.entries.has(name)) return name;
    const lower = name.toLowerCase();
    return this.names.find((n) => n.toLowerCase() === lower);
  }

  /**
   * Reads an entry. With `prefix`, an entry larger than `maxBytes` is cut at `maxBytes` (returned with `partial`);
   * otherwise it is rejected. Missing entry → null.
   */
  async read(name: string, opts: { maxBytes?: number; prefix?: boolean } = {}): Promise<{ data: Buffer; partial: boolean } | null> {
    const key = this.resolve(name);
    const entry = key === undefined ? undefined : this.entries.get(key);
    if (!entry || entry.fileName.endsWith("/")) return null;
    if (entry.isEncrypted()) throw encrypted();
    const maxBytes = Math.min(opts.maxBytes ?? ZIP_IMPORT_LIMITS.entryBytes, ZIP_IMPORT_LIMITS.entryBytes);
    if (entry.uncompressedSize > maxBytes && !opts.prefix) throw tooBig();
    const limit = Math.min(entry.uncompressedSize, maxBytes);
    if (limit > this.budget) throw tooBig();
    const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) =>
      this.zip.openReadStream(entry, (error, s) => (error || !s ? reject(corrupt()) : resolve(s))),
    );
    const chunks: Buffer[] = [];
    let size = 0;
    let partial = false;
    try {
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        const room = limit - size;
        if (chunk.length >= room) {
          chunks.push(chunk.subarray(0, room));
          size += room;
          partial = entry.uncompressedSize > limit;
          break;
        }
        chunks.push(chunk);
        size += chunk.length;
      }
    } catch (error) {
      if (error instanceof DocImportError) throw error;
      throw corrupt();
    } finally {
      (stream as unknown as { destroy?: () => void }).destroy?.();
    }
    this.budget -= size;
    return { data: Buffer.concat(chunks, size), partial };
  }

  async text(name: string, opts: { maxBytes?: number; prefix?: boolean } = {}): Promise<string | null> {
    const r = await this.read(name, opts);
    return r ? r.data.toString("utf8") : null;
  }

  /**
   * Inflates every entry once (discarding the data) so that the real sizes are validated against the budget before a
   * third-party parser that trusts the central directory (mammoth/jszip) touches the archive.
   */
  async verifyAll(skip: (name: string) => boolean = () => false): Promise<void> {
    for (const name of this.names) {
      if (name.endsWith("/") || skip(name)) continue;
      await this.read(name);
    }
  }

  close(): void {
    this.zip.close();
  }
}

/** Opens a ZIP, runs `fn`, always closes it. */
export async function withZip<T>(bytes: Uint8Array, fn: (zip: ZipArchive) => Promise<T>): Promise<T> {
  const zip = await ZipArchive.open(bytes);
  try {
    return await fn(zip);
  } finally {
    zip.close();
  }
}

/** Resolves an archive-relative href against the directory of `base` (OOXML relationships, EPUB manifests). */
export function resolvePath(base: string, href: string): string {
  let clean = href.split("#")[0]!.split("?")[0]!;
  try {
    clean = decodeURIComponent(clean);
  } catch {
    /* keep as is */
  }
  if (clean.startsWith("/")) return clean.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const seg of clean.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}
