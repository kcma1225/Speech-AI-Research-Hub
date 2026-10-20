import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Queryable } from "../../db.js";
import { requireUser, type CurrentUser } from "../auth.js";
import { badRequest, conflict, forbidden, idParams, isUniqueViolation, notFound, parse } from "../http.js";

export type Tag = { id: string; name: string };
export type TagWithCount = Tag & { count: number };
/** Filter token for "no tag". */
export const NO_TAG = "none";

/** One tag namespace. All SQL is static per namespace; no identifiers are interpolated. */
export type TagStore = {
  readOnly: string;
  sql: { list: string; owner: string; clear: string; assign: string; insert: string; rename: string; remove: string };
};

export const noteTags: TagStore = {
  readOnly: "Professor 僅可閱讀研究筆記。",
  sql: {
    list: "SELECT t.id,t.name,count(j.item_id)::int AS count FROM tags t LEFT JOIN item_tags j ON j.tag_id=t.id GROUP BY t.id ORDER BY lower(t.name)",
    owner: "SELECT t.id,t.name FROM item_tags j JOIN tags t ON t.id=j.tag_id WHERE j.item_id=$1 ORDER BY lower(t.name)",
    clear: "DELETE FROM item_tags WHERE item_id=$1",
    assign: "INSERT INTO item_tags(item_id,tag_id) SELECT $1,t.id FROM tags t WHERE t.id=ANY($2::uuid[]) ON CONFLICT DO NOTHING",
    insert: "INSERT INTO tags(name) VALUES($1) RETURNING id,name",
    rename: "UPDATE tags SET name=$1 WHERE id=$2 RETURNING id,name",
    remove: "DELETE FROM tags WHERE id=$1",
  },
};

export const slideTags: TagStore = {
  readOnly: "Professor 僅可檢視簡報。",
  sql: {
    list: "SELECT t.id,t.name,count(j.project_id)::int AS count FROM slide_tags t LEFT JOIN slide_project_tags j ON j.tag_id=t.id GROUP BY t.id ORDER BY lower(t.name)",
    owner: "SELECT t.id,t.name FROM slide_project_tags j JOIN slide_tags t ON t.id=j.tag_id WHERE j.project_id=$1 ORDER BY lower(t.name)",
    clear: "DELETE FROM slide_project_tags WHERE project_id=$1",
    assign: "INSERT INTO slide_project_tags(project_id,tag_id) SELECT $1,t.id FROM slide_tags t WHERE t.id=ANY($2::uuid[]) ON CONFLICT DO NOTHING",
    insert: "INSERT INTO slide_tags(name) VALUES($1) RETURNING id,name",
    rename: "UPDATE slide_tags SET name=$1 WHERE id=$2 RETURNING id,name",
    remove: "DELETE FROM slide_tags WHERE id=$1",
  },
};

export const tagName = z.string().trim().min(1, "請輸入標籤名稱。").max(40, "標籤名稱最多 40 字。");
export const tagIds = z.array(z.uuid()).max(100);
const nameInput = z.object({ name: tagName });

export async function listStoreTags(client: Queryable, store: TagStore) {
  return (await client.query<TagWithCount>(store.sql.list)).rows;
}

export async function ownerTags(client: Queryable, store: TagStore, ownerId: string) {
  return (await client.query<Tag>(store.sql.owner, [ownerId])).rows;
}

/** Replaces an owner's tags; unknown ids are ignored. Caller holds the transaction. */
export async function setOwnerTags(client: Queryable, store: TagStore, ownerId: string, ids: string[]) {
  await client.query(store.sql.clear, [ownerId]);
  await client.query(store.sql.assign, [ownerId, [...new Set(ids)]]);
}

/** Signed-in user who may change this namespace (everyone but Professor). */
export async function requireTagWriter(request: FastifyRequest, store: TagStore): Promise<CurrentUser> {
  const user = await requireUser(request);
  if (user.role === "professor") throw forbidden(store.readOnly);
  return user;
}

function parseName(body: unknown) {
  const result = nameInput.safeParse(body);
  if (!result.success) throw badRequest(result.error.issues[0]?.message ?? "標籤名稱不正確。");
  return result.data.name;
}

function tagNotFound() {
  return notFound("標籤不存在。");
}

/** Registers GET/POST `base` and PATCH/DELETE `base/:id` for one namespace. */
export function registerTagRoutes(app: FastifyInstance, base: string, store: TagStore) {
  app.get(base, async (request, reply) => {
    await requireUser(request);
    return reply.header("Cache-Control", "no-store").send({ tags: await listStoreTags(app.db, store) });
  });

  app.post(base, async (request, reply) => {
    await requireTagWriter(request, store);
    const name = parseName(request.body);
    try {
      const tag = (await app.db.query<Tag>(store.sql.insert, [name])).rows[0]!;
      return reply.code(201).send({ tag: { ...tag, count: 0 } });
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict("已有同名標籤。");
      throw error;
    }
  });

  app.patch(`${base}/:id`, async request => {
    await requireTagWriter(request, store);
    const { id } = parse(idParams, request.params, "標籤不存在。");
    const name = parseName(request.body);
    try {
      const tag = (await app.db.query<Tag>(store.sql.rename, [name, id])).rows[0];
      if (!tag) throw tagNotFound();
      return { tag };
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict("已有同名標籤。");
      throw error;
    }
  });

  app.delete(`${base}/:id`, async request => {
    await requireTagWriter(request, store);
    const { id } = parse(idParams, request.params, "標籤不存在。");
    const result = await app.db.query(store.sql.remove, [id]);
    if (!result.rowCount) throw tagNotFound();
    return { ok: true };
  });
}
