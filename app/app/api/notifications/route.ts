import { NextResponse } from "next/server";
import { z } from "zod";
import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";
export async function GET(){
  const user=await currentUser();if(!user)return NextResponse.json({error:"請重新登入。"},{status:401});
  const result=await(await db()).query("SELECT id,kind,title,body,url,read_at,created_at FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100",[user.id]);
  return NextResponse.json({notifications:result.rows},{headers:{"Cache-Control":"no-store"}});
}
const removeInput=z.object({id:z.string().uuid().optional()});
export async function DELETE(request:Request){
  const user=await currentUser();if(!user)return NextResponse.json({error:"請重新登入。"},{status:401});
  const data=removeInput.safeParse(await request.json().catch(()=>({})));if(!data.success)return NextResponse.json({error:"欄位內容不正確。"},{status:400});
  const pool=await db();
  const result=data.data.id
    ?await pool.query("DELETE FROM notifications WHERE id=$1 AND user_id=$2",[data.data.id,user.id])
    :await pool.query("DELETE FROM notifications WHERE user_id=$1",[user.id]);
  return NextResponse.json({removed:result.rowCount??0});
}
