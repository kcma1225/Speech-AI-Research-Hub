import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isUuid } from "@/lib/origin";
import { slideBySlug, validShareKey, validViewToken } from "@/lib/slide-access";
import { projectDir } from "@/lib/slides";
const types:Record<string,string>={".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",".js":"application/javascript; charset=utf-8",".json":"application/json",".svg":"image/svg+xml",".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".webp":"image/webp",".gif":"image/gif",".woff":"font/woff",".woff2":"font/woff2",".pdf":"application/pdf"};
const storageShim="(function(){function m(){var d=Object.create(null);return{get length(){return Object.keys(d).length},key:function(i){return Object.keys(d)[i]??null},getItem:function(k){k=String(k);return k in d?d[k]:null},setItem:function(k,v){d[String(k)]=String(v)},removeItem:function(k){delete d[String(k)]},clear:function(){d=Object.create(null)}}}['localStorage','sessionStorage'].forEach(function(n){try{window[n].length}catch(e){Object.defineProperty(window,n,{value:m(),configurable:true})}})})();";
export async function GET(_:Request,{params}:{params:Promise<{slug:string;key:string;versionId:string;asset?:string[]}>}){
  const {slug,key,versionId,asset}=await params;
  if(!isUuid(versionId))return new NextResponse("Not found",{status:404});
  const project=await slideBySlug(slug);
  // Opaque-origin sandbox sends no cookies: authorise by path capability only.
  if(!project||!(key==="public"&&project.public_view||validViewToken(key,project.id,versionId)||validShareKey(key,project.share_key)))return new NextResponse("Not found",{status:404});
  const result=await(await db()).query("SELECT entry_html FROM slide_versions WHERE project_id=$1 AND id=$2 AND status='published'",[project.id,versionId]);
  if(!result.rowCount)return new NextResponse("Not found",{status:404});
  const relative=asset?.join("/")||result.rows[0].entry_html;
  if(relative==="slides.pdf"||relative==="pdf.log"||relative.startsWith("offline-assets/licenses/"))return new NextResponse("Not found",{status:404});
  if(relative.includes("\\")||relative.includes("\0")||relative.split("/").some((part:string)=>part===".."||part==="."))return new NextResponse("Invalid path",{status:400});
  const normalized=path.posix.normalize(relative);
  if(normalized.startsWith("/")||normalized.startsWith("../")||normalized==="..")return new NextResponse("Invalid path",{status:400});
  const file=path.join(projectDir(project.id),"versions",versionId,"output",...normalized.split("/"));
  try{
    let content:Uint8Array<ArrayBuffer>|string=new Uint8Array(await readFile(file));
    // Opaque-origin sandbox throws on Web Storage access, which aborts Reveal init.
    // Replace both stores with in-memory shims before any deck script runs.
    if(path.extname(file).toLowerCase()===".html")content=new TextDecoder().decode(content).replace(/<head(\s[^>]*)?>/i,match=>`${match}<script>${storageShim}</script>`).replace(/Reveal\.initialize\(\{/,'Reveal.initialize({scrollActivationWidth:0,').replace(/<\/head>/i,match=>`<style>html:not(.print-pdf) .reveal .slide-number{bottom:auto;height:auto;padding:7px 9px;min-width:44px;min-height:44px;box-sizing:border-box;display:grid!important;place-items:center}html:not(.print-pdf) .reveal .slide-menu-button{min-width:44px;min-height:44px;display:grid;place-items:center}html:not(.print-pdf) .reveal .slide-menu-button a{display:grid;place-items:center;min-width:44px;min-height:44px}html:not(.print-pdf) .slide-menu-wrapper .slide-tool-item a{display:flex;align-items:center;min-height:44px}html.print-pdf .annotate-dock,html.print-pdf .slide-menu-button{display:none!important}</style>${match}`);
    // Sandboxed iframe has an opaque origin: 'self' cannot load its own assets.
    const origin=new URL(process.env.APP_ORIGIN??"http://localhost").origin;
    const csp=`sandbox allow-scripts allow-pointer-lock allow-presentation; default-src 'none'; script-src ${origin} https://cdn.jsdelivr.net 'unsafe-inline' 'unsafe-eval'; style-src ${origin} https://cdn.jsdelivr.net https://fonts.googleapis.com 'unsafe-inline'; img-src ${origin} data: blob:; font-src ${origin} https://cdn.jsdelivr.net https://fonts.gstatic.com data:; media-src ${origin} blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors ${origin}`;
    return new NextResponse(content,{headers:{"Content-Type":types[path.extname(file).toLowerCase()]??"application/octet-stream","Cache-Control":"private, no-store","Content-Security-Policy":csp,"X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"}});
  }catch{return new NextResponse("Not found",{status:404})}
}
