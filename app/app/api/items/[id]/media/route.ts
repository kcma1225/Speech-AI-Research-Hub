import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { createJob } from "@/lib/media-jobs";
import { crossOrigin, isUuid } from "@/lib/origin";

export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){
  const denied=crossOrigin(request);if(denied)return denied;
  const user=await currentUser();if(!user)return NextResponse.json({error:"請重新登入。"},{status:401});if(user.role==="professor")return NextResponse.json({error:"Professor 僅可閱讀研究筆記。"},{status:403});
  const {id}=await params;if(!isUuid(id))return NextResponse.json({error:"筆記不存在。"},{status:404});
  const form=await request.formData().catch(()=>null);if(!form)return NextResponse.json({error:"上傳中斷，請重新選擇檔案。"},{status:400});const file=form.get("file");
  if(!(file instanceof File)||!file.size)return NextResponse.json({error:"請選擇媒體檔。"},{status:400});
  if(file.size>500*1024*1024)return NextResponse.json({error:"媒體檔不得超過 500 MB。"},{status:413});
  if(!(/^(audio|video)\//.test(file.type)||/\.(mp4|m4a|mov|webm|mkv|mp3|wav|aac|ogg)$/i.test(file.name)))return NextResponse.json({error:"請上傳影音檔。"},{status:415});
  try{return NextResponse.json({jobId:await createJob(id,user.id,file)},{status:202})}
  catch(error){return NextResponse.json({error:error instanceof Error&&error.message==="筆記不存在。"?error.message:"媒體上傳失敗。"},{status:error instanceof Error&&error.message==="筆記不存在。"?404:500})}
}
