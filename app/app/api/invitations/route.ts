import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { currentUser, tokenHash } from "@/lib/auth";
import { db } from "@/lib/db";

const input=z.object({
  role:z.enum(["owner","admin","member","professor"]),
  expiresInMinutes:z.union([z.null(),z.number().int().refine(value=>[5,30,60,120,300,1440,4320,7200,10080].includes(value))]),
  maxUses:z.union([z.null(),z.literal(1)]),
});
export async function POST(request:Request){
  const user=await currentUser();
  if(!user||user.role!=="owner")return NextResponse.json({error:"權限不足。"},{status:403});
  const data=input.safeParse(await request.json().catch(()=>null));
  if(!data.success)return NextResponse.json({error:"邀請設定不正確。"},{status:400});
  // A second Owner conflicts with one_owner; never issue unusable or privilege-escalating links.
  if(data.data.role==="owner")return NextResponse.json({error:"系統僅允許一位 Owner，無法建立 Owner 邀請。"},{status:409});
  const origin=process.env.APP_ORIGIN;
  if(!origin)return NextResponse.json({error:"尚未設定 APP_ORIGIN。"},{status:500});
  const token=randomBytes(32).toString("base64url");
  const result=await(await db()).query("INSERT INTO invitations(token_hash,role,created_by,expires_at,max_uses) VALUES($1,$2,$3,CASE WHEN $4::integer IS NULL THEN NULL ELSE now()+($4||' minutes')::interval END,$5) RETURNING id,role,expires_at,max_uses,use_count,used_at,revoked_at,created_at",[tokenHash(token),data.data.role,user.id,data.data.expiresInMinutes,data.data.maxUses]);
  return NextResponse.json({url:`${origin}/join?token=${encodeURIComponent(token)}`,invitation:result.rows[0]},{status:201});
}
