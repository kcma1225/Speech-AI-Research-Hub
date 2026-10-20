import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { db, transaction } from "@/lib/db";
import { crossOrigin } from "@/lib/origin";
import { enqueueRender, newVersionId, projectDir, saveVersionSource, shareKey } from "@/lib/slides";
import { setOwnerTags, slideTags, tagIds } from "@/lib/tag-store";

export async function GET(){
  if(!await currentUser())return NextResponse.json({error:"請重新登入。"},{status:401});
  const result=await(await db()).query("SELECT p.id,p.title,p.slug,p.public_view,p.updated_at,v.version,v.status,COALESCE((SELECT json_agg(json_build_object('id',t.id,'name',t.name)) FROM slide_project_tags j JOIN slide_tags t ON t.id=j.tag_id WHERE j.project_id=p.id),'[]') AS tags FROM slide_projects p LEFT JOIN LATERAL (SELECT version,status FROM slide_versions WHERE project_id=p.id ORDER BY version DESC LIMIT 1) v ON true ORDER BY p.updated_at DESC");
  return NextResponse.json(result.rows);
}
export async function POST(request:Request){
  const denied=crossOrigin(request);if(denied)return denied;
  const user=await currentUser();if(!user)return NextResponse.json({error:"請重新登入。"},{status:401});
  if(user.role==="professor")return NextResponse.json({error:"權限不足。"},{status:403});
  const form=await request.formData().catch(()=>null);if(!form)return NextResponse.json({error:"上傳中斷。"},{status:400});
  const title=String(form.get("title")??"").trim(),slug=String(form.get("slug")??"").trim().toLowerCase();
  const entry=String(form.get("entry")??"").trim(),file=form.get("file");
  let rawTags:unknown;
  try{rawTags=JSON.parse(String(form.get("tagIds")??"[]"))}catch{return NextResponse.json({error:"標籤格式不正確。"},{status:400})}
  const tags=tagIds.safeParse(rawTags);
  if(!title||title.length>160||!tags.success||!(file instanceof File)||!file.size||file.size>100*1024*1024||!/\.zip$/i.test(file.name)||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))return NextResponse.json({error:"請確認名稱、slug、標籤與 ZIP 檔案（上限 100 MB）。"},{status:400});
  const id=randomUUID(),versionId=newVersionId();
  try{
    const {entry:chosen,html,scan}=await saveVersionSource(id,versionId,file,entry);
    await transaction(async client=>{
      await client.query("INSERT INTO slide_projects(id,title,slug,share_key,active_version_id,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$6)",[id,title,slug,shareKey(),versionId,user.id]);
      await client.query("INSERT INTO slide_versions(id,project_id,version,entry_qmd,entry_html,source_name) VALUES($1,$2,1,$3,$4,$5)",[versionId,id,chosen,html,file.name]);
      await setOwnerTags(client,slideTags,id,tags.data);
    });
    try{await enqueueRender(id,versionId,chosen)}catch(error){
      await (await db()).query("UPDATE slide_versions SET status='failed',error=$1 WHERE id=$2",[error instanceof Error?error.message:"無法排入編譯工作。",versionId]);
      return NextResponse.json({error:"無法排入編譯工作。"},{status:500});
    }
    return NextResponse.json({id,slug,version:1,scan},{status:201});
  }catch(error){
    await (await db()).query("DELETE FROM slide_projects WHERE id=$1",[id]).catch(()=>undefined);
    await rm(projectDir(id),{recursive:true,force:true});
    if((error as {code?:string}).code==="23505")return NextResponse.json({error:"slug 已被使用。"},{status:409});
    return NextResponse.json({error:error instanceof Error?error.message:"ZIP 無法處理。"},{status:400});
  }
}
