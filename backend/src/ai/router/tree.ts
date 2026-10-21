/**
 * Routing trees. ONE routing configuration: each role is bound to a model profile or a group; groups hold models
 * and child groups (nesting, cycles rejected, depth ≤ MAX_GROUP_DEPTH). A direct model binding resolves to a
 * synthetic single-member node (`id` null, strategy `single`).
 */
import { PlatformError } from "../platform/errors.js";
import type { ResolvedProfile } from "../platform/models.js";
import { ROLE_CAPABILITY, type AiRole, type RouteCapability } from "../platform/roles.js";
import type { BindingRecord, ConfigSnapshot, GroupRecord, ProviderRecord, Strategy } from "../platform/store.js";

export const MAX_GROUP_DEPTH = 6;
/** @deprecated name kept for older imports. */
export const MAX_ROUTE_DEPTH = MAX_GROUP_DEPTH;

export type ModelLeaf = {
  type: "model";
  /** Group member id, or `binding:<role>` for a direct model binding (stable: ASR checkpoints key on it). */
  memberId: string;
  /** Group that holds this member (null for a direct binding). */
  groupId: string | null;
  /** @deprecated alias of `groupId ?? ""` (call-log and RouteInfo compatibility). */
  routeId: string;
  provider: ProviderRecord;
  /** ai_models.id */
  modelRef: string;
  /** Vendor model id sent in requests. */
  model: string;
  profile: ResolvedProfile;
  params: Record<string, unknown>;
  weight: number;
};

export type GroupNode = {
  type: "group";
  /** null for the synthetic node of a direct model binding. */
  id: string | null;
  name: string;
  capability: RouteCapability;
  strategy: Strategy;
  /** Enabled members in position order. */
  members: Array<{ memberId: string; weight: number; node: ModelLeaf | GroupNode }>;
};
/** @deprecated old name. */
export type RouteNode = GroupNode;

type Snap = Pick<ConfigSnapshot, "groups" | "providers" | "models">;

function leafFor(snap: Snap, modelRef: string, memberId: string, groupId: string | null, params: Record<string, unknown>, weight: number): ModelLeaf {
  const model = snap.models.get(modelRef);
  const provider = model ? snap.providers.get(model.provider_id) : undefined;
  if (!model || !provider) throw new PlatformError("route_invalid", { message_zh: "綁定指向不存在的模型。", detail: { memberId, modelRef } });
  return { type: "model", memberId, groupId, routeId: groupId ?? "", provider, modelRef, model: model.model_id, profile: model.profile, params: params ?? {}, weight };
}

/** Resolves a group into a tree. Throws `route_cycle` / `route_invalid` / `capability_mismatch`. */
export function resolveGroup(snap: Snap, groupId: string, stack: string[] = []): GroupNode {
  if (stack.includes(groupId)) throw new PlatformError("route_cycle", { detail: { path: [...stack, groupId] } });
  if (stack.length >= MAX_GROUP_DEPTH) throw new PlatformError("route_invalid", { message_zh: `群組最多 ${MAX_GROUP_DEPTH} 層。` });
  const group = snap.groups.get(groupId);
  if (!group) throw new PlatformError("route_invalid", { message_zh: "找不到群組。", detail: { groupId } });
  const members: GroupNode["members"] = [];
  for (const m of [...group.members].sort((a, b) => a.position - b.position)) {
    if (!m.enabled) continue;
    if (m.child_group_id) {
      const child = resolveGroup(snap, m.child_group_id, [...stack, groupId]);
      if (child.capability !== group.capability) throw new PlatformError("capability_mismatch", { detail: { groupId, childGroupId: child.id } });
      members.push({ memberId: m.id, weight: m.weight, node: child });
      continue;
    }
    if (!m.model_ref) throw new PlatformError("route_invalid", { message_zh: "群組成員沒有指定模型。", detail: { memberId: m.id } });
    members.push({ memberId: m.id, weight: m.weight, node: leafFor(snap, m.model_ref, m.id, groupId, m.params, m.weight) });
  }
  return { type: "group", id: group.id, name: group.name, capability: group.capability, strategy: group.strategy, members };
}

/** Tree of a binding target (role binding, embedding space). */
export function resolveTarget(snap: Snap, target: Pick<BindingRecord, "model_ref" | "group_id" | "params">, role: AiRole | null, capability: RouteCapability): GroupNode {
  if (target.group_id) return resolveGroup(snap, target.group_id);
  if (!target.model_ref) throw new PlatformError("route_invalid", { message_zh: "綁定沒有目標。" });
  const leaf = leafFor(snap, target.model_ref, `binding:${role ?? "target"}`, null, target.params ?? {}, 1);
  return { type: "group", id: null, name: leaf.model, capability, strategy: "single", members: [{ memberId: leaf.memberId, weight: 1, node: leaf }] };
}

export function resolveRole(snap: ConfigSnapshot, role: AiRole): GroupNode | null {
  const b = snap.bindings.get(role);
  if (!b) return null;
  return resolveTarget(snap, b, role, ROLE_CAPABILITY[role]);
}

/** All model leaves in preference order (strategy-independent), for health and fingerprint checks. */
export function leaves(node: GroupNode): ModelLeaf[] {
  const out: ModelLeaf[] = [];
  for (const m of node.members) {
    if (m.node.type === "model") out.push(m.node);
    else out.push(...leaves(m.node));
  }
  return out;
}

/** Group ids in a tree (root first). */
export function groupIdsIn(node: GroupNode): string[] {
  return [...(node.id ? [node.id] : []), ...node.members.flatMap((m) => (m.node.type === "group" ? groupIdsIn(m.node) : []))];
}

/**
 * Would saving `groupId` with these child groups create a cycle? Checks the stored graph with the edited group's
 * edges replaced. Returns the cycle path or null.
 */
export function findCycle(groups: Map<string, Pick<GroupRecord, "id" | "members">>, groupId: string, childIds: string[]): string[] | null {
  const edges = new Map<string, string[]>();
  for (const g of groups.values()) edges.set(g.id, g.members.flatMap((m) => (m.child_group_id ? [m.child_group_id] : [])));
  edges.set(groupId, childIds);
  const walk = (id: string, path: string[]): string[] | null => {
    if (path.includes(id)) return [...path, id];
    for (const next of edges.get(id) ?? []) {
      const found = walk(next, [...path, id]);
      if (found) return found;
    }
    return null;
  };
  return walk(groupId, []);
}

/** Depth of the deepest nesting below `groupId` (1 = no child groups), with the edited edges applied. */
export function groupDepth(groups: Map<string, Pick<GroupRecord, "id" | "members">>, groupId: string, childIds: string[]): number {
  const edges = new Map<string, string[]>();
  for (const g of groups.values()) edges.set(g.id, g.members.flatMap((m) => (m.child_group_id ? [m.child_group_id] : [])));
  edges.set(groupId, childIds);
  const depth = (id: string, seen: Set<string>): number => {
    if (seen.has(id)) return Infinity;
    const next = edges.get(id) ?? [];
    if (!next.length) return 1;
    const s = new Set(seen).add(id);
    return 1 + Math.max(...next.map((c) => depth(c, s)));
  };
  return depth(groupId, new Set());
}
