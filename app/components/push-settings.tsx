"use client";
import { useCallback, useEffect, useState } from "react";
import { ArrowSquareOut, Bell, BellSlash, Copy } from "./icons";

type Status="loading"|"unsupported"|"install"|"insecure"|"default"|"denied"|"unsubscribed"|"subscribed"|"unconfigured";
type Platform="ios"|"android"|"mac"|"windows"|"other";

function platform():Platform{const ua=navigator.userAgent;if(/iPhone|iPad|iPod/.test(ua)||(/Macintosh/.test(ua)&&navigator.maxTouchPoints>1))return "ios";if(/Android/.test(ua))return "android";if(/Macintosh/.test(ua))return "mac";if(/Windows/.test(ua))return "windows";return "other"}
const standalone=()=>matchMedia("(display-mode: standalone)").matches||(navigator as Navigator&{standalone?:boolean}).standalone===true;
const base64=(value:string)=>{const pad="=".repeat((4-value.length%4)%4);const raw=atob((value+pad).replace(/-/g,"+").replace(/_/g,"/"));return Uint8Array.from(raw,c=>c.charCodeAt(0))};

export async function pushStatus():Promise<Status>{
  if(typeof window==="undefined")return "loading";
  if(!window.isSecureContext)return "insecure";
  if(platform()==="ios"&&!standalone())return "install";
  if(!("serviceWorker" in navigator)||!("PushManager" in window)||!("Notification" in window))return "unsupported";
  if(Notification.permission==="denied")return "denied";
  if(Notification.permission==="default")return "default";
  const reg=await navigator.serviceWorker.getRegistration();const sub=await reg?.pushManager.getSubscription();
  return sub?"subscribed":"unsubscribed";
}

async function subscribe(){
  const key=(await (await fetch("/api/push")).json()).publicKey as string;
  if(!key)throw new Error("unconfigured");
  const reg=await navigator.serviceWorker.register("/sw.js");await navigator.serviceWorker.ready;
  const sub=await reg.pushManager.getSubscription()??await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:base64(key)});
  const r=await fetch("/api/push",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(sub.toJSON())});
  if(!r.ok)throw new Error((await r.json()).error??"subscribe failed");
}

const SETTINGS_PREFIX="chrome://settings/content/siteDetails?site=";
function settingsLink(origin:string){let parsed:URL;try{parsed=new URL(origin)}catch{return null}if(parsed.origin!==location.origin)return null;return SETTINGS_PREFIX+encodeURIComponent(parsed.origin)}
const trusted=(link:string|null)=>link&&link.startsWith(SETTINGS_PREFIX)?link:null;

function steps(p:Platform,origin:string){
  switch(p){
    case "ios":return {link:null,label:"",items:["打開 iPhone「設定」","點「通知」","在 App 清單找到「Speech-AI Hub」","開啟「允許通知」，再回到 App 重新整理"]};
    case "android":return {link:settingsLink(origin),label:"Chrome 網站設定",items:["長按主畫面上的 Speech-AI Hub 圖示，點「應用程式資訊」","點「通知」並開啟「顯示通知」","或在 Chrome 開啟下方網址，把「通知」設為「允許」"]};
    case "mac":return {link:settingsLink(origin),label:"Chrome／Edge 網站設定",items:["點網址列左側的網站資訊圖示，把「通知」改成「允許」","Safari：設定 → 網站 → 通知，把此網站改成「允許」","並確認 macOS「系統設定 → 通知」中瀏覽器已允許通知"]};
    case "windows":return {link:settingsLink(origin),label:"Chrome／Edge 網站設定",items:["點網址列左側的網站資訊圖示，把「通知」改成「允許」","並確認 Windows「設定 → 系統 → 通知」中瀏覽器已允許通知"]};
    default:return {link:null,label:"",items:["在瀏覽器網站設定中，把此網站的「通知」改成「允許」"]};
  }
}

export function PushSettings(){
  const [status,setStatus]=useState<Status>("loading");
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState("");
  const [copied,setCopied]=useState(false);
  const [os,setOs]=useState<Platform>("other");
  const [origin,setOrigin]=useState("");
  const refresh=useCallback(async()=>{setStatus(await pushStatus())},[]);
  useEffect(()=>{setOs(platform());setOrigin(location.origin);void refresh();const onFocus=()=>void refresh();window.addEventListener("focus",onFocus);document.addEventListener("visibilitychange",onFocus);return()=>{window.removeEventListener("focus",onFocus);document.removeEventListener("visibilitychange",onFocus)}},[refresh]);
  async function enable(){
    setBusy(true);setMessage("");
    try{
      const result=status==="default"?await Notification.requestPermission():Notification.permission;
      if(result!=="granted"){await refresh();setBusy(false);return}
      await subscribe();await refresh();setMessage("推播已開啟。");
    }catch(error){setMessage(error instanceof Error&&error.message==="unconfigured"?"伺服器尚未設定推播金鑰（VAPID）。":"無法開啟推播，請稍後再試。");await refresh()}
    setBusy(false);
  }
  async function disable(){setBusy(true);const reg=await navigator.serviceWorker.getRegistration();const sub=await reg?.pushManager.getSubscription();if(sub){await fetch("/api/push",{method:"DELETE",headers:{"content-type":"application/json"},body:JSON.stringify({endpoint:sub.endpoint})});await sub.unsubscribe()}await refresh();setBusy(false);setMessage("已在此裝置關閉推播。")}
  async function test(){setBusy(true);const r=await fetch("/api/push/test",{method:"POST"});setBusy(false);setMessage(r.ok?"已送出測試通知；若手機沒有跳出，請依下方步驟檢查系統設定。":(await r.json()).error??"測試失敗。")}
  if(status==="loading")return null;
  const raw=steps(os,origin);const guide={...raw,link:trusted(raw.link)};const openSettings=()=>{if(!guide.link)return;const settingsUrl=SETTINGS_PREFIX+encodeURIComponent(location.origin);navigator.clipboard?.writeText(settingsUrl).then(()=>setCopied(true)).catch(()=>undefined);window.open(settingsUrl,"_blank","noopener")};
  const title=status==="subscribed"?"推播已開啟":status==="denied"?"通知已被封鎖":status==="install"?"請先加入主畫面":status==="insecure"?"需要 HTTPS 才能推播":status==="unsupported"?"此瀏覽器不支援推播":"尚未開啟推播通知";
  const desc=status==="subscribed"?"影音處理完成會直接跳出在這台裝置。":status==="denied"?"瀏覽器禁止網頁直接開啟系統設定。請依下方步驟手動允許通知。":status==="install"?"iPhone／iPad 只有加入主畫面的 App 能收到推播：點 Safari 分享按鈕 → 加入主畫面，再從主畫面開啟。":status==="insecure"?"推播只在 HTTPS 網址可用（localhost 除外）。請改用正式 HTTPS 網址開啟。":status==="unsupported"?"請改用最新版 Chrome、Edge、Firefox 或 Safari。":"開啟後，影音處理完成通知會直接跳出在手機上。";
  return <section className="push-settings" data-status={status} aria-live="polite">
    <div className="push-head">{status==="subscribed"?<Bell size={22} weight="fill"/>:<BellSlash size={22}/>}<div><h2>{title}</h2><p>{desc}</p></div></div>
    <div className="row push-actions">
      {(status==="default"||status==="unsubscribed")&&<button type="button" className="button primary" disabled={busy} onClick={enable}><Bell size={18}/>{busy?"設定中…":"開啟通知設定"}</button>}
      {status==="denied"&&guide.link&&<button type="button" className="button primary" onClick={openSettings}><ArrowSquareOut size={18}/>開啟{guide.label}</button>}
      {status==="denied"&&guide.link&&<button type="button" className="button" onClick={()=>navigator.clipboard.writeText(guide.link!).then(()=>setCopied(true))}><Copy size={18}/>{copied?"已複製網址":"複製設定網址"}</button>}
      {status==="denied"&&<button type="button" className="button" onClick={()=>void refresh()}>我已開啟，重新檢查</button>}
      {status==="subscribed"&&<><button type="button" className="button" disabled={busy} onClick={test}>傳送測試通知</button><button type="button" className="button" disabled={busy} onClick={disable}>在此裝置關閉</button></>}
    </div>
    {status==="denied"&&<ol className="push-steps">{guide.items.map(item=><li key={item}>{item}</li>)}</ol>}
    {status==="denied"&&guide.link&&<p className="push-note">若按鈕沒有反應，代表瀏覽器不允許網頁開啟設定頁；網址已複製，請貼到瀏覽器網址列。</p>}
    {message&&<p className="push-message" role="status">{message}</p>}
  </section>;
}
