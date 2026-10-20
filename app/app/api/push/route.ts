import { NextResponse } from "next/server";
import { z } from "zod";
import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { pushPublicKey } from "@/lib/notify";
const sub=z.object({endpoint:z.string().url().max(2000).refine(v=>v.startsWith("https://")),keys:z.object({p256dh:z.string().min(1).max(200),auth:z.string().min(1).max(100)})});
export async function GET(){
  if(!await currentUser())return NextResponse.json({error:"請重新登入。"},{status:401});
  return NextResponse.json({publicKey:pushPublicKey()},{headers:{"Cache-Control":"no-store"}});
}
export async function POST(request:Request){
  const user=await currentUser();if(!user)return NextResponse.json({error:"請重新登入。"},{status:401});
  const data=sub.safeParse(await request.json().catch(()=>null));if(!data.success)return NextResponse.json({error:"訂閱資料不正確。"},{status:400});
  await(await db()).query("INSERT INTO push_subscriptions(endpoint,user_id,p256dh,auth,user_agent) VALUES($1,$2,$3,$4,$5) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id,p256dh=excluded.p256dh,auth=excluded.auth,user_agent=excluded.user_agent",[data.data.endpoint,user.id,data.data.keys.p256dh,data.data.keys.auth,request.headers.get("user-agent")?.slice(0,300)??null]);
  return NextResponse.json({ok:true},{status:201});
}
export async function DELETE(request:Request){
  const user=await currentUser();if(!user)return NextResponse.json({error:"請重新登入。"},{status:401});
  const data=z.object({endpoint:z.string().max(2000)}).safeParse(await request.json().catch(()=>null));if(!data.success)return NextResponse.json({error:"欄位內容不正確。"},{status:400});
  await(await db()).query("DELETE FROM push_subscriptions WHERE endpoint=$1 AND user_id=$2",[data.data.endpoint,user.id]);
  return NextResponse.json({ok:true});
}
