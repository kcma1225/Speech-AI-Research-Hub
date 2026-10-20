import { db } from "./db";
export async function slideDetail(id:string){
  const pool=await db();
  const [versions,references,reviews,replies,tags]=await Promise.all([
    pool.query("SELECT id,version,status,error,source_name,created_at,entry_html FROM slide_versions WHERE project_id=$1 ORDER BY version DESC",[id]),
    pool.query("SELECT id,title,url,file_name,is_default FROM slide_references WHERE project_id=$1 ORDER BY is_default DESC,created_at,id",[id]),
    pool.query("SELECT r.id,r.body,r.created_at,u.name AS author FROM slide_reviews r JOIN users u ON u.id=r.author_id WHERE r.project_id=$1 ORDER BY r.created_at,r.id",[id]),
    pool.query("SELECT p.id,p.review_id,p.body,p.created_at,u.name AS author FROM slide_review_replies p JOIN slide_reviews r ON r.id=p.review_id JOIN users u ON u.id=p.author_id WHERE r.project_id=$1 ORDER BY p.created_at,p.id",[id]),
    pool.query("SELECT t.id,t.name FROM slide_project_tags j JOIN slide_tags t ON t.id=j.tag_id WHERE j.project_id=$1 ORDER BY lower(t.name)",[id]),
  ]);
  return {versions:versions.rows,references:references.rows,reviews:reviews.rows.map(review=>({...review,replies:replies.rows.filter(reply=>reply.review_id===review.id)})),tags:tags.rows};
}
