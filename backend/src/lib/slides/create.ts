import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Queryable } from "../../db.js";
import { badRequest } from "../http.js";
import { slugPattern } from "./access.js";

/** Paper of a paper-report deck that is not linked to the library (`decks.metadata.paper`). */
export const paperMeta = z.object({
  title: z.string().trim().min(1).max(300),
  url: z.string().trim().max(2000).optional().or(z.literal("").transform(() => undefined)),
  abstract: z.string().trim().max(8000).optional(),
}).refine(value => !value.url || /^https?:\/\//i.test(value.url), { message: "url" });
export type PaperMeta = z.infer<typeof paperMeta>;

export const deckKind = z.enum(["progress", "paper_report"]);

/** ASCII slug base from a title ("" when the title has no ASCII words). */
export function slugBase(title: string) {
  return title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/, "");
}

/** A free slug for a new deck: the title's ASCII words (or `deck`) plus the date, then `-2`, `-3`… or a random suffix. */
export async function freeSlug(db: Queryable, title: string, date: string) {
  const stamp = date.replace(/-/g, "").slice(2);
  // Default titles already end with the date (「進度報告 261021」): don't repeat it (deck-261021-261021).
  const words = slugBase(title).replace(new RegExp(`(^|-)(20)?${stamp}$`), "");
  const base = `${/[a-z]/.test(words) ? words : words ? `deck-${words}` : "deck"}-${stamp}`;
  for (let n = 1; n <= 20; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (!(await db.query("SELECT 1 FROM decks WHERE slug=$1", [candidate])).rowCount) return candidate;
  }
  const random = `${base}-${randomBytes(3).toString("hex")}`;
  if (!slugPattern.test(random)) throw badRequest("無法產生網址代稱。");
  return random;
}

/** `decks.metadata` with `paper` set or removed. */
export function withPaper(metadata: Record<string, unknown>, paper: PaperMeta | null | undefined) {
  if (paper === undefined) return metadata;
  const { paper: _, ...rest } = metadata;
  return paper ? { ...rest, paper } : rest;
}
