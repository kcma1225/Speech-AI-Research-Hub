import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ensureSchema } from "@/lib/schema";
export async function GET(){await ensureSchema();const result=await(await db()).query("SELECT id,name FROM users WHERE disabled_at IS NULL ORDER BY role='owner' DESC,name");return NextResponse.json({accounts:result.rows})}
