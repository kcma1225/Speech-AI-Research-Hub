import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { Config } from "./config.js";
import { JobInputError } from "./errors.js";

export class Storage {
  readonly client: S3Client;
  readonly bucket: string;

  constructor(config: Pick<Config, "S3_ENDPOINT" | "S3_REGION" | "S3_BUCKET" | "S3_ACCESS_KEY" | "S3_SECRET_KEY">) {
    this.bucket = config.S3_BUCKET;
    this.client = new S3Client({
      endpoint: config.S3_ENDPOINT,
      region: config.S3_REGION,
      forcePathStyle: true,
      credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY },
    });
  }

  /** Streams an object to a local file. A missing object is an input error (nothing to retry). */
  async download(key: string, file: string, signal?: AbortSignal) {
    let body: Readable;
    try {
      const output = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: signal });
      body = output.Body as Readable;
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || (error as { name?: string }).name === "NoSuchKey") throw new JobInputError("找不到上傳的檔案。");
      throw error;
    }
    await pipeline(body, createWriteStream(file), { signal });
  }

  async uploadFile(key: string, file: string, contentType: string, signal?: AbortSignal) {
    const upload = new Upload({
      client: this.client,
      params: { Bucket: this.bucket, Key: key, Body: createReadStream(file), ContentType: contentType },
    });
    const abort = () => void upload.abort().catch(() => {});
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await upload.done();
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  /** True when `key` exists (HEAD). */
  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || (error as { name?: string }).name === "NotFound") return false;
      throw error;
    }
  }

  async put(key: string, body: string, contentType: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async deletePrefix(prefix: string) {
    let token: string | undefined;
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      const objects = (page.Contents ?? []).flatMap(item => (item.Key ? [{ Key: item.Key }] : []));
      if (objects.length) await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: objects, Quiet: true } }));
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".xml": "application/xml",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
};

export function contentType(file: string): string {
  const dot = file.lastIndexOf(".");
  return (dot >= 0 && CONTENT_TYPES[file.slice(dot).toLowerCase()]) || "application/octet-stream";
}
