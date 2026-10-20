import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { hashPassword } from "../bootstrap.js";
import { transaction } from "../db.js";
import { audit, createSession, randomToken, requireOwner, sha256 } from "../lib/auth.js";
import { conflict, HttpError, idParams, isUniqueViolation, notFound, parse } from "../lib/http.js";

/** Expiry choices offered in the admin UI; `never` = no expiry. */
export const EXPIRY_MINUTES = { "5m": 5, "30m": 30, "1h": 60, "2h": 120, "5h": 300, "1d": 1440, "3d": 4320, "5d": 7200, "7d": 10080, never: null } as const;

const createInput = z.object({
  role: z.enum(["admin", "member", "professor"]),
  expiresIn: z.enum(Object.keys(EXPIRY_MINUTES) as [keyof typeof EXPIRY_MINUTES, ...(keyof typeof EXPIRY_MINUTES)[]]),
  maxUses: z.union([z.literal(1), z.null()]),
});
const joinInput = z
  .object({
    token: z.string().min(32).max(200),
    name: z.string().trim().min(1).max(80),
    password: z.string().max(4096).refine(value => value.trim().length > 0),
    passwordConfirm: z.string().optional(),
  })
  .refine(data => data.passwordConfirm === undefined || data.password === data.passwordConfirm);

const INVITATION_COLUMNS = `id,role,expires_at,max_uses,use_count,revoked_at,created_at,
  CASE WHEN revoked_at IS NOT NULL THEN 'revoked'
       WHEN expires_at IS NOT NULL AND expires_at<=now() THEN 'expired'
       WHEN max_uses IS NOT NULL AND use_count>=max_uses THEN 'exhausted'
       ELSE 'active' END AS state`;
const VALID_INVITE = "revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()) AND (max_uses IS NULL OR use_count<max_uses)";
const invalidInvite = () => new HttpError(410, "邀請已失效、用罄或已過期。");

const invitations: FastifyPluginAsync = async app => {
  app.get("/invitations", async (request, reply) => {
    await requireOwner(request);
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
    const user = await requireOwner(request);
    const data = parse(createInput, request.body, "邀請設定不正確。");
    const token = randomToken();
    const minutes = EXPIRY_MINUTES[data.expiresIn];
    const result = await app.db.query(
      `INSERT INTO invitations(token_hash,role,created_by,expires_at,max_uses)
       VALUES($1,$2,$3,CASE WHEN $4::integer IS NULL THEN NULL ELSE now()+make_interval(mins=>$4::integer) END,$5)
       RETURNING ${INVITATION_COLUMNS}`,
      [sha256(token), data.role, user.id, minutes, data.maxUses],
    );
    const invitation = result.rows[0];
    await audit(request, user.id, "invitation_created", "invitation", invitation.id, { role: data.role, expiresIn: data.expiresIn, maxUses: data.maxUses });
    return reply.code(201).send({ invitation, token, url: `${new URL(app.config.APP_ORIGIN).origin}/join?token=${encodeURIComponent(token)}` });
  });

  app.delete("/invitations/:id", async request => {
    const user = await requireOwner(request);
    const { id } = parse(idParams, request.params);
    const result = await app.db.query(
      "UPDATE invitations SET revoked_at=coalesce(revoked_at,now()) WHERE id=$1 RETURNING id",
      [id],
    );
    if (!result.rowCount) throw notFound("邀請不存在。");
    await audit(request, user.id, "invitation_revoked", "invitation", id);
    return { ok: true };
  });

  app.get("/join/:token", async (request, reply) => {
    const { token } = parse(z.object({ token: z.string().min(32).max(200) }), request.params);
    const result = await app.db.query<{ role: string; expires_at: string | null }>(
      `SELECT role,expires_at FROM invitations WHERE token_hash=$1 AND ${VALID_INVITE}`,
      [sha256(token)],
    );
    const invite = result.rows[0];
    if (!invite) throw notFound("邀請已失效、用罄或已過期。");
    reply.header("Cache-Control", "no-store");
    return { role: invite.role, expiresAt: invite.expires_at };
  });

  app.post("/join", async (request, reply) => {
    const data = parse(joinInput, request.body, "邀請或帳號資料不正確。");
    const passwordHash = await hashPassword(data.password);
    try {
      const account = await transaction(app.db, async client => {
        const invite = (await client.query<{ id: string; role: string }>(
          `SELECT id,role FROM invitations WHERE token_hash=$1 AND ${VALID_INVITE} FOR UPDATE`,
          [sha256(data.token)],
        )).rows[0];
        if (!invite) throw invalidInvite();
        const created = (await client.query<{ id: string; name: string }>(
          "INSERT INTO users(name,password_hash,role) VALUES($1,$2,$3) RETURNING id,name",
          [data.name, passwordHash, invite.role],
        )).rows[0]!;
        await client.query("INSERT INTO invitation_uses(invitation_id,user_id) VALUES($1,$2)", [invite.id, created.id]);
        await client.query("UPDATE invitations SET use_count=use_count+1 WHERE id=$1", [invite.id]);
        await client.query(
          "INSERT INTO audit_log(actor_id,action,target_type,target_id,metadata) VALUES($1,'invitation_used','invitation',$2,$3)",
          [created.id, invite.id, JSON.stringify({ role: invite.role })],
        );
        return created;
      });
      await createSession(request, reply, account.id);
      await app.db.query("UPDATE users SET last_login_at=now() WHERE id=$1", [account.id]);
      return reply.code(201).send({ account });
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict("此名稱已被使用，請換一個。");
      throw error;
    }
  });
};

export default invitations;
