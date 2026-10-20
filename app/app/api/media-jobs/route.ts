import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { listJobs } from "@/lib/media-jobs";
export async function GET(){const user=await currentUser();if(!user)return NextResponse.json({error:"請重新登入。"},{status:401});return NextResponse.json({jobs:await listJobs(user.id)},{headers:{"Cache-Control":"no-store"}})}
