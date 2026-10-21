import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { Config } from "./config.js";
import { JobInputError } from "./errors.js";

function isMissing(error: unknown) {
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return status === 404 || (error as { name?: string }).name === "NoSuchKey";
}

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

  /** Reads a small object as text, refusing anything larger than `maxBytes`. */
  async getText(key: string, maxBytes: number, signal?: AbortSignal): Promise<string> {
    try {
      const output = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: signal });
      if ((output.ContentLength ?? 0) > maxBytes) throw new JobInputError("專案檔案清單過大。");
      return await output.Body!.transformToString("utf8");
    } catch (error) {
      if (isMissing(error)) throw new JobInputError("找不到專案的檔案清單。");
      throw error;
    }
  }

  /** Streams an object to a local file; returns its size. A missing object is an input error. */
  async download(key: string, file: string, signal?: AbortSignal): Promise<number> {
    let body: Readable;
    try {
      const output = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: signal });
      body = output.Body as Readable;
    } catch (error) {
      if (isMissing(error)) throw new JobInputError("找不到專案中的檔案，請重新整理後再編譯。");
      throw error;
    }
    let bytes = 0;
    body.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
    });
    await pipeline(body, createWriteStream(file, { mode: 0o600 }), { signal });
    return bytes;
  }

  async uploadFile(key: string, file: string, contentType: string, signal?: AbortSignal) {
    await this.upload(key, createReadStream(file), contentType, signal);
  }

  async uploadBuffer(key: string, body: Buffer | string, contentType: string, signal?: AbortSignal) {
    await this.upload(key, body, contentType, signal);
  }

  private async upload(key: string, body: Readable | Buffer | string, contentType: string, signal?: AbortSignal) {
    const upload = new Upload({ client: this.client, params: { Bucket: this.bucket, Key: key, Body: body, ContentType: contentType } });
    const abort = () => void upload.abort().catch(() => {});
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await upload.done();
    } finally {
      signal?.removeEventListener("abort", abort);
    }
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
