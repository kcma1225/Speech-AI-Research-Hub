import Link from "next/link";
import { Shell } from "@/components/shell";
import { TagManager } from "@/components/tag-manager";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { listStoreTags, slideTags } from "@/lib/tag-store";
export default async function SlideTagsPage(){
  const user=await requireUser();const tags=await listStoreTags(await db(),slideTags);
  return <Shell><section className="page-head compact-head"><h1>簡報標籤</h1></section><p>簡報標籤與研究筆記標籤分開管理。</p>{user.role!=="professor"&&<TagManager tags={tags} endpoint="/api/slide-tags" subject="簡報"/>}<p><Link href="/slides">返回簡報</Link></p></Shell>;
}
