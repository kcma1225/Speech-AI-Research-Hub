import argon2 from "argon2";
import { NextResponse } from "next/server";
import { z } from "zod";
import { currentUser, tokenHash } from "@/lib/auth";
import { cookies } from "next/headers";
import { db } from "@/lib/db";

const input = z.object({
  name: z.string().trim().min(1).max(80),
  currentPassword: z.string().min(1),
  newPassword: z.string().max(4096).refine(value=>value.trim().length>0).optional(),
});

export async function PATCH(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({error:"請重新登入。"},{status:401});
  const parsed = input.safeParse(await request.json().catch(()=>null));
  if (!parsed.success) return NextResponse.json({error:"請填寫名稱、目前密碼；新密碼不可只有空白。"},{status:400});
  const pool = await db();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const record = await client.query<{password_hash:string}>("SELECT password_hash FROM users WHERE id=$1 FOR UPDATE",[user.id]);
    if (!record.rowCount || !await argon2.verify(record.rows[0].password_hash,parsed.data.currentPassword).catch(()=>false)) {
      await client.query("ROLLBACK");
      return NextResponse.json({error:"目前密碼不正確。"},{status:403});
    }
    if (parsed.data.newPassword) {
      const hash = await argon2.hash(parsed.data.newPassword,{type:argon2.argon2id});
      await client.query("UPDATE users SET name=$1,password_hash=$2 WHERE id=$3",[parsed.data.name,hash,user.id]);
      const sessionToken = (await cookies()).get("research_session")?.value ?? "";
      await client.query("DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2",[user.id,tokenHash(sessionToken)]);
    } else await client.query("UPDATE users SET name=$1 WHERE id=$2",[parsed.data.name,user.id]);
    await client.query("INSERT INTO audit_log(actor_id,action,target_type,target_id) VALUES($1,$2,'user',$1)",[user.id,parsed.data.newPassword?"profile_password_changed":"profile_name_changed"]);
    await client.query("COMMIT");
    return NextResponse.json({name:parsed.data.name});
  } catch {
    await client.query("ROLLBACK");
    return NextResponse.json({error:"更新失敗，請稍後再試。"},{status:500});
  } finally {client.release()}
}
