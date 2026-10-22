import type { ActivityItem } from "./types.ts";

/** Consecutive activity by the same person, of the same kind, in the same study (e.g. ten papers imported at once). */
export type ActivityGroup = { key: string; kind: string; actor: ActivityItem["actor"]; study: ActivityItem["study"]; at: string; items: ActivityItem[] };

/**
 * Folds runs of activity (newest first) that share actor, kind and study and happened within `windowMs` of the run's
 * newest item into one group, so a burst of imports or note edits reads as one line instead of a wall of rows.
 */
export function groupActivity(items: ActivityItem[], windowMs = 6 * 3600_000): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  for (const item of items) {
    const last = groups.at(-1);
    if (
      last &&
      last.kind === item.kind &&
      last.study.id === item.study.id &&
      (last.actor?.id ?? null) === (item.actor?.id ?? null) &&
      Math.abs(Date.parse(last.at) - Date.parse(item.at)) <= windowMs
    ) {
      last.items.push(item);
    } else {
      groups.push({ key: item.id, kind: item.kind, actor: item.actor, study: item.study, at: item.at, items: [item] });
    }
  }
  return groups;
}
