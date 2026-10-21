/** `ai_embedding_reindex` (ai-worker): fills a space from every registered embedding source. */
import { registerAiJob, AiJobInputError } from "../../ai-worker/registry.js";
import { embeddingSources } from "./sources.js";
import { chunkHashes, contentHash, getSpace, upsertVectors } from "./spaces.js";
import { REINDEX_JOB, type ReindexPayload } from "./switch.js";

const BATCH = 64;

registerAiJob<ReindexPayload>(REINDEX_JOB, {
  roles: ["embedding"],
  concurrency: 1,
  timeoutMs: 12 * 3600_000,
  async run({ job, db, ai, signal, progress, checkpoint, saveCheckpoint }) {
    const spaceId = job.payload?.spaceId;
    if (!spaceId) throw new AiJobInputError("缺少向量空間。");
    let space = await getSpace(db, spaceId);
    if (!space || !["building", "active"].includes(space.status)) return { skipped: true };
    const sources = embeddingSources();
    let total = 0;
    for (const [, s] of sources) total += await s.count(db);
    await db.query("UPDATE embedding_spaces SET items_total=$2 WHERE id=$1", [spaceId, total]);
    const cp = (checkpoint ?? {}) as { ownerType?: string; afterId?: string; done?: number };
    let done = cp.done ?? 0;
    let skipping = Boolean(cp.ownerType);
    await progress("embedding", total ? (done / total) * 100 : 0);
    for (const [ownerType, source] of sources) {
      if (skipping && ownerType !== cp.ownerType) continue;
      const afterId = skipping ? cp.afterId : undefined;
      skipping = false;
      for await (const item of source.iterate(db, { afterId, batchSize: BATCH })) {
        if (signal.aborted) throw new Error("aborted");
        const old = await chunkHashes(db, spaceId, ownerType, item.ownerId);
        const hashes = item.chunks.map((c) => contentHash(c.text));
        const todo = item.chunks.filter((c, i) => old[c.index] !== hashes[i]);
        if (todo.length || old.length !== item.chunks.length) {
          const vectors: number[][] = [];
          for (let i = 0; i < todo.length; i += BATCH) {
            const r = await ai.embed(todo.slice(i, i + BATCH).map((c) => c.text), "document", { spaceId, jobId: job.id, signal });
            vectors.push(...r.vectors);
          }
          const byIndex = new Map(todo.map((c, i) => [c.index, vectors[i]!]));
          // Unchanged chunks keep their vectors: re-read them is unnecessary, upsertVectors only touches given rows.
          const chunks = item.chunks
            .map((c, i) => ({ index: c.index, contentHash: hashes[i]!, vec: byIndex.get(c.index) }))
            .filter((c): c is { index: number; contentHash: string; vec: number[] } => Boolean(c.vec));
          space = await getSpace(db, spaceId);
          if (!space) return { cancelled: true };
          await db.query("DELETE FROM embeddings WHERE space_id=$1 AND owner_type=$2 AND owner_id=$3 AND chunk_index >= $4", [spaceId, ownerType, item.ownerId, item.chunks.length]);
          if (chunks.length) await upsertVectorsKeep(db, spaceId, ownerType, item.ownerId, chunks);
        }
        done++;
        if (done % 20 === 0) {
          await db.query("UPDATE embedding_spaces SET items_done=$2 WHERE id=$1", [spaceId, done]);
          await saveCheckpoint({ ownerType, afterId: item.ownerId, done });
          await progress("embedding", total ? Math.min(99, (done / total) * 100) : 50);
        }
      }
    }
    await db.query(
      "UPDATE embedding_spaces SET items_done=$2, items_total=GREATEST(items_total,$2), status=CASE WHEN status='building' THEN 'ready' ELSE status END, ready_at=now() WHERE id=$1",
      [spaceId, done],
    );
    return { items: done };
  },
});

/** upsertVectors without the trailing delete (the caller already trimmed extra chunks). */
async function upsertVectorsKeep(db: Parameters<typeof upsertVectors>[0], spaceId: string, ownerType: string, ownerId: string, chunks: Parameters<typeof upsertVectors>[4]) {
  for (const c of chunks) {
    await db.query(
      `INSERT INTO embeddings(space_id,owner_type,owner_id,chunk_index,content_hash,vec) VALUES($1,$2,$3,$4,$5,$6::halfvec)
       ON CONFLICT (space_id,owner_type,owner_id,chunk_index) DO UPDATE SET content_hash=EXCLUDED.content_hash, vec=EXCLUDED.vec, updated_at=now()`,
      [spaceId, ownerType, ownerId, c.index, c.contentHash, `[${c.vec.join(",")}]`],
    );
  }
}
