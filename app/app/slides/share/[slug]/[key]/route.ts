import { NextResponse } from "next/server";
import { slideBySlug, validShareKey } from "@/lib/slide-access";
export async function GET(_:Request,{params}:{params:Promise<{slug:string;key:string}>}){
  const {slug,key}=await params;
  const project=await slideBySlug(slug);
  if(!project||!validShareKey(key,project.share_key))return new NextResponse("找不到分享連結。",{status:404});
  const response=new NextResponse(null,{status:307,headers:{Location:`/slides/play/${encodeURIComponent(slug)}`}});
  response.cookies.set(`slide_share_${slug}`,key,{httpOnly:true,sameSite:"lax",secure:process.env.APP_ORIGIN?.startsWith("https"),path:`/slides`,maxAge:60*60*24*7});
  response.headers.set("Cache-Control","private, no-store");
  response.headers.set("Referrer-Policy","no-referrer");
  return response;
}
