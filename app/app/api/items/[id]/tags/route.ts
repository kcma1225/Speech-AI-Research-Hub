import { NextResponse } from "next/server";
import { z } from "zod";
import { currentUser } from "@/lib/auth";
import { transaction } from "@/lib/db";
import { itemTags } from "@/lib/tags";

const input = z.object({ tagIds: z.array(z.string().uuid()).max(100) });

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "請重新登入。" }, { status: 401 });
  if (user.role === "professor") return NextResponse.json({ error: "Professor 僅可閱讀研究筆記。" }, { status: 403 });
  const { id } = await params;
  const data = input.safeParse(await request.json().catch(() => null));
  if (!z.string().uuid().safeParse(id).success || !data.success) return NextResponse.json({ error: "標籤資料不正確。" }, { status: 400 });
  const tags = await transaction(async client => {
    const item = await client.query("SELECT id FROM items WHERE id=$1 FOR UPDATE", [id]);
    if (!item.rowCount) return null;
    await client.query("DELETE FROM item_tags WHERE item_id=$1", [id]);
    await client.query("INSERT INTO item_tags(item_id,tag_id) SELECT $1,t.id FROM tags t WHERE t.id=ANY($2::uuid[]) ON CONFLICT DO NOTHING", [id, [...new Set(data.data.tagIds)]]);
    await client.query("UPDATE items SET updated_by=$1,updated_at=now() WHERE id=$2", [user.id, id]);
    return itemTags(client, id);
  });
  if (!tags) return NextResponse.json({ error: "筆記不存在。" }, { status: 404 });
  return NextResponse.json({ tags });
}
