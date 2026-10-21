import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { transaction } from "../db.js";
import { requireAdmin, requireUser } from "../lib/auth.js";
import { badRequest, conflict, idParams, isUniqueViolation, notFound, parse } from "../lib/http.js";
import { personNamesSchema, personNamesUpdate, sameNames, toPerson, type PersonNames } from "../lib/users/person-name.js";
import { USERNAME_TAKEN, usernameAvailable, usernameSchema } from "../lib/users/username.js";

/**
 * Role changes only between student and professor; admin accounts are created by invitation (or bootstrap).
 * Names (structured, see person-name.ts) and username can be changed on any account (including the initial admin and
 * the caller's own). An admin edit does not mark the names confirmed for the account holder.
 */
const patchInput = z
  .object({
    role: z.enum(["student", "professor"]).optional(),
    disabled: z.boolean().optional(),
    names: personNamesSchema.optional(),
    username: usernameSchema.optional(),
  })
  .strict()
  .refine(data => Object.values(data).some(value => value !== undefined));

const USER_COLUMNS = "id,name,name_en,zh_family,zh_given,en_family,en_given,title,(names_confirmed_at IS NOT NULL) AS names_confirmed,username,role,is_admin,is_owner,auth_mode,(disabled_at IS NOT NULL) AS disabled,disabled_at,created_at,last_login_at";

const PERSON_SQL = "u.zh_family,u.zh_given,u.en_family,u.en_given,u.title";
/** Moves the name columns of a row into `person` (API shape shared with CurrentUser). */
function withPerson<T extends Partial<PersonNames>>(row: T) {
  const { zh_family, zh_given, en_family, en_given, title, ...rest } = row;
  return { ...rest, person: toPerson({ zh_family, zh_given, en_family, en_given, title }) };
}

const users: FastifyPluginAsync = async app => {
  /** Enabled research accounts for member/participant/assignee pickers (any signed-in user; admins are never listed). */
  app.get("/users/directory", async (request, reply) => {
    await requireUser(request);
    const result = await app.db.query<{ id: string; name: string; name_en: string | null; username: string; role: string } & PersonNames>(
      `SELECT u.id,u.name,u.name_en,u.username,u.role,${PERSON_SQL} FROM users u WHERE u.disabled_at IS NULL AND u.role<>'admin' ORDER BY lower(u.name)`,
    );
    return reply.header("Cache-Control", "no-store").send({ users: result.rows.map(withPerson) });
  });

  app.get("/users", async (request, reply) => {
    await requireAdmin(request);
    const result = await app.db.query(`SELECT ${USER_COLUMNS} FROM users ORDER BY is_owner DESC, created_at`);
    reply.header("Cache-Control", "no-store");
    return { users: result.rows.map(withPerson) };
  });

  app.patch("/users/:id", async request => {
    const actor = await requireAdmin(request);
    const { id } = parse(idParams, request.params);
    const data = parse(patchInput, request.body, "角色不正確；學生與教授帳號不能設為管理員，管理員帳號請用邀請連結建立。");
    const changesAccess = data.role !== undefined || data.disabled !== undefined;
    if (changesAccess && id === actor.id) throw badRequest("不能變更自己的角色或停用自己的帳號。");
    try {
      const user = await transaction(app.db, async client => {
        const target = (await client.query<{ role: string; is_admin: boolean; is_owner: boolean; disabled: boolean; username: string } & PersonNames>(
          "SELECT role,is_admin,is_owner,(disabled_at IS NOT NULL) AS disabled,username,zh_family,zh_given,en_family,en_given,title FROM users WHERE id=$1 FOR UPDATE",
          [id],
        )).rows[0];
        if (!target || (changesAccess && target.is_owner)) throw notFound("帳號不存在，或是無法變更的初始管理員。");
        if (data.role !== undefined && target.role === "admin") throw badRequest("管理員帳號不能改成學生或教授。");
        const log = (action: string, metadata: object = {}) =>
          client.query("INSERT INTO audit_log(actor_id,action,target_type,target_id,metadata) VALUES($1,$2,'user',$3,$4)", [actor.id, action, id, JSON.stringify(metadata)]);
        if (data.username !== undefined && data.username !== target.username) {
          if (!(await usernameAvailable(client, data.username, id))) throw conflict(USERNAME_TAKEN);
          await client.query("UPDATE users SET username=$1 WHERE id=$2", [data.username, id]);
          await log("user_username_changed", { from: target.username, to: data.username });
        }
        if (data.names !== undefined && !sameNames(data.names, target)) {
          const update = personNamesUpdate(data.names, 2);
          await client.query(`UPDATE users SET ${update.sql} WHERE id=$1`, [id, ...update.params]);
          await log("user_real_name_changed");
        }
        if (data.role !== undefined && data.role !== target.role) {
          // Advisors must be professor accounts.
          if (data.role === "student" && (await client.query("SELECT 1 FROM study_members WHERE user_id=$1 AND role='advisor' LIMIT 1", [id])).rowCount) {
            throw conflict("此帳號仍是研究的指導教授，請先在研究中移除或變更其身分。");
          }
          await client.query("UPDATE users SET role=$1 WHERE id=$2", [data.role, id]);
          await log("user_role_changed", { from: target.role, to: data.role });
        }
        if (data.disabled && !target.disabled && target.role === "admin") {
          // At least one enabled admin must remain (the initial admin is protected above, so this is belt and braces).
          const others = (await client.query("SELECT 1 FROM users WHERE role='admin' AND disabled_at IS NULL AND id<>$1 LIMIT 1", [id])).rowCount;
          if (!others) throw conflict("至少要保留一個啟用中的管理員帳號。");
        }
        if (data.disabled !== undefined && data.disabled !== target.disabled) {
          await client.query("UPDATE users SET disabled_at=CASE WHEN $1 THEN now() ELSE NULL END WHERE id=$2", [data.disabled, id]);
          if (data.disabled) await client.query("DELETE FROM sessions WHERE user_id=$1", [id]);
          await log(data.disabled ? "user_disabled" : "user_enabled");
        }
        return withPerson((await client.query(`SELECT ${USER_COLUMNS} FROM users WHERE id=$1`, [id])).rows[0]);
      });
      return { user };
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict(USERNAME_TAKEN);
      throw error;
    }
  });
};

export default users;
