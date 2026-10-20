"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import { MarkdownImage } from "./image-lightbox";

type Heading={id:string;text:string;level:number};

function themeIsDark(){return document.documentElement.dataset.theme==="dark"||(document.documentElement.dataset.theme!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches)}

function Diagram({kind,code}:{kind:"mermaid"|"flow";code:string}){
  const ref=useRef<HTMLDivElement>(null);
  const id=useId().replace(/[^a-zA-Z0-9]/g,"");
  const [error,setError]=useState("");
  useEffect(()=>{
    let cancelled=false;
    const target=ref.current;if(!target)return;
    const timer=setTimeout(async()=>{
      try{
        if(kind==="mermaid"){
          const mermaid=(await import("mermaid")).default;
          mermaid.initialize({startOnLoad:false,securityLevel:"strict",theme:themeIsDark()?"dark":"default",fontFamily:"Noto Sans TC, sans-serif",htmlLabels:false,flowchart:{htmlLabels:false}});
          const {svg}=await mermaid.render(`mermaid-${id}-${Date.now()}`,code);
          if(!cancelled){const DOMPurify=(await import("dompurify")).default;const clean=DOMPurify.sanitize(svg,{USE_PROFILES:{svg:true,svgFilters:true},ADD_TAGS:["foreignObject"],RETURN_DOM_FRAGMENT:true});target.replaceChildren(clean);setError("")}
        }else{
          const flowchart=(await import("flowchart.js")).default;
          const dark=themeIsDark();
          target.replaceChildren();
          flowchart.parse(code).drawSVG(target,{"line-color":dark?"#c8d3df":"#33404d","element-color":dark?"#c8d3df":"#33404d","font-color":dark?"#e8eef4":"#16202a",fill:dark?"#232b33":"#ffffff","font-family":"Noto Sans TC, sans-serif","yes-text":"是","no-text":"否"});
          if(!cancelled)setError("");
        }
      }catch(reason){if(!cancelled){target.replaceChildren();setError(reason instanceof Error?reason.message:"圖表語法錯誤")}}
    },250);
    return()=>{cancelled=true;clearTimeout(timer)};
  },[kind,code,id]);
  return <figure className="diagram" aria-label={kind==="mermaid"?"Mermaid 圖表":"流程圖"}><div ref={ref}/>{error&&<figcaption className="form-error">圖表無法渲染：{error}<pre><code>{code}</code></pre></figcaption>}</figure>;
}

const components:Components={
  img({src,alt}){return <MarkdownImage src={typeof src==="string"?src:undefined} alt={alt}/>},
  pre({children,node,...props}){
    const child=node?.children[0];
    if(child&&child.type==="element"&&child.tagName==="code"){
      const cls=String((child.properties?.className as string[]|undefined)?.join(" ")??"");
      const text=child.children.map(part=>part.type==="text"?part.value:"").join("").replace(/\n$/,"");
      if(/language-mermaid/.test(cls))return <Diagram kind="mermaid" code={text}/>;
      if(/language-(flow|flowchart)\b/.test(cls))return <Diagram kind="flow" code={text}/>;
    }
    return <pre {...props}>{children}</pre>;
  },
};

export function MarkdownView({content,className="markdown-body"}:{content:string;className?:string}){
  return <div className={className}><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSlug]} components={components}>{content}</ReactMarkdown></div>;
}

export function ReadingView({content}:{content:string}){
  const body=useRef<HTMLDivElement>(null);
  const [headings,setHeadings]=useState<Heading[]>([]);
  const [active,setActive]=useState("");
  useEffect(()=>{
    const root=body.current;if(!root)return;
    const nodes=[...root.querySelectorAll<HTMLElement>("h1[id],h2[id],h3[id],h4[id]")];
    setHeadings(nodes.map(node=>({id:node.id,text:node.textContent??"",level:Number(node.tagName[1])})));
    const update=()=>{const offset=120;let current=nodes[0]?.id??"";for(const node of nodes){if(node.getBoundingClientRect().top-offset<=0)current=node.id;else break}if(nodes.length&&innerHeight+scrollY>=document.documentElement.scrollHeight-2)current=nodes[nodes.length-1].id;setActive(current)};
    update();window.addEventListener("scroll",update,{passive:true});return()=>window.removeEventListener("scroll",update);
  },[content]);
  const minLevel=Math.min(...headings.map(h=>h.level),6);
  const toc:ReactNode=headings.length>1&&<nav className="toc" aria-label="標題導覽"><p className="status">ON THIS PAGE</p><ol>{headings.map(h=><li key={h.id} style={{paddingLeft:`${(h.level-minLevel)*14}px`}}><a href={`#${h.id}`} aria-current={active===h.id?"location":undefined} onClick={e=>{e.preventDefault();document.getElementById(h.id)?.scrollIntoView({behavior:matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth"});history.replaceState(null,"",`#${h.id}`)}}>{h.text}</a></li>)}</ol></nav>;
  return <div className={headings.length>1?"reading-layout has-toc":"reading-layout"}><div ref={body} className="document-reading"><MarkdownView content={content}/></div>{toc}</div>;
}
