import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isUuid } from "@/lib/origin";
import { slideAccess } from "@/lib/slide-access";
import { projectDir } from "@/lib/slides";
export async function GET(request:Request,{params}:{params:Promise<{slug:string;referenceId:string}>}){
  const {slug,referenceId}=await params;
  if(!isUuid(referenceId))return new NextResponse("Not found",{status:404});
  const access=await slideAccess(slug);if(!access)return new NextResponse("Not found",{status:404});
  const result=await(await db()).query("SELECT file_name FROM slide_references WHERE id=$1 AND project_id=$2",[referenceId,access.project.id]);
  const name=result.rows[0]?.file_name;
  if(!name||name!==`${referenceId}.pdf`)return new NextResponse("Not found",{status:404});
  try{return new NextResponse(await readFile(path.join(projectDir(access.project.id),"references",name)),{headers:{"Content-Type":"application/pdf","Content-Disposition":"inline","Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}})}catch{return new NextResponse("Not found",{status:404})}
}
