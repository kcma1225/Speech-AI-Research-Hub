/**
 * Vector spaces: one per embedding model identity. `embeddings.vec` is an untyped `halfvec`; each space has a
 * partial HNSW index on `(vec::halfvec(<dims>))`, so every query must filter `space_id` and cast to the space's
 * dimension (`searchSpace` does both). The search module owns what gets embedded; this module owns where.
 */
import { createHash } from "node:crypto";
import type { Queryable } from "../../db.js";
import { compactVectors, FINGERPRINT_VERSION } from "./fingerprint.js";

export type SpaceStatus = "building" | "ready" | "active" | "retired" | "failed";
export type EmbeddingSpace = {
  id: string;
  label: string;
  /** Embedding model profile the space belongs to. */
  model_ref: string | null;
  /** Group serving the space (deployments of the same model), when not served by the model directly. */
  group_id: string | null;
  /** Request params of a direct model target (e.g. `dimensions`). */
  params: Record<string, unknown>;
  provider_kind: string;
  model: string;
  dims: number;
  status: SpaceStatus;
  items_total: number;
  items_done: number;
  job_id: string | null;
  error: string | null;
  created_at: Date;
  ready_at: Date | null;
  activated_at: Date | null;
  retired_at: Date | null;
};

const COLS = "id,label,model_ref,group_id,params,provider_kind,model,dims,status,items_total,items_done,job_id,error,created_at,ready_at,activated_at,retired_at";

export const spaceIndexName = (id: string) => `embeddings_hnsw_${id.replace(/-/g, "")}`;
const assertUuid = (id: string) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error("bad space id");
};

export const contentHash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 32);
const vecLiteral = (v: number[]) => `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(",")}]`;

export async function listSpaces(db: Queryable): Promise<EmbeddingSpace[]> {
  return (await db.query<EmbeddingSpace>(`SELECT ${COLS} FROM embedding_spaces ORDER BY created_at DESC`)).rows;
}

export async function getSpace(db: Queryable, id: string): Promise<EmbeddingSpace | null> {
  return (await db.query<EmbeddingSpace>(`SELECT ${COLS} FROM embedding_spaces WHERE id=$1`, [id])).rows[0] ?? null;
}

export async function activeSpace(db: Queryable): Promise<EmbeddingSpace | null> {
  return (
    (await db.query<EmbeddingSpace>(`SELECT ${COLS.split(",").map((c) => `s.${c}`).join(",")} FROM embedding_identity i JOIN embedding_spaces s ON s.id=i.active_space_id`)).rows[0] ?? null
  );
}

/** Spaces new content must be written to: the active one plus one being built by a switch. */
export async function liveSpaces(db: Queryable): Promise<EmbeddingSpace[]> {
  return (await db.query<EmbeddingSpace>(`SELECT ${COLS} FROM embedding_spaces WHERE status IN ('active','building','ready') ORDER BY status='active' DESC`)).rows;
}

export async function storedFingerprint(db: Queryable, spaceId: string): Promise<number[][] | null> {
  const row = (await db.query<{ vectors: number[][] }>("SELECT vectors FROM embedding_fingerprints WHERE space_id=$1 AND probe_version=$2", [spaceId, FINGERPRINT_VERSION])).rows[0];
  return row?.vectors ?? null;
}

export async function insertSpace(
  db: Queryable,
  s: { label: string; modelRef: string | null; groupId: string | null; params: Record<string, unknown>; providerKind: string; model: string; dims: number; status: SpaceStatus; fingerprint: number[][]; createdBy: string | null },
): Promise<EmbeddingSpace> {
  const space = (
    await db.query<EmbeddingSpace>(
      `INSERT INTO embedding_spaces(label,model_ref,group_id,params,provider_kind,model,dims,status,created_by,activated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $8='active' THEN now() END) RETURNING ${COLS}`,
      [s.label, s.modelRef, s.groupId, JSON.stringify(s.params ?? {}), s.providerKind, s.model, s.dims, s.status, s.createdBy],
    )
  ).rows[0]!;
  await db.query("INSERT INTO embedding_fingerprints(space_id,probe_version,dims,vectors) VALUES($1,$2,$3,$4)", [
    space.id,
    FINGERPRINT_VERSION,
    s.dims,
    JSON.stringify(compactVectors(s.fingerprint)),
  ]);
  return space;
}

/** Creates the space's partial HNSW index (idempotent; quick while the space is still empty). */
export async function ensureSpaceIndex(db: Queryable, id: string, dims: number) {
  assertUuid(id);
  if (!Number.isInteger(dims) || dims < 1 || dims > 4000) throw new Error("bad dims");
  await db.query(
    `CREATE INDEX IF NOT EXISTS ${spaceIndexName(id)} ON embeddings USING hnsw ((vec::halfvec(${dims})) halfvec_cosine_ops) WHERE space_id = '${id}'`,
  );
}

export async function dropSpace(db: Queryable, id: string) {
  assertUuid(id);
  await db.query(`DROP INDEX IF EXISTS ${spaceIndexName(id)}`);
  await db.query("DELETE FROM embedding_spaces WHERE id=$1", [id]);
}

export type VectorChunk = { index: number; contentHash: string; vec: number[] };

/** Replaces an owner's chunks in one space (extra old chunks are removed). */
export async function upsertVectors(db: Queryable, spaceId: string, ownerType: string, ownerId: string, chunks: VectorChunk[]) {
  await db.query("DELETE FROM embeddings WHERE space_id=$1 AND owner_type=$2 AND owner_id=$3 AND chunk_index >= $4", [spaceId, ownerType, ownerId, chunks.length]);
  for (const c of chunks) {
    await db.query(
      `INSERT INTO embeddings(space_id,owner_type,owner_id,chunk_index,content_hash,vec) VALUES($1,$2,$3,$4,$5,$6::halfvec)
       ON CONFLICT (space_id,owner_type,owner_id,chunk_index) DO UPDATE SET content_hash=EXCLUDED.content_hash, vec=EXCLUDED.vec, updated_at=now()`,
      [spaceId, ownerType, ownerId, c.index, c.contentHash, vecLiteral(c.vec)],
    );
  }
}

/** Existing chunk hashes of an owner in a space (skip unchanged chunks when re-indexing). */
export async function chunkHashes(db: Queryable, spaceId: string, ownerType: string, ownerId: string): Promise<string[]> {
  const rows = (await db.query<{ chunk_index: number; content_hash: string }>("SELECT chunk_index,content_hash FROM embeddings WHERE space_id=$1 AND owner_type=$2 AND owner_id=$3 ORDER BY chunk_index", [spaceId, ownerType, ownerId])).rows;
  return rows.map((r) => r.content_hash);
}

/** Removes an owner's vectors from every space (content deleted). */
export async function deleteOwnerVectors(db: Queryable, ownerType: string, ownerId: string) {
  await db.query("DELETE FROM embeddings WHERE owner_type=$1 AND owner_id=$2", [ownerType, ownerId]);
}

export type VectorHit = { owner_type: string; owner_id: string; chunk_index: number; distance: number };

/** k-NN in one space by cosine distance (uses the space's HNSW index). */
export async function searchSpace(db: Queryable, space: Pick<EmbeddingSpace, "id" | "dims">, query: number[], opts: { ownerTypes?: string[]; limit?: number } = {}): Promise<VectorHit[]> {
  const d = space.dims;
  if (!Number.isInteger(d) || d < 1 || d > 4000) throw new Error("bad dims");
  const args: unknown[] = [space.id, vecLiteral(query), Math.min(Math.max(opts.limit ?? 20, 1), 200)];
  let filter = "";
  if (opts.ownerTypes?.length) {
    args.push(opts.ownerTypes);
    filter = "AND owner_type = ANY($4)";
  }
  return (
    await db.query<VectorHit>(
      `SELECT owner_type, owner_id, chunk_index, (vec::halfvec(${d}) <=> $2::halfvec(${d}))::float8 AS distance
         FROM embeddings WHERE space_id=$1 ${filter}
        ORDER BY vec::halfvec(${d}) <=> $2::halfvec(${d}) LIMIT $3`,
      args,
    )
  ).rows;
}
