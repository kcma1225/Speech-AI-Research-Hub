import Link from "next/link";
import { Shell } from "@/components/shell";
import { ArrowRight } from "@/components/icons";
import { requireUser } from "@/lib/auth";
type Entry=readonly [string,string,string,string];
const entries:Entry[]=[
  ["研究筆記","會議、實驗與草稿的 Markdown 筆記，以標籤分類","/notes",""],
  ["簡報","Quarto reveal.js 研究簡報","/slides",""],
  ["Overleaf","共同編輯的 LaTeX 論文專案","/overleaf",""],
];
const owner:Entry=["Owner 管理","邀請、成員與角色權限","/admin","owner-entry"];
export default async function Home(){
  const user=await requireUser();
  const rows=user.role==="owner"?[...entries,owner]:entries;
  return <Shell>
    <nav className="ledger" aria-label="主要功能">{rows.map(([title,desc,href,cls],i)=><Link className={`ledger-row ${cls}`.trim()} href={href} key={href}><span className="ledger-number">{String(i+1).padStart(2,"0")}</span><span><span className="ledger-title">{title}</span><span className="ledger-desc">{desc}</span></span><ArrowRight size={22}/></Link>)}</nav>
  </Shell>;
}
