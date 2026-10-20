import { access, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { db, transaction } from "@/lib/db";
import { isUuid } from "@/lib/origin";
import { projectDir, SLIDES_DIR } from "@/lib/slides";
const exists=(file:string)=>access(file).then(()=>true,()=>false);
export async function GET(_:Request,{params}:{params:Promise<{id:string}>}){
  if(!await currentUser())return NextResponse.json({error:"請重新登入。"},{status:401});
  const {id}=await params;if(!isUuid(id))return NextResponse.json({error:"簡報不存在。"},{status:404});
  const pool=await db();
  const result=await pool.query("SELECT id,status,version,error FROM slide_versions WHERE project_id=$1 ORDER BY version DESC",[id]);
  if(!result.rowCount)return NextResponse.json({error:"簡報不存在。"},{status:404});
  for(const version of result.rows.toReversed().filter(row=>row.status==="queued"||row.status==="rendering")){
    const job=path.join(SLIDES_DIR,"jobs",version.id);
    if(await exists(path.join(job,"complete"))){
      const destination=path.join(projectDir(id),"versions",version.id,"output");
      try{if(await exists(path.join(job,"output"))&&!await exists(destination))await rename(path.join(job,"output"),destination)}catch{return NextResponse.json({...version,status:"rendering"})}
      const quarto=await readFile(path.join(job,"quarto-version"),"utf8").catch(()=>"");
      await transaction(async client=>{
        const updated=await client.query("UPDATE slide_versions SET status='published',quarto_version=$1 WHERE id=$2 AND status IN ('queued','rendering') RETURNING id",[quarto.trim(),version.id]);
        if(updated.rowCount){
          await client.query("UPDATE slide_projects SET active_version_id=$1,updated_at=now() WHERE id=$2 AND (active_version_id IS NULL OR NOT EXISTS (SELECT 1 FROM slide_versions WHERE id=active_version_id AND version>$3))",[version.id,id,version.version]);
        }
      });
      await rm(job,{recursive:true,force:true});
      version.status="published";
    }else if(await exists(path.join(job,"failed"))){
      const log=(await readFile(path.join(job,"render.log"),"utf8").catch(()=>"")).slice(-4000);
      await pool.query("UPDATE slide_versions SET status='failed',error=$1 WHERE id=$2 AND status IN ('queued','rendering')",[log,version.id]);
      await rm(job,{recursive:true,force:true});
      version.status="failed";version.error=log;
    }else version.status=await exists(path.join(job,"rendering"))?"rendering":"queued";
  }
  return NextResponse.json(result.rows[0]);
}
