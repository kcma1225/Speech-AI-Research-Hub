"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowClockwise, ArrowCounterClockwise, Pause, Play, SpeakerHigh, SpeakerSlash, Subtitles } from "./icons";
import type { Cue } from "@/lib/srt";

const rates=[0.75,1,1.25,1.5,2];
const format=(value:number)=>{if(!Number.isFinite(value))return "--:--";const s=Math.floor(value%60),m=Math.floor(value/60)%60,h=Math.floor(value/3600);return `${h?`${h}:${String(m).padStart(2,"0")}`:m}:${String(s).padStart(2,"0")}`};

function findCue(cues:Cue[],t:number){let lo=0,hi=cues.length-1,found=-1;while(lo<=hi){const mid=(lo+hi)>>1;if(cues[mid].start<=t){found=mid;lo=mid+1}else hi=mid-1}return found}

export function AudioPlayer({src,name,cues}:{src:string;name:string;cues?:Cue[]|null}){
  const audio=useRef<HTMLAudioElement>(null);
  const [playing,setPlaying]=useState(false);
  const [time,setTime]=useState(0);
  const [duration,setDuration]=useState(NaN);
  const [rate,setRate]=useState(1);
  const [muted,setMuted]=useState(false);
  const [error,setError]=useState(false);
  const [open,setOpen]=useState(false);
  const list=useRef<HTMLOListElement>(null);
  const userScroll=useRef(0);
  const hasCues=Boolean(cues?.length);
  const active=useMemo(()=>hasCues?findCue(cues!,time):-1,[cues,hasCues,time]);
  useEffect(()=>{if(!open||active<0||Date.now()-userScroll.current<4000)return;const box=list.current;const row=box?.querySelector<HTMLElement>(`[data-cue="${active}"]`);if(!box||!row)return;const target=row.offsetTop-box.clientHeight/2+row.clientHeight/2;box.scrollTo({top:target,behavior:matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth"})},[active,open]);
  const seek=(t:number)=>{const el=audio.current;if(!el)return;el.currentTime=t;setTime(t);userScroll.current=0;if(el.paused)el.play().catch(()=>setError(true))};
  useEffect(()=>{const el=audio.current;if(el)el.playbackRate=rate},[rate]);
  const toggle=()=>{const el=audio.current;if(!el)return;if(el.paused)el.play().catch(()=>setError(true));else el.pause()};
  const skip=(delta:number)=>{const el=audio.current;if(el)el.currentTime=Math.min(Math.max(0,el.currentTime+delta),el.duration||0)};
  const progress=duration?Math.min(100,time/duration*100):0;
  return <section className="player" aria-label={`音訊播放器：${name}`}>
    <audio ref={audio} src={src} preload="metadata" onPlay={()=>setPlaying(true)} onPause={()=>setPlaying(false)} onEnded={()=>setPlaying(false)} onTimeUpdate={e=>setTime(e.currentTarget.currentTime)} onLoadedMetadata={e=>setDuration(e.currentTarget.duration)} onDurationChange={e=>setDuration(e.currentTarget.duration)} onError={()=>setError(true)}/>
    <button type="button" className="player-play" onClick={toggle} aria-label={playing?"暫停":"播放"} disabled={error}>{playing?<Pause size={22} weight="fill"/>:<Play size={22} weight="fill"/>}</button>
    <div className="player-main">
      <div className="player-meta"><span className="player-name" title={name}>{name}</span><span className="player-time">{format(time)} / {format(duration)}</span></div>
      <input className="player-seek" type="range" min={0} max={Number.isFinite(duration)?duration:0} step={0.1} value={time} onChange={e=>{const el=audio.current;if(el)el.currentTime=Number(e.target.value)}} aria-label="播放進度" aria-valuetext={`${format(time)} / ${format(duration)}`} style={{"--progress":`${progress}%`} as React.CSSProperties} disabled={error||!Number.isFinite(duration)}/>
      {error&&<p className="form-error" role="alert">音訊無法載入，請重新整理或重新上傳。</p>}
    </div>
    <div className="player-tools">
      <button type="button" className="player-icon" onClick={()=>skip(-10)} aria-label="倒退 10 秒" title="倒退 10 秒"><ArrowCounterClockwise size={20}/></button>
      <button type="button" className="player-icon" onClick={()=>skip(10)} aria-label="快轉 10 秒" title="快轉 10 秒"><ArrowClockwise size={20}/></button>
      {hasCues&&<button type="button" className="player-icon" onClick={()=>setOpen(v=>!v)} aria-expanded={open} aria-controls="player-transcript" aria-label={open?"收合逐字稿":"展開逐字稿"} title="逐字稿"><Subtitles size={20} weight={open?"fill":"regular"}/></button>}
      <button type="button" className="player-rate" onClick={()=>setRate(rates[(rates.indexOf(rate)+1)%rates.length])} aria-label={`播放速度 ${rate} 倍，點擊切換`}>{rate}×</button>
      <button type="button" className="player-icon" onClick={()=>{const el=audio.current;if(el){el.muted=!el.muted;setMuted(el.muted)}}} aria-label={muted?"取消靜音":"靜音"} aria-pressed={muted}>{muted?<SpeakerSlash size={20}/>:<SpeakerHigh size={20}/>}</button>
    </div>
    {hasCues&&open&&<div className="transcript" id="player-transcript">
      <p className="transcript-head"><span>逐字稿</span><span>{cues!.length} 段</span></p>
      <ol ref={list} className="transcript-list" aria-label="逐字稿段落" onWheel={()=>userScroll.current=Date.now()} onTouchMove={()=>userScroll.current=Date.now()}>
        {cues!.map((cue,i)=><li key={i} data-cue={i}><button type="button" className="transcript-cue" aria-current={i===active?"true":undefined} onClick={()=>seek(cue.start)}><time>{format(cue.start)}</time><span>{cue.text}</span></button></li>)}
      </ol>
      <p className="sr-only" aria-live="polite">{active>=0?cues![active].text:""}</p>
    </div>}
  </section>;
}
