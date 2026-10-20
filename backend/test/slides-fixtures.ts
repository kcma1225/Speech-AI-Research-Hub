import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { zlib } from "./slides-zlib.js";
import type { Db } from "../src/db.js";
import { sha256 } from "../src/lib/auth.js";

export type ZipEntry = { name: string; data?: string | Buffer; mode?: number };

/** Minimal ZIP writer (stored, no compression) so tests can craft hostile archives. */
export function makeZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? "", "utf8");
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by Unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

export async function writeZip(path: string, entries: ZipEntry[]) {
  await writeFile(path, makeZip(entries));
}

export const deckZip = (extra: ZipEntry[] = []) => makeZip([
  { name: "index.qmd", data: "---\ntitle: Test\nformat: revealjs\n---\n\n## Hello\n" },
  { name: "slides.css", data: ".reveal{}" },
  ...extra,
]);

/** Encodes a multipart/form-data body for `app.inject`. */
export function multipart(fields: Record<string, string>, file?: { field?: string; filename: string; data: Buffer; type?: string }) {
  const boundary = `----hubtest${randomBytes(8).toString("hex")}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field ?? "file"}"; filename="${file.filename}"\r\nContent-Type: ${file.type ?? "application/octet-stream"}\r\n\r\n`));
    parts.push(file.data, Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

/** Creates a user and a session directly (independent of the auth routes). */
export async function userSession(db: Db, role: "owner" | "admin" | "member" | "professor", name = `${role}-${randomBytes(3).toString("hex")}`) {
  const id = role === "owner"
    ? (await db.query<{ id: string }>("SELECT id FROM users WHERE role='owner'")).rows[0]!.id
    : (await db.query<{ id: string }>("INSERT INTO users(name,password_hash,role) VALUES($1,'x',$2) RETURNING id", [name, role])).rows[0]!.id;
  const token = randomBytes(32).toString("base64url");
  await db.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 day')", [id, sha256(token)]);
  return { id, cookie: `hub_session=${token}` };
}

export const PDF_BYTES = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(20_000, 0x20), Buffer.from("\n%%EOF\n")]);

/** Minimal PPTX package (OOXML parts the backend checks). */
export const pptxBytes = (extra: { name: string; data?: string }[] = [], types = "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml") => makeZip([
  { name: "[Content_Types].xml", data: `<?xml version="1.0"?><Types><Override PartName="/ppt/presentation.xml" ContentType="${types}"/></Types>` },
  { name: "ppt/presentation.xml", data: "<p:presentation/>" },
  { name: "ppt/slides/slide1.xml", data: "<p:sld/>" },
  ...extra,
]);
