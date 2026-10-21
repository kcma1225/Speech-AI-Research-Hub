/**
 * Content sources for (re-)indexing. The search module (and any module with searchable content) registers one
 * source per `owner_type`; the `ai_embedding_reindex` job walks every source to fill a new space.
 */
import type { Queryable } from "../../db.js";

export type SourceChunk = { index: number; text: string };
export type SourceItem = { ownerId: string; chunks: SourceChunk[] };

export type EmbeddingSource = {
  /** Number of owners (for progress). */
  count(db: Queryable): Promise<number>;
  /** All owners with their chunks, in a stable order. `afterId` resumes after a crash. */
  iterate(db: Queryable, opts: { afterId?: string; batchSize: number }): AsyncIterable<SourceItem>;
};

const sources = new Map<string, EmbeddingSource>();

export function registerEmbeddingSource(ownerType: string, source: EmbeddingSource) {
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(ownerType)) throw new Error(`bad owner type ${ownerType}`);
  sources.set(ownerType, source);
}

export const embeddingSources = () => [...sources.entries()];
