import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireRole } from "../lib/auth.js";
import { forbidden, HttpError, notFound, parse } from "../lib/http.js";
import { slideUrls } from "../lib/slides/access.js";

const reviewParams = z.object({ id: z.uuid() });
const replyParams = z.object({ id: z.uuid(), reviewId: z.uuid() });
const body = z.object({ body: z.string().trim().min(1).max(10000) });

const slideReviews: FastifyPluginAsync = async app => {
  /** Professor (and Owner) review of a deck; notifies the deck creator. */
  app.post("/slides/:id/reviews", async (request, reply) => {
    const user = await requireRole(request, ["professor", "owner"]).catch(error => {
      throw error instanceof HttpError && error.status === 403 ? forbidden("只有 Professor 或 Owner 可以新增審閱。") : error;
    });
    const { id } = parse(reviewParams, request.params);
    const input = parse(body, request.body, "審閱內容須為 1–10000 字。");
    const result = await app.db.query<{ id: string; created_at: string; created_by: string; slug: string; title: string }>(
      `WITH project AS (SELECT id,created_by,slug,title FROM slide_projects WHERE id=$1),
            inserted AS (INSERT INTO slide_reviews(project_id,author_id,body) SELECT id,$2,$3 FROM project RETURNING id,created_at)
       SELECT inserted.id,inserted.created_at,project.created_by,project.slug,project.title FROM inserted, project`,
      [id, user.id, input.body],
    );
    const row = result.rows[0];
    if (!row) throw notFound("簡報不存在。");
    if (row.created_by !== user.id) {
      await app.notifier.notify([row.created_by], { kind: "slide", title: `${user.name} 新增了簡報審閱`, body: `${row.title}：${input.body}`, url: slideUrls.player(row.slug) }, { pref: "reviews", tag: `review-${row.id}` })
        .catch(error => request.log.warn({ err: error }, "review notification failed"));
    }
    return reply.code(201).send({ review: { id: row.id, body: input.body, created_at: row.created_at, author: user.name, author_id: user.id, replies: [] } });
  });

  /** Owner reply to a review; notifies the review author. */
  app.post("/slides/:id/reviews/:reviewId/replies", async (request, reply) => {
    const user = await requireRole(request, ["owner"]).catch(error => {
      throw error instanceof HttpError && error.status === 403 ? forbidden("只有 Owner 可以回覆審閱。") : error;
    });
    const { id, reviewId } = parse(replyParams, request.params);
    const input = parse(body, request.body, "回覆內容須為 1–10000 字。");
    const result = await app.db.query<{ id: string; created_at: string; author_id: string; slug: string; title: string }>(
      `WITH review AS (
         SELECT r.id,r.author_id,p.slug,p.title FROM slide_reviews r JOIN slide_projects p ON p.id=r.project_id WHERE r.id=$2 AND r.project_id=$1
       ), inserted AS (
         INSERT INTO slide_review_replies(review_id,author_id,body) SELECT id,$3,$4 FROM review RETURNING id,created_at
       )
       SELECT inserted.id,inserted.created_at,review.author_id,review.slug,review.title FROM inserted, review`,
      [id, reviewId, user.id, input.body],
    );
    const row = result.rows[0];
    if (!row) throw notFound("審閱不存在。");
    if (row.author_id !== user.id) {
      await app.notifier.notify([row.author_id], { kind: "slide", title: `${user.name} 回覆了你的審閱`, body: `${row.title}：${input.body}`, url: slideUrls.player(row.slug) }, { pref: "replies", tag: `reply-${row.id}` })
        .catch(error => request.log.warn({ err: error }, "reply notification failed"));
    }
    return reply.code(201).send({ reply: { id: row.id, review_id: reviewId, body: input.body, created_at: row.created_at, author: user.name, author_id: user.id } });
  });
};

export default slideReviews;
