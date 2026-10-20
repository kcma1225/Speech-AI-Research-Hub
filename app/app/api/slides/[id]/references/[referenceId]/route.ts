import { unlink } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { transaction } from "@/lib/db";
import { isUuid } from "@/lib/origin";
import { projectDir } from "@/lib/slides";
type Context={params:Promise<{id:string;referenceId:string}>};
export async function PATCH(_:Request,{params}:Context){
  const user=await currentUser();if(!user)return NextResponse.json({error:"請重新登入。"},{status:401});if(user.role==="professor")return NextResponse.json({error:"權限不足。"},{status:403});
  const {id,referenceId}=await params;if(!isUuid(id)||!isUuid(referenceId))return NextResponse.json({error:"參考資料不存在。"},{status:404});
  const found=await transaction(async client=>{
    const lock=await client.query("SELECT id FROM slide_projects WHERE id=$1 FOR UPDATE",[id]);if(!lock.rowCount)return false;
    const result=await client.query("SELECT id FROM slide_references WHERE id=$1 AND project_id=$2",[referenceId,id]);if(!result.rowCount)return false;
    await client.query("UPDATE slide_references SET is_default=false WHERE project_id=$1 AND is_default",[id]);
    await client.query("UPDATE slide_references SET is_default=true WHERE id=$1",[referenceId]);return true;
  });
  return found?NextResponse.json({ok:true}):NextResponse.json({error:"參考資料不存在。"},{status:404});
}
export async function DELETE(_:Request,{params}:Context){
  const user=await currentUser();if(!user)return NextResponse.json({error:"請重新登入。"},{status:401});if(user.role==="professor")return NextResponse.json({error:"權限不足。"},{status:403});
  const {id,referenceId}=await params;if(!isUuid(id)||!isUuid(referenceId))return NextResponse.json({error:"參考資料不存在。"},{status:404});
  const removed=await transaction(async client=>{
    const lock=await client.query("SELECT id FROM slide_projects WHERE id=$1 FOR UPDATE",[id]);if(!lock.rowCount)return null;
    const result=await client.query("DELETE FROM slide_references WHERE id=$1 AND project_id=$2 RETURNING file_name,is_default",[referenceId,id]);if(!result.rowCount)return null;
    if(result.rows[0].is_default)await client.query("UPDATE slide_references SET is_default=true WHERE id=(SELECT id FROM slide_references WHERE project_id=$1 ORDER BY created_at,id LIMIT 1)",[id]);
    return result.rows[0] as {file_name:string|null};
  });
  if(!removed)return NextResponse.json({error:"參考資料不存在。"},{status:404});
  if(removed.file_name)await unlink(path.join(projectDir(id),"references",removed.file_name)).catch(()=>undefined);
  return NextResponse.json({ok:true});
}
