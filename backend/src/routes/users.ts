import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { transaction } from "../db.js";
import { requireOwner } from "../lib/auth.js";
import { badRequest, idParams, notFound, parse } from "../lib/http.js";

const patchInput = z
  .object({ role: z.enum(["admin", "member", "professor"]).optional(), disabled: z.boolean().optional() })
  .refine(data => data.role !== undefined || data.disabled !== undefined);

const users: FastifyPluginAsync = async app => {
  app.get("/users", async (request, reply) => {
    await requireOwner(request);
    const result = await app.db.query(
      `SELECT id,name,role,auth_mode,(disabled_at IS NOT NULL) AS disabled,disabled_at,created_at,last_login_at
         FROM users ORDER BY role='owner' DESC, created_at`,
    );
    reply.header("Cache-Control", "no-store");
    return { users: result.rows };
  });

  app.patch("/users/:id", async request => {
    const actor = await requireOwner(request);
    const { id } = parse(idParams, request.params);
    const data = parse(patchInput, request.body, "角色不正確。");
    if (id === actor.id) throw badRequest("不能變更自己的帳號。");
    const user = await transaction(app.db, async client => {
      const target = (await client.query<{ role: string; disabled: boolean }>(
        "SELECT role,(disabled_at IS NOT NULL) AS disabled FROM users WHERE id=$1 FOR UPDATE",
        [id],
      )).rows[0];
      if (!target || target.role === "owner") throw notFound("帳號不存在或受保護。");
      if (data.role !== undefined && data.role !== target.role) {
        await client.query("UPDATE users SET role=$1 WHERE id=$2", [data.role, id]);
        await client.query(
          "INSERT INTO audit_log(actor_id,action,target_type,target_id,metadata) VALUES($1,'user_role_changed','user',$2,$3)",
          [actor.id, id, JSON.stringify({ from: target.role, to: data.role })],
        );
      }
      if (data.disabled !== undefined && data.disabled !== target.disabled) {
        await client.query("UPDATE users SET disabled_at=CASE WHEN $1 THEN now() ELSE NULL END WHERE id=$2", [data.disabled, id]);
        if (data.disabled) await client.query("DELETE FROM sessions WHERE user_id=$1", [id]);
        await client.query(
          "INSERT INTO audit_log(actor_id,action,target_type,target_id) VALUES($1,$2,'user',$3)",
          [actor.id, data.disabled ? "user_disabled" : "user_enabled", id],
        );
      }
      return (await client.query(
        "SELECT id,name,role,auth_mode,(disabled_at IS NOT NULL) AS disabled,disabled_at,created_at,last_login_at FROM users WHERE id=$1",
        [id],
      )).rows[0];
    });
    return { user };
  });
};

export default users;
