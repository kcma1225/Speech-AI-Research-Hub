import { access as fileAccess } from "node:fs/promises";
import path from "node:path";
import { notFound } from "next/navigation";
import { Shell } from "@/components/shell";
import { SlideDetail } from "@/components/slide-detail";
import { slideAccess, viewToken } from "@/lib/slide-access";
import { slideDetail } from "@/lib/slide-detail";
import { projectDir } from "@/lib/slides";

export default async function SlidePlayer({params}:{params:Promise<{slug:string}>}){
  const {slug}=await params;
  const access=await slideAccess(slug);if(!access)notFound();
  const raw=await slideDetail(access.project.id);
  // Each published version gets a signed path token; the sandboxed iframe cannot send cookies.
  const detail={...raw,versions:await Promise.all(raw.versions.map(async item=>({...item,view_key:item.status==="published"?viewToken(access.project.id,item.id):"",pdf_ready:item.status==="published"&&await fileAccess(path.join(projectDir(access.project.id),"versions",item.id,"output","slides.pdf")).then(()=>true,()=>false)})))};
  // Only managers may see the share key.
  const project={...access.project,share_key:access.user&&access.user.role!=="professor"?access.project.share_key:""};
  if(!access.user)return <main className="public-slide"><a className="button" href="/slides">登入</a><SlideDetail project={project} detail={detail} role={null}/></main>;
  return <Shell><SlideDetail project={project} detail={detail} role={access.user.role}/></Shell>;
}
