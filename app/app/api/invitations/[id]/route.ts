import { NextResponse } from "next/server";
import { isUuid } from "@/lib/origin";
import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";
export async function DELETE(_:Request,{params}:{params:Promise<{id:string}>}){const user=await currentUser();if(!user||user.role!=="owner")return NextResponse.json({error:"權限不足。"},{status:403});const {id}=await params;if(!isUuid(id))return NextResponse.json({error:"邀請不存在。"},{status:404});const result=await(await db()).query("DELETE FROM invitations WHERE id=$1 RETURNING id",[id]);if(!result.rowCount)return NextResponse.json({error:"邀請不存在。"},{status:404});return NextResponse.json({ok:true})}
