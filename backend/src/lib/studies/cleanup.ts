import type pg from "pg";

/**
 * Hooks run inside the `DELETE /studies/:ref` transaction, before the study row is deleted (rows cascade).
 * A module that keeps S3 objects (or other external state) for a study registers one: collect what to remove
 * with `client`, and return a post-commit callback that removes it. Callbacks never block the delete.
 */
export type StudyCleanup = (client: pg.PoolClient, studyId: string) => Promise<void | (() => Promise<void>)>;

const hooks = new Map<string, StudyCleanup>();

/** `name` identifies the module (re-registering replaces, so plugin re-registration in tests is harmless). */
export function registerStudyCleanup(name: string, hook: StudyCleanup) {
  hooks.set(name, hook);
}

export async function runStudyCleanups(client: pg.PoolClient, studyId: string) {
  const after: (() => Promise<void>)[] = [];
  for (const hook of hooks.values()) {
    const callback = await hook(client, studyId);
    if (callback) after.push(callback);
  }
  return after;
}
