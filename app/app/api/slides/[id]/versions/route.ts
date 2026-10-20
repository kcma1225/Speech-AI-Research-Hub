import { rm } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { db, transaction } from "@/lib/db";
import { crossOrigin, isUuid } from "@/lib/origin";
import { enqueueRender, newVersionId, projectDir, saveVersionSource } from "@/lib/slides";

type Context={params:Promise<{id:string}>};
export async function GET(_:Request,{params}:Context){
  if(!await currentUser())return NextResponse.json({error:"請重新登入。"},{status:401});
  const {id}=await params;if(!isUuid(id))return NextResponse.json({error:"簡報不存在。"},{status:404});
  const result=await(await db()).query("SELECT v.id,v.version,v.status,v.error,v.source_name,v.created_at,p.active_version_id FROM slide_versions v JOIN slide_projects p ON p.id=v.project_id WHERE v.project_id=$1 ORDER BY v.version DESC",[id]);
  return NextResponse.json({versions:result.rows});
}
export async function POST(request:Request,{params}:Context){
  const denied=crossOrigin(request);if(denied)return denied;
  const user=await currentUser();if(!user)return NextResponse.json({error:"請重新登入。"},{status:401});
  if(user.role==="professor")return NextResponse.json({error:"權限不足。"},{status:403});
  const {id}=await params;if(!isUuid(id))return NextResponse.json({error:"簡報不存在。"},{status:404});
  const project=await(await db()).query("SELECT id FROM slide_projects WHERE id=$1",[id]);if(!project.rowCount)return NextResponse.json({error:"簡報不存在。"},{status:404});
  const form=await request.formData().catch(()=>null),file=form?.get("file"),entry=String(form?.get("entry")??"");
  if(!(file instanceof File)||!file.size||file.size>100*1024*1024||!/\.zip$/i.test(file.name))return NextResponse.json({error:"請選擇 100 MB 以下的 ZIP。"},{status:400});
  const versionId=newVersionId();
  try{
    const source=await saveVersionSource(id,versionId,file,entry);
    const version=await transaction(async client=>{
      const lock=await client.query("SELECT id FROM slide_projects WHERE id=$1 FOR UPDATE",[id]);if(!lock.rowCount)throw new Error("簡報不存在。");
      const number=await client.query<{version:number}>("SELECT COALESCE(max(version),0)+1 AS version FROM slide_versions WHERE project_id=$1",[id]);
      const value=number.rows[0].version;
      await client.query("INSERT INTO slide_versions(id,project_id,version,entry_qmd,entry_html,source_name) VALUES($1,$2,$3,$4,$5,$6)",[versionId,id,value,source.entry,source.html,file.name]);
      return value;
    });
    try{await enqueueRender(id,versionId,source.entry)}catch(error){
      await(await db()).query("UPDATE slide_versions SET status='failed',error=$1 WHERE id=$2",[error instanceof Error?error.message:"無法排入編譯工作。",versionId]);
      return NextResponse.json({error:"無法排入編譯工作。"},{status:500});
    }
    return NextResponse.json({versionId,version,scan:source.scan},{status:201});
  }catch(error){
    await rm(path.join(projectDir(id),"versions",versionId),{recursive:true,force:true});
    return NextResponse.json({error:error instanceof Error?error.message:"版本上傳失敗。"},{status:400});
  }
}
