"use client";
import { FormEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AppDialog } from "./dialog";
import { Check, PencilSimple, Plus, Tag as TagIcon, Trash, X } from "./icons";
import type { TagWithCount } from "@/lib/tag-types";

async function send(url:string,method:string,body?:unknown){
  const response=await fetch(url,{method,headers:body?{"content-type":"application/json"}:undefined,body:body?JSON.stringify(body):undefined}).catch(()=>null);
  if(!response)return "網路中斷，請重試。";
  if(response.ok)return null;
  return (await response.json().catch(()=>({}))).error??"操作失敗，請重試。";
}

export function TagManager({tags,endpoint="/api/tags",subject="筆記"}:{tags:TagWithCount[];endpoint?:string;subject?:string}){
  const router=useRouter();
  const [open,setOpen]=useState(false);
  const [name,setName]=useState("");
  const [editing,setEditing]=useState<{id:string;name:string}|null>(null);
  const [removing,setRemoving]=useState<TagWithCount|null>(null);
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  const newTag=useRef<HTMLInputElement>(null);
  const returnTo=useRef<HTMLElement|null>(null);
  const focusAfter=useRef<string|null>(null);
  const focusRename=(id:string)=>{focusAfter.current=id};
  useEffect(()=>{const id=focusAfter.current;if(editing||!id)return;const button=document.querySelector<HTMLButtonElement>(`[data-rename="${id}"]`);if(button){focusAfter.current=null;button.focus()}});
  function cancelEdit(){if(!editing)return;const id=editing.id;setEditing(null);focusRename(id)}
  async function run(action:()=>Promise<string|null>,done:()=>void){setBusy(true);setError("");const message=await action();setBusy(false);if(message){setError(message);return}done();router.refresh()}
  function create(e:FormEvent<HTMLFormElement>){e.preventDefault();void run(()=>send(endpoint,"POST",{name}),()=>setName(""))}
  function rename(e:FormEvent<HTMLFormElement>){e.preventDefault();if(!editing)return;const target=editing;void run(()=>send(`${endpoint}/${target.id}`,"PATCH",{name:target.name}),()=>{setEditing(null);focusRename(target.id)})}
  function remove(){if(!removing)return;const target=removing;void run(()=>send(`${endpoint}/${target.id}`,"DELETE"),()=>{returnTo.current=null;setRemoving(null)})}
  return <>
    <AppDialog trigger={<button type="button" className="button" onClick={()=>setError("")}><TagIcon size={18}/>管理標籤</button>} open={open} onOpenChange={value=>{setOpen(value);if(!value){setEditing(null);setError("")}}} onEscapeKeyDown={event=>{if(editing){event.preventDefault();cancelEdit()}}} title="管理標籤" description={`新增、改名或刪除標籤。刪除標籤不會刪除${subject}。`}>
      <form className="tag-create" onSubmit={create}><div className="field"><label htmlFor="new-tag">新增標籤</label><input id="new-tag" ref={newTag} value={name} onChange={e=>setName(e.target.value)} maxLength={40} required/></div><button className="button primary" disabled={busy||!name.trim()}><Plus size={18}/>新增</button></form>
      {error&&<p className="form-error" role="alert">{error}</p>}
      <ul className="tag-admin-list">{tags.map(tag=><li key={tag.id}>{editing?.id===tag.id?<form className="tag-rename" onSubmit={rename}><input aria-label={`重新命名 ${tag.name}`} value={editing.name} onChange={e=>setEditing({id:tag.id,name:e.target.value})} maxLength={40} required autoFocus/><button className="icon-button" aria-label="儲存名稱" disabled={busy||!editing.name.trim()}><Check size={18}/></button><button type="button" className="icon-button" aria-label="取消改名" onClick={cancelEdit}><X size={18}/></button></form>:<><span className="tag-admin-name">{tag.name}</span><span className="tag-admin-count">{tag.count} 筆</span><button type="button" className="icon-button" data-rename={tag.id} aria-label={`重新命名 ${tag.name}`} onClick={()=>{setError("");setEditing({id:tag.id,name:tag.name})}}><PencilSimple size={18}/></button><button type="button" className="icon-button danger-icon" aria-label={`刪除 ${tag.name}`} onClick={event=>{returnTo.current=event.currentTarget;setError("");setRemoving(tag)}}><Trash size={18}/></button></>}</li>)}</ul>
      {!tags.length&&<p className="field-hint">尚無標籤。</p>}
    </AppDialog>
    <AppDialog open={!!removing} onOpenChange={value=>{if(!value)setRemoving(null)}} onCloseAutoFocus={event=>{if(returnTo.current?.isConnected)return;event.preventDefault();newTag.current?.focus()}} title="刪除此標籤？" description={`${subject}會保留；只移除這個標籤。`} ><p><strong>{removing?.name}</strong>（{removing?.count??0} 筆{subject}）</p>{error&&<p className="form-error" role="alert">{error}</p>}<div className="dialog-actions"><button className="button" onClick={()=>setRemoving(null)}>保留</button><button className="button danger" disabled={busy} onClick={remove}>確認刪除</button></div></AppDialog>
  </>;
}
