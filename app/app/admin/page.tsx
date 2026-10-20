import Link from "next/link";
import { Shell } from "@/components/shell";
import { requireUser } from "@/lib/auth";
import { Forbidden } from "@/components/forbidden";

const destinations = [
  ["01", "建立邀請", "指定角色、期限與使用次數，管理邀請連結", "/admin/invitations"],
  ["02", "角色管理", "查看成員並調整 Admin／Member／Professor 權限", "/admin/roles"],
] as const;

export default async function AdminPage() {
  const user=await requireUser();
  if(user.role!=="owner")return <Shell><Forbidden/></Shell>;
  return <Shell><section className="page-head owner-page"><h1>Owner 管理</h1><p>僅 Owner 可存取。管理成員權限與加入研究空間的邀請。</p></section><nav className="ledger" aria-label="Owner 管理功能">{destinations.map(([number,title,description,href])=><Link className="ledger-row" key={href} href={href}><span className="ledger-number">{number}</span><span><span className="ledger-title">{title}</span><span className="ledger-desc">{description}</span></span><span aria-hidden="true">↗</span></Link>)}</nav></Shell>;
}
