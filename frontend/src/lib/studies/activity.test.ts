import { describe, expect, it } from "vitest";
import { groupActivity } from "./activity.ts";
import type { ActivityItem } from "./types.ts";

const study = (id: string) => ({ id, slug: id, title: id }) as ActivityItem["study"];
const item = (id: string, kind: string, at: string, actor: string | null = "u1", s = "s1"): ActivityItem => ({
  id, kind, title: id, url: null, at, metadata: {}, actor: actor ? { id: actor, name: actor } : null, study: study(s),
});

describe("groupActivity", () => {
  it("folds consecutive same actor/kind/study items", () => {
    const g = groupActivity([
      item("a", "paper_added", "2026-10-23T10:00:00Z"),
      item("b", "paper_added", "2026-10-23T09:59:00Z"),
      item("c", "paper_added", "2026-10-23T09:58:00Z"),
      item("d", "task_done", "2026-10-23T09:00:00Z"),
    ]);
    expect(g.map(x => x.items.map(i => i.id))).toEqual([["a", "b", "c"], ["d"]]);
    expect(g[0]!.at).toBe("2026-10-23T10:00:00Z");
  });
  it("keeps different actors, studies and distant times apart", () => {
    const g = groupActivity([
      item("a", "paper_added", "2026-10-23T10:00:00Z", "u1"),
      item("b", "paper_added", "2026-10-23T10:00:00Z", "u2"),
      item("c", "paper_added", "2026-10-23T10:00:00Z", "u2", "s2"),
      item("d", "paper_added", "2026-10-22T10:00:00Z", "u2", "s2"),
      item("e", "other", "2026-10-22T09:00:00Z", null),
      item("f", "other", "2026-10-22T09:00:00Z", null),
    ]);
    expect(g.map(x => x.items.length)).toEqual([1, 1, 1, 1, 2]);
  });
  it("does not merge non-adjacent runs", () => {
    const g = groupActivity([item("a", "k", "2026-10-23T10:00:00Z"), item("b", "j", "2026-10-23T10:00:00Z"), item("c", "k", "2026-10-23T10:00:00Z")]);
    expect(g).toHaveLength(3);
  });
});
