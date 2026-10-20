import type { FastifyRequest } from "fastify";
import { z } from "zod";
import type { Queryable } from "../../db.js";
import { requireUser, type CurrentUser } from "../auth.js";
import { forbidden, notFound } from "../http.js";

export const NOTE_READ_ONLY = "Professor 僅可閱讀研究筆記。";
/** S3 prefix holding every transcoded audio file of an item (see `keys.itemAudio`). */
export const itemAudioPrefix = (itemId: string) => `media/items/${itemId}/`;

export const itemNotFound = () => notFound("筆記不存在。");

/** Signed-in user allowed to change notes and their media (everyone but Professor). */
export async function requireNoteWriter(request: FastifyRequest): Promise<CurrentUser> {
  const user = await requireUser(request);
  if (user.role === "professor") throw forbidden(NOTE_READ_ONLY);
  return user;
}

/** `YYYY-MM-DD` that is a real calendar date. */
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
});

/** Escapes LIKE wildcards (Postgres default escape character is backslash). */
export const escapeLike = (value: string) => value.replace(/[\\%_]/g, char => `\\${char}`);

export type ActiveJob = { id: string; status: "processing"; stage: string; progress: number; file_name: string; created_at: string };

/** Latest queued/running transcode for an item, as shown on the note page. */
export async function activeMediaJob(client: Queryable, itemId: string): Promise<ActiveJob | null> {
  const result = await client.query<ActiveJob>(
    `SELECT id,'processing' AS status,stage,progress,payload->>'fileName' AS file_name,created_at FROM jobs
      WHERE kind='media_transcode' AND status IN ('queued','running') AND payload->>'itemId'=$1
      ORDER BY created_at DESC LIMIT 1`,
    [itemId],
  );
  return result.rows[0] ?? null;
}
