import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { currentUser, type CurrentUser } from "../auth.js";
import type { Queryable } from "../../db.js";

export type SlideProject = {
  id: string;
  title: string;
  slug: string;
  public_view: boolean;
  share_key: string;
  active_version_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};

const PROJECT_COLUMNS = "id,title,slug,public_view,share_key,active_version_id,created_by,created_at,updated_at";
export const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const shareCookie = (slug: string) => `slide_share_${slug}`;
export const newShareKey = () => randomBytes(24).toString("base64url");

export async function projectBySlug(db: Queryable, slug: string): Promise<SlideProject | null> {
  if (!slugPattern.test(slug) || slug.length > 80) return null;
  const result = await db.query<SlideProject>(`SELECT ${PROJECT_COLUMNS} FROM slide_projects WHERE slug=$1`, [slug]);
  return result.rows[0] ?? null;
}

export async function projectById(db: Queryable, id: string): Promise<SlideProject | null> {
  const result = await db.query<SlideProject>(`SELECT ${PROJECT_COLUMNS} FROM slide_projects WHERE id=$1`, [id]);
  return result.rows[0] ?? null;
}

/** Constant-time comparison of two secrets of any length. */
export function safeEqual(given: string | undefined, expected: string) {
  if (!given) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

// Sandboxed iframes have an opaque origin and send no cookies, so viewers get a
// short-lived signed token in the path instead of relying on the session cookie.
export const VIEW_TTL_SECONDS = 12 * 60 * 60;

function viewSignature(secret: string, projectId: string, versionId: string, expires: number) {
  return createHmac("sha256", secret).update(`slide-view|${projectId}|${versionId}|${expires}`).digest("base64url");
}

export function viewToken(secret: string, projectId: string, versionId: string, now = Date.now()) {
  const expires = Math.floor(now / 1000) + VIEW_TTL_SECONDS;
  return `t.${expires}.${viewSignature(secret, projectId, versionId, expires)}`;
}

export function validViewToken(secret: string, token: string, projectId: string, versionId: string, now = Date.now()) {
  const match = /^t\.(\d{10})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return false;
  const expires = Number(match[1]);
  if (expires < now / 1000) return false;
  return safeEqual(match[2], viewSignature(secret, projectId, versionId, expires));
}

/** Whether a path capability (`t.<exp>.<sig>`, `public`, or the share key) grants viewing this version. */
export function validCapability(secret: string, token: string, project: SlideProject, versionId: string) {
  if (token === "public") return project.public_view;
  if (token.startsWith("t.")) return validViewToken(secret, token, project.id, versionId);
  return safeEqual(token, project.share_key);
}

export type SlideAccess = { project: SlideProject; user: CurrentUser | null };

/**
 * Viewer access to a deck by slug: a signed-in user, a public deck, a `key` (share key) given in the
 * query, or the share cookie set by `/slides/share/:slug/:key`. Returns null when access is denied.
 */
export async function slideAccess(request: FastifyRequest, slug: string, key?: string): Promise<SlideAccess | null> {
  const project = await projectBySlug(request.server.db, slug);
  if (!project) return null;
  const user = await currentUser(request);
  if (user || project.public_view) return { project, user };
  if (safeEqual(key, project.share_key) || safeEqual(request.cookies[shareCookie(slug)], project.share_key)) return { project, user };
  return null;
}

export const isEditorRole = (user: CurrentUser | null) => Boolean(user && user.role !== "professor");

/** URLs handed to the SPA. */
export const slideUrls = {
  view: (slug: string, token: string, versionId: string, entryHtml: string) =>
    `/api/slides/view/${encodeURIComponent(slug)}/${encodeURIComponent(token)}/${versionId}/${entryHtml.split("/").map(encodeURIComponent).join("/")}`,
  pdf: (slug: string, versionId: string) => `/api/slides/pdf/${encodeURIComponent(slug)}/${versionId}`,
  reference: (slug: string, referenceId: string) => `/api/slides/reference/${encodeURIComponent(slug)}/${referenceId}`,
  share: (slug: string, key: string) => `/api/slides/share/${encodeURIComponent(slug)}/${encodeURIComponent(key)}`,
  player: (slug: string) => `/slides/play/${encodeURIComponent(slug)}`,
  /** Active version's thumbnail (signed-in users); `v` busts caches when the active version changes. */
  thumbnail: (projectId: string, versionId: string) => `/api/slides/${projectId}/thumbnail?v=${versionId}`,
};
