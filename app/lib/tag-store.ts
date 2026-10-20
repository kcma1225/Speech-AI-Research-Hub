import { NextResponse } from "next/server";
import { z } from "zod";
import { currentUser } from "./auth";
import { db, type Queryable } from "./db";
import type { Tag, TagWithCount } from "./tag-types";

/** One tag namespace. All SQL is static per namespace; no identifiers are interpolated. */
export type TagStore = { readOnly: string; sql: { list: string; owner: string; clear: string; assign: string; insert: string; rename: string; remove: string } };
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
export const tagIds = z.array(z.string().uuid()).max(100);
export const isUniqueViolation = (error: unknown) => (error as { code?: string }).code === "23505";
const uuid = z.string().uuid();
const input = z.object({ name: tagName });

export async function listStoreTags(client: Queryable, store: TagStore) {
  const result = await client.query<TagWithCount>(store.sql.list);
  return result.rows;
}

export async function ownerTags(client: Queryable, store: TagStore, ownerId: string) {
  const result = await client.query<Tag>(store.sql.owner, [ownerId]);
  return result.rows;
}

/** Replace an owner's tags; unknown ids are ignored. Caller holds the transaction. */
export async function setOwnerTags(client: Queryable, store: TagStore, ownerId: string, ids: string[]) {
  await client.query(store.sql.clear, [ownerId]);
  await client.query(store.sql.assign, [ownerId, [...new Set(ids)]]);
}

async function writer(store: TagStore) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "請重新登入。" }, { status: 401 });
  if (user.role === "professor") return NextResponse.json({ error: store.readOnly }, { status: 403 });
  return null;
}

export function tagCollectionRoutes(store: TagStore) {
  return {
    async GET() {
      if (!await currentUser()) return NextResponse.json({ error: "請重新登入。" }, { status: 401 });
      return NextResponse.json({ tags: await listStoreTags(await db(), store) });
    },
    async POST(request: Request) {
      const denied = await writer(store);
      if (denied) return denied;
      const data = input.safeParse(await request.json().catch(() => null));
      if (!data.success) return NextResponse.json({ error: data.error.issues[0]?.message ?? "標籤名稱不正確。" }, { status: 400 });
      try {
        const result = await (await db()).query<Tag>(store.sql.insert, [data.data.name]);
        return NextResponse.json({ tag: { ...result.rows[0], count: 0 } }, { status: 201 });
      } catch (error) {
        if (isUniqueViolation(error)) return NextResponse.json({ error: "已有同名標籤。" }, { status: 409 });
        throw error;
      }
    },
  };
}

type Context = { params: Promise<{ id: string }> };
export function tagMemberRoutes(store: TagStore) {
  return {
    async PATCH(request: Request, { params }: Context) {
      const denied = await writer(store);
      if (denied) return denied;
      const { id } = await params;
      if (!uuid.safeParse(id).success) return NextResponse.json({ error: "標籤不存在。" }, { status: 404 });
      const data = input.safeParse(await request.json().catch(() => null));
      if (!data.success) return NextResponse.json({ error: data.error.issues[0]?.message ?? "標籤名稱不正確。" }, { status: 400 });
      try {
        const result = await (await db()).query(store.sql.rename, [data.data.name, id]);
        if (!result.rowCount) return NextResponse.json({ error: "標籤不存在。" }, { status: 404 });
        return NextResponse.json({ tag: result.rows[0] });
      } catch (error) {
        if (isUniqueViolation(error)) return NextResponse.json({ error: "已有同名標籤。" }, { status: 409 });
        throw error;
      }
    },
    async DELETE(_: Request, { params }: Context) {
      const denied = await writer(store);
      if (denied) return denied;
      const { id } = await params;
      if (!uuid.safeParse(id).success) return NextResponse.json({ error: "標籤不存在。" }, { status: 404 });
      const result = await (await db()).query(store.sql.remove, [id]);
      if (!result.rowCount) return NextResponse.json({ error: "標籤不存在。" }, { status: 404 });
      return NextResponse.json({ ok: true });
    },
  };
}
