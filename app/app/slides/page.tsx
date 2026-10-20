import { Shell } from "@/components/shell";
import { SlideManager } from "@/components/slide-manager";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { listStoreTags, slideTags } from "@/lib/tag-store";
export default async function SlidesPage(){
  const user=await requireUser();const pool=await db();
  const [projects,tags]=await Promise.all([
    pool.query("SELECT p.id,p.title,p.slug,p.public_view,p.updated_at,v.version,v.status,COALESCE((SELECT json_agg(json_build_object('id',t.id,'name',t.name)) FROM slide_project_tags j JOIN slide_tags t ON t.id=j.tag_id WHERE j.project_id=p.id),'[]') AS tags FROM slide_projects p LEFT JOIN LATERAL (SELECT version,status FROM slide_versions WHERE project_id=p.id ORDER BY version DESC LIMIT 1) v ON true ORDER BY p.updated_at DESC"),
    listStoreTags(pool,slideTags),
  ]);
  return <Shell><section className="page-head compact-head"><h1>簡報</h1></section><SlideManager projects={projects.rows} tags={tags} canEdit={user.role!=="professor"}/></Shell>;
}
