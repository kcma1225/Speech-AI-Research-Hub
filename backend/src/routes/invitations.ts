import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { hashPassword } from "../bootstrap.js";
import { transaction } from "../db.js";
import { audit, createSession, randomToken, requireAdmin, sha256 } from "../lib/auth.js";
import { badRequest, conflict, HttpError, idParams, isUniqueViolation, notFound, parse } from "../lib/http.js";
import { composeZhName, NAMES_HINT, personNamesSchema } from "../lib/users/person-name.js";
import { USERNAME_HINT, USERNAME_RE, USERNAME_TAKEN, usernameAvailable, usernameSchema } from "../lib/users/username.js";

/** Expiry choices offered in the admin UI; `never` = no expiry. */
export const EXPIRY_MINUTES = { "5m": 5, "30m": 30, "1h": 60, "2h": 120, "5h": 300, "1d": 1440, "3d": 4320, "5d": 7200, "7d": 10080, never: null } as const;

/** `admin` invitations create system-only admin accounts; `isAdmin` is legacy and must agree with `role`. */
const createInput = z.object({
  role: z.enum(["student", "professor", "admin"]),
  isAdmin: z.boolean().optional(),
  expiresIn: z.enum(Object.keys(EXPIRY_MINUTES) as [keyof typeof EXPIRY_MINUTES, ...(keyof typeof EXPIRY_MINUTES)[]]),
  maxUses: z.union([z.literal(1), z.null()]),
});
const joinInput = z
  .object({
    token: z.string().min(32).max(200),
    names: personNamesSchema,
    username: usernameSchema,
    password: z.string().max(4096).refine(value => value.trim().length >= 8, { message: "密碼至少需要 8 個字元。" }),
    passwordConfirm: z.string().optional(),
  })
  .refine(data => data.passwordConfirm === undefined || data.password === data.passwordConfirm);

const INVITATION_COLUMNS = `id,role,is_admin,expires_at,max_uses,use_count,revoked_at,created_at,
  CASE WHEN revoked_at IS NOT NULL THEN 'revoked'
       WHEN max_uses IS NOT NULL AND use_count>=max_uses THEN 'exhausted'
       WHEN expires_at IS NOT NULL AND expires_at<=now() THEN 'expired'
       ELSE 'active' END AS state`;
const VALID_INVITE = "revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()) AND (max_uses IS NULL OR use_count<max_uses)";
const invalidInvite = () => new HttpError(410, "邀請已失效、用罄或已過期。");

const invitations: FastifyPluginAsync = async app => {
  app.get("/invitations", async (request, reply) => {
    await requireAdmin(request);
    const result = await app.db.query(
      `SELECT ${INVITATION_COLUMNS},
              (SELECT coalesce(json_agg(json_build_object('id',u.id,'name',u.name,'used_at',iu.used_at) ORDER BY iu.used_at),'[]')
                 FROM invitation_uses iu JOIN users u ON u.id=iu.user_id WHERE iu.invitation_id=i.id) AS uses
         FROM invitations i ORDER BY created_at DESC LIMIT 200`,
    );
    reply.header("Cache-Control", "no-store");
    return { invitations: result.rows };
  });

  app.post("/invitations", async (request, reply) => {
    const user = await requireAdmin(request);
    const data = parse(createInput, request.body, "邀請設定不正確。");
    if (data.isAdmin !== undefined && data.isAdmin !== (data.role === "admin")) throw badRequest("學生與教授帳號不能是管理員；要建立管理員請選「管理員」身分。");
    const isAdmin = data.role === "admin";
    const token = randomToken();
    const minutes = EXPIRY_MINUTES[data.expiresIn];
    const result = await app.db.query(
      `INSERT INTO invitations(token_hash,role,created_by,expires_at,max_uses,is_admin)
       VALUES($1,$2,$3,CASE WHEN $4::integer IS NULL THEN NULL ELSE now()+make_interval(mins=>$4::integer) END,$5,$6)
       RETURNING ${INVITATION_COLUMNS}`,
      [sha256(token), data.role, user.id, minutes, data.maxUses, isAdmin],
    );
    const invitation = result.rows[0];
    await audit(request, user.id, "invitation_created", "invitation", invitation.id, { role: data.role, isAdmin, expiresIn: data.expiresIn, maxUses: data.maxUses });
    return reply.code(201).send({ invitation, token, url: `${new URL(app.config.APP_ORIGIN).origin}/join/${encodeURIComponent(token)}` });
  });

  app.delete("/invitations/:id", async request => {
    const user = await requireAdmin(request);
    const { id } = parse(idParams, request.params);
    const result = await app.db.query(
      "UPDATE invitations SET revoked_at=coalesce(revoked_at,now()) WHERE id=$1 RETURNING id",
      [id],
    );
    if (!result.rowCount) throw notFound("邀請不存在。");
    await audit(request, user.id, "invitation_revoked", "invitation", id);
    return { ok: true };
  });

  /** Live check for the join form. Needs a valid invitation token (no anonymous enumeration); nginx rate-limits it. */
  app.get("/join/username-available", async (request, reply) => {
    const { u, token } = parse(z.object({ u: z.string().max(80), token: z.string().min(32).max(200) }), request.query);
    reply.header("Cache-Control", "no-store");
    if (!(await app.db.query(`SELECT 1 FROM invitations WHERE token_hash=$1 AND ${VALID_INVITE}`, [sha256(token)])).rowCount) throw invalidInvite();
    const username = u.trim().toLowerCase();
    if (!USERNAME_RE.test(username)) return { username, valid: false, available: false, error: USERNAME_HINT };
    const available = await usernameAvailable(app.db, username);
    return { username, valid: true, available, ...(available ? {} : { error: USERNAME_TAKEN }) };
  });

  app.get("/join/:token", async (request, reply) => {
    const { token } = parse(z.object({ token: z.string().min(32).max(200) }), request.params);
    const result = await app.db.query<{ role: string; is_admin: boolean; expires_at: string | null }>(
      `SELECT role,is_admin,expires_at FROM invitations WHERE token_hash=$1 AND ${VALID_INVITE}`,
      [sha256(token)],
    );
    const invite = result.rows[0];
    if (!invite) throw notFound("邀請已失效、用罄或已過期。");
    reply.header("Cache-Control", "no-store");
    return { role: invite.role, isAdmin: invite.is_admin, expiresAt: invite.expires_at };
  });

  app.post("/join", async (request, reply) => {
    const data = parse(joinInput, request.body, `邀請或帳號資料不正確：${NAMES_HINT}並填寫使用者名稱與兩次相同的密碼。`);
    const passwordHash = await hashPassword(data.password);
    try {
      const account = await transaction(app.db, async client => {
        const invite = (await client.query<{ id: string; role: string; is_admin: boolean }>(
          `SELECT id,role,is_admin FROM invitations WHERE token_hash=$1 AND ${VALID_INVITE} FOR UPDATE`,
          [sha256(data.token)],
        )).rows[0];
        if (!invite) throw invalidInvite();
        if (!(await usernameAvailable(client, data.username))) throw conflict(USERNAME_TAKEN);
        const n = data.names;
        const created = (await client.query<{ id: string; name: string; name_en: string | null; username: string }>(
          `INSERT INTO users(username,real_name,zh_family,zh_given,en_family,en_given,title,names_confirmed_at,password_hash,role,is_admin)
           VALUES($1,$2,$3,$4,$5,$6,$7,now(),$8,$9,$10) RETURNING id,name,name_en,username`,
          [data.username, composeZhName(n.zh_family!, n.zh_given!), n.zh_family, n.zh_given, n.en_family, n.en_given, n.title, passwordHash, invite.role, invite.role === "admin"],
        )).rows[0]!;
        await client.query("INSERT INTO invitation_uses(invitation_id,user_id) VALUES($1,$2)", [invite.id, created.id]);
        await client.query("UPDATE invitations SET use_count=use_count+1 WHERE id=$1", [invite.id]);
        await client.query(
          "INSERT INTO audit_log(actor_id,action,target_type,target_id,metadata) VALUES($1,'invitation_used','invitation',$2,$3)",
          [created.id, invite.id, JSON.stringify({ role: invite.role, isAdmin: invite.is_admin })],
        );
        return created;
      });
      await createSession(request, reply, account.id);
      await app.db.query("UPDATE users SET last_login_at=now() WHERE id=$1", [account.id]);
      return reply.code(201).send({ account });
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict(USERNAME_TAKEN);
      throw error;
    }
  });
};

export default invitations;
