import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { secureCookies } from "../config.js";
import { forbidden, unauthorized } from "./http.js";

export type Role = "owner" | "admin" | "member" | "professor";
export type CurrentUser = { id: string; name: string; role: Role; auth_mode: "either" | "two_factor"; theme: "system" | "light" | "dark" };

export const SESSION_COOKIE = "hub_session";
const SESSION_DAYS = 30;
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

/** Resolves the session cookie to a user (cached per request). */
export async function currentUser(request: FastifyRequest): Promise<CurrentUser | null> {
  if (request.userLoaded) return request.user;
  request.userLoaded = true;
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return (request.user = null);
  const result = await request.server.db.query<CurrentUser & { session_id: string; stale: boolean }>(
    `SELECT u.id,u.name,u.role,u.auth_mode,u.theme,s.id AS session_id,(s.last_seen_at < now() - interval '10 minutes') AS stale
       FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=$1 AND s.expires_at>now() AND u.disabled_at IS NULL`,
    [sha256(token)],
  );
  const row = result.rows[0];
  if (!row) return (request.user = null);
  if (row.stale) void request.server.db.query("UPDATE sessions SET last_seen_at=now() WHERE id=$1", [row.session_id]).catch(() => {});
  const { session_id: _, stale: __, ...user } = row;
  return (request.user = user);
}

export async function requireUser(request: FastifyRequest): Promise<CurrentUser> {
  const user = await currentUser(request);
  if (!user) throw unauthorized();
  return user;
}

export async function requireRole(request: FastifyRequest, roles: readonly Role[]): Promise<CurrentUser> {
  const user = await requireUser(request);
  if (!roles.includes(user.role)) throw forbidden();
  return user;
}

/** Owner-only (admin console: invitations, roles). */
export const requireOwner = (request: FastifyRequest) => requireRole(request, ["owner"]);
/** Everyone except Professor, who is read-only for notes, tags, media and slide management. */
export const requireEditor = (request: FastifyRequest) => requireRole(request, ["owner", "admin", "member"]);

export async function createSession(request: FastifyRequest, reply: FastifyReply, userId: string) {
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await request.server.db.query(
    "INSERT INTO sessions (user_id,token_hash,expires_at,user_agent,ip) VALUES ($1,$2,$3,$4,$5)",
    [userId, sha256(token), expires, request.headers["user-agent"] ?? null, request.ip],
  );
  reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: secureCookies(request.server.config), path: "/", expires });
}

export async function clearSession(request: FastifyRequest, reply: FastifyReply) {
  const token = request.cookies[SESSION_COOKIE];
  if (token) await request.server.db.query("DELETE FROM sessions WHERE token_hash=$1", [sha256(token)]);
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

export async function audit(request: FastifyRequest, actorId: string | null, action: string, targetType: string, targetId: string | null, metadata: object = {}) {
  await request.server.db.query(
    "INSERT INTO audit_log(actor_id,action,target_type,target_id,metadata) VALUES($1,$2,$3,$4,$5)",
    [actorId, action, targetType, targetId, JSON.stringify(metadata)],
  );
}
