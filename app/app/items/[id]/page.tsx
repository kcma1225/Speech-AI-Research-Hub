import { notFound } from "next/navigation";
import { Shell } from "@/components/shell";
import { DocumentWorkspace } from "@/components/document-workspace";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatDate, formatDateTime } from "@/lib/format";
import { itemTags, listTags } from "@/lib/tags";

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ItemPage({params}:{params:Promise<{id:string}>}){
  const user=await requireUser();
  const {id}=await params;
  if(!uuid.test(id))notFound();
  const pool=await db();
  const result=await pool.query("SELECT id,title,content,event_date,file_name,storage_name,transcript,transcript_name,updated_at FROM items WHERE id=$1",[id]);
  const item=result.rows[0];
  if(!item)notFound();
  const [tags,allTags]=await Promise.all([itemTags(pool,id),listTags(pool)]);
  return <Shell layout="document">
    <section className="page-head document-head"><div><span className="status">研究筆記</span><h1>{item.title}</h1><ul className="note-tags document-tags" aria-label="標籤">{tags.length?tags.map(tag=><li className="tag-chip" key={tag.id}>{tag.name}</li>):<li className="tag-chip is-empty">無標籤</li>}</ul></div><p>日期：{formatDate(item.event_date)}<br/>最後修改：{formatDateTime(item.updated_at)}</p></section>
    <DocumentWorkspace item={{...item,event_date:new Date(item.event_date).toISOString().slice(0,10),updated_at:new Date(item.updated_at).toISOString()}} tags={tags} allTags={allTags.map(({id,name})=>({id,name}))} readOnly={user.role==="professor"}/>
  </Shell>;
}
