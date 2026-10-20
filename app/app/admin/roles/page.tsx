import { Shell } from "@/components/shell";
import { AdminPanel } from "@/components/admin-panel";
import { requireUser } from "@/lib/auth";
import { Forbidden } from "@/components/forbidden";
import { db } from "@/lib/db";

export default async function RolesPage() {
  const actor = await requireUser();
  if(actor.role!=="owner")return <Shell><Forbidden/></Shell>;
  const result = await (await db()).query("SELECT id,name,role,disabled_at FROM users ORDER BY role='owner' DESC,name");
  return <Shell><section className="page-head"><h1>角色管理</h1><p>Owner 帳號受保護；僅能調整其他成員的 Admin／Member／Professor 權限。</p></section><AdminPanel actor={actor} initialUsers={result.rows} invitations={[]} mode="roles"/></Shell>;
}
