"use client";
import type { Tag } from "@/lib/tag-types";

/** Checkbox group for assigning tags. Empty selection means "no tag". */
export function TagPicker({tags,value,onChange,legend="標籤"}:{tags:Tag[];value:string[];onChange:(next:string[])=>void;legend?:string}){
  const toggle=(id:string,checked:boolean)=>onChange(checked?[...value,id]:value.filter(item=>item!==id));
  return <fieldset className="tag-picker">
    <legend>{legend}</legend>
    {tags.length?<div className="tag-options">{tags.map(tag=><label key={tag.id} className="tag-option"><input type="checkbox" checked={value.includes(tag.id)} onChange={e=>toggle(tag.id,e.target.checked)}/><span>{tag.name}</span></label>)}</div>:<p className="field-hint">尚無標籤。可在「管理標籤」新增。</p>}
    <p className="field-hint">{value.length?`已選 ${value.length} 個`:"未選擇：此筆記為無標籤"}</p>
  </fieldset>;
}
