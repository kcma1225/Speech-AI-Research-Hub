import { rm } from "node:fs/promises";
import { NextResponse } from "next/server";
import { z } from "zod";
import { currentUser } from "@/lib/auth";
import { db, transaction } from "@/lib/db";
import { isUuid } from "@/lib/origin";
import { projectDir, shareKey } from "@/lib/slides";
import { setOwnerTags, slideTags, tagIds } from "@/lib/tag-store";

const input=z.object({title:z.string().trim().min(1).max(160).optional(),publicView:z.boolean().optional(),rotateShare:z.boolean().optional(),tagIds:tagIds.optional()});
type Context={params:Promise<{id:string}>};
export async function PATCH(request:Request,{params}:Context){
  const user=await currentUser();if(!user)return NextResponse.json({error:"請重新登入。"},{status:401});
  if(user.role==="professor")return NextResponse.json({error:"權限不足。"},{status:403});
  const {id}=await params;if(!isUuid(id))return NextResponse.json({error:"簡報不存在。"},{status:404});
  const parsed=input.safeParse(await request.json().catch(()=>null));if(!parsed.success)return NextResponse.json({error:"欄位不正確。"},{status:400});
  const {title,publicView,rotateShare,tagIds:ids}=parsed.data;
  const project=await transaction(async client=>{
    const result=await client.query("UPDATE slide_projects SET title=COALESCE($1,title),public_view=COALESCE($2,public_view),share_key=CASE WHEN $3::boolean THEN $4 ELSE share_key END,updated_by=$5,updated_at=now() WHERE id=$6 RETURNING id,slug,title,public_view,share_key",[title??null,publicView??null,rotateShare??false,shareKey(),user.id,id]);
    if(result.rowCount&&ids)await setOwnerTags(client,slideTags,id,ids);
    return result.rows[0];
  });
  return project?NextResponse.json({project}):NextResponse.json({error:"簡報不存在。"},{status:404});
}
export async function DELETE(_:Request,{params}:Context){
  const user=await currentUser();if(!user)return NextResponse.json({error:"請重新登入。"},{status:401});
  if(user.role==="professor")return NextResponse.json({error:"權限不足。"},{status:403});
  const {id}=await params;if(!isUuid(id))return NextResponse.json({error:"簡報不存在。"},{status:404});
  const result=await(await db()).query("DELETE FROM slide_projects WHERE id=$1 RETURNING id",[id]);
  if(!result.rowCount)return NextResponse.json({error:"簡報不存在。"},{status:404});
  await rm(projectDir(id),{recursive:true,force:true});
  return NextResponse.json({ok:true});
}
