import { NextResponse } from "next/server";
import { z } from "zod";
import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";
const input=z.object({id:z.string().uuid().optional()});
export async function POST(request:Request){
  const user=await currentUser();if(!user)return NextResponse.json({error:"請重新登入。"},{status:401});
  const data=input.safeParse(await request.json().catch(()=>({})));if(!data.success)return NextResponse.json({error:"欄位內容不正確。"},{status:400});
  const pool=await db();
  if(data.data.id)await pool.query("UPDATE notifications SET read_at=now() WHERE id=$1 AND user_id=$2 AND read_at IS NULL",[data.data.id,user.id]);
  else await pool.query("UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL",[user.id]);
  return NextResponse.json({ok:true});
}
