import type { FastifyPluginAsync } from "fastify";
import type { Queryable } from "../db.js";
import { requireUser, type CurrentUser } from "../lib/auth.js";
import { markdownExcerpt } from "../lib/notes/excerpt.js";
import type { Tag } from "../lib/notes/tag-store.js";
import { slideUrls } from "../lib/slides/access.js";

/** Monday 00:00 of the current week in Asia/Taipei, as timestamptz. */
const WEEK_START = "(date_trunc('week', now() AT TIME ZONE 'Asia/Taipei') AT TIME ZONE 'Asia/Taipei')";
/** When a published version went live: its render job's finish time (falls back to upload time). */
const PUBLISHED_AT = "COALESCE(j.finished_at, v.created_at)";

/**
 * Reviews still waiting for a reply. Only the Owner replies, so the Owner sees every one; others see
 * those on decks they created. `$1` = user id, `$2` = is owner.
 */
const PENDING_REVIEWS_WHERE = `NOT EXISTS (SELECT 1 FROM slide_review_replies x WHERE x.review_id=r.id)
  AND ($2::boolean OR p.created_by=$1)`;

type ActivityRow = { kind: "slide_version" | "note" | "recording" | "review" | "reply"; id: string; title: string; target_id: string; actor_id: string | null; actor_name: string | null; at: string };

const activityUrl = (row: ActivityRow) =>
  row.kind === "note" ? `/notes/${row.target_id}` : row.kind === "recording" ? `/recordings/${row.target_id}` : `/slides/${row.target_id}`;

async function stats(db: Queryable, user: CurrentUser) {
  const row = (await db.query<{ slides: number; notes: number; recordings: number; pending_reviews: number; slides_this_week: number; notes_this_week: number }>(
    `SELECT (SELECT count(*)::int FROM slide_projects) AS slides,
            (SELECT count(*)::int FROM items) AS notes,
            (SELECT count(*)::int FROM items WHERE audio_key IS NOT NULL) AS recordings,
            (SELECT count(*)::int FROM slide_reviews r JOIN slide_projects p ON p.id=r.project_id WHERE ${PENDING_REVIEWS_WHERE}) AS pending_reviews,
            (SELECT count(*)::int FROM slide_versions v LEFT JOIN jobs j ON j.id=v.job_id
              WHERE v.status='published' AND ${PUBLISHED_AT} >= ${WEEK_START}) AS slides_this_week,
            (SELECT count(*)::int FROM items WHERE created_at >= ${WEEK_START}) AS notes_this_week`,
    [user.id, user.role === "owner"],
  )).rows[0]!;
  return {
    slides: row.slides,
    notes: row.notes,
    recordings: row.recordings,
    pendingReviews: row.pending_reviews,
    slidesThisWeek: row.slides_this_week,
    notesThisWeek: row.notes_this_week,
  };
}

async function latestSlide(db: Queryable) {
  const row = (await db.query<{ id: string; title: string; slug: string; version: number; version_id: string; has_thumbnail: boolean; author_name: string | null; published_at: string; tags: Tag[]; review_count: number }>(
    `SELECT p.id,p.title,p.slug,v.version,v.id AS version_id,(v.thumbnail_key IS NOT NULL) AS has_thumbnail,
            COALESCE(vu.name,pu.name) AS author_name,${PUBLISHED_AT} AS published_at,
            COALESCE((SELECT json_agg(json_build_object('id',t.id,'name',t.name) ORDER BY lower(t.name))
                        FROM slide_project_tags x JOIN slide_tags t ON t.id=x.tag_id WHERE x.project_id=p.id),'[]') AS tags,
            (SELECT count(*)::int FROM slide_reviews r WHERE r.project_id=p.id) AS review_count
       FROM slide_projects p
       JOIN slide_versions v ON v.id=p.active_version_id AND v.status='published'
       LEFT JOIN jobs j ON j.id=v.job_id
       LEFT JOIN users vu ON vu.id=v.created_by
       LEFT JOIN users pu ON pu.id=p.created_by
      ORDER BY ${PUBLISHED_AT} DESC, p.id
      LIMIT 1`,
  )).rows[0];
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    version: row.version,
    authorName: row.author_name,
    publishedAt: row.published_at,
    tags: row.tags,
    thumbnailUrl: row.has_thumbnail ? slideUrls.thumbnail(row.id, row.version_id) : null,
    reviewCount: row.review_count,
  };
}

async function activity(db: Queryable) {
  // Each branch is limited first so the union stays small.
  const rows = (await db.query<ActivityRow>(
    `SELECT * FROM (
       (SELECT 'slide_version' AS kind,v.id,p.title || ' v' || v.version AS title,p.id AS target_id,u.id AS actor_id,u.name AS actor_name,${PUBLISHED_AT} AS at
          FROM slide_versions v JOIN slide_projects p ON p.id=v.project_id LEFT JOIN jobs j ON j.id=v.job_id LEFT JOIN users u ON u.id=v.created_by
         WHERE v.status='published' ORDER BY at DESC LIMIT 10)
       UNION ALL
       (SELECT 'note',i.id,i.title,i.id,u.id,u.name,i.created_at
          FROM items i LEFT JOIN users u ON u.id=i.created_by ORDER BY i.created_at DESC LIMIT 10)
       UNION ALL
       (SELECT 'recording',j.id,i.title,i.id,u.id,u.name,j.finished_at
          FROM jobs j JOIN items i ON i.id::text=j.payload->>'itemId' LEFT JOIN users u ON u.id=j.created_by
         WHERE j.kind='media_transcode' AND j.status='succeeded' AND j.finalized_at IS NOT NULL ORDER BY j.finished_at DESC LIMIT 10)
       UNION ALL
       (SELECT 'review',r.id,p.title,p.id,u.id,u.name,r.created_at
          FROM slide_reviews r JOIN slide_projects p ON p.id=r.project_id LEFT JOIN users u ON u.id=r.author_id ORDER BY r.created_at DESC LIMIT 10)
       UNION ALL
       (SELECT 'reply',x.id,p.title,p.id,u.id,u.name,x.created_at
          FROM slide_review_replies x JOIN slide_reviews r ON r.id=x.review_id JOIN slide_projects p ON p.id=r.project_id
          LEFT JOIN users u ON u.id=x.author_id ORDER BY x.created_at DESC LIMIT 10)
     ) a ORDER BY at DESC, id LIMIT 10`,
  )).rows;
  return rows.map(row => ({
    kind: row.kind,
    id: row.id,
    title: row.title,
    url: activityUrl(row),
    actor: row.actor_id ? { id: row.actor_id, name: row.actor_name! } : null,
    at: row.at,
  }));
}

async function pendingReviews(db: Queryable, user: CurrentUser) {
  const rows = (await db.query<{ review_id: string; slide_id: string; slide_title: string; body: string; author_name: string; created_at: string }>(
    `SELECT r.id AS review_id,p.id AS slide_id,p.title AS slide_title,left(r.body,2000) AS body,u.name AS author_name,r.created_at
       FROM slide_reviews r JOIN slide_projects p ON p.id=r.project_id JOIN users u ON u.id=r.author_id
      WHERE ${PENDING_REVIEWS_WHERE}
      ORDER BY r.created_at DESC, r.id LIMIT 5`,
    [user.id, user.role === "owner"],
  )).rows;
  return rows.map(row => ({
    reviewId: row.review_id,
    slideId: row.slide_id,
    slideTitle: row.slide_title,
    excerpt: markdownExcerpt(row.body),
    authorName: row.author_name,
    createdAt: row.created_at,
  }));
}

async function recentNotes(db: Queryable) {
  const rows = (await db.query<{ id: string; title: string; content: string; audio_name: string | null; updated_at: string; tags: Tag[]; has_audio: boolean }>(
    `SELECT i.id,i.title,left(i.content,4000) AS content,i.audio_name,i.updated_at,(i.audio_key IS NOT NULL) AS has_audio,
            COALESCE((SELECT json_agg(json_build_object('id',t.id,'name',t.name) ORDER BY lower(t.name))
                        FROM item_tags x JOIN tags t ON t.id=x.tag_id WHERE x.item_id=i.id),'[]') AS tags
       FROM items i ORDER BY i.updated_at DESC, i.id LIMIT 6`,
  )).rows;
  return rows.map(row => ({
    id: row.id,
    title: row.title,
    excerpt: markdownExcerpt(row.content) || row.audio_name || "",
    updatedAt: row.updated_at,
    tags: row.tags,
    hasAudio: row.has_audio,
  }));
}

const dashboard: FastifyPluginAsync = async app => {
  app.get("/dashboard", async (request, reply) => {
    const user = await requireUser(request);
    const [statsResult, latest, recent, pending, notes] = await Promise.all([
      stats(app.db, user),
      latestSlide(app.db),
      activity(app.db),
      pendingReviews(app.db, user),
      recentNotes(app.db),
    ]);
    return reply.header("Cache-Control", "no-store").send({
      stats: statsResult,
      latestSlide: latest,
      activity: recent,
      pendingReviews: pending,
      recentNotes: notes,
    });
  });
};

export default dashboard;
