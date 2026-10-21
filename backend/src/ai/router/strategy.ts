/**
 * Member ordering per strategy. Every strategy ends in failover: the first member is the strategy's pick, the
 * rest are tried in order when it fails before streaming.
 * - single: only the first enabled member (no failover).
 * - fallback: position order.
 * - round_robin: rotates the starting member on each call (per process), then wraps around.
 * - load_balance: weighted random pick, then the remaining members in weighted-random order.
 */
import type { RouteNode } from "./tree.js";

export type Rng = () => number;

const rrCounters = new Map<string, number>();

export function resetRoundRobin() {
  rrCounters.clear();
}

export function orderMembers(node: RouteNode, rng: Rng = Math.random): RouteNode["members"] {
  const ms = node.members;
  if (!ms.length) return [];
  switch (node.strategy) {
    case "single":
      return [ms[0]!];
    case "fallback":
      return [...ms];
    case "round_robin": {
      const n = rrCounters.get(node.id ?? "") ?? 0;
      rrCounters.set(node.id ?? "", (n + 1) % 1_000_000);
      const start = n % ms.length;
      return [...ms.slice(start), ...ms.slice(0, start)];
    }
    case "load_balance": {
      const pool = [...ms];
      const out: RouteNode["members"] = [];
      while (pool.length) {
        const total = pool.reduce((s, m) => s + Math.max(1, m.weight), 0);
        let x = rng() * total;
        let i = 0;
        for (; i < pool.length - 1; i++) {
          x -= Math.max(1, pool[i]!.weight);
          if (x < 0) break;
        }
        out.push(pool.splice(i, 1)[0]!);
      }
      return out;
    }
    default:
      return [...ms];
  }
}
