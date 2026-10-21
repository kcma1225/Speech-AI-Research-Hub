/**
 * Embedding identity rules and the guided switch:
 * - Binding/editing the embedding route must keep the active identity: every member's fingerprint must match
 *   (cosine ≥ 0.95, same dims) or the API answers 409 `embedding_model_change_requires_switch`.
 * - First setup (no active space): the route's model becomes the active space immediately (empty, filled by a
 *   reindex job); search stays keyword-only for content not yet embedded.
 * - Switch: build a new space with the new route (job `ai_embedding_reindex`), then `flip` makes it active and
 *   rebinds the role; the old space is retired (deletable later). Search keeps using the old space meanwhile.
 */
import type pg from "pg";
import { transaction, type Queryable } from "../../db.js";
import { cancelJob, enqueueJob } from "../../jobs/queue.js";
import { fromThrown } from "../errors.js";
import type { AiPlatform } from "../platform/platform.js";
import { PlatformError } from "../platform/errors.js";
import { notifyConfigChanged, type ConfigSnapshot } from "../platform/store.js";
import { leaves, resolveRoute, type ModelLeaf, type RouteNode } from "../router/index.js";
import { compareFingerprints, probesFor, type FingerprintComparison } from "./fingerprint.js";
import { activeSpace, dropSpace, ensureSpaceIndex, getSpace, insertSpace, listSpaces, storedFingerprint, type EmbeddingSpace } from "./spaces.js";

export const REINDEX_JOB = "ai_embedding_reindex";
export type ReindexPayload = { spaceId: string };

export type MemberFingerprint = { memberId: string; providerId: string; providerName: string; model: string; ok: boolean; dims?: number; error?: { code: string; message_zh: string }; comparison?: FingerprintComparison };
export type RouteFingerprint = { routeId: string; dims: number | null; vectors: number[][] | null; members: MemberFingerprint[]; consistent: boolean };

/** Embeds the probe set with each member of the route (directly, no fallback). */
export async function fingerprintRoute(platform: AiPlatform, tree: RouteNode): Promise<RouteFingerprint> {
  const probes = probesFor();
  const members: MemberFingerprint[] = [];
  let reference: number[][] | null = null;
  let consistent = true;
  for (const leaf of leaves(tree)) {
    const base = { memberId: leaf.memberId, providerId: leaf.provider.id, providerName: leaf.provider.name, model: leaf.model };
    try {
      const r = await platform.embedWithLeaf(leaf, probes, "document");
      if (!reference) {
        reference = r.vectors;
        members.push({ ...base, ok: true, dims: r.dims || r.vectors[0]?.length });
      } else {
        const comparison = compareFingerprints(reference, r.vectors);
        if (!comparison.same) consistent = false;
        members.push({ ...base, ok: true, dims: r.dims || r.vectors[0]?.length, comparison });
      }
    } catch (e) {
      const err = fromThrown(e);
      members.push({ ...base, ok: false, error: { code: err.code, message_zh: err.message_zh } });
    }
  }
  return { routeId: tree.id, dims: reference?.[0]?.length ?? null, vectors: reference, members, consistent };
}

export type Precheck = {
  activeSpace: EmbeddingSpace | null;
  candidate: RouteFingerprint;
  /** Compared with the active space's fingerprint (null when there is no active space or the probe failed). */
  comparison: FingerprintComparison | null;
  /** true: bind directly; false: a switch (re-embedding) is required. */
  sameIdentity: boolean;
};

export async function precheckRoute(platform: AiPlatform, tree: RouteNode): Promise<Precheck> {
  if (tree.capability !== "embedding") throw new PlatformError("capability_mismatch");
  const candidate = await fingerprintRoute(platform, tree);
  const space = await activeSpace(platform.db);
  let comparison: FingerprintComparison | null = null;
  if (space && candidate.vectors) {
    const stored = await storedFingerprint(platform.db, space.id);
    if (stored) comparison = compareFingerprints(stored, candidate.vectors);
  }
  return { activeSpace: space, candidate, comparison, sameIdentity: Boolean(comparison?.same && candidate.consistent && candidate.members.every((m) => m.ok)) };
}

function assertUsable(fp: RouteFingerprint) {
  const failed = fp.members.find((m) => !m.ok);
  if (failed) throw new PlatformError("route_invalid", { message_zh: `無法用「${failed.providerName} / ${failed.model}」產生向量：${failed.error?.message_zh ?? ""}`, detail: { fingerprint: summarize(fp) } });
  if (!fp.vectors || !fp.dims) throw new PlatformError("route_invalid", { message_zh: "這條路由沒有可用的 embedding 模型。" });
  if (!fp.consistent) throw new PlatformError("route_invalid", { message_zh: "同一條 embedding 路由的成員必須是同一個模型（指紋不一致）。", hint_zh: "備援成員只能是同一個模型的其他部署。不同模型請另建路由並使用切換精靈。", detail: { fingerprint: summarize(fp) } });
  if (fp.dims > 4000) throw new PlatformError("embedding_dims_unsupported", { detail: { dims: fp.dims } });
}

export const summarize = (fp: RouteFingerprint) => ({ routeId: fp.routeId, dims: fp.dims, consistent: fp.consistent, members: fp.members });

const spaceLabel = (leaf: ModelLeaf, dims: number) => `${leaf.provider.name} · ${leaf.model} · ${dims}d`;

/**
 * Guard for binding `embedding` to `tree` (role binding or editing the bound route). Returns what to do:
 * create the first space, keep the active one (same identity), or reject with 409.
 */
export async function checkEmbeddingBinding(platform: AiPlatform, tree: RouteNode): Promise<{ action: "create_first" | "keep"; fp: RouteFingerprint; precheck: Precheck }> {
  const pre = await precheckRoute(platform, tree);
  assertUsable(pre.candidate);
  if (!pre.activeSpace) return { action: "create_first", fp: pre.candidate, precheck: pre };
  if (!pre.sameIdentity)
    throw new PlatformError("embedding_model_change_requires_switch", {
      detail: { comparison: pre.comparison, activeSpace: { id: pre.activeSpace.id, label: pre.activeSpace.label, dims: pre.activeSpace.dims }, fingerprint: summarize(pre.candidate) },
    });
  return { action: "keep", fp: pre.candidate, precheck: pre };
}

/** Applies a passed binding check inside the binding transaction. */
export async function applyEmbeddingBinding(client: pg.PoolClient, tree: RouteNode, check: Awaited<ReturnType<typeof checkEmbeddingBinding>>, userId: string | null) {
  if (check.action === "keep") {
    await client.query("UPDATE embedding_spaces SET route_id=$1 WHERE id=$2", [tree.id, check.precheck.activeSpace!.id]);
    return null;
  }
  const leaf = leaves(tree)[0]!;
  const space = await insertSpace(client, {
    label: spaceLabel(leaf, check.fp.dims!),
    routeId: tree.id,
    providerKind: leaf.provider.kind,
    model: leaf.model,
    dims: check.fp.dims!,
    status: "active",
    fingerprint: check.fp.vectors!,
    createdBy: userId,
  });
  await ensureSpaceIndex(client, space.id, space.dims);
  await client.query("UPDATE embedding_identity SET active_space_id=$1, updated_by=$2, updated_at=now()", [space.id, userId]);
  const jobId = await enqueueJob(client, REINDEX_JOB, { spaceId: space.id } satisfies ReindexPayload, userId, 5);
  await client.query("UPDATE embedding_spaces SET job_id=$1 WHERE id=$2", [jobId, space.id]);
  return space;
}

/** Starts building a new space for `routeId`. */
export async function startSwitch(platform: AiPlatform, snap: ConfigSnapshot, routeId: string, userId: string): Promise<EmbeddingSpace> {
  const tree = resolveRoute(snap, routeId);
  const pre = await precheckRoute(platform, tree);
  assertUsable(pre.candidate);
  if (!pre.activeSpace) throw new PlatformError("embedding_not_configured", { hint_zh: "目前沒有使用中的向量空間：直接在「功能綁定」選擇這條路由即可，不需要切換精靈。" });
  if (pre.sameIdentity) throw new PlatformError("route_invalid", { message_zh: "這條路由和目前使用中的是同一個模型，不需要重算。", hint_zh: "直接在「功能綁定」改選這條路由即可。" });
  const leaf = leaves(tree)[0]!;
  const space = await transaction(platform.db, async (client) => {
    await client.query("SELECT 1 FROM embedding_identity FOR UPDATE");
    const busy = (await client.query("SELECT 1 FROM embedding_spaces WHERE status IN ('building','ready')")).rowCount;
    if (busy) throw new PlatformError("embedding_switch_in_progress");
    const s = await insertSpace(client, {
      label: spaceLabel(leaf, pre.candidate.dims!),
      routeId,
      providerKind: leaf.provider.kind,
      model: leaf.model,
      dims: pre.candidate.dims!,
      status: "building",
      fingerprint: pre.candidate.vectors!,
      createdBy: userId,
    });
    await ensureSpaceIndex(client, s.id, s.dims);
    const jobId = await enqueueJob(client, REINDEX_JOB, { spaceId: s.id } satisfies ReindexPayload, userId, 5);
    await client.query("UPDATE embedding_spaces SET job_id=$1 WHERE id=$2", [jobId, s.id]);
    return { ...s, job_id: jobId };
  });
  return space;
}

/** Makes a fully built space active and binds the embedding role to its route. */
export async function flipSwitch(platform: AiPlatform, spaceId: string, userId: string) {
  await transaction(platform.db, async (client) => {
    await client.query("SELECT 1 FROM embedding_identity FOR UPDATE");
    const s = await getSpace(client, spaceId);
    if (!s) throw new PlatformError("not_found");
    if (s.status !== "ready") throw new PlatformError("route_invalid", { message_zh: "向量空間還沒重算完成，不能切換。", hint_zh: "請等進度到 100% 後再按「切換」。" });
    if (!s.route_id) throw new PlatformError("route_invalid", { message_zh: "這個向量空間的路由已被刪除。" });
    await client.query("UPDATE embedding_spaces SET status='retired', retired_at=now() WHERE status='active'");
    await client.query("UPDATE embedding_spaces SET status='active', activated_at=now() WHERE id=$1", [spaceId]);
    await client.query("UPDATE embedding_identity SET active_space_id=$1, updated_by=$2, updated_at=now()", [spaceId, userId]);
    await client.query(
      `INSERT INTO ai_role_routes(role,route_id,updated_by) VALUES('embedding',$1,$2)
       ON CONFLICT (role) DO UPDATE SET route_id=EXCLUDED.route_id, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [s.route_id, userId],
    );
    await notifyConfigChanged(client);
  });
  platform.invalidate();
}

export async function cancelSwitch(platform: AiPlatform, spaceId: string) {
  const s = await getSpace(platform.db, spaceId);
  if (!s) throw new PlatformError("not_found");
  if (!["building", "ready", "failed"].includes(s.status)) throw new PlatformError("route_invalid", { message_zh: "只能取消尚未切換的向量空間。" });
  if (s.job_id) await cancelJob(platform.db, s.job_id);
  await dropSpace(platform.db, spaceId);
}

export async function deleteRetiredSpace(db: Queryable, spaceId: string) {
  const s = await getSpace(db, spaceId);
  if (!s) throw new PlatformError("not_found");
  if (s.status !== "retired") throw new PlatformError("route_invalid", { message_zh: "只能刪除已停用的向量空間。" });
  await dropSpace(db, spaceId);
}

export async function embeddingOverview(platform: AiPlatform) {
  const [spaces, state] = await Promise.all([listSpaces(platform.db), platform.embeddingState()]);
  return { mode: state.mode, reason_zh: state.reason_zh ?? null, activeSpaceId: state.space?.id ?? null, spaces };
}
