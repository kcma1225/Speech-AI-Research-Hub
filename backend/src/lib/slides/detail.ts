import type { CurrentUser } from "../auth.js";
import type { Queryable } from "../../db.js";
import { isEditorRole, slideUrls, viewToken, type SlideProject } from "./access.js";

type VersionRow = {
  id: string;
  version: number;
  status: "queued" | "rendering" | "published" | "failed";
  error: string | null;
  source_name: string;
  entry_qmd: string;
  entry_html: string | null;
  pdf_key: string | null;
  quarto_version: string | null;
  thumbnail_key: string | null;
  created_at: string;
  job_status: string | null;
  job_stage: string | null;
  job_progress: number | null;
};

/** Version status as seen by clients: a queued version whose job is running is `rendering`. */
export const liveStatus = (row: Pick<VersionRow, "status" | "job_status">) =>
  row.status === "queued" && row.job_status === "running" ? "rendering" : row.status;

export const VERSION_SELECT = `SELECT v.id,v.version,v.status,v.error,v.source_name,v.entry_qmd,v.entry_html,v.pdf_key,v.quarto_version,v.thumbnail_key,v.created_at,
  j.status AS job_status,j.stage AS job_stage,j.progress AS job_progress
  FROM slide_versions v LEFT JOIN jobs j ON j.id=v.job_id`;

export async function listVersions(db: Queryable, secret: string, project: SlideProject) {
  const rows = (await db.query<VersionRow>(`${VERSION_SELECT} WHERE v.project_id=$1 ORDER BY v.version DESC`, [project.id])).rows;
  return rows.map(row => {
    const published = row.status === "published" && row.entry_html;
    return {
      id: row.id,
      version: row.version,
      status: liveStatus(row),
      stage: row.job_stage,
      progress: row.status === "published" ? 100 : row.job_progress ?? 0,
      error: row.error,
      source_name: row.source_name,
      entry_qmd: row.entry_qmd,
      quarto_version: row.quarto_version,
      created_at: row.created_at,
      is_active: row.id === project.active_version_id,
      viewUrl: published ? slideUrls.view(project.slug, viewToken(secret, project.id, row.id), row.id, row.entry_html!) : null,
      pdfUrl: published && row.pdf_key ? slideUrls.pdf(project.slug, row.id) : null,
      hasThumbnail: Boolean(published && row.thumbnail_key),
    };
  });
}

/** Everything the deck detail / player page renders. `share_key` is only revealed to editors. */
export async function slideDetail(db: Queryable, secret: string, project: SlideProject, user: CurrentUser | null) {
  const [versions, references, reviews, replies, tags] = await Promise.all([
    listVersions(db, secret, project),
    db.query<{ id: string; title: string; url: string | null; file_key: string | null; file_name: string | null; file_bytes: string | null; is_default: boolean; created_at: string }>(
      "SELECT id,title,url,file_key,file_name,file_bytes,is_default,created_at FROM slide_references WHERE project_id=$1 ORDER BY is_default DESC,created_at,id",
      [project.id],
    ),
    db.query<{ id: string; body: string; created_at: string; author: string; author_id: string }>(
      "SELECT r.id,r.body,r.created_at,u.name AS author,r.author_id FROM slide_reviews r JOIN users u ON u.id=r.author_id WHERE r.project_id=$1 ORDER BY r.created_at,r.id",
      [project.id],
    ),
    db.query<{ id: string; review_id: string; body: string; created_at: string; author: string; author_id: string }>(
      "SELECT p.id,p.review_id,p.body,p.created_at,u.name AS author,p.author_id FROM slide_review_replies p JOIN slide_reviews r ON r.id=p.review_id JOIN users u ON u.id=p.author_id WHERE r.project_id=$1 ORDER BY p.created_at,p.id",
      [project.id],
    ),
    db.query<{ id: string; name: string }>(
      "SELECT t.id,t.name FROM slide_project_tags j JOIN slide_tags t ON t.id=j.tag_id WHERE j.project_id=$1 ORDER BY lower(t.name)",
      [project.id],
    ),
  ]);
  const editor = isEditorRole(user);
  const active = versions.find(version => version.id === project.active_version_id && version.viewUrl) ?? null;
  // The thumbnail route needs a session, so anonymous viewers get no URL.
  const thumbnailUrl = user && active?.hasThumbnail ? slideUrls.thumbnail(project.id, active.id) : null;
  return {
    project: {
      id: project.id,
      title: project.title,
      slug: project.slug,
      public_view: project.public_view,
      active_version_id: project.active_version_id,
      created_by: project.created_by,
      created_at: project.created_at,
      updated_at: project.updated_at,
      share_key: editor ? project.share_key : null,
      shareUrl: editor ? slideUrls.share(project.slug, project.share_key) : null,
      playerUrl: slideUrls.player(project.slug),
    },
    activeVersion: active,
    thumbnailUrl,
    viewUrl: active?.viewUrl ?? null,
    pdfUrl: active?.pdfUrl ?? null,
    versions,
    references: references.rows.map(({ file_key, ...ref }) => ({
      ...ref,
      file_bytes: ref.file_bytes === null ? null : Number(ref.file_bytes),
      kind: file_key ? "file" : "url",
      href: file_key ? slideUrls.reference(project.slug, ref.id) : ref.url,
    })),
    reviews: reviews.rows.map(review => ({ ...review, replies: replies.rows.filter(reply => reply.review_id === review.id) })),
    tags: tags.rows,
    permissions: {
      manage: editor,
      review: Boolean(user && (user.role === "professor" || user.role === "owner")),
      reply: user?.role === "owner",
    },
  };
}
