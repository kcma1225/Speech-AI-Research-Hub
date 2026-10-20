"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { BookOpenText, CaretDown, House, NotePencil, Presentation, SquaresFour } from "./icons";
import { HeaderNotifications } from "./header-notifications";

const workspace=[
  {href:"/notes",label:"研究筆記",Icon:BookOpenText},
  {href:"/slides",label:"簡報",Icon:Presentation},
  {href:"/overleaf",label:"Overleaf",Icon:NotePencil},
] as const;

export function BottomNav() {
  const path=usePathname();
  const [open,setOpen]=useState(false);
  const menuRef=useRef<HTMLDivElement>(null);
  const inWorkspace=path==="/notes"||path.startsWith("/items/")||path.startsWith("/slides")||path==="/overleaf";
  const current=path==="/notes"||path.startsWith("/items/")?"研究筆記":path.startsWith("/slides")?"簡報":path==="/overleaf"?"Overleaf":"選單";

  useEffect(()=>{
    function close(event:PointerEvent){if(!menuRef.current?.contains(event.target as Node))setOpen(false)}
    function escape(event:KeyboardEvent){if(event.key==="Escape")setOpen(false)}
    document.addEventListener("pointerdown",close);
    document.addEventListener("keydown",escape);
    return()=>{document.removeEventListener("pointerdown",close);document.removeEventListener("keydown",escape)};
  },[]);
  useEffect(()=>setOpen(false),[path]);

  return <nav className="bottom-nav" aria-label="PWA 主要功能">
    <Link href="/" className="bottom-nav-item" aria-current={path==="/"?"page":undefined}><House size={23}/><span>首頁</span></Link>
    <div className="bottom-nav-menu" ref={menuRef}>
      {open&&<div className="bottom-nav-popover" role="menu" aria-label="功能選單">
        <p className="bottom-nav-popover-title">功能選單</p>
        {workspace.map(({href,label,Icon})=><Link key={href} href={href} role="menuitem" onClick={()=>setOpen(false)}><Icon size={21}/><span>{label}</span></Link>)}
      </div>}
      <button className="bottom-nav-item bottom-nav-center" aria-expanded={open} aria-haspopup="menu" aria-current={inWorkspace?"page":undefined} onClick={()=>setOpen(value=>!value)}>{open?<CaretDown size={23}/>:<SquaresFour size={23}/>}<span>{current}</span></button>
    </div>
    <HeaderNotifications variant="dock"/>
  </nav>;
}
