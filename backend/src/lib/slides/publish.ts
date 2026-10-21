/**
 * 「發布新版本」 from the in-app source tree: packs the tree into a Quarto ZIP and renders it as a new version (same
 * flow as an upload). Used by POST /slides/:id/source/publish and by the AI draft job's automatic first version.
 */
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { transaction, type Db } from "../../db.js";
import { badRequest, HttpError } from "../http.js";
import { keys, type Storage } from "../storage.js";
import { detectDeck, SOURCE_CONTENT_TYPES } from "./source.js";
import { packTree } from "./sources.js";
import { insertVersion, nextVersionNumber } from "./versions.js";

export type PublishedTree = { versionId: string; version: number; jobId: string; revision: number; entry: string };

/**
 * Publishes the deck's current tree as a new version. With `firstOnly` the publish happens only when the deck has no
 * version yet and the tree is still at `expectRevision` (the AI draft's automatic v1); returns null when skipped.
 */
export async function publishTree(
  db: Db,
  storage: Storage,
  deckId: string,
  userId: string,
  opts: { maxZipBytes: number; firstOnly?: { expectRevision: number } },
): Promise<PublishedTree | null> {
  const { zip, tree } = await packTree(db, storage, deckId);
  if (opts.firstOnly && tree.revision !== opts.firstOnly.expectRevision) return null;
  const dir = await mkdtemp(path.join(tmpdir(), "hub-publish-"));
  try {
    const zipPath = path.join(dir, "source.zip");
    await writeFile(zipPath, zip);
    let deck;
    try {
      deck = await detectDeck({ path: zipPath, filename: "source.zip" }, tree.entry, opts.maxZipBytes);
    } catch (error) {
      if (error instanceof HttpError) throw badRequest(`原始檔無法發布：${error.message}`);
      throw error;
    }
    const versionId = randomUUID();
    await storage.put(keys.slideSource(deckId, versionId, "zip"), createReadStream(zipPath), SOURCE_CONTENT_TYPES.quarto);
    try {
      const result = await transaction(db, async client => {
        await client.query("SELECT 1 FROM decks WHERE id=$1 FOR UPDATE", [deckId]);
        if (opts.firstOnly) {
          const existing = await client.query("SELECT 1 FROM slide_versions WHERE deck_id=$1 LIMIT 1", [deckId]);
          const current = await client.query<{ revision: number }>("SELECT revision FROM deck_source_trees WHERE deck_id=$1", [deckId]);
          if (existing.rowCount || current.rows[0]?.revision !== opts.firstOnly.expectRevision) return null;
        }
        const version = await nextVersionNumber(client, deckId);
        const jobId = await insertVersion(client, userId, deckId, versionId, version, deck, `quarto-r${tree.revision}.zip`);
        await client.query("UPDATE deck_source_trees SET published_revision=$2 WHERE deck_id=$1", [deckId, tree.revision]);
        await client.query("UPDATE decks SET updated_by=$2,updated_at=now() WHERE id=$1", [deckId, userId]);
        return { version, jobId };
      });
      if (!result) {
        await storage.deletePrefix(`${keys.slideProjectPrefix(deckId)}${versionId}/`).catch(() => {});
        return null;
      }
      return { versionId, ...result, revision: tree.revision, entry: deck.entry };
    } catch (error) {
      await storage.deletePrefix(`${keys.slideProjectPrefix(deckId)}${versionId}/`).catch(() => {});
      throw error;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
