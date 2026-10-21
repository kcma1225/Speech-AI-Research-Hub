import type { Queryable } from "../../db.js";
import { enqueueJob, type SlideRenderPayload, type SlideSourceType } from "../../jobs/queue.js";
import { keys } from "../storage.js";
import { SOURCE_EXTENSIONS, type DetectedDeck } from "./source.js";

export const renderPayload = (projectId: string, versionId: string, sourceType: SlideSourceType, entry: string, outputPrefix?: string): SlideRenderPayload => ({
  projectId,
  versionId,
  sourceKey: keys.slideSource(projectId, versionId, SOURCE_EXTENSIONS[sourceType]),
  entry,
  outputPrefix: outputPrefix ?? keys.slideOutputPrefix(projectId, versionId),
  sourceType,
});

/**
 * Inserts a version row plus its render job. The source file must already be in S3 so a worker never
 * claims a job whose input is missing.
 */
export async function insertVersion(client: Queryable, userId: string, projectId: string, versionId: string, version: number, deck: DetectedDeck, sourceName: string) {
  const payload = renderPayload(projectId, versionId, deck.sourceType, deck.entry);
  const jobId = await enqueueJob(client, "slide_render", payload, userId);
  await client.query(
    `INSERT INTO slide_versions(id,deck_id,version,entry_qmd,source_name,source_key,output_prefix,job_id,created_by,source_type)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [versionId, projectId, version, deck.entry, sourceName.slice(0, 255), payload.sourceKey, payload.outputPrefix, jobId, userId, deck.sourceType],
  );
  return jobId;
}

export async function nextVersionNumber(client: Queryable, deckId: string) {
  return (await client.query<{ next: number }>("SELECT COALESCE(max(version),0)+1 AS next FROM slide_versions WHERE deck_id=$1", [deckId])).rows[0]!.next;
}
