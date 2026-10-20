"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

export function Breadcrumbs(){
  const path=usePathname();
  const parts:[string,string][]=[["/","首頁"]];
  if(path==="/login") parts.push([path,"登入"]);
  else if(path==="/join") parts.push([path,"加入研究空間"]);
  else if(path==="/notes") parts.push([path,"研究筆記"]);
  else if(path.startsWith("/items/")) parts.push(["/notes","研究筆記"],[path,"筆記內容"]);
  else if(path==="/slides") parts.push([path,"簡報"]);
  else if(path==="/slides/tags") parts.push(["/slides","簡報"],[path,"簡報標籤"]);
  else if(path.startsWith("/slides/play/")) parts.push(["/slides","簡報"],[path,"檢視簡報"]);
  else if(path==="/overleaf") parts.push([path,"Overleaf"]);
  else if(path.startsWith("/admin")){
    parts.push(["/admin","Owner 管理"]);
    if(path==="/admin/invitations")parts.push([path,"建立邀請"]);
    if(path==="/admin/roles")parts.push([path,"角色管理"]);
  }
  return <nav className="breadcrumbs" aria-label="麵包屑導覽"><ol>{parts.map(([href,label],index)=><li key={href}>{index>0&&<span className="breadcrumb-separator" aria-hidden="true">/</span>}{index===parts.length-1?<span aria-current="page">{label}</span>:<Link href={href}>{label}</Link>}</li>)}</ol></nav>;
}
