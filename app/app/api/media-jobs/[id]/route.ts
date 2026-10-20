import { NextResponse } from "next/server";
import { isUuid } from "@/lib/origin";
import { currentUser } from "@/lib/auth";
import { cancelJob, getJob } from "@/lib/media-jobs";
type Context={params:Promise<{id:string}>};
export async function GET(_:Request,{params}:Context){const user=await currentUser();if(!user)return NextResponse.json({error:"請重新登入。"},{status:401});const {id}=await params;if(!isUuid(id))return NextResponse.json({error:"找不到處理工作。"},{status:404});const job=await getJob(id,user.id);return job?NextResponse.json({job},{headers:{"Cache-Control":"no-store"}}):NextResponse.json({error:"找不到處理工作。"},{status:404})}
export async function DELETE(_:Request,{params}:Context){const user=await currentUser();if(!user)return NextResponse.json({error:"請重新登入。"},{status:401});if(user.role==="professor")return NextResponse.json({error:"權限不足。"},{status:403});const {id}=await params;if(!isUuid(id))return NextResponse.json({error:"找不到處理工作。"},{status:404});const cancelled=await cancelJob(id,user.id);return cancelled?NextResponse.json({ok:true}):NextResponse.json({error:"無法取消；工作可能已完成。"},{status:409})}
