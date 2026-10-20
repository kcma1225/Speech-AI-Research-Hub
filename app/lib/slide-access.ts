import { currentUser } from "./auth";
import { cookies } from "next/headers";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { db } from "./db";

export type SlideProject={id:string;title:string;slug:string;public_view:boolean;share_key:string;active_version_id:string|null;created_by:string;updated_at:string};
export async function slideBySlug(slug:string){
  const result=await(await db()).query<SlideProject>("SELECT id,title,slug,public_view,share_key,active_version_id,created_by,updated_at FROM slide_projects WHERE slug=$1",[slug]);
  return result.rows[0]??null;
}
export function validShareKey(given:string|undefined,expected:string){
  if(!given)return false;
  const a=createHash("sha256").update(given).digest(),b=createHash("sha256").update(expected).digest();
  return timingSafeEqual(a,b);
}
// Sandboxed iframes have an opaque origin and send no cookies, so viewers get a
// short-lived signed token in the path instead of relying on the session cookie.
const VIEW_TTL=12*60*60;
function viewSignature(projectId:string,versionId:string,expires:number){
  const secret=process.env.AUTH_SECRET;if(!secret)throw new Error("AUTH_SECRET is not set");
  return createHmac("sha256",secret).update(`slide-view|${projectId}|${versionId}|${expires}`).digest("base64url");
}
export function viewToken(projectId:string,versionId:string){
  const expires=Math.floor(Date.now()/1000)+VIEW_TTL;
  return `t.${expires}.${viewSignature(projectId,versionId,expires)}`;
}
export function validViewToken(token:string,projectId:string,versionId:string){
  const match=/^t\.(\d{10})\.([A-Za-z0-9_-]{43})$/.exec(token);if(!match)return false;
  const expires=Number(match[1]);if(expires<Date.now()/1000)return false;
  return validShareKey(match[2],viewSignature(projectId,versionId,expires));
}
export async function slideAccess(slug:string,key?:string){
  const [project,user,jar]=await Promise.all([slideBySlug(slug),currentUser(),cookies()]);
  if(!project)return null;
  if(!user&&!project.public_view&&!validShareKey(key??jar.get(`slide_share_${slug}`)?.value,project.share_key))return null;
  return {project,user};
}
