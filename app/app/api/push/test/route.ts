import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { pushTo } from "@/lib/notify";
export async function POST(){
  const user=await currentUser();if(!user)return NextResponse.json({error:"請重新登入。"},{status:401});
  const count=(await(await db()).query<{count:number}>("SELECT count(*)::int AS count FROM push_subscriptions WHERE user_id=$1",[user.id])).rows[0].count;
  if(!count)return NextResponse.json({error:"此帳號尚未在任何裝置開啟推播。"},{status:409});
  await pushTo([user.id],{kind:"system",title:"測試通知",body:"推播已開啟，這台裝置會收到影音處理完成通知。",url:"/"},"test");
  return NextResponse.json({ok:true,devices:count});
}
