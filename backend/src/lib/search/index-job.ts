/**
 * `ai_search_index` (ai-worker, role `embedding`): drains `search_index_queue` (filled by DB triggers on notes,
 * studies, papers, study_papers — and by modules via `enqueueSearchIndex`) and re-embeds changed chunks of each owner
 * into every live space (active + one being built by a switch). Debounced: only entries quiet for 10 s are taken; the
 * job re-queues itself for the rest. Unchanged chunks (same content hash) are never re-embedded.
 */
import type { Queryable } from "../../db.js";
import { registerAiJob } from "../../ai-worker/registry.js";
import { chunkHashes, contentHash, deleteOwnerVectors, liveSpaces } from "../../ai/embedding/spaces.js";
import type { AiPlatform } from "../../ai/platform/platform.js";
import { chunksOf, embeddingOwner } from "./sources.js";
import "./sources.js";

export const SEARCH_INDEX_JOB = "ai_search_index";
/** Entries changed more recently than this wait for the next run (editing sessions save every few seconds). */
export const QUIET_SECONDS = 10;
const BATCH_OWNERS = 50;
const EMBED_BATCH = 32;

const vecLiteral = (v: number[]) => `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(",")}]`;

/** Re-embeds one owner in one space; returns the number of chunks embedded. */
async function indexOwner(db: Queryable, platform: AiPlatform, spaceId: string, ownerType: string, ownerId: string, chunks: string[], ctx: { jobId?: string; signal?: AbortSignal }) {
  const old = await chunkHashes(db, spaceId, ownerType, ownerId);
  const hashes = chunks.map(contentHash);
  const todo = chunks.map((text, index) => ({ index, text, hash: hashes[index]! })).filter((c) => old[c.index] !== c.hash);
  if (old.length > chunks.length) {
    await db.query("DELETE FROM embeddings WHERE space_id=$1 AND owner_type=$2 AND owner_id=$3 AND chunk_index >= $4", [spaceId, ownerType, ownerId, chunks.length]);
  }
  for (let i = 0; i < todo.length; i += EMBED_BATCH) {
    const batch = todo.slice(i, i + EMBED_BATCH);
    const r = await platform.embed(batch.map((c) => c.text), "document", { spaceId, jobId: ctx.jobId, signal: ctx.signal });
    for (const [j, c] of batch.entries()) {
      await db.query(
        `INSERT INTO embeddings(space_id,owner_type,owner_id,chunk_index,content_hash,vec) VALUES($1,$2,$3,$4,$5,$6::halfvec)
         ON CONFLICT (space_id,owner_type,owner_id,chunk_index) DO UPDATE SET content_hash=EXCLUDED.content_hash, vec=EXCLUDED.vec, updated_at=now()`,
        [spaceId, ownerType, ownerId, c.index, c.hash, vecLiteral(r.vectors[j]!)],
      );
    }
  }
  return todo.length;
}

/** One drain pass (exported for tests). `quietSeconds` 0 takes everything. */
export async function drainSearchQueue(db: Queryable, platform: AiPlatform, opts: { jobId?: string; signal?: AbortSignal; quietSeconds?: number; progress?: (n: number) => Promise<void> } = {}) {
  const spaces = await liveSpaces(db);
  if (!spaces.length) {
    await db.query("DELETE FROM search_index_queue");
    return { owners: 0, chunks: 0, skipped: true };
  }
  const quiet = opts.quietSeconds ?? QUIET_SECONDS;
  let owners = 0;
  let chunks = 0;
  // Owners handled in this pass (an entry touched again meanwhile stays queued for the next run).
  const seen = new Set<string>();
  for (;;) {
    if (opts.signal?.aborted) throw new Error("aborted");
    const rows = (
      await db.query<{ owner_type: string; owner_id: string; stamp: string }>(
        // Text stamp: JS dates lose the microseconds, and the delete below compares exactly.
        `SELECT owner_type, owner_id, enqueued_at::text AS stamp FROM search_index_queue WHERE enqueued_at <= now() - make_interval(secs => $1)
          AND NOT (owner_type || ':' || owner_id::text = ANY($3::text[]))
          ORDER BY enqueued_at LIMIT $2`,
        [quiet, BATCH_OWNERS, [...seen]],
      )
    ).rows;
    if (!rows.length) break;
    for (const r of rows) seen.add(`${r.owner_type}:${r.owner_id}`);
    const byType = new Map<string, typeof rows>();
    for (const r of rows) byType.set(r.owner_type, [...(byType.get(r.owner_type) ?? []), r]);
    for (const [ownerType, list] of byType) {
      const src = embeddingOwner(ownerType);
      const loaded = src ? await src.def.load(db, list.map((r) => r.owner_id)) : new Map();
      for (const r of list) {
        const owner = loaded.get(r.owner_id);
        if (!owner) await deleteOwnerVectors(db, ownerType, r.owner_id);
        else {
          const texts = chunksOf(owner);
          for (const space of spaces) chunks += await indexOwner(db, platform, space.id, ownerType, r.owner_id, texts, opts);
        }
        // Only remove the entry if it was not touched again meanwhile.
        await db.query("DELETE FROM search_index_queue WHERE owner_type=$1 AND owner_id=$2 AND enqueued_at=$3::timestamptz", [ownerType, r.owner_id, r.stamp]);
        owners++;
      }
    }
    await opts.progress?.(owners);
  }
  return { owners, chunks, skipped: false };
}

registerAiJob(SEARCH_INDEX_JOB, {
  roles: ["embedding"],
  concurrency: 1,
  timeoutMs: 30 * 60_000,
  async run({ job, db, ai, signal, progress }) {
    await progress("indexing", 0);
    const result = await drainSearchQueue(db, ai, { jobId: job.id, signal, progress: (n) => progress("indexing", Math.min(95, n)) });
    // Entries still too fresh: make sure a later run picks them up.
    await db.query(
      `INSERT INTO jobs(kind, payload, run_after, max_attempts)
       SELECT $1, '{}'::jsonb, min(enqueued_at) + make_interval(secs => $2 + 1), 5 FROM search_index_queue
       HAVING count(*) > 0 AND NOT EXISTS (SELECT 1 FROM jobs WHERE kind = $1 AND status = 'queued')`,
      [SEARCH_INDEX_JOB, QUIET_SECONDS],
    );
    // Housekeeping: these system jobs are frequent; keep a day of history.
    await db.query(
      "DELETE FROM jobs WHERE kind=$1 AND status IN ('succeeded','cancelled') AND finalized_at IS NOT NULL AND finished_at < now() - interval '1 day'",
      [SEARCH_INDEX_JOB],
    );
    return result;
  },
});
