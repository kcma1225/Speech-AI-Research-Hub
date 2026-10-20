"use client";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { AppDialog } from "./dialog";
import { Plus } from "./icons";
import { TagPicker } from "./tag-picker";
import type { Tag } from "@/lib/tag-types";

export function AddItemDialog({tags}:{tags:Tag[]}){
  const [open,setOpen]=useState(false);
  const [title,setTitle]=useState("");
  const [tagIds,setTagIds]=useState<string[]>([]);
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  const router=useRouter();
  function change(value:boolean){setOpen(value);if(value){setTitle("");setTagIds([]);setError("")}}
  async function submit(e:FormEvent<HTMLFormElement>){
    e.preventDefault();setBusy(true);setError("");
    const response=await fetch("/api/items",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({title,tagIds})}).catch(()=>null);
    const data=response?await response.json().catch(()=>({})):{error:"網路中斷，請重試。"};
    if(!response?.ok){setError(data.error??"無法建立筆記。");setBusy(false);return}
    setBusy(false);setOpen(false);router.push(`/items/${data.id}`);
  }
  return <><AppDialog trigger={<button className="fab" aria-label="新增筆記"><Plus size={26}/></button>} open={open} onOpenChange={change} title="新增筆記" description="建立 Markdown 筆記。標籤可留空，之後再補。"><form onSubmit={submit}><div className="field"><label htmlFor="title">名稱</label><input id="title" name="title" value={title} onChange={e=>setTitle(e.target.value)} required maxLength={160}/></div><TagPicker tags={tags} value={tagIds} onChange={setTagIds}/>{error&&<p className="form-error" role="alert">{error}</p>}<div className="dialog-actions"><button type="button" className="button" onClick={()=>setOpen(false)}>取消</button><button className="button primary" disabled={busy}>{busy?"建立中…":"建立筆記"}</button></div></form></AppDialog></>;
}
