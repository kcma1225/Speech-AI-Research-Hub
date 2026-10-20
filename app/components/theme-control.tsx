"use client";
import { Monitor, Moon, Sun } from "./icons";
const modes = [{id:"light",label:"亮色",Icon:Sun},{id:"dark",label:"暗色",Icon:Moon},{id:"system",label:"跟隨系統",Icon:Monitor}] as const;
export function ThemeControl(){function setTheme(mode:string){localStorage.setItem("theme",mode);const dark=mode==="dark"||(mode==="system"&&matchMedia("(prefers-color-scheme:dark)").matches);document.documentElement.dataset.theme=dark?"dark":"light";document.documentElement.dataset.themePreference=mode}return <div className="row" role="group" aria-label="外觀主題">{modes.map(({id,label,Icon})=><button type="button" className="icon-button" key={id} title={label} aria-label={label} onClick={()=>setTheme(id)}><Icon size={20}/></button>)}</div>}
