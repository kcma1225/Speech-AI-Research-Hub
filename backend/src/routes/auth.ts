import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { hashPassword, verifyPassword } from "../bootstrap.js";
import { transaction } from "../db.js";
import { audit, clearSession, createSession, CURRENT_USER_COLUMNS, currentUser, requireUser, SESSION_COOKIE, sha256, toCurrentUser } from "../lib/auth.js";
import { badRequest, forbidden, idParams, notFound, parse, unauthorized } from "../lib/http.js";
import { mergePreferences, preferencesPatchSchema } from "../lib/preferences.js";
import { realNameSchema } from "../lib/users/username.js";

const password = z.string().max(4096).refine(value => value.trim().length >= 8, { message: "密碼至少需要 8 個字元。" });
/** Sign in by remembered account id or by username (case-insensitive; `name` is a legacy alias of `username`). */
const loginInput = z
  .object({
    userId: z.uuid().optional(),
    username: z.string().trim().min(1).max(80).optional(),
    name: z.string().trim().min(1).max(80).optional(),
    password: z.string().min(1).max(4096),
  })
  .transform(({ name, ...rest }) => ({ ...rest, username: rest.username ?? name }))
  .refine(data => Boolean(data.userId) !== Boolean(data.username));
const profileInput = z
  .object({
    /** Real name (真實姓名); `name` is a legacy alias. The username is changed only by an admin. */
    realName: realNameSchema.optional(),
    name: realNameSchema.optional(),
    theme: z.enum(["system", "light", "dark"]).optional(),
    locale: z.enum(["zh-TW", "en"]).optional(),
    preferences: preferencesPatchSchema.optional(),
    currentPassword: z.string().min(1).max(4096).optional(),
    newPassword: password.optional(),
  })
  .refine(data => !data.newPassword || data.currentPassword, { path: ["currentPassword"] })
  .transform(({ name, ...rest }) => ({ ...rest, realName: rest.realName ?? name }));

const auth: FastifyPluginAsync = async app => {
  /** Real names + usernames for account hints remembered on the device. */
  app.get("/auth/accounts", async request => {
    const { ids } = parse(z.object({ ids: z.string().max(400).optional() }), request.query);
    const list = (ids ?? "").split(",").map(id => id.trim()).filter(Boolean);
    if (!list.length) return { accounts: [] };
    if (list.length > 10 || !list.every(id => z.uuid().safeParse(id).success)) throw badRequest();
    const result = await app.db.query<{ id: string; name: string; username: string }>(
      "SELECT id,name,username FROM users WHERE id=ANY($1::uuid[]) AND disabled_at IS NULL ORDER BY lower(name)",
      [list],
    );
    return { accounts: result.rows };
  });

  app.get("/auth/me", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    return { user: await currentUser(request) };
  });

  app.post("/auth/login", async (request, reply) => {
    const data = parse(loginInput, request.body, "登入資訊不正確。");
    const result = data.userId
      ? await app.db.query("SELECT id,name,username,password_hash,auth_mode FROM users WHERE id=$1 AND disabled_at IS NULL", [data.userId])
      : await app.db.query("SELECT id,name,username,password_hash,auth_mode FROM users WHERE lower(username)=lower($1) AND disabled_at IS NULL", [data.username]);
    const user = result.rows[0] as { id: string; name: string; username: string; password_hash: string; auth_mode: string } | undefined;
    if (!user || !(await verifyPassword(user.password_hash, data.password))) {
      await audit(request, user?.id ?? null, "login_failed", "user", user?.id ?? null, { ip: request.ip });
      throw unauthorized("登入資訊不正確。");
    }
    if (user.auth_mode === "two_factor") throw forbidden("此帳號需要 Passkey 2FA；功能將於下一階段啟用。");
    await createSession(request, reply, user.id);
    await app.db.query("UPDATE users SET last_login_at=now() WHERE id=$1", [user.id]);
    return { account: { id: user.id, name: user.name, username: user.username } };
  });

  app.post("/auth/logout", async (request, reply) => {
    await clearSession(request, reply);
    return { ok: true };
  });

  app.patch("/auth/profile", async (request, reply) => {
    const user = await requireUser(request);
    const data = parse(profileInput, request.body, "請確認真實姓名（1–40 個字元）、目前密碼與偏好設定；新密碼不可只有空白。");
    const currentToken = sha256(request.cookies[SESSION_COOKIE] ?? "");
    const updated = await transaction(app.db, async client => {
      const record = (await client.query<{ password_hash: string; preferences: unknown }>("SELECT password_hash,preferences FROM users WHERE id=$1 FOR UPDATE", [user.id])).rows[0];
      if (!record) throw unauthorized();
      if (data.currentPassword !== undefined && !(await verifyPassword(record.password_hash, data.currentPassword))) {
        throw forbidden("目前密碼不正確。");
      }
      if (data.realName !== undefined) await client.query("UPDATE users SET real_name=$1 WHERE id=$2", [data.realName, user.id]);
      if (data.theme !== undefined) await client.query("UPDATE users SET theme=$1 WHERE id=$2", [data.theme, user.id]);
      if (data.locale !== undefined) await client.query("UPDATE users SET locale=$1 WHERE id=$2", [data.locale, user.id]);
      if (data.preferences !== undefined) {
        const merged = mergePreferences(record.preferences, data.preferences);
        await client.query("UPDATE users SET preferences=$1 WHERE id=$2", [JSON.stringify(merged), user.id]);
      }
      if (data.newPassword) {
        await client.query("UPDATE users SET password_hash=$1 WHERE id=$2", [await hashPassword(data.newPassword), user.id]);
        await client.query("DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2", [user.id, currentToken]);
        await client.query("INSERT INTO audit_log(actor_id,action,target_type,target_id) VALUES($1,'profile_password_changed','user',$2)", [user.id, user.id]);
      }
      if (data.realName !== undefined) {
        await client.query("INSERT INTO audit_log(actor_id,action,target_type,target_id) VALUES($1,'profile_name_changed','user',$2)", [user.id, user.id]);
      }
      return toCurrentUser((await client.query(`SELECT ${CURRENT_USER_COLUMNS} FROM users u WHERE u.id=$1`, [user.id])).rows[0]);
    });
    reply.header("Cache-Control", "no-store");
    return { user: updated };
  });

  app.get("/auth/sessions", async (request, reply) => {
    const user = await requireUser(request);
    const currentToken = sha256(request.cookies[SESSION_COOKIE] ?? "");
    const result = await app.db.query(
      `SELECT id,user_agent,ip,created_at,last_seen_at,expires_at,(token_hash=$2) AS current
         FROM sessions WHERE user_id=$1 AND expires_at>now() ORDER BY last_seen_at DESC`,
      [user.id, currentToken],
    );
    reply.header("Cache-Control", "no-store");
    return { sessions: result.rows };
  });

  app.delete("/auth/sessions/:id", async (request, reply) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params);
    const result = await app.db.query<{ token_hash: string }>("DELETE FROM sessions WHERE id=$1 AND user_id=$2 RETURNING token_hash", [id, user.id]);
    const removed = result.rows[0];
    if (!removed) throw notFound("工作階段不存在。");
    if (removed.token_hash === sha256(request.cookies[SESSION_COOKIE] ?? "")) reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });
};

export default auth;
