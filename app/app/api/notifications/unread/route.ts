import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";
export async function GET(){
  const user=await currentUser();if(!user)return NextResponse.json({error:"請重新登入。"},{status:401});
  const result=await(await db()).query<{count:number}>("SELECT count(*)::int AS count FROM notifications WHERE user_id=$1 AND read_at IS NULL",[user.id]);
  return NextResponse.json({count:result.rows[0].count},{headers:{"Cache-Control":"no-store"}});
}
