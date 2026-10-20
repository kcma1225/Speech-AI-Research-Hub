import argon2 from "argon2";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { ensureSchema } from "@/lib/schema";
const input=z.object({userId:z.string().uuid(),password:z.string().min(1).max(256)});
export async function POST(request:Request){await ensureSchema();const parsed=input.safeParse(await request.json().catch(()=>null));if(!parsed.success)return NextResponse.json({error:"登入資訊不正確。"},{status:400});const result=await(await db()).query("SELECT id,name,password_hash,auth_mode FROM users WHERE id=$1 AND disabled_at IS NULL",[parsed.data.userId]);const user=result.rows[0];const valid=user&&await argon2.verify(user.password_hash,parsed.data.password).catch(()=>false);if(!valid)return NextResponse.json({error:"登入資訊不正確。"},{status:401});if(user.auth_mode==="two_factor")return NextResponse.json({error:"此帳號需要 Passkey 2FA；功能將於下一階段啟用。"},{status:403});await createSession(user.id);await(await db()).query("UPDATE users SET last_login_at=now() WHERE id=$1",[user.id]);return NextResponse.json({account:{id:user.id,name:user.name}})}
