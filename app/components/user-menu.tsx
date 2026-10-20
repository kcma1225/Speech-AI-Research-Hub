"use client";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import type { CurrentUser } from "@/lib/auth";
import { AppDialog } from "./dialog";
import { ThemeControl } from "./theme-control";
import { BottomNav } from "./bottom-nav";
import { UserCircle } from "./icons";
import { PushSettings } from "./push-settings";

export function UserMenu({user}:{user:CurrentUser}) {
  const router=useRouter();
  const [open,setOpen]=useState(false);
  const [profile,setProfile]=useState(false);
  const [name,setName]=useState(user.name);
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  async function updateProfile(event:FormEvent<HTMLFormElement>){
    event.preventDefault();setBusy(true);setError("");
    const form=event.currentTarget;
    const data=new FormData(form);
    const response=await fetch("/api/auth/profile",{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({name:data.get("name"),currentPassword:data.get("currentPassword"),newPassword:data.get("newPassword")||undefined})}).catch(()=>null);
    setBusy(false);
    if(!response?.ok){setError(response?((await response.json()).error??"更新失敗。"):"網路中斷，請重試。");return}
    const result=await response.json();setName(result.name);localStorage.setItem("account_hint",JSON.stringify({id:user.id,name:result.name}));form.reset();setProfile(false);router.refresh();
  }
  return <> 
    <button className="identity" onClick={()=>setOpen(true)} aria-label={`個人設定，目前登入 ${name}`}><UserCircle size={22}/><span className="identity-copy"><span className="identity-role">{user.role.toUpperCase()}</span><strong>{name}</strong></span></button>
    <BottomNav/>
    <AppDialog open={open} onOpenChange={setOpen} className="settings-dialog" title="設定" description="帳號與介面偏好。">
      <div className="settings-list">
        <section className="settings-section"><div><h3>帳號</h3><p>{name} <span className="status">／ {user.role.toUpperCase()}</span></p></div><button type="button" className="button" onClick={()=>{setOpen(false);setProfile(true);setError("")}}>更改</button></section>
        <section className="settings-section"><div><h3>外觀</h3><p>選擇閱讀介面配色</p></div><ThemeControl/></section>
        <div className="settings-push"><PushSettings/></div>
        <section className="settings-section"><div><h3>登入安全</h3><p>{user.auth_mode==="two_factor"?"密碼 + Passkey 2FA":"密碼登入（Passkey 尚未開放）"}</p></div><span className="status">目前模式</span></section>
        <section className="settings-section"><div><h3>Passkey</h3><p>此功能尚未開放</p></div><button className="button" disabled>新增</button></section>
        <section className="settings-section settings-exit"><div><h3>工作階段</h3><p>結束目前裝置的登入</p></div><form action="/api/auth/logout" method="post"><button className="button logout-button" type="submit">登出</button></form></section>
      </div>
    </AppDialog>
    <AppDialog open={profile} onOpenChange={setProfile} title="更改帳號" description="更改名稱或密碼。請輸入目前密碼驗證身分。">
      <form onSubmit={updateProfile}>
        <div className="field"><label htmlFor="profile-name">名稱</label><input id="profile-name" name="name" defaultValue={name} required maxLength={80}/></div>
        <div className="field"><label htmlFor="profile-current">目前密碼</label><input id="profile-current" name="currentPassword" type="password" autoComplete="current-password" required/></div>
        <div className="field"><label htmlFor="profile-new">新密碼（不更改可留空）</label><input id="profile-new" name="newPassword" type="password" autoComplete="new-password" pattern=".*\S.*" title="密碼不可只有空白"/></div>
        {user.role==="owner"&&<p className="status">Owner 密碼可在此更改；若日後更改 `.env` 的 OWNER_PASSWORD，App 啟動時會以新設定重設密碼。</p>}
        {error&&<p role="alert" className="form-error">{error}</p>}
        <div className="dialog-actions"><button type="button" className="button" onClick={()=>setProfile(false)}>取消</button><button className="button primary" disabled={busy}>{busy?"儲存中…":"儲存變更"}</button></div>
      </form>
    </AppDialog>
  </>;
}
