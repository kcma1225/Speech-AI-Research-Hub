"use client";
import * as Dialog from "@radix-ui/react-dialog";
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent } from "react";
import { ArrowCounterClockwise, Crosshair, MagnifyingGlass, MagnifyingGlassMinus, MagnifyingGlassPlus, X } from "./icons";

const MIN=1, MAX=6, STEP=0.5, LOUPE=200, LOUPE_ZOOM=2.5, TRAIL_MS=450;
const clamp=(value:number)=>Math.min(MAX,Math.max(MIN,Math.round(value*100)/100));

type Tool="pan"|"lens"|"laser";
type Loupe={x:number;y:number;width:number;height:number;left:number;top:number};
type Point={x:number;y:number;t:number};

export function MarkdownImage({src,alt}:{src?:string;alt?:string}){
  const [open,setOpen]=useState(false);
  if(!src)return null;
  const label=alt?`放大圖片：${alt}`:"放大圖片";
  return <>
    <button type="button" className="md-image" onClick={()=>setOpen(true)} aria-label={label} title="點擊放大">
      <img src={src} alt={alt??""} loading="lazy" decoding="async"/>
    </button>
    <ImageLightbox src={src} alt={alt??""} open={open} onOpenChange={setOpen}/>
  </>;
}

function useLaser(active:boolean,stage:React.RefObject<HTMLDivElement|null>,canvas:React.RefObject<HTMLCanvasElement|null>){
  const points=useRef<Point[]>([]);
  const frame=useRef(0);
  const draw=useCallback(()=>{
    frame.current=0;
    const c=canvas.current;if(!c)return;
    const ctx=c.getContext("2d");if(!ctx)return;
    const now=performance.now();
    points.current=points.current.filter(p=>now-p.t<TRAIL_MS);
    ctx.clearRect(0,0,c.width,c.height);
    const dpr=window.devicePixelRatio||1;
    const list=points.current;
    ctx.lineCap="round";ctx.lineJoin="round";
    for(let i=1;i<list.length;i++){
      const a=list[i-1], b=list[i];
      const life=1-(now-b.t)/TRAIL_MS;
      ctx.strokeStyle=`rgba(255,40,40,${(life*0.85).toFixed(3)})`;
      ctx.lineWidth=(2+life*5)*dpr;
      ctx.shadowColor="rgba(255,30,30,.9)";ctx.shadowBlur=10*dpr*life;
      ctx.beginPath();ctx.moveTo(a.x*dpr,a.y*dpr);ctx.lineTo(b.x*dpr,b.y*dpr);ctx.stroke();
    }
    if(list.length)frame.current=requestAnimationFrame(draw);
  },[canvas]);
  const resize=useCallback(()=>{
    const c=canvas.current, s=stage.current;if(!c||!s)return;
    const dpr=window.devicePixelRatio||1, r=s.getBoundingClientRect();
    c.width=Math.round(r.width*dpr);c.height=Math.round(r.height*dpr);
  },[canvas,stage]);
  useEffect(()=>{
    if(!active){points.current=[];cancelAnimationFrame(frame.current);frame.current=0;canvas.current?.getContext("2d")?.clearRect(0,0,canvas.current.width,canvas.current.height);return}
    resize();window.addEventListener("resize",resize);
    return()=>{window.removeEventListener("resize",resize);cancelAnimationFrame(frame.current);frame.current=0};
  },[active,resize,canvas]);
  const add=useCallback((x:number,y:number)=>{
    if(matchMedia("(prefers-reduced-motion: reduce)").matches)return;
    points.current.push({x,y,t:performance.now()});
    cancelAnimationFrame(frame.current);draw();
  },[draw]);
  return add;
}

function ImageLightbox({src,alt,open,onOpenChange}:{src:string;alt:string;open:boolean;onOpenChange:(value:boolean)=>void}){
  const [zoom,setZoom]=useState(1);
  const [pan,setPan]=useState({x:0,y:0});
  const [tool,setTool]=useState<Tool>("pan");
  const [loupe,setLoupe]=useState<Loupe|null>(null);
  const [dot,setDot]=useState<{x:number;y:number;down:boolean}|null>(null);
  const drag=useRef<{id:number;x:number;y:number;px:number;py:number}|null>(null);
  const dragged=useRef(false);
  const image=useRef<HTMLImageElement>(null);
  const stage=useRef<HTMLDivElement>(null);
  const canvas=useRef<HTMLCanvasElement>(null);
  const addTrail=useLaser(open&&tool==="laser",stage,canvas);
  const reset=useCallback(()=>{setZoom(1);setPan({x:0,y:0})},[]);
  const zoomBy=useCallback((change:(z:number)=>number)=>{setZoom(z=>clamp(change(z)))},[]);
  const zoomTo=useCallback((next:number)=>zoomBy(()=>next),[zoomBy]);
  const toggle=useCallback((next:Tool)=>{setTool(t=>t===next?"pan":next);setLoupe(null);setDot(null)},[]);
  useEffect(()=>{if(!open){reset();setTool("pan");setLoupe(null);setDot(null)}},[open,reset]);
  useEffect(()=>{
    if(!open)return;
    const key=(e:KeyboardEvent)=>{
      if(e.target instanceof HTMLButtonElement&&(e.key===" "||e.key==="Enter"))return;
      if(e.key==="+"||e.key==="="){e.preventDefault();zoomBy(z=>z+STEP)}
      else if(e.key==="-"||e.key==="_"){e.preventDefault();zoomBy(z=>z-STEP)}
      else if(e.key==="0"){e.preventDefault();reset()}
      else if(e.key==="m"||e.key==="M"){e.preventDefault();toggle("lens")}
      else if(e.key==="l"||e.key==="L"){e.preventDefault();toggle("laser")}
    };
    window.addEventListener("keydown",key);return()=>window.removeEventListener("keydown",key);
  },[open,reset,zoomBy,toggle]);

  function local(clientX:number,clientY:number){const s=stage.current?.getBoundingClientRect();return s?{x:clientX-s.left,y:clientY-s.top}:null}
  function updateLoupe(clientX:number,clientY:number){
    const img=image.current, p=local(clientX,clientY);if(!img||!p)return;
    const r=img.getBoundingClientRect();
    const x=clientX-r.left, y=clientY-r.top;
    if(x<0||y<0||x>r.width||y>r.height){setLoupe(null);return}
    setLoupe({x:p.x,y:p.y,width:r.width*LOUPE_ZOOM,height:r.height*LOUPE_ZOOM,left:LOUPE/2-x*LOUPE_ZOOM,top:LOUPE/2-y*LOUPE_ZOOM});
  }
  function pointLaser(e:ReactPointerEvent<HTMLDivElement>,down:boolean){
    const p=local(e.clientX,e.clientY);if(!p)return;
    setDot({...p,down});addTrail(p.x,p.y);
  }
  function down(e:ReactPointerEvent<HTMLDivElement>){
    if(tool==="laser"){e.currentTarget.setPointerCapture(e.pointerId);pointLaser(e,true);return}
    if(tool==="lens"){updateLoupe(e.clientX,e.clientY);return}
    if(e.button!==0)return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragged.current=false;
    drag.current={id:e.pointerId,x:e.clientX,y:e.clientY,px:pan.x,py:pan.y};
  }
  function move(e:ReactPointerEvent<HTMLDivElement>){
    if(tool==="laser"){if(e.pointerType==="mouse"||e.buttons)pointLaser(e,e.buttons>0);return}
    if(tool==="lens"){updateLoupe(e.clientX,e.clientY);return}
    const d=drag.current;if(!d||d.id!==e.pointerId)return;
    if(Math.abs(e.clientX-d.x)+Math.abs(e.clientY-d.y)>4)dragged.current=true;
    setPan({x:d.px+(e.clientX-d.x)/zoom,y:d.py+(e.clientY-d.y)/zoom});
  }
  function up(e:ReactPointerEvent<HTMLDivElement>){
    if(drag.current?.id===e.pointerId)drag.current=null;
    if(e.pointerType!=="mouse"){setLoupe(null);setDot(null)}
    else if(tool==="laser")setDot(d=>d&&{...d,down:false});
  }
  function leave(){setLoupe(null);setDot(null)}
  function wheel(e:WheelEvent<HTMLDivElement>){if(tool==="lens")return;zoomBy(z=>z*(e.deltaY<0?1.15:1/1.15))}

  const mode=tool==="lens"?" is-lens":tool==="laser"?" is-laser":" is-pan";
  const pristine=zoom===1&&pan.x===0&&pan.y===0;
  const hint=tool==="lens"?"移動游標或手指查看細節 · M 關閉放大鏡":tool==="laser"?"移動游標或手指指示重點 · 按住可加強光點 · L 關閉雷射筆":"滾輪或 +／- 縮放 · 拖曳移動 · 雙擊切換 200%";
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay lightbox-overlay"/>
      <Dialog.Content className="lightbox" aria-describedby={undefined}>
        <Dialog.Title className="sr-only">{alt||"圖片預覽"}</Dialog.Title>
        <div className="lightbox-toolbar" role="toolbar" aria-label="圖片檢視工具">
          <button type="button" className="icon-button" onClick={()=>zoomBy(z=>z-STEP)} disabled={zoom<=MIN} aria-label="縮小（-）" title="縮小（-）"><MagnifyingGlassMinus size={20}/></button>
          <output className="lightbox-zoom" aria-live="polite">{Math.round(zoom*100)}%</output>
          <button type="button" className="icon-button" onClick={()=>zoomBy(z=>z+STEP)} disabled={zoom>=MAX} aria-label="放大（+）" title="放大（+）"><MagnifyingGlassPlus size={20}/></button>
          <button type="button" className="icon-button" onClick={reset} disabled={pristine} aria-label="重設大小（0）" title="重設大小（0）"><ArrowCounterClockwise size={20}/></button>
          <span className="lightbox-sep" aria-hidden="true"/>
          <button type="button" className="icon-button" aria-pressed={tool==="lens"} onClick={()=>toggle("lens")} aria-label="放大鏡（M）" title="放大鏡（M）"><MagnifyingGlass size={20}/></button>
          <button type="button" className="icon-button laser-toggle" aria-pressed={tool==="laser"} onClick={()=>toggle("laser")} aria-label="雷射筆（L）" title="雷射筆（L）"><Crosshair size={20}/></button>
          <Dialog.Close className="icon-button" aria-label="關閉（Esc）" title="關閉（Esc）"><X size={20}/></Dialog.Close>
        </div>
        <div ref={stage} className={`lightbox-stage${mode}`} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={leave} onWheel={wheel} onDoubleClick={()=>{if(tool==="pan"){if(zoom>1)reset();else zoomTo(2)}}}
          onClick={e=>{if(dragged.current){dragged.current=false;return}if(e.target===e.currentTarget&&pristine&&tool==="pan")onOpenChange(false)}}>
          <img ref={image} src={src} alt={alt} draggable={false} style={{transform:`scale(${zoom}) translate(${pan.x}px,${pan.y}px)`}}/>
          {tool==="lens"&&loupe&&<div className="lightbox-loupe" aria-hidden="true" style={{left:loupe.x-LOUPE/2,top:loupe.y-LOUPE/2,width:LOUPE,height:LOUPE}}>
            <img src={src} alt="" draggable={false} style={{width:loupe.width,height:loupe.height,left:loupe.left,top:loupe.top}}/>
          </div>}
          {tool==="laser"&&<canvas ref={canvas} className="laser-trail" aria-hidden="true"/>}
          {tool==="laser"&&dot&&<span className={`laser-dot${dot.down?" is-down":""}`} aria-hidden="true" style={{left:dot.x,top:dot.y}}/>}
        </div>
        <p className="lightbox-hint">{hint}</p>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
