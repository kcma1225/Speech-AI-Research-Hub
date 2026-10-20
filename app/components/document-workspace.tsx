"use client";
import { FormEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUp } from "./icons";
import { MarkdownView, ReadingView } from "./markdown-view";
import { AudioPlayer } from "./audio-player";
import { AppDialog } from "./dialog";
import type { Cue } from "@/lib/srt";
import type { Tag } from "@/lib/tag-types";
import { TagPicker } from "./tag-picker";
import { ArrowCounterClockwise, Check, X, Code, Columns, Eye, FloppyDisk, Link, ListBullets, PencilSimple, Quotes, TextB, TextHOne, TextItalic, Trash, UploadSimple } from "./icons";

type Item={id:string;title:string;content:string;event_date:string;file_name:string|null;storage_name:string|null;updated_at:string;transcript:Cue[]|null;transcript_name:string|null};
type Mode="see"|"edit"|"split";
const tools=[
  {label:"標題",before:"## ",after:"",Icon:TextHOne},
  {label:"粗體",before:"**",after:"**",Icon:TextB},
  {label:"斜體",before:"_",after:"_",Icon:TextItalic},
  {label:"清單",before:"- ",after:"",Icon:ListBullets},
  {label:"引用",before:"> ",after:"",Icon:Quotes},
  {label:"程式碼",before:"`",after:"`",Icon:Code},
  {label:"連結",before:"[",after:"](https://)",Icon:Link},
] as const;

export function DocumentWorkspace({item,tags,allTags,readOnly=false}:{item:Item;tags:Tag[];allTags:Tag[];readOnly?:boolean}){
  if(readOnly)return <><div className="document-bar"><span className="status">唯讀</span></div>{item.storage_name&&<section className="media-panel"><AudioPlayer src={`/api/media/${item.id}`} name={item.file_name??"錄音"} cues={item.transcript}/></section>}<ReadingView content={item.content}/></>;
  return <EditableDocumentWorkspace item={item} tags={tags} allTags={allTags}/>;
}

function EditableDocumentWorkspace({item,tags,allTags}:{item:Item;tags:Tag[];allTags:Tag[]}){
  const router=useRouter();
  const [mode,setMode]=useState<Mode>(()=>item.content.trim()?"see":"edit");
  const [content,setContent]=useState(item.content);
  const [saved,setSaved]=useState(item.content);
  const [meta,setMeta]=useState(false);
  const [tagIds,setTagIds]=useState(()=>tags.map(tag=>tag.id));
  const [remove,setRemove]=useState(false);
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  const [showTop,setShowTop]=useState(false);
  const [toast,setToast]=useState<{kind:"ok"|"error";text:string;undo?:boolean}|null>(null);
  const dirty=content!==saved;
  const [leave,setLeave]=useState<null|{href:string;kind:"link"|"back"|"form";form?:HTMLFormElement}>(null);
  const [revert,setRevert]=useState(false);
  const discarded=useRef<string|null>(null);
  const bypass=useRef(false);
  const guarded=useRef(false);
  const dirtyRef=useRef(dirty);dirtyRef.current=dirty;
  useEffect(()=>{
    const click=(e:MouseEvent)=>{
      if(!dirtyRef.current||bypass.current||e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;
      const a=(e.target as Element|null)?.closest?.("a[href]") as HTMLAnchorElement|null;
      if(!a||a.target==="_blank"||a.hasAttribute("download"))return;
      const href=a.getAttribute("href")??"";
      if(!href||href.startsWith("#"))return;
      e.preventDefault();e.stopImmediatePropagation();
      setLeave({href,kind:"link"});
    };
    const submit=(e:SubmitEvent)=>{
      const form=e.target as HTMLFormElement;
      if(!dirtyRef.current||bypass.current||!form.getAttribute("action"))return;
      e.preventDefault();e.stopImmediatePropagation();
      setLeave({href:form.getAttribute("action")??"",kind:"form",form});
    };
    window.addEventListener("click",click,true);window.addEventListener("submit",submit,true);
    return()=>{window.removeEventListener("click",click,true);window.removeEventListener("submit",submit,true)};
  },[]);
  useEffect(()=>{
    const pop=()=>{
      if(bypass.current||!guarded.current)return;
      if(!dirtyRef.current){guarded.current=false;history.back();return}
      history.pushState({...history.state,docGuard:true},"",location.href);
      setLeave({href:"",kind:"back"});
    };
    window.addEventListener("popstate",pop);
    return()=>window.removeEventListener("popstate",pop);
  },[]);
  useEffect(()=>{
    if(!dirty||guarded.current)return;
    guarded.current=true;
    history.pushState({...history.state,docGuard:true},"",location.href);
  },[dirty]);
  function proceed(){
    const target=leave;if(!target)return;
    bypass.current=true;setLeave(null);
    if(target.kind==="back"){guarded.current=false;history.go(-2);return}
    if(target.kind==="form"&&target.form){target.form.requestSubmit();return}
    if(/^\/(?!\/)/.test(target.href))router.push(target.href);
    else{let url:URL|null=null;try{url=new URL(target.href,window.location.origin)}catch{url=null}if(url&&/^https?:$/.test(url.protocol))window.location.assign(url.toString());else bypass.current=false}
  }
  async function saveAndLeave(){const ok=await saveRef.current();if(ok)proceed()}
  function rollback(){discarded.current=content;setContent(saved);setRevert(false);setToast({kind:"ok",text:"已還原到上次儲存的版本",undo:true})}
  function undoRollback(){if(discarded.current===null)return;setContent(discarded.current);discarded.current=null;setToast(null)}
  useEffect(()=>{if(!toast)return;const timer=setTimeout(()=>setToast(null),toast.undo?7000:toast.kind==="ok"?2600:4200);return()=>clearTimeout(timer)},[toast]);
  useEffect(()=>{if(!dirty)return;const warn=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue=""};window.addEventListener("beforeunload",warn);return()=>window.removeEventListener("beforeunload",warn)},[dirty]);
  useEffect(()=>{const onScroll=()=>setShowTop(window.scrollY>300);onScroll();window.addEventListener("scroll",onScroll,{passive:true});return()=>window.removeEventListener("scroll",onScroll)},[]);
  useEffect(()=>{if(mode==="split"&&document.documentElement.dataset.pwa)setMode("edit")},[mode]);
  const editor=useRef<HTMLTextAreaElement>(null);
  const preview=useRef<HTMLDivElement>(null);
  const syncing=useRef(false);
  function wrap(before:string,after:string){const field=editor.current;if(!field)return;const start=field.selectionStart,end=field.selectionEnd;setContent(content.slice(0,start)+before+content.slice(start,end)+after+content.slice(end));requestAnimationFrame(()=>{field.focus();field.setSelectionRange(start+before.length,end+before.length)})}
  function sync(source:HTMLElement,target:HTMLElement){if(syncing.current)return;syncing.current=true;const sourceMax=source.scrollHeight-source.clientHeight;const targetMax=target.scrollHeight-target.clientHeight;target.scrollTop=sourceMax?source.scrollTop/sourceMax*targetMax:0;requestAnimationFrame(()=>syncing.current=false)}
  async function saveContent(){
    if(busy||!dirty)return !dirty;
    const snapshot=content;
    setBusy(true);setError("");
    const r=await fetch(`/api/items/${item.id}`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({title:item.title,eventDate:item.event_date,content:snapshot})}).catch(()=>null);
    setBusy(false);
    if(!r?.ok){const message=r?((await r.json().catch(()=>({}))).error??"儲存失敗，請重試。"):"網路中斷，尚未儲存。";setToast({kind:"error",text:message});return false}
    const result=await r.json();const persisted=typeof result.content==="string"?result.content:snapshot;setSaved(persisted);setContent(value=>value===snapshot?persisted:value);discarded.current=null;setToast({kind:"ok",text:"已儲存變更"});router.refresh();return true;
  }
  const saveRef=useRef(saveContent);saveRef.current=saveContent;
  useEffect(()=>{const key=(e:KeyboardEvent)=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==="s"){e.preventDefault();void saveRef.current()}};window.addEventListener("keydown",key);return()=>window.removeEventListener("keydown",key)},[]);
  async function updateMeta(e:FormEvent<HTMLFormElement>){e.preventDefault();setBusy(true);const form=e.currentTarget;const values=Object.fromEntries(new FormData(form));const r=await fetch(`/api/items/${item.id}`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({title:values.title,eventDate:values.eventDate,content})});if(!r.ok){setError((await r.json()).error);setBusy(false);return}const tagged=await fetch(`/api/items/${item.id}/tags`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({tagIds})});if(!tagged.ok){setError((await tagged.json().catch(()=>({}))).error??"標籤儲存失敗。");setBusy(false);return}const media=(form.elements.namedItem("file") as HTMLInputElement).files?.[0];if(media){const data=new FormData();data.set("file",media);const upload=await fetch(`/api/items/${item.id}/media`,{method:"POST",body:data});if(!upload.ok){setError((await upload.json()).error);setBusy(false);return}window.dispatchEvent(new Event("media-job-started"));}const srt=(form.elements.namedItem("transcript") as HTMLInputElement|null)?.files?.[0];if(srt){const data=new FormData();data.set("file",srt);const upload=await fetch(`/api/items/${item.id}/transcript`,{method:"POST",body:data});if(!upload.ok){setError((await upload.json()).error);setBusy(false);return}}const drop=(form.elements.namedItem("removeTranscript") as HTMLInputElement|null)?.checked;if(drop&&!srt)await fetch(`/api/items/${item.id}/transcript`,{method:"DELETE"});setBusy(false);setMeta(false);router.refresh()}
  async function destroy(){const r=await fetch(`/api/items/${item.id}`,{method:"DELETE"});if(r.ok){router.replace("/notes");router.refresh()}else setError((await r.json()).error)}
  return <>
    <div className="document-bar">
      <div className="document-modes" role="group" aria-label="文件模式">
        <button className="icon-button" aria-label="預覽模式" title="預覽" aria-pressed={mode==="see"} onClick={()=>setMode("see")}><Eye size={20}/></button>
        <button className="icon-button" aria-label="編輯模式" title="編輯" aria-pressed={mode==="edit"} onClick={()=>setMode("edit")}><PencilSimple size={20}/></button>
        <button className="icon-button split-mode-button" aria-label="分割模式" title="分割" aria-pressed={mode==="split"} onClick={()=>setMode("split")}><Columns size={20}/></button>
      </div>
      <div className="document-actions">
        {dirty&&<span className="save-state is-dirty"><span className="save-dot" aria-hidden="true"/><span className="save-long">{busy?"儲存中…":"已修改，尚未儲存"}</span><span className="save-short">{busy?"儲存中":"未儲存"}</span></span>}
        {dirty&&<button className="icon-button" aria-label="還原到上次儲存的版本" title="還原到上次儲存" disabled={busy} onClick={()=>setRevert(true)}><ArrowCounterClockwise size={20}/></button>}
        {(mode!=="see"||dirty)&&<button className={`icon-button${dirty?" save-pending":""}`} aria-label={dirty?"儲存內容（尚未儲存）":"儲存內容"} title="儲存（⌘S ／ Ctrl+S）" disabled={busy||!dirty} onClick={saveContent}><FloppyDisk size={20}/></button>}
        <button className="icon-button" aria-label="編輯名稱、日期、標籤與媒體" title="編輯資料" onClick={()=>{setTagIds(tags.map(tag=>tag.id));setError("");setMeta(true)}}><UploadSimple size={20}/></button>
        <button className="icon-button danger-icon" aria-label="刪除筆記" title="刪除" onClick={()=>setRemove(true)}><Trash size={20}/></button>
      </div>
    </div>
    {error&&<p role="alert" className="form-error">{error}</p>}
    <div className="save-toast-region" role="status" aria-live="polite">{toast&&<div className={`save-toast is-${toast.kind}`}>{toast.kind==="ok"?<Check size={18} weight="bold" aria-hidden="true"/>:<X size={18} weight="bold" aria-hidden="true"/>}<span>{toast.text}</span>{toast.undo&&<button type="button" className="save-toast-undo" onClick={undoRollback}>復原</button>}</div>}</div>
    {item.storage_name&&<section className="media-panel"><AudioPlayer src={`/api/media/${item.id}`} name={item.file_name??"錄音"} cues={item.transcript}/></section>}
    {mode!=="see"&&<div className="markdown-toolbar" role="toolbar" aria-label="Markdown 格式工具">{tools.map(({label,before,after,Icon})=><button type="button" key={label} aria-label={label} title={label} onClick={()=>wrap(before,after)}><Icon size={19}/></button>)}</div>}
    {mode==="see"?<ReadingView content={content}/>:mode==="edit"?<textarea ref={editor} className="document-editor" value={content} onChange={e=>setContent(e.target.value)} aria-label="Markdown 內容"/>:<div className="split-editor"><textarea ref={editor} className="document-editor" value={content} onChange={e=>setContent(e.target.value)} onScroll={e=>preview.current&&sync(e.currentTarget,preview.current)} aria-label="Markdown 內容"/><div ref={preview} className="split-preview" onScroll={e=>editor.current&&sync(e.currentTarget,editor.current)}><MarkdownView content={content}/></div></div>}
    {mode==="see"&&showTop&&<button type="button" className="back-to-top" aria-label="回到頁首" title="回到頁首" onClick={()=>window.scrollTo({top:0,behavior:window.matchMedia("(prefers-reduced-motion: reduce)").matches?"instant":"smooth"})}><ArrowUp size={18} weight="bold" aria-hidden="true"/><span className="back-to-top-label">回到頁首</span></button>}
    <AppDialog open={meta} onOpenChange={setMeta} title="編輯筆記資料" description="修改名稱、日期與標籤，新增或替換媒體與逐字稿。"><form onSubmit={updateMeta}><div className="field"><label htmlFor="edit-title">名稱</label><input id="edit-title" name="title" defaultValue={item.title} required/></div><div className="field"><label htmlFor="edit-date">日期</label><input id="edit-date" name="eventDate" type="date" defaultValue={item.event_date} required/></div><TagPicker tags={allTags} value={tagIds} onChange={setTagIds}/><div className="field"><label htmlFor="item-media">錄音或影片</label><input id="item-media" name="file" type="file" accept="audio/*,video/*,.mp4,.m4a,.mov,.webm,.mkv"/></div>{item.storage_name&&<div className="field"><label htmlFor="item-transcript">逐字稿（.srt）</label><input id="item-transcript" name="transcript" type="file" accept=".srt,application/x-subrip,text/plain"/><small className="field-hint">{item.transcript_name?`目前：${item.transcript_name}（${item.transcript?.length??0} 段）。上傳新檔會取代。`:"匯入後，播放錄音時會同步標示目前段落。"}</small></div>}{item.transcript_name&&<label className="check-field"><input type="checkbox" name="removeTranscript"/>移除目前逐字稿</label>}<div className="dialog-actions"><button type="button" className="button" onClick={()=>setMeta(false)}>取消</button><button className="button primary" disabled={busy}>{busy?"處理中…":"儲存"}</button></div></form></AppDialog>
    <AppDialog open={remove} onOpenChange={setRemove} title="刪除此資料？" description="刪除後無法復原，媒體檔也會一起移除。"><p><strong>{item.title}</strong></p><div className="dialog-actions"><button className="button" onClick={()=>setRemove(false)}>保留資料</button><button className="button danger" onClick={destroy}>確認刪除</button></div></AppDialog>
    <AppDialog open={revert} onOpenChange={setRevert} title="還原到上次儲存的版本？" description="這次編輯但尚未儲存的內容會被移除，文件回到最後一次儲存的狀態。"><div className="dialog-actions"><button className="button" onClick={()=>setRevert(false)}>繼續編輯</button><button className="button danger" onClick={rollback}>還原</button></div></AppDialog>
    <AppDialog open={!!leave} onOpenChange={v=>{if(!v)setLeave(null)}} title="有尚未儲存的變更" description="離開此頁會遺失這次的修改。要先儲存嗎？"><div className="dialog-actions leave-actions"><button className="button" autoFocus onClick={()=>setLeave(null)}>留在此頁</button><button className="button danger" onClick={proceed}>不儲存，直接離開</button><button className="button primary" disabled={busy} onClick={()=>void saveAndLeave()}>{busy?"儲存中…":"儲存並離開"}</button></div></AppDialog>
  </>;
}
