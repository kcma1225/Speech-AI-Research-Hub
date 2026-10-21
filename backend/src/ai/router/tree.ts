/** Route trees: resolve a role's route (with nested child routes) from a config snapshot, rejecting cycles. */
import { PlatformError } from "../platform/errors.js";
import type { AiRole, RouteCapability } from "../platform/roles.js";
import type { ConfigSnapshot, ProviderRecord, RouteRecord, Strategy } from "../platform/store.js";

export const MAX_ROUTE_DEPTH = 6;

export type ModelLeaf = {
  type: "model";
  memberId: string;
  routeId: string;
  provider: ProviderRecord;
  model: string;
  params: Record<string, unknown>;
  weight: number;
};

export type RouteNode = {
  type: "route";
  id: string;
  name: string;
  capability: RouteCapability;
  strategy: Strategy;
  /** Enabled members in position order. */
  members: Array<{ memberId: string; weight: number; node: ModelLeaf | RouteNode }>;
};

/** Resolves a route into a tree. Throws `route_cycle` / `route_invalid` (missing provider or child). */
export function resolveRoute(snap: Pick<ConfigSnapshot, "routes" | "providers">, routeId: string, stack: string[] = []): RouteNode {
  if (stack.includes(routeId)) throw new PlatformError("route_cycle", { detail: { path: [...stack, routeId] } });
  if (stack.length >= MAX_ROUTE_DEPTH) throw new PlatformError("route_invalid", { message_zh: `子路由最多 ${MAX_ROUTE_DEPTH} 層。` });
  const route = snap.routes.get(routeId);
  if (!route) throw new PlatformError("route_invalid", { message_zh: "找不到路由。", detail: { routeId } });
  const members: RouteNode["members"] = [];
  for (const m of [...route.members].sort((a, b) => a.position - b.position)) {
    if (!m.enabled) continue;
    if (m.child_route_id) {
      const child = resolveRoute(snap, m.child_route_id, [...stack, routeId]);
      if (child.capability !== route.capability) throw new PlatformError("capability_mismatch", { detail: { routeId, childRouteId: child.id } });
      members.push({ memberId: m.id, weight: m.weight, node: child });
      continue;
    }
    const provider = m.provider_id ? snap.providers.get(m.provider_id) : undefined;
    if (!provider || !m.model) throw new PlatformError("route_invalid", { message_zh: "路由成員指向不存在的供應商帳號。", detail: { memberId: m.id } });
    members.push({
      memberId: m.id,
      weight: m.weight,
      node: { type: "model", memberId: m.id, routeId, provider, model: m.model, params: m.params ?? {}, weight: m.weight },
    });
  }
  return { type: "route", id: route.id, name: route.name, capability: route.capability, strategy: route.strategy, members };
}

export function resolveRole(snap: ConfigSnapshot, role: AiRole): RouteNode | null {
  const routeId = snap.roles.get(role);
  return routeId ? resolveRoute(snap, routeId) : null;
}

/** All model leaves in preference order (strategy-independent), for health and fingerprint checks. */
export function leaves(node: RouteNode): ModelLeaf[] {
  const out: ModelLeaf[] = [];
  for (const m of node.members) {
    if (m.node.type === "model") out.push(m.node);
    else out.push(...leaves(m.node));
  }
  return out;
}

/**
 * Would saving `routeId` with these child routes create a cycle? Checks the stored graph with the edited route's
 * edges replaced. Returns the cycle path or null.
 */
export function findCycle(routes: Map<string, Pick<RouteRecord, "id" | "members">>, routeId: string, childIds: string[]): string[] | null {
  const edges = new Map<string, string[]>();
  for (const r of routes.values()) edges.set(r.id, r.members.flatMap((m) => (m.child_route_id ? [m.child_route_id] : [])));
  edges.set(routeId, childIds);
  const walk = (id: string, path: string[]): string[] | null => {
    if (path.includes(id)) return [...path, id];
    for (const next of edges.get(id) ?? []) {
      const found = walk(next, [...path, id]);
      if (found) return found;
    }
    return null;
  };
  return walk(routeId, []);
}
