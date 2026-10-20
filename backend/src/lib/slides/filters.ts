import { z } from "zod";
import { badRequest } from "../http.js";

export type TagFilter = { mode: "all" } | { mode: "set"; ids: string[]; untagged: boolean };

/**
 * `tags` query semantics shared with notes: omitted = all; empty string = none selected;
 * comma-separated tag ids, where `none` selects untagged entries.
 */
export function parseTagFilter(raw: string | undefined): TagFilter {
  if (raw === undefined) return { mode: "all" };
  const values = raw.split(",").map(value => value.trim()).filter(Boolean);
  const ids = values.filter(value => value !== "none");
  if (ids.some(id => !z.uuid().safeParse(id).success) || ids.length > 100) throw badRequest("標籤篩選不正確。");
  return { mode: "set", ids, untagged: values.includes("none") };
}

export const tagIdsSchema = z.array(z.uuid()).max(100);
