import { NextResponse } from "next/server";
import { isUuid } from "@/lib/origin";
import { z } from "zod";
import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";
const input=z.object({role:z.enum(["admin","member","professor"])});
export async function PATCH(request:Request,{params}:{params:Promise<{id:string}>}){const actor=await currentUser();if(!actor||actor.role!=="owner")return NextResponse.json({error:"權限不足。"},{status:403});const data=input.safeParse(await request.json().catch(()=>null));if(!data.success)return NextResponse.json({error:"角色不正確。"},{status:400});const {id}=await params;if(!isUuid(id))return NextResponse.json({error:"帳號不存在或受保護。"},{status:404});if(id===actor.id)return NextResponse.json({error:"不能變更自己的角色。"},{status:400});const result=await(await db()).query("UPDATE users SET role=$1 WHERE id=$2 AND role<>'owner' RETURNING id",[data.data.role,id]);if(!result.rowCount)return NextResponse.json({error:"帳號不存在或受保護。"},{status:404});return NextResponse.json({ok:true})}
