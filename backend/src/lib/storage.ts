import { Readable } from "node:stream";
import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  S3Client,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { Config } from "../config.js";

export type StoredObject = {
  body: Readable;
  contentType?: string;
  contentLength?: number;
  contentRange?: string;
  etag?: string;
  lastModified?: Date;
};

/** Thin wrapper over the S3 API of RustFS. All keys live in one bucket; see docs/architecture.md "Object keys". */
export class Storage {
  readonly client: S3Client;
  constructor(readonly bucket: string, config: Pick<Config, "S3_ENDPOINT" | "S3_REGION" | "S3_ACCESS_KEY" | "S3_SECRET_KEY">) {
    this.client = new S3Client({
      endpoint: config.S3_ENDPOINT,
      region: config.S3_REGION,
      forcePathStyle: true,
      credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY },
    });
  }

  async ensureBucket() {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  /** Streams `body` to `key` with multipart upload; returns bytes written when known. */
  async put(key: string, body: Readable | Buffer | string, contentType = "application/octet-stream") {
    await new Upload({ client: this.client, params: { Bucket: this.bucket, Key: key, Body: body, ContentType: contentType } }).done();
  }

  /** Returns null when the object does not exist. `range` is a raw HTTP Range header value. */
  async get(key: string, range?: string): Promise<StoredObject | null> {
    let output: GetObjectCommandOutput;
    try {
      output = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: range }));
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || (error as { name?: string }).name === "NoSuchKey") return null;
      throw error;
    }
    return {
      body: output.Body as Readable,
      contentType: output.ContentType,
      contentLength: output.ContentLength,
      contentRange: output.ContentRange,
      etag: output.ETag,
      lastModified: output.LastModified,
    };
  }

  async getBuffer(key: string): Promise<Buffer | null> {
    const object = await this.get(key);
    if (!object) return null;
    const chunks: Buffer[] = [];
    for await (const chunk of object.body) chunks.push(Buffer.from(chunk as Uint8Array));
    return Buffer.concat(chunks);
  }

  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /** Deletes every object under `prefix` (which should end with '/'). */
  async deletePrefix(prefix: string) {
    let token: string | undefined;
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      const keys = (page.Contents ?? []).flatMap(item => (item.Key ? [{ Key: item.Key }] : []));
      if (keys.length) await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys, Quiet: true } }));
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }
}

/** Canonical object keys. Worker uses the same layout (keys arrive in job payloads). */
export const keys = {
  mediaUpload: (jobId: string) => `media/uploads/${jobId}/source`,
  itemAudio: (itemId: string, jobId: string) => `media/items/${itemId}/${jobId}.m4a`,
  /** `ext`: zip (Quarto), pdf or pptx — see SOURCE_EXTENSIONS in lib/slides/source.ts. */
  slideSource: (projectId: string, versionId: string, ext: "zip" | "pdf" | "pptx" = "zip") => `slides/${projectId}/${versionId}/source.${ext}`,
  slideOutputPrefix: (projectId: string, versionId: string) => `slides/${projectId}/${versionId}/output/`,
  /** Output of a re-index render, swapped in for `output/` by the finalizer when it succeeds. */
  slideReindexPrefix: (projectId: string, versionId: string, suffix: string) => `slides/${projectId}/${versionId}/output-${suffix}/`,
  slideProjectPrefix: (projectId: string) => `slides/${projectId}/`,
  reference: (projectId: string, referenceId: string) => `references/${projectId}/${referenceId}`,
  referenceProjectPrefix: (projectId: string) => `references/${projectId}/`,
  /** Images in Markdown documents (notes, study summary): table `md_images`, served by GET /api/md-images/:id. */
  mdImage: (studyId: string, imageId: string, ext: string) => `md-images/${studyId}/${imageId}.${ext}`,
  mdImagePrefix: (studyId: string) => `md-images/${studyId}/`,
  /** Draft image uploaded on /studies/new before the study exists (moved to `mdImage` when the study is created). */
  mdImageDraft: (userId: string, imageId: string, ext: string) => `md-images/_drafts/${userId}/${imageId}.${ext}`,
};
