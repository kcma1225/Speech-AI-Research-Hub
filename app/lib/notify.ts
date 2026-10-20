import webpush from "web-push";
import { db } from "./db";

type Payload={kind:"media"|"system";title:string;body:string;url:string};
let configured:boolean|undefined;
function ready(){
  if(configured!==undefined)return configured;
  const pub=process.env.VAPID_PUBLIC_KEY,priv=process.env.VAPID_PRIVATE_KEY;
  configured=Boolean(pub&&priv);
  if(configured)webpush.setVapidDetails(process.env.VAPID_SUBJECT||"mailto:admin@example.com",pub!,priv!);
  return configured;
}
export const pushPublicKey=()=>process.env.VAPID_PUBLIC_KEY||"";

export async function pushTo(userIds:string[],payload:Payload,tag?:string){
  if(!userIds.length||!ready())return;
  const pool=await db();
  const subs=await pool.query<{endpoint:string;p256dh:string;auth:string}>("SELECT endpoint,p256dh,auth FROM push_subscriptions WHERE user_id=ANY($1::uuid[])",[userIds]);
  const body=JSON.stringify({...payload,tag:tag??payload.kind});
  const send=async(s:{endpoint:string;p256dh:string;auth:string})=>{
    try{await webpush.sendNotification({endpoint:s.endpoint,keys:{p256dh:s.p256dh,auth:s.auth}},body,{TTL:3600,urgency:"high"})}
    catch(error){const code=(error as {statusCode?:number}).statusCode;let host="unknown";try{host=new URL(s.endpoint).host}catch{}console.warn(`[push] ${host} failed: ${code??(error instanceof Error?error.message:"error")}`);if(code===404||code===410)await pool.query("DELETE FROM push_subscriptions WHERE endpoint=$1",[s.endpoint]).catch(()=>undefined)}
  };
  await Promise.all(subs.rows.map(s=>send(s)));
}

export async function notify(userIds:string[],payload:Payload,tag?:string){
  if(!userIds.length)return;
  await (await db()).query("INSERT INTO notifications(user_id,kind,title,body,url) SELECT u,$2,$3,$4,$5 FROM unnest($1::uuid[]) AS u",[userIds,payload.kind,payload.title,payload.body.slice(0,300),payload.url]);
  await pushTo(userIds,payload,tag).catch(()=>undefined);
}
