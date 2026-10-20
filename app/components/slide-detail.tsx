"use client";
import { FormEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { SlideProject } from "@/lib/slide-access";
import { AppDialog } from "./dialog";

type Version={id:string;version:number;status:string;error:string|null;source_name:string;entry_html:string;view_key:string;pdf_ready:boolean};
type Reference={id:string;title:string;url:string|null;file_name:string|null;is_default:boolean};
type Reply={id:string;body:string;author:string};
type Review={id:string;body:string;author:string;replies:Reply[]};
type Detail={versions:Version[];references:Reference[];reviews:Review[];tags:{id:string;name:string}[]};
export function SlideDetail({project,detail,role}:{project:SlideProject;detail:Detail;role:string|null}){
  const router=useRouter();
  const [version,setVersion]=useState(project.active_version_id??"");
  const [review,setReview]=useState("");
  const [reply,setReply]=useState<Record<string,string>>({});
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  const active=detail.versions.find(item=>item.id===version&&item.status==="published");
  useEffect(()=>{if(!version&&project.active_version_id)setVersion(project.active_version_id)},[version,project.active_version_id]);
  useEffect(()=>{
    if(!detail.versions.some(item=>item.status==="queued"||item.status==="rendering"))return;
    const timer=setInterval(async()=>{
      const response=await fetch(`/api/slides/${project.id}/status`,{cache:"no-store"}).catch(()=>null);
      if(response?.ok){const result=await response.json();if(result.status==="published"||result.status==="failed")router.refresh()}
    },3000);
    return()=>clearInterval(timer);
  },[detail.versions,project.id,router]);
  const [frameKey,setFrameKey]=useState(0);
  const frameRef=useRef<HTMLIFrameElement>(null);
  const [fullScreen,setFullScreen]=useState(false);
  useEffect(()=>{const changed=()=>setFullScreen(document.fullscreenElement===frameRef.current);document.addEventListener("fullscreenchange",changed);return()=>document.removeEventListener("fullscreenchange",changed)},[]);
  const [deleteVersion,setDeleteVersion]=useState<Version|null>(null);
  const [versionFile,setVersionFile]=useState<File|null>(null);
  const [versionEntry,setVersionEntry]=useState("");
  const [refTitle,setRefTitle]=useState("");
  const [refUrl,setRefUrl]=useState("");
  const [refFile,setRefFile]=useState<File|null>(null);
  const [removingRef,setRemovingRef]=useState<Reference|null>(null);
  async function send(url:string,body:unknown){
    setBusy(true);setError("");
    const response=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}).catch(()=>null);
    setBusy(false);
    if(!response?.ok){setError((await response?.json().catch(()=>({})))?.error??"送出失敗。");return false}
    router.refresh();return true;
  }
  async function removeVersion(){if(!deleteVersion)return;setBusy(true);const response=await fetch(`/api/slides/${project.id}/versions/${deleteVersion.id}`,{method:"DELETE"}).catch(()=>null);setBusy(false);if(response?.ok){setDeleteVersion(null);router.refresh()}else setError("刪除失敗。")}
  async function uploadVersion(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(!versionFile)return;setBusy(true);setError("");
    const form=new FormData();form.set("file",versionFile);form.set("entry",versionEntry);
    const response=await fetch(`/api/slides/${project.id}/versions`,{method:"POST",body:form}).catch(()=>null);
    setBusy(false);if(!response?.ok){setError((await response?.json().catch(()=>({})))?.error??"版本上傳失敗。");return}
    setVersionFile(null);setVersionEntry("");router.refresh();
  }
  async function addReference(event:FormEvent<HTMLFormElement>){
    event.preventDefault();setBusy(true);setError("");const form=new FormData();form.set("title",refTitle);if(refFile)form.set("file",refFile);else form.set("url",refUrl);
    const response=await fetch(`/api/slides/${project.id}/references`,{method:"POST",body:form}).catch(()=>null);
    setBusy(false);if(!response?.ok){setError((await response?.json().catch(()=>({})))?.error??"參考資料新增失敗。");return}
    setRefTitle("");setRefUrl("");setRefFile(null);router.refresh();
  }
  async function referenceAction(ref:Reference,method:"PATCH"|"DELETE"){
    setBusy(true);setError("");const response=await fetch(`/api/slides/${project.id}/references/${ref.id}`,{method}).catch(()=>null);
    setBusy(false);if(!response?.ok){setError("參考資料更新失敗。");return}
    setRemovingRef(null);router.refresh();
  }
  const share=`/slides/share/${project.slug}/${project.share_key}`;
  return <div className="slide-detail">
    <header className="page-head compact-head"><div><p className="status">研究簡報</p><h1>{project.title}</h1><div className="note-tags">{detail.tags.map(tag=><span className="tag-chip" key={tag.id}>{tag.name}</span>)}</div></div></header>
    <div className="slide-detail-tools"><label htmlFor="slide-version">版本</label><select id="slide-version" value={version} onChange={event=>{setVersion(event.target.value);setFrameKey(value=>value+1)}}>{detail.versions.filter(item=>item.status==="published").map(item=><option value={item.id} key={item.id}>Version {item.version}</option>)}</select>{active&&<><button className="button" type="button" onClick={()=>{router.refresh();setFrameKey(value=>value+1)}}>重新載入簡報</button><button className="button" type="button" onClick={()=>{if(document.fullscreenElement)void document.exitFullscreen();else void frameRef.current?.requestFullscreen().catch(()=>setError("無法進入全螢幕，請檢查瀏覽器權限。"))}}>{fullScreen?"離開全螢幕":"全螢幕"}</button>{active.pdf_ready?<a className="button" href={`/slides/pdf/${project.slug}/${active.id}`} download>下載 PDF</a>:<span className="field-hint">此版本尚無 PDF</span>}</>}</div>
    {active?<iframe ref={frameRef} key={frameKey} className="slide-detail-frame" src={`/slides/view/${project.slug}/${active.view_key}/${active.id}/${active.entry_html}`} title={`${project.title}，Version ${active.version}`} sandbox="allow-scripts allow-pointer-lock allow-presentation" allow="fullscreen" allowFullScreen/>:<p className="empty-ledger">尚無已發布版本。請稍後查看編譯狀態。</p>}
    <p className="field-hint">註記工具可在簡報上畫線與標記。隔離模式下筆跡只存於目前頁面，重新載入即消失。</p>
    <section className="slide-detail-section"><h2>參考資料</h2>{detail.references.length?<ul className="slide-detail-list">{detail.references.map(ref=><li key={ref.id}>{ref.is_default&&<span className="status">預設</span>} <a href={ref.url??`/slides/reference/${project.slug}/${ref.id}`} target="_blank" rel="noopener noreferrer">{ref.title}</a>{role&&role!=="professor"&&<>{!ref.is_default&&<button type="button" className="button" disabled={busy} onClick={()=>void referenceAction(ref,"PATCH")}>設為預設</button>}<button type="button" className="button danger" disabled={busy} onClick={()=>setRemovingRef(ref)}>刪除</button></>}</li>)}</ul>:<p>尚無參考資料。</p>}{role&&role!=="professor"&&<form onSubmit={addReference}><h3>新增參考資料</h3><div className="field"><label htmlFor="reference-title">名稱</label><input id="reference-title" value={refTitle} onChange={event=>setRefTitle(event.target.value)} required maxLength={300}/></div><div className="field"><label htmlFor="reference-url">連結（與 PDF 擇一）</label><input id="reference-url" type="url" value={refUrl} onChange={event=>setRefUrl(event.target.value)} disabled={!!refFile}/></div><div className="field"><label htmlFor="reference-file">PDF（與連結擇一；30 MB 以下）</label><input id="reference-file" type="file" accept=".pdf,application/pdf" disabled={!!refUrl} onChange={event=>setRefFile(event.target.files?.[0]??null)}/></div><button className="button" disabled={busy||!refTitle||(!refUrl&&!refFile)}>新增參考資料</button></form>}</section>
    <section className="slide-detail-section"><h2>Professor 審閱</h2>{detail.reviews.length?detail.reviews.map(item=><article className="slide-review" key={item.id}><h3>{item.author}</h3><p className="slide-review-body">{item.body}</p>{item.replies.map(response=><div className="slide-review-reply" key={response.id}><strong>{response.author} 回覆</strong><p>{response.body}</p></div>)}{role==="owner"&&<form onSubmit={async(event:FormEvent)=>{event.preventDefault();if(await send(`/api/slides/${project.id}/reviews/${item.id}/replies`,{body:reply[item.id]}))setReply(value=>({...value,[item.id]:""}))}}><label htmlFor={`reply-${item.id}`}>回覆審閱</label><textarea id={`reply-${item.id}`} value={reply[item.id]??""} onChange={event=>setReply(value=>({...value,[item.id]:event.target.value}))} maxLength={10000} required/><button className="button" disabled={busy}>送出回覆</button></form>}</article>):<p>尚無審閱。</p>}{role==="professor"&&<form onSubmit={async(event:FormEvent)=>{event.preventDefault();if(await send(`/api/slides/${project.id}/reviews`,{body:review}))setReview("")}}><label htmlFor="new-slide-review">新增審閱</label><textarea id="new-slide-review" value={review} onChange={event=>setReview(event.target.value)} maxLength={10000} required/><button className="button primary" disabled={busy}>送出審閱</button></form>}{!role&&<p className="field-hint">訪客可閱讀審閱，不能評論。</p>}{error&&<p className="form-error" role="alert">{error}</p>}</section>
    {role&&role!=="professor"&&<section className="slide-detail-section"><h2>管理</h2><p>公開檢視：{project.public_view?"所有人":"僅登入成員及持分享連結者"}</p><div className="slide-detail-tools"><label htmlFor="slide-share">分享連結</label><input id="slide-share" value={share} readOnly onFocus={event=>event.currentTarget.select()}/><button type="button" className="button" onClick={()=>void navigator.clipboard.writeText(new URL(share,window.location.origin).href)}>複製</button></div><form onSubmit={uploadVersion}><h3>上傳新版本</h3><div className="field"><label htmlFor="version-file">ZIP 檔</label><input id="version-file" type="file" accept=".zip,application/zip" required onChange={event=>setVersionFile(event.target.files?.[0]??null)}/></div><div className="field"><label htmlFor="version-entry">入口 QMD（選填）</label><input id="version-entry" value={versionEntry} onChange={event=>setVersionEntry(event.target.value)}/></div><button className="button" disabled={busy||!versionFile}>上傳並編譯</button></form><ul className="slide-detail-list">{detail.versions.map(item=><li key={item.id}>Version {item.version} · {item.status}{item.error&&<p className="form-error">{item.error.slice(-500)}</p>}{item.id!==project.active_version_id&&item.status==="published"&&<button className="button" onClick={async()=>{const response=await fetch(`/api/slides/${project.id}/versions/${item.id}`,{method:"PATCH"});if(response.ok){setVersion(item.id);router.refresh()}}}>設為目前版本</button>}{item.id!==project.active_version_id&&<button className="button danger" onClick={()=>setDeleteVersion(item)}>刪除版本</button>}</li>)}</ul></section>}
    <AppDialog open={!!removingRef} onOpenChange={open=>{if(!open)setRemovingRef(null)}} title="刪除參考資料？" description="此參考資料會永久刪除。"><p>{removingRef?.title}</p><div className="dialog-actions"><button className="button" onClick={()=>setRemovingRef(null)}>保留</button><button className="button danger" disabled={busy} onClick={()=>removingRef&&void referenceAction(removingRef,"DELETE")}>確認刪除</button></div></AppDialog>
    <AppDialog open={!!deleteVersion} onOpenChange={open=>{if(!open)setDeleteVersion(null)}} title="刪除此版本？" description="版本來源與輸出會永久刪除。"><p>Version {deleteVersion?.version}</p><div className="dialog-actions"><button className="button" onClick={()=>setDeleteVersion(null)}>保留</button><button className="button danger" disabled={busy} onClick={removeVersion}>確認刪除</button></div></AppDialog>
  </div>;
}
