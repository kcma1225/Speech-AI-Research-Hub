import { NextResponse } from "next/server";
import { z } from "zod";
import { currentUser } from "@/lib/auth";
import { transaction } from "@/lib/db";

const input = z.object({ title: z.string().trim().min(1).max(160), tagIds: z.array(z.string().uuid()).max(100).default([]) });

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "請重新登入。" }, { status: 401 });
  if (user.role === "professor") return NextResponse.json({ error: "Professor 僅可閱讀研究筆記。" }, { status: 403 });
  const data = input.safeParse(await request.json().catch(() => null));
  if (!data.success) return NextResponse.json({ error: "請輸入筆記名稱。" }, { status: 400 });
  const id = await transaction(async client => {
    const result = await client.query<{ id: string }>("INSERT INTO items(title,content,event_date,created_by,updated_by) VALUES($1,'',(now() AT TIME ZONE 'Asia/Taipei')::date,$2,$2) RETURNING id", [data.data.title, user.id]);
    const itemId = result.rows[0].id;
    await client.query("INSERT INTO item_tags(item_id,tag_id) SELECT $1,t.id FROM tags t WHERE t.id=ANY($2::uuid[]) ON CONFLICT DO NOTHING", [itemId, [...new Set(data.data.tagIds)]]);
    return itemId;
  });
  return NextResponse.json({ id }, { status: 201 });
}
