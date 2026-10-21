import { randomBytes } from "node:crypto";
import type { Queryable } from "../src/db.js";

/** Inserts a study (default stages: none) owned by `ownerId`, bypassing the API. Returns its id and slug. */
export async function insertStudy(db: Queryable, ownerId: string, title = `Study ${randomBytes(3).toString("hex")}`) {
  const slug = `s-${randomBytes(4).toString("hex")}`;
  const id = (await db.query<{ id: string }>(
    "INSERT INTO studies(slug,title,created_by,updated_by) VALUES($1,$2,$3,$3) RETURNING id",
    [slug, title, ownerId],
  )).rows[0]!.id;
  await db.query("INSERT INTO study_members(study_id,user_id,role) VALUES($1,$2,'owner')", [id, ownerId]);
  return { id, slug };
}

export async function addStudyMember(db: Queryable, studyId: string, userId: string, role: "member" | "advisor" = "member") {
  await db.query("INSERT INTO study_members(study_id,user_id,role) VALUES($1,$2,$3)", [studyId, userId, role]);
}
