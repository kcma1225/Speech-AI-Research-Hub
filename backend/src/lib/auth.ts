import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { secureCookies } from "../config.js";
import { forbidden, unauthorized } from "./http.js";
import { resolvePreferences, type Preferences } from "./preferences.js";

/**
 * Account kind. `admin` accounts are system-only (models, system settings, users, invitations) and never act in the
 * research workspace; `is_admin` always equals `role === "admin"`. `is_owner` marks the initial admin (bootstrap account).
 */
export type Role = "student" | "professor" | "admin";
export type Locale = "zh-TW" | "en";
export type CurrentUser = {
  id: string;
  /** Real name (真實姓名), shown everywhere the person appears. */
  name: string;
  /** Login id (使用者名稱), lower-case. */
  username: string;
  role: Role;
  is_admin: boolean;
  is_owner: boolean;
  auth_mode: "either" | "two_factor";
  theme: "system" | "light" | "dark";
  locale: Locale;
  /** Stored preferences with defaults filled in. */
  preferences: Preferences;
};

/** Columns of `users` (alias `u`) that make up a CurrentUser; pass the row to `toCurrentUser`. */
export const CURRENT_USER_COLUMNS = "u.id,u.name,u.username,u.role,u.is_admin,u.is_owner,u.auth_mode,u.theme,u.locale,u.preferences";
export const toCurrentUser = (row: Omit<CurrentUser, "preferences"> & { preferences: unknown }): CurrentUser => ({
  id: row.id,
  name: row.name,
  username: row.username,
  role: row.role,
  is_admin: row.is_admin,
  is_owner: row.is_owner,
  auth_mode: row.auth_mode,
  theme: row.theme,
  locale: row.locale,
  preferences: resolvePreferences(row.preferences),
});

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
    `SELECT ${CURRENT_USER_COLUMNS},s.id AS session_id,(s.last_seen_at < now() - interval '10 minutes') AS stale
       FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=$1 AND s.expires_at>now() AND u.disabled_at IS NULL`,
    [sha256(token)],
  );
  const row = result.rows[0];
  if (!row) return (request.user = null);
  if (row.stale) void request.server.db.query("UPDATE sessions SET last_seen_at=now() WHERE id=$1", [row.session_id]).catch(() => {});
  return (request.user = toCurrentUser(row));
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

/** System administration (accounts, invitations, models, templates, system settings). */
export async function requireAdmin(request: FastifyRequest): Promise<CurrentUser> {
  const user = await requireUser(request);
  if (user.role !== "admin") throw forbidden("需要管理員權限。");
  return user;
}

/** Message for admin sessions that reach a research-workspace route (see `workspaceGuard`). */
export const ADMIN_WORKSPACE_FORBIDDEN = "管理員帳號只能管理系統設定與使用者。";

/**
 * API paths an admin session may use (everything else under /api is research workspace and refused for admins):
 * sign-in/session/profile, users and invitations, AI platform admin + status, system settings, templates,
 * notifications/push, the jobs tray, health/config.
 */
const ADMIN_ALLOWED = [
  /^\/api\/health(\/|$)/,
  /^\/api\/config$/,
  /^\/api\/auth(\/|$)/,
  /^\/api\/users(\/|$)/,
  /^\/api\/invitations(\/|$)/,
  /^\/api\/join(\/|$)/,
  /^\/api\/admin(\/|$)/,
  /^\/api\/ai\/status(\/|$)/,
  /^\/api\/library\/settings$/,
  /^\/api\/note-templates(\/|$)/,
  /^\/api\/notifications(\/|$)/,
  /^\/api\/push(\/|$)/,
  /^\/api\/jobs(\/|$)/,
];
export const adminMayUse = (path: string) => ADMIN_ALLOWED.some(re => re.test(path));

/** onRequest hook: refuses admin sessions on research-workspace API routes (403). Bearer-only routes are unaffected. */
export async function workspaceGuard(request: FastifyRequest, reply: FastifyReply) {
  const path = request.url.split("?")[0]!;
  if (!path.startsWith("/api/") || adminMayUse(path)) return;
  if (!request.cookies?.[SESSION_COOKIE]) return;
  const user = await currentUser(request);
  if (user?.role === "admin") return reply.code(403).send({ error: ADMIN_WORKSPACE_FORBIDDEN, code: "admin_workspace" });
}

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
