"use client";
import { useEffect, useState } from "react";
export function useUnreadCount(){
  const [count,setCount]=useState(0);
  useEffect(()=>{
    let alive=true;
    const load=async()=>{if(document.visibilityState!=="visible")return;const r=await fetch("/api/notifications/unread",{cache:"no-store"}).catch(()=>null);if(alive&&r?.ok)setCount((await r.json()).count)};
    void load();const t=setInterval(load,20000);
    window.addEventListener("notifications-changed",load);document.addEventListener("visibilitychange",load);
    const onMessage=()=>void load();navigator.serviceWorker?.addEventListener("message",onMessage);
    return()=>{alive=false;clearInterval(t);window.removeEventListener("notifications-changed",load);document.removeEventListener("visibilitychange",load);navigator.serviceWorker?.removeEventListener("message",onMessage)};
  },[]);
  useEffect(()=>{const nav=navigator as Navigator&{setAppBadge?:(n:number)=>Promise<void>;clearAppBadge?:()=>Promise<void>};if(count)nav.setAppBadge?.(count).catch(()=>undefined);else nav.clearAppBadge?.().catch(()=>undefined)},[count]);
  return count;
}
