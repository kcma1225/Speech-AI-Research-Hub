import argon2 from "argon2";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createSession, tokenHash } from "@/lib/auth";
import { transaction } from "@/lib/db";
const input=z.object({token:z.string().min(32),name:z.string().trim().min(1).max(80),password:z.string().max(4096).refine(value=>value.trim().length>0),passwordConfirm:z.string().min(1)}).refine(data=>data.password===data.passwordConfirm,{message:"PASSWORD_MISMATCH",path:["passwordConfirm"]});
export async function POST(request:Request){
  const data=input.safeParse(await request.json().catch(()=>null));
  if(!data.success)return NextResponse.json({error:"邀請或帳號資料不正確。"},{status:400});
  const passwordHash=await argon2.hash(data.data.password,{type:argon2.argon2id});
  const user=await transaction(async client=>{
    const invite=await client.query("SELECT id,role,max_uses,use_count FROM invitations WHERE token_hash=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()) AND (max_uses IS NULL OR use_count<max_uses) FOR UPDATE",[tokenHash(data.data.token)]);
    if(!invite.rowCount)throw new Error("INVALID_INVITE");
    const created=await client.query("INSERT INTO users(name,password_hash,role) VALUES($1,$2,$3) RETURNING id,name",[data.data.name,passwordHash,invite.rows[0].role]);
    await client.query("INSERT INTO invitation_uses(invitation_id,user_id) VALUES($1,$2)",[invite.rows[0].id,created.rows[0].id]);
    await client.query("UPDATE invitations SET use_count=use_count+1,used_at=now(),used_by=$1 WHERE id=$2",[created.rows[0].id,invite.rows[0].id]);
    return created.rows[0];
  }).catch(error=>{if(error instanceof Error&&error.message==="INVALID_INVITE")return null;throw error});
  if(!user)return NextResponse.json({error:"邀請已失效、用罄或已過期。"},{status:410});
  await createSession(user.id);
  return NextResponse.json({account:user},{status:201});
}
