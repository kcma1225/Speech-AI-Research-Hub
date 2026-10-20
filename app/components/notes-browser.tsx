"use client";
import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { AddItemDialog } from "./add-item-dialog";
import { TagManager } from "./tag-manager";
import { ArrowCounterClockwise, CaretDown, FunnelSimple, MagnifyingGlass, X } from "./icons";
import { NO_TAG, type Tag, type TagWithCount } from "@/lib/tag-types";

type Note={id:string;title:string;date:string;excerpt:string;tags:Tag[]};

export function NotesBrowser({notes,tags,query,selected,canEdit}:{notes:Note[];tags:TagWithCount[];query:string;selected:string[]|null;canEdit:boolean}){
  const router=useRouter();
  const path=usePathname();
  const [pending,startTransition]=useTransition();
  const [text,setText]=useState(query);
  const options=[NO_TAG,...tags.map(tag=>tag.id)];
  const checked=new Set(selected??options);
  const allChecked=options.every(option=>checked.has(option));
  const [open,setOpen]=useState(false);
  const filterBox=useRef<HTMLDivElement>(null);
  const filterButton=useRef<HTMLButtonElement>(null);
  useEffect(()=>{
    if(!open)return;
    const outside=(event:PointerEvent)=>{if(!filterBox.current?.contains(event.target as Node))setOpen(false)};
    const escape=(event:KeyboardEvent)=>{if(event.key==="Escape"){setOpen(false);filterButton.current?.focus()}};
    document.addEventListener("pointerdown",outside);document.addEventListener("keydown",escape);
    return()=>{document.removeEventListener("pointerdown",outside);document.removeEventListener("keydown",escape)};
  },[open]);
  const labels=new Map<string,string>([[NO_TAG,"無標籤"],...tags.map(tag=>[tag.id,tag.name] as [string,string])]);
  const picked=options.filter(option=>checked.has(option));
  const shown=allChecked?[]:picked.slice(0,2);
  const hidden=allChecked?0:picked.length-shown.length;
  useEffect(()=>setText(query),[query]);

  function navigate(nextQuery:string,next:Set<string>){
    const params=new URLSearchParams();
    if(nextQuery.trim())params.set("q",nextQuery.trim());
    // Omit `tags` when everything is checked so new tags stay visible by default.
    if(!options.every(option=>next.has(option)))params.set("tags",options.filter(option=>next.has(option)).join(","));
    const search=params.toString();
    startTransition(()=>router.replace(search?`${path}?${search}`:path,{scroll:false}));
  }
  useEffect(()=>{
    if(text.trim()===query)return;
    const timer=setTimeout(()=>navigate(text,checked),300);
    return()=>clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[text]);
  function toggle(option:string,value:boolean){const next=new Set(checked);if(value)next.add(option);else next.delete(option);navigate(text,next)}
  function toggleAll(value:boolean){navigate(text,value?new Set(options):new Set())}

  const filtered=!allChecked||Boolean(query);
  return <>
    <div className="notes-tools">
      <form className="notes-search" role="search" onSubmit={e=>{e.preventDefault();navigate(text,checked)}}>
        <label htmlFor="notes-q" className="sr-only">搜尋筆記</label>
        <MagnifyingGlass size={19} aria-hidden="true"/>
        <input id="notes-q" type="search" value={text} onChange={e=>setText(e.target.value)} placeholder="搜尋名稱或內容" maxLength={200} autoComplete="off"/>
        {text&&<button type="button" className="icon-button" aria-label="清除搜尋" onClick={()=>{setText("");navigate("",checked)}}><X size={18}/></button>}
      </form>
      {canEdit&&<TagManager tags={tags}/>}
    </div>
    <div className="tag-filter-bar">
      <div className="tag-filter" ref={filterBox}>
        <button ref={filterButton} type="button" className="tag-filter-toggle" aria-expanded={open} aria-controls="tag-filter-panel" onClick={()=>setOpen(value=>!value)}>
          <FunnelSimple size={18} aria-hidden="true"/>
          <span className="tag-filter-label">標籤</span>
          <span className="tag-filter-value">
            {allChecked?<span className="tag-chip">全部</span>:picked.length===0?<span className="tag-chip is-empty">未選擇</span>:<>{shown.map(option=><span className="tag-chip" key={option}>{labels.get(option)}</span>)}{hidden>0&&<span className="tag-more" aria-hidden="true">…</span>}</>}
          </span>
          <span className="tag-filter-count">{picked.length}/{options.length}</span>
          <span className="sr-only">，已勾選 {picked.length} 個，共 {options.length} 個</span>
          <CaretDown size={16} aria-hidden="true" className="tag-filter-caret"/>
        </button>
        {open&&<fieldset id="tag-filter-panel" className="tag-filter-panel">
          <legend className="sr-only">標籤篩選</legend>
          <label className="tag-option tag-option-all"><input type="checkbox" checked={allChecked} onChange={e=>toggleAll(e.target.checked)}/><span>全部</span></label>
          <label className="tag-option"><input type="checkbox" checked={checked.has(NO_TAG)} onChange={e=>toggle(NO_TAG,e.target.checked)}/><span>無標籤</span></label>
          {tags.map(tag=><label className="tag-option" key={tag.id}><input type="checkbox" checked={checked.has(tag.id)} onChange={e=>toggle(tag.id,e.target.checked)}/><span className="tag-option-name">{tag.name}</span><span className="tag-count">{tag.count}</span></label>)}
        </fieldset>}
      </div>
      <button type="button" className="button tag-filter-reset" disabled={allChecked&&!query&&!text} onClick={()=>{setText("");filterButton.current?.focus();navigate("",new Set(options))}}><ArrowCounterClockwise size={17} aria-hidden="true"/><span className="reset-text">清除篩選</span></button>
    </div>
    <p id="tag-filter-summary" className="notes-summary" role="status" aria-live="polite">{pending?"更新中…":`${notes.length} 筆筆記${filtered?"（已篩選）":""}`}</p>
    <div className="records" aria-busy={pending}>
      {notes.length?notes.map(note=><Link href={`/items/${note.id}`} className="record note-row" key={note.id}><time>{note.date}</time><div><h3>{note.title}</h3><p>{note.excerpt}</p></div><span className="note-tags" aria-label="標籤">{note.tags.length?note.tags.map(tag=><span className="tag-chip" key={tag.id}>{tag.name}</span>):<span className="tag-chip is-empty">無標籤</span>}</span></Link>)
        :<p className="empty-ledger">{filtered?"沒有符合條件的筆記。調整搜尋字詞或標籤篩選。":canEdit?"尚無筆記。使用新增按鈕建立第一筆。":"尚無筆記。"}</p>}
    </div>
    {canEdit&&<AddItemDialog tags={tags}/>}
  </>;
}
