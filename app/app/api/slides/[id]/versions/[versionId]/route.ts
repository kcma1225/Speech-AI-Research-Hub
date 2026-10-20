import { rm } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { db, transaction } from "@/lib/db";
import { isUuid } from "@/lib/origin";
import { projectDir } from "@/lib/slides";
type Context={params:Promise<{id:string;versionId:string}>};
export async function PATCH(_:Request,{params}:Context){
  const user=await currentUser();if(!user)return NextResponse.json({error:"請重新登入。"},{status:401});
  if(user.role==="professor")return NextResponse.json({error:"權限不足。"},{status:403});
  const {id,versionId}=await params;if(!isUuid(id)||!isUuid(versionId))return NextResponse.json({error:"版本不存在。"},{status:404});
  const result=await(await db()).query("UPDATE slide_projects SET active_version_id=$1,updated_by=$3,updated_at=now() WHERE id=$2 AND EXISTS(SELECT 1 FROM slide_versions WHERE id=$1 AND project_id=$2 AND status='published') RETURNING id",[versionId,id,user.id]);
  return result.rowCount?NextResponse.json({ok:true}):NextResponse.json({error:"版本尚未發布或不存在。"},{status:404});
}
export async function DELETE(_:Request,{params}:Context){
  const user=await currentUser();if(!user)return NextResponse.json({error:"請重新登入。"},{status:401});
  if(user.role==="professor")return NextResponse.json({error:"權限不足。"},{status:403});
  const {id,versionId}=await params;if(!isUuid(id)||!isUuid(versionId))return NextResponse.json({error:"版本不存在。"},{status:404});
  const removed=await transaction(async client=>{
    const lock=await client.query("SELECT active_version_id FROM slide_projects WHERE id=$1 FOR UPDATE",[id]);
    if(!lock.rowCount||lock.rows[0].active_version_id===versionId)return false;
    const result=await client.query("DELETE FROM slide_versions WHERE id=$1 AND project_id=$2 RETURNING id",[versionId,id]);return Boolean(result.rowCount);
  });
  if(!removed)return NextResponse.json({error:"無法刪除目前版本；請先切換版本。"},{status:409});
  await rm(path.join(projectDir(id),"versions",versionId),{recursive:true,force:true});
  return NextResponse.json({ok:true});
}
