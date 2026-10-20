"use client";
export function SlideFrame({src,title}:{src:string;title:string}){
  return <iframe src={src} title={title} allow="fullscreen" allowFullScreen onLoad={e=>e.currentTarget.contentWindow?.focus()}/>;
}
