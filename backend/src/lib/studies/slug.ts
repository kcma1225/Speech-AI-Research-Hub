import type { Queryable } from "../../db.js";

export const STUDY_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A slug the DB accepts: pattern, ≤ 80 chars, and not UUID-shaped (routes take an id or a slug). */
export const validStudySlug = (slug: string) => STUDY_SLUG_RE.test(slug) && slug.length <= 80 && !UUID_SHAPE.test(slug);

const taipeiDate = (now: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(now);

/**
 * ASCII slug from a title (same rule as deck slugs). A title without ASCII letters/digits becomes `study-<date>`;
 * a title that also has non-ASCII letters (CJK…) keeps its ASCII words plus the date, so "ASR 研究" and
 * "ASR 實驗" don't both become `asr`.
 */
export function slugifyTitle(title: string, now = new Date()): string {
  const base = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  const date = taipeiDate(now);
  if (!base) return `study-${date}`;
  const lossy = /[^\t\n\r -~]/.test(title.normalize("NFKD").replace(/\p{M}/gu, ""));
  const slug = lossy ? `${base}-${date}` : base;
  return UUID_SHAPE.test(slug) ? `study-${slug.slice(0, 60)}` : slug;
}

/** `wanted` (or a slug from `title`) made unique with `-2`, `-3`, … against existing studies. */
export async function uniqueStudySlug(db: Queryable, title: string, wanted?: string): Promise<string> {
  const base = (wanted ?? slugifyTitle(title)).slice(0, 72).replace(/-+$/, "");
  const taken = new Set(
    (await db.query<{ slug: string }>("SELECT slug FROM studies WHERE slug=$1 OR slug LIKE $2", [base, `${base}-%`])).rows.map(row => row.slug),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
