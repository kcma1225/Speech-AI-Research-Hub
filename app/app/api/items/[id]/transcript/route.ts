import { NextResponse } from "next/server";
import { isUuid } from "@/lib/origin";
import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { parseSrt } from "@/lib/srt";
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){
  const user=await currentUser();if(!user)return NextResponse.json({error:"請重新登入。"},{status:401});if(user.role==="professor")return NextResponse.json({error:"Professor 僅可閱讀研究筆記。"},{status:403});
  const {id}=await params;if(!isUuid(id))return NextResponse.json({error:"筆記不存在。"},{status:404});const form=await request.formData().catch(()=>null);const file=form?.get("file");
  if(!(file instanceof File)||!file.size)return NextResponse.json({error:"請選擇 SRT 逐字稿。"},{status:400});
  if(!/\.srt$/i.test(file.name))return NextResponse.json({error:"逐字稿須為 .srt 檔。"},{status:415});
  if(file.size>5*1024*1024)return NextResponse.json({error:"逐字稿不得超過 5 MB。"},{status:413});
  const cues=parseSrt(await file.text());
  if(!cues.length)return NextResponse.json({error:"無法解析 SRT 內容，請確認格式。"},{status:422});
  const result=await(await db()).query("UPDATE items SET transcript=$1,transcript_name=$2,updated_by=$3,updated_at=now() WHERE id=$4 AND storage_name IS NOT NULL RETURNING id",[JSON.stringify(cues),file.name.slice(0,200),user.id,id]);
  if(!result.rowCount)return NextResponse.json({error:"此筆記沒有錄音檔，無法加入逐字稿。"},{status:409});
  return NextResponse.json({ok:true,count:cues.length});
}
export async function DELETE(_:Request,{params}:{params:Promise<{id:string}>}){
  const user=await currentUser();if(!user)return NextResponse.json({error:"請重新登入。"},{status:401});if(user.role==="professor")return NextResponse.json({error:"Professor 僅可閱讀研究筆記。"},{status:403});
  const {id}=await params;if(!isUuid(id))return NextResponse.json({error:"筆記不存在。"},{status:404});await(await db()).query("UPDATE items SET transcript=NULL,transcript_name=NULL,updated_by=$1,updated_at=now() WHERE id=$2",[user.id,id]);
  return NextResponse.json({ok:true});
}
