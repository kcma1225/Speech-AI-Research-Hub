import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { hashPassword } from "../bootstrap.js";
import { transaction } from "../db.js";
import { audit, createSession, randomToken, requireAdmin, sha256 } from "../lib/auth.js";
import { badRequest, conflict, HttpError, idParams, notFound, parse } from "../lib/http.js";

/**
 * Admin-issued one-time password reset links (migration 0110). The admin never learns the new password: the link opens
 * `/reset/<token>`, where the account holder sets it. Issuing revokes older unused links (and, by default, the account's
 * sessions); using a link sets the password, ends every session of the account and signs the holder in.
 */
export const RESET_EXPIRY_MINUTES = { "1h": 60, "1d": 1440, "3d": 4320, "7d": 10080 } as const;

const issueInput = z
  .object({
    expiresIn: z.enum(Object.keys(RESET_EXPIRY_MINUTES) as [keyof typeof RESET_EXPIRY_MINUTES, ...(keyof typeof RESET_EXPIRY_MINUTES)[]]).default("1d"),
    revokeSessions: z.boolean().default(true),
  })
  .strict();
const tokenSchema = z.string().min(32).max(200);
const useInput = z
  .object({
    token: tokenSchema,
    password: z.string().max(4096).refine(value => value.trim().length >= 8, { message: "密碼至少需要 8 個字元。" }),
    passwordConfirm: z.string().optional(),
  })
  .refine(data => data.passwordConfirm === undefined || data.password === data.passwordConfirm);

const VALID_RESET = "r.used_at IS NULL AND r.revoked_at IS NULL AND r.expires_at>now()";
const INVALID_RESET = "重設連結已失效、已使用或已過期，請向管理員索取新的連結。";

const passwordReset: FastifyPluginAsync = async app => {
  app.post("/users/:id/password-reset", async (request, reply) => {
    const actor = await requireAdmin(request);
    const { id } = parse(idParams, request.params);
    const data = parse(issueInput, request.body ?? {}, "重設連結的設定不正確。");
    if (id === actor.id) throw badRequest("請在「設定」變更自己的密碼。");
    const token = randomToken();
    const minutes = RESET_EXPIRY_MINUTES[data.expiresIn];
    const reset = await transaction(app.db, async client => {
      const target = (await client.query<{ is_owner: boolean; disabled: boolean }>(
        "SELECT is_owner,(disabled_at IS NOT NULL) AS disabled FROM users WHERE id=$1 FOR UPDATE",
        [id],
      )).rows[0];
      if (!target) throw notFound("帳號不存在。");
      if (target.is_owner) throw badRequest("初始管理員的密碼由伺服器設定（ADMIN_PASSWORD）管理，不能用重設連結。");
      if (target.disabled) throw conflict("帳號已停用，請先啟用再產生重設連結。");
      await client.query("UPDATE password_resets SET revoked_at=now() WHERE user_id=$1 AND used_at IS NULL AND revoked_at IS NULL", [id]);
      const row = (await client.query<{ id: string; expires_at: string }>(
        "INSERT INTO password_resets(user_id,token_hash,created_by,expires_at) VALUES($1,$2,$3,now()+make_interval(mins=>$4::integer)) RETURNING id,expires_at",
        [id, sha256(token), actor.id, minutes],
      )).rows[0]!;
      const sessions = data.revokeSessions ? (await client.query("DELETE FROM sessions WHERE user_id=$1", [id])).rowCount ?? 0 : 0;
      await client.query(
        "INSERT INTO audit_log(actor_id,action,target_type,target_id,metadata) VALUES($1,'user_password_reset_issued','user',$2,$3)",
        [actor.id, id, JSON.stringify({ resetId: row.id, expiresIn: data.expiresIn, revokedSessions: sessions })],
      );
      return { ...row, revoked_sessions: sessions };
    });
    reply.header("Cache-Control", "no-store");
    return reply.code(201).send({ reset, token, url: `${new URL(app.config.APP_ORIGIN).origin}/reset/${encodeURIComponent(token)}` });
  });

  /** Revokes the account's unused reset links. */
  app.delete("/users/:id/password-reset", async request => {
    const actor = await requireAdmin(request);
    const { id } = parse(idParams, request.params);
    const result = await app.db.query("UPDATE password_resets SET revoked_at=now() WHERE user_id=$1 AND used_at IS NULL AND revoked_at IS NULL", [id]);
    if (result.rowCount) await audit(request, actor.id, "user_password_reset_revoked", "user", id, { count: result.rowCount });
    return { ok: true, revoked: result.rowCount ?? 0 };
  });

  /** Public: validates a link for the reset form → whose account it is. */
  app.get("/password-reset/:token", async (request, reply) => {
    const { token } = parse(z.object({ token: tokenSchema }), request.params, INVALID_RESET);
    const row = (await app.db.query<{ name: string; username: string; expires_at: string }>(
      `SELECT u.name,u.username,r.expires_at FROM password_resets r JOIN users u ON u.id=r.user_id
        WHERE r.token_hash=$1 AND ${VALID_RESET} AND u.disabled_at IS NULL`,
      [sha256(token)],
    )).rows[0];
    if (!row) throw notFound(INVALID_RESET);
    reply.header("Cache-Control", "no-store");
    return { account: { name: row.name, username: row.username }, expiresAt: row.expires_at };
  });

  /** Public: sets the new password (single use), ends every session of the account, signs the holder in. */
  app.post("/password-reset", async (request, reply) => {
    const data = parse(useInput, request.body, "請輸入兩次相同的新密碼（至少 8 個字元）。");
    const passwordHash = await hashPassword(data.password);
    const account = await transaction(app.db, async client => {
      const row = (await client.query<{ id: string; user_id: string; name: string; username: string; auth_mode: string }>(
        `SELECT r.id,r.user_id,u.name,u.username,u.auth_mode FROM password_resets r JOIN users u ON u.id=r.user_id
          WHERE r.token_hash=$1 AND ${VALID_RESET} AND u.disabled_at IS NULL FOR UPDATE OF r, u`,
        [sha256(data.token)],
      )).rows[0];
      if (!row) throw new HttpError(410, INVALID_RESET);
      await client.query("UPDATE password_resets SET used_at=now() WHERE id=$1", [row.id]);
      await client.query("UPDATE password_resets SET revoked_at=now() WHERE user_id=$1 AND used_at IS NULL AND revoked_at IS NULL", [row.user_id]);
      await client.query("UPDATE users SET password_hash=$1 WHERE id=$2", [passwordHash, row.user_id]);
      await client.query("DELETE FROM sessions WHERE user_id=$1", [row.user_id]);
      await client.query(
        "INSERT INTO audit_log(actor_id,action,target_type,target_id,metadata) VALUES($1,'user_password_reset_used','user',$2,$3)",
        [row.user_id, row.user_id, JSON.stringify({ resetId: row.id, ip: request.ip })],
      );
      return row;
    });
    // Two-factor accounts set the password but sign in through the normal (2FA) flow.
    const signedIn = account.auth_mode !== "two_factor";
    if (signedIn) {
      await createSession(request, reply, account.user_id);
      await app.db.query("UPDATE users SET last_login_at=now() WHERE id=$1", [account.user_id]);
    }
    return { account: { id: account.user_id, name: account.name, username: account.username }, signedIn };
  });
};

export default passwordReset;
