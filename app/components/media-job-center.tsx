"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AppDialog } from "./dialog";

export type Job={id:string;item_id:string;status:"processing"|"completed"|"failed"|"cancelled";stage:string;progress:number;duration_seconds:number|null;error:string|null;created_at:string};

function remaining(job:Job,now:number){
  if(job.status!=="processing")return job.error??"";
  if(job.progress<3)return "正在估算剩餘時間…";
  const elapsed=Math.max(1,(now-new Date(job.created_at).getTime())/1000);
  const seconds=Math.max(1,Math.round(elapsed*(100-job.progress)/job.progress));
  return seconds<60?`約剩 ${seconds} 秒`:`約剩 ${Math.ceil(seconds/60)} 分鐘`;
}

export function JobProgress({job,busy=false,onCancel,onOpenItem}:{job:Job;busy?:boolean;onCancel?:()=>void;onOpenItem?:()=>void}){
  const [now,setNow]=useState(()=>Date.now());
  useEffect(()=>{if(job.status!=="processing")return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer)},[job.status]);
  const label=job.status==="processing"?"正在處理中":job.status==="completed"?"處理完成":job.status==="cancelled"?"已取消":"處理失敗";
  const eta=remaining(job,now);
  return <section className="media-job-row" aria-live="polite">
    <div className="media-job-heading"><strong>{job.status==="processing"&&<span className="media-spinner" aria-hidden="true"/>}{label}</strong><span>{job.progress}%</span></div>
    <progress value={job.progress} max={100} aria-label={`媒體處理進度 ${job.progress}%`}/>
    <p>目前步驟：{job.stage}{eta?` · ${eta}`:""}</p>
    {(onOpenItem||job.status==="processing"&&onCancel)&&<div className="row">{onOpenItem&&<a className="button" href={`/items/${job.item_id}`} onClick={onOpenItem}>查看筆記</a>}{job.status==="processing"&&onCancel&&<button type="button" className="button logout-button" disabled={busy} onClick={onCancel}>{busy?"取消中…":"取消處理"}</button>}</div>}
  </section>;
}

export function MediaJobCenter(){
  const router=useRouter();
  const [jobs,setJobs]=useState<Job[]>([]);
  const [open,setOpen]=useState(false);
  const [notice,setNotice]=useState<string|null>(null);
  const [busy,setBusy]=useState<string|null>(null);
  const refresh=useCallback(async()=>{
    const response=await fetch("/api/media-jobs",{cache:"no-store"}).catch(()=>null);
    if(!response?.ok)return;
    const result=await response.json() as {jobs:Job[]};
    setJobs(result.jobs);
    let seen:string[]=[];
    try{seen=JSON.parse(localStorage.getItem("seen_media_jobs")??"[]")}catch{localStorage.removeItem("seen_media_jobs")}
    const done=result.jobs.filter(job=>job.status==="completed"&&!seen.includes(job.id));
    if(!done.length)return;
    setNotice(`影音處理完成（${done.length}）`);
    localStorage.setItem("seen_media_jobs",JSON.stringify([...seen,...done.map(job=>job.id)].slice(-100)));
    router.refresh();
  },[router]);
  useEffect(()=>{
    void refresh();
    const timer=setInterval(()=>{void refresh()},2500);
    const started=()=>{setOpen(true);void refresh()};
    window.addEventListener("media-job-started",started);
    return()=>{clearInterval(timer);window.removeEventListener("media-job-started",started)};
  },[refresh]);
  async function cancel(id:string){
    setBusy(id);
    const response=await fetch(`/api/media-jobs/${id}`,{method:"DELETE"}).catch(()=>null);
    setBusy(null);
    if(!response?.ok)setNotice("無法取消；工作可能已完成。");
    await refresh();
  }
  const active=jobs.filter(job=>job.status==="processing");
  const recent=jobs.filter(job=>job.status!=="processing").slice(0,5);
  return <>
    {(active.length>0||notice)&&<div className="media-job-toast" role="status">
      {active.length>0&&!notice&&<span className="media-spinner" aria-hidden="true"/>}
      <span>{notice??`影音處理中（${active.length}）`}</span>
      <button type="button" className="button" onClick={()=>{setOpen(true);setNotice(null)}}>查看進度</button>
      {notice&&<button type="button" className="icon-button" aria-label="關閉通知" onClick={()=>setNotice(null)}>×</button>}
    </div>}
    <AppDialog open={open} onOpenChange={setOpen} title="影音處理進度" description="可關閉視窗繼續使用其他頁面；完成後會通知。">
      {active.length===0&&recent.length===0&&<p>目前沒有處理工作。</p>}
      {[...active,...recent].map(job=><JobProgress key={job.id} job={job} busy={busy===job.id} onCancel={()=>cancel(job.id)} onOpenItem={()=>setOpen(false)}/>)}
    </AppDialog>
  </>;
}
