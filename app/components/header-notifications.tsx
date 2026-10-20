"use client";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Bell, ChatCircleDots, Checks, Trash, UploadSimple, X } from "./icons";
import { useUnreadCount } from "./unread-badge";
import { formatDateTime } from "@/lib/format";

type Note={id:string;kind:"media"|"system";title:string;body:string;url:string;read_at:string|null;created_at:string};
const internal=(url:string)=>/^\/(?!\/)/.test(url)&&url!=="/"&&url!=="/notifications"?url:null;

export function HeaderNotifications({variant="header"}:{variant?:"header"|"dock"}){
  const dock=variant==="dock";
  const router=useRouter();
  const unread=useUnreadCount();
  const [open,setOpen]=useState(false);
  const [notes,setNotes]=useState<Note[]|null>(null);
  const [error,setError]=useState("");
  const [confirmClear,setConfirmClear]=useState(false);
  const [notice,setNotice]=useState("");
  const confirmRef=useRef<HTMLButtonElement>(null);
  const wrap=useRef<HTMLDivElement>(null);
  const trigger=useRef<HTMLButtonElement>(null);
  const panelId=useId();
  const load=useCallback(async()=>{const r=await fetch("/api/notifications",{cache:"no-store"}).catch(()=>null);if(r?.ok){setNotes((await r.json()).notifications);setError("")}else setError("通知載入失敗，請稍後再試。")},[]);
  useEffect(()=>{if(!open){setConfirmClear(false);setNotice("")}},[open]);
  useEffect(()=>{if(confirmClear)confirmRef.current?.focus()},[confirmClear]);
  useEffect(()=>{if(!notice)return;const t=setTimeout(()=>setNotice(""),2400);return()=>clearTimeout(t)},[notice]);
  useEffect(()=>{if(!open)return;void load();const t=setInterval(()=>{if(document.visibilityState==="visible")void load()},15000);return()=>clearInterval(t)},[open,load]);
  useEffect(()=>{
    if(!open)return;
    const outside=(e:PointerEvent)=>{if(!wrap.current?.contains(e.target as Node))setOpen(false)};
    const escape=(e:KeyboardEvent)=>{if(e.key!=="Escape")return;if(confirmClear){setConfirmClear(false);return}setOpen(false);trigger.current?.focus()};
    document.addEventListener("pointerdown",outside);document.addEventListener("keydown",escape);
    return()=>{document.removeEventListener("pointerdown",outside);document.removeEventListener("keydown",escape)};
  },[open,confirmClear]);
  async function remove(id?:string){
    const before=notes;
    setNotes(list=>id?list?.filter(n=>n.id!==id)??list:[]);setConfirmClear(false);
    const r=await fetch("/api/notifications",{method:"DELETE",headers:{"content-type":"application/json"},body:JSON.stringify(id?{id}:{})}).catch(()=>null);
    if(!r?.ok){setNotes(before);setError("移除失敗，請稍後再試。");return}
    setError("");setNotice(id?"已移除 1 則通知":"已清除全部通知");
    window.dispatchEvent(new Event("notifications-changed"));
  }
  async function markRead(id?:string){
    const now=new Date().toISOString();
    setNotes(list=>list?.map(n=>!id||n.id===id?{...n,read_at:n.read_at??now}:n)??list);
    await fetch("/api/notifications/read",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(id?{id}:{})}).catch(()=>null);
    window.dispatchEvent(new Event("notifications-changed"));
  }
  function choose(n:Note){
    if(!n.read_at)void markRead(n.id);
    const target=internal(n.url);
    if(target){setOpen(false);router.push(target)}
  }
  const count=notes?notes.filter(n=>!n.read_at).length:unread;
  const label=unread?`通知，${unread} 則未讀`:"通知";
  return <div className={dock?"header-notify-wrap dock-notify-wrap":"header-notify-wrap"} ref={wrap}>
    <button ref={trigger} type="button" className={dock?"bottom-nav-item dock-notify":"header-notify"} aria-label={label} title={label} aria-expanded={open} aria-controls={panelId} onClick={()=>setOpen(v=>!v)}>
      <span className="notify-glyph"><ChatCircleDots size={dock?23:24}/>{unread>0&&<span className="header-notify-alert" aria-hidden="true">!</span>}</span>
      {dock&&<span>通知</span>}
    </button>
    {open&&<section id={panelId} className={dock?"notify-panel notify-panel-dock":"notify-panel"} role="dialog" aria-label="通知">
      <header className="notify-panel-head">
        <h2>通知{count>0&&<span className="status"> ／ {count} 則未讀</span>}</h2>
        <button type="button" className="button notify-read-all" disabled={!count} onClick={()=>void markRead()} aria-label="全部標示為已讀" title="全部已讀"><Checks size={18}/><span className="notify-btn-text">全部已讀</span></button>
        <button type="button" className="button notify-clear" disabled={!notes?.length} aria-expanded={confirmClear} onClick={()=>setConfirmClear(v=>!v)} aria-label="清除全部通知" title="清除全部"><Trash size={18}/><span className="notify-btn-text">清除全部</span></button>
        <button type="button" className="icon-button" aria-label="關閉通知" onClick={()=>{setOpen(false);trigger.current?.focus()}}><X size={18}/></button>
      </header>
      {confirmClear&&<div className="notify-confirm" role="group" aria-label="確認清除"><p>清除全部 {notes?.length??0} 則通知？此動作無法復原。</p><button type="button" className="button" onClick={()=>setConfirmClear(false)}>取消</button><button ref={confirmRef} type="button" className="button danger" onClick={()=>void remove()}>清除</button></div>}
      {error&&<p className="form-error" role="alert">{error}</p>}
      <p className="sr-only" role="status" aria-live="polite">{notice}</p>
      <ol className="notify-list">
        {!notes&&!error&&<li className="notify-empty">載入中…</li>}
        {notes&&!notes.length&&<li className="notify-empty">目前沒有通知。</li>}
        {notes?.map(n=><li key={n.id} className="notify-item">
          <button type="button" className={`notify-row${n.read_at?"":" unread"}`} onClick={()=>choose(n)}>
            <span className="notify-icon" aria-hidden="true">{n.kind==="media"?<UploadSimple size={19}/>:<Bell size={19}/>}</span>
            <span className="notify-copy"><strong>{!n.read_at&&<span className="sr-only">未讀：</span>}{n.title}</strong><span>{n.body}</span></span>
            <time dateTime={n.created_at}>{formatDateTime(n.created_at)}</time>
          </button>
          <button type="button" className="icon-button notify-remove" aria-label={`移除通知：${n.title}`} title="移除此通知" onClick={()=>void remove(n.id)}><X size={16}/></button>
        </li>)}
      </ol>
    </section>}
  </div>;
}
