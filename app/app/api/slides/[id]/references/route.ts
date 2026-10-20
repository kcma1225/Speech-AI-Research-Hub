import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { db, transaction } from "@/lib/db";
import { crossOrigin, isUuid } from "@/lib/origin";
import { projectDir } from "@/lib/slides";
type Context={params:Promise<{id:string}>};
export async function POST(request:Request,{params}:Context){
  const denied=crossOrigin(request);if(denied)return denied;
  const user=await currentUser();if(!user)return NextResponse.json({error:"請重新登入。"},{status:401});
  if(user.role==="professor")return NextResponse.json({error:"權限不足。"},{status:403});
  const {id}=await params;if(!isUuid(id))return NextResponse.json({error:"簡報不存在。"},{status:404});
  const form=await request.formData().catch(()=>null);if(!form)return NextResponse.json({error:"上傳中斷。"},{status:400});
  const title=String(form.get("title")??"").trim(),url=String(form.get("url")??"").trim(),file=form.get("file");
  const pdf=file instanceof File&&file.size?file:null;
  if(!title||title.length>300||Boolean(url)===Boolean(pdf)||pdf&&(pdf.size>30*1024*1024||!pdf.name.toLowerCase().endsWith(".pdf")))return NextResponse.json({error:"請填名稱，並提供 PDF（30 MB 以下）或 HTTP(S) 連結。"},{status:400});
  if(url){try{const parsed=new URL(url);if(!["http:","https:"].includes(parsed.protocol))throw new Error("invalid")}catch{return NextResponse.json({error:"連結須為 HTTP(S) 網址。"},{status:400})}}
  if(pdf){const header=new Uint8Array(await pdf.slice(0,5).arrayBuffer());if(new TextDecoder().decode(header)!=="%PDF-")return NextResponse.json({error:"檔案不是 PDF。"},{status:415})}
  const refId=randomUUID(),fileName=pdf?`${refId}.pdf`:null;
  try{
    if(pdf){const dir=path.join(projectDir(id),"references");await mkdir(dir,{recursive:true});await writeFile(path.join(dir,fileName!),Buffer.from(await pdf.arrayBuffer()))}
    await transaction(async client=>{
      const project=await client.query("SELECT id FROM slide_projects WHERE id=$1 FOR UPDATE",[id]);if(!project.rowCount)throw new Error("簡報不存在。");
      const count=await client.query("SELECT count(*)::int AS count FROM slide_references WHERE project_id=$1",[id]);
      await client.query("INSERT INTO slide_references(id,project_id,title,url,file_name,is_default) VALUES($1,$2,$3,$4,$5,$6)",[refId,id,title,url||null,fileName,count.rows[0].count===0]);
    });
    return NextResponse.json({id:refId},{status:201});
  }catch(error){return NextResponse.json({error:error instanceof Error?error.message:"參考資料新增失敗。"},{status:400})}
}
