import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyRequest } from "fastify";
import { badRequest } from "../http.js";

export type ReceivedUpload = {
  fields: Record<string, string>;
  file: { path: string; filename: string; bytes: number } | null;
  cleanup(): Promise<void>;
};

/**
 * Reads a multipart request: text fields into `fields`, the single file part streamed to a temp file.
 * Exceeding `maxBytes` raises the multipart 413 error. Always call `cleanup()`.
 */
export async function receiveUpload(request: FastifyRequest, maxBytes: number): Promise<ReceivedUpload> {
  if (!request.isMultipart()) throw badRequest("請以表單上傳檔案。");
  const dir = await mkdtemp(path.join(tmpdir(), "hub-upload-"));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  const fields: Record<string, string> = {};
  let file: ReceivedUpload["file"] = null;
  try {
    for await (const part of request.parts({ limits: { fileSize: maxBytes, files: 1 } })) {
      if (part.type === "file") {
        if (file) {
          part.file.resume();
          continue;
        }
        const target = path.join(dir, "upload");
        await pipeline(part.file, createWriteStream(target));
        if (part.file.truncated) throw Object.assign(new Error("file too large"), { statusCode: 413 });
        file = { path: target, filename: part.filename, bytes: (await stat(target)).size };
      } else if (typeof part.value === "string") {
        fields[part.fieldname] = part.value;
      }
    }
  } catch (error) {
    await cleanup();
    throw error;
  }
  return { fields, file, cleanup };
}
