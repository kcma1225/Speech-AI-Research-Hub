import { Shell } from "@/components/shell";
import { AdminPanel } from "@/components/admin-panel";
import { requireUser } from "@/lib/auth";
import { Forbidden } from "@/components/forbidden";
import { db } from "@/lib/db";

export default async function InvitationsPage() {
  const actor = await requireUser();
  if(actor.role!=="owner")return <Shell><Forbidden/></Shell>;
  const result = await (await db()).query("SELECT id,role,expires_at,max_uses,use_count,used_at,revoked_at,created_at FROM invitations ORDER BY created_at DESC LIMIT 100");
  const invitations = result.rows.map(row=>({
    ...row,
    expires_at:row.expires_at?new Date(row.expires_at).toISOString():null,
    used_at:row.used_at?new Date(row.used_at).toISOString():null,
    revoked_at:row.revoked_at?new Date(row.revoked_at).toISOString():null,
    created_at:new Date(row.created_at).toISOString(),
  }));
  return <Shell><section className="page-head"><h1>建立邀請</h1><p>連結僅顯示一次。可選權限、期限與使用次數；請妥善保管永久連結。</p></section><AdminPanel actor={actor} initialUsers={[]} invitations={invitations} mode="invitations"/></Shell>;
}
