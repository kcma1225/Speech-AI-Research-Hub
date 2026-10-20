import { NextResponse } from "next/server";
import { z } from "zod";
import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { isUuid } from "@/lib/origin";
const input=z.object({body:z.string().trim().min(1).max(10000)});
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){
  const user=await currentUser();if(!user)return NextResponse.json({error:"請重新登入。"},{status:401});
  if(user.role!=="professor")return NextResponse.json({error:"只有 Professor 可以新增審閱。"},{status:403});
  const {id}=await params;if(!isUuid(id))return NextResponse.json({error:"簡報不存在。"},{status:404});
  const data=input.safeParse(await request.json().catch(()=>null));if(!data.success)return NextResponse.json({error:"審閱內容須為 1–10000 字。"},{status:400});
  const result=await(await db()).query("INSERT INTO slide_reviews(project_id,author_id,body) SELECT id,$2,$3 FROM slide_projects WHERE id=$1 RETURNING id",[id,user.id,data.data.body]);
  return result.rowCount?NextResponse.json({id:result.rows[0].id},{status:201}):NextResponse.json({error:"簡報不存在。"},{status:404});
}
