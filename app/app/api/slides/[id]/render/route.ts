import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { isUuid } from "@/lib/origin";
import { enqueueRender } from "@/lib/slides";

export async function POST(_:Request,{params}:{params:Promise<{id:string}>}){
  const user=await currentUser();if(!user)return NextResponse.json({error:"請重新登入。"},{status:401});
  if(user.role==="professor")return NextResponse.json({error:"權限不足。"},{status:403});
  const {id}=await params;if(!isUuid(id))return NextResponse.json({error:"簡報不存在。"},{status:404});
  const pool=await db();
  const result=await pool.query("SELECT v.id,v.entry_qmd FROM slide_versions v WHERE v.project_id=$1 AND v.status='failed' ORDER BY v.version DESC LIMIT 1",[id]);
  if(!result.rowCount)return NextResponse.json({error:"沒有可重試的失敗版本。"},{status:404});
  const version=result.rows[0];
  await pool.query("UPDATE slide_versions SET status='queued',error=NULL WHERE id=$1",[version.id]);
  await enqueueRender(id,version.id,version.entry_qmd);
  return NextResponse.json({versionId:version.id},{status:202});
}
