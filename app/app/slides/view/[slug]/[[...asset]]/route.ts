import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isUuid } from "@/lib/origin";
import { slideAccess, viewToken } from "@/lib/slide-access";
// Stable entry: redirect to the versioned, CSP-hardened route.
export async function GET(request:Request,{params}:{params:Promise<{slug:string;asset?:string[]}>}){
  const {slug,asset}=await params;
  let query:URLSearchParams;
  try{query=new URL(request.url).searchParams}catch{return new NextResponse("Invalid URL",{status:400})}
  const key=query.get("key")??undefined;
  const access=await slideAccess(slug,key);if(!access)return new NextResponse("Not found",{status:404});
  const versionId=query.get("version")??access.project.active_version_id;
  if(!versionId||!isUuid(versionId))return new NextResponse("Not found",{status:404});
  const result=await(await db()).query("SELECT entry_html FROM slide_versions WHERE project_id=$1 AND id=$2 AND status='published'",[access.project.id,versionId]);
  if(!result.rowCount)return new NextResponse("Not found",{status:404});
  const relative=asset?.map(encodeURIComponent).join("/")||result.rows[0].entry_html;
  // slideAccess already checked session / public / share cookie / key; hand out a path capability.
  const scope=access.project.public_view&&!access.user&&!key?"public":viewToken(access.project.id,versionId);
  return new NextResponse(null,{status:307,headers:{Location:`/slides/view/${encodeURIComponent(slug)}/${encodeURIComponent(scope)}/${versionId}/${relative}`,"Referrer-Policy":"no-referrer","Cache-Control":"private, no-store"}});
}
