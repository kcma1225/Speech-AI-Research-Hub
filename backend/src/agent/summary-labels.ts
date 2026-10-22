/**
 * Tool-row summaries are built from the call's arguments before it runs, so they name objects by id or slug
 * (「查看研究 9696d128-… 的進度」). Once a read succeeds its result knows the titles: swap the ids / slugs for
 * 〈title〉 so the transcript reads like the rest of the UI.
 */
const KEYS = ["study", "paper", "note", "deck", "meeting", "project", "task"] as const;

type Named = { id?: unknown; slug?: unknown; title?: unknown };

function pairs(data: unknown): [string, string][] {
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const out: [string, string][] = [];
  const add = (o: unknown) => {
    if (!o || typeof o !== "object" || Array.isArray(o)) return;
    const { id, slug, title } = o as Named;
    if (typeof title !== "string" || !title.trim()) return;
    const label = `〈${title.trim().slice(0, 60)}〉`;
    if (typeof id === "string" && id.length >= 8) out.push([id, label]);
    if (typeof slug === "string" && slug.length >= 3) out.push([slug, label]);
  };
  add(data);
  for (const k of KEYS) add((data as Record<string, unknown>)[k]);
  return out;
}

export function labelSummary(summary: string, data: unknown): string {
  if (!summary) return summary;
  let out = summary;
  for (const [needle, label] of pairs(data)) {
    // Whole tokens only (a slug must not match inside another word).
    out = out.replace(new RegExp(`(^|[\\s「（(])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[\\s」）),，。的])`, "g"), `$1${label}`);
  }
  return out;
}
