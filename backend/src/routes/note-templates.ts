import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../lib/auth.js";
import { forbidden, notFound, parse } from "../lib/http.js";
import { NOTE_KINDS, type NoteKind } from "../lib/notes/store.js";

const kind = z.enum(NOTE_KINDS as [NoteKind, ...NoteKind[]]);
const fields = {
  name: z.string().trim().min(1).max(60),
  kind,
  description: z.string().trim().max(300),
  body_md: z.string().max(20_000),
  ai_prompt: z.string().trim().max(4000),
  position: z.number().int().min(0).max(1000),
};
const createInput = z.object({
  name: fields.name,
  kind: kind.default("custom"),
  description: fields.description.default(""),
  body_md: fields.body_md.default(""),
  ai_prompt: fields.ai_prompt.default(""),
  scope: z.enum(["user", "system"]).default("user"),
  position: fields.position.optional(),
});
const patchInput = z.object({
  name: fields.name.optional(),
  kind: kind.optional(),
  description: fields.description.optional(),
  body_md: fields.body_md.optional(),
  ai_prompt: fields.ai_prompt.optional(),
  position: fields.position.optional(),
});
const params = z.object({ id: z.uuid() });

const SELECT = `SELECT t.id,t.scope,t.owner_id,t.name,t.kind,t.description,t.body_md,t.ai_prompt,t.position,t.created_at,t.updated_at,
  (SELECT count(*)::int FROM notes n WHERE n.template_id=t.id) AS note_count FROM note_templates t`;

/** Note templates: system ones (admins manage) + the caller's own. */
export default async function noteTemplates(app: FastifyInstance) {
  async function editable(request: Parameters<typeof requireUser>[0], id: string) {
    const user = await requireUser(request);
    const row = (await app.db.query<{ scope: string; owner_id: string | null }>("SELECT scope, owner_id FROM note_templates WHERE id=$1", [id])).rows[0];
    if (!row || (row.scope === "user" && row.owner_id !== user.id && !user.is_admin)) throw notFound("範本不存在。");
    if (row.scope === "system" && !user.is_admin) throw forbidden("只有管理員可以修改系統範本。");
    return user;
  }

  app.get("/note-templates", async (request, reply) => {
    const user = await requireUser(request);
    const templates = (await app.db.query(`${SELECT} WHERE t.scope='system' OR t.owner_id=$1 ORDER BY (t.scope='user'), t.position, t.name`, [user.id])).rows;
    reply.header("Cache-Control", "no-store");
    return { templates, permissions: { manageSystem: user.is_admin } };
  });

  app.post("/note-templates", async (request, reply) => {
    const user = await requireUser(request);
    const input = parse(createInput, request.body);
    if (input.scope === "system" && !user.is_admin) throw forbidden("只有管理員可以建立系統範本。");
    const position = input.position ?? (await app.db.query<{ p: number }>("SELECT coalesce(max(position)+1,0)::int AS p FROM note_templates WHERE scope=$1", [input.scope])).rows[0]!.p;
    const id = (
      await app.db.query<{ id: string }>(
        "INSERT INTO note_templates(scope,owner_id,name,kind,description,body_md,ai_prompt,position) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
        [input.scope, input.scope === "system" ? null : user.id, input.name, input.kind, input.description, input.body_md, input.ai_prompt, position],
      )
    ).rows[0]!.id;
    reply.code(201);
    return { template: (await app.db.query(`${SELECT} WHERE t.id=$1`, [id])).rows[0] };
  });

  app.patch("/note-templates/:id", async (request) => {
    const { id } = parse(params, request.params);
    const input = parse(patchInput, request.body);
    await editable(request, id);
    await app.db.query(
      `UPDATE note_templates SET name=coalesce($2,name), kind=coalesce($3,kind), description=coalesce($4,description), body_md=coalesce($5,body_md),
              ai_prompt=coalesce($6,ai_prompt), position=coalesce($7,position), updated_at=now() WHERE id=$1`,
      [id, input.name ?? null, input.kind ?? null, input.description ?? null, input.body_md ?? null, input.ai_prompt ?? null, input.position ?? null],
    );
    return { template: (await app.db.query(`${SELECT} WHERE t.id=$1`, [id])).rows[0] };
  });

  /** Notes made from it keep their content and kind (template_id becomes null). */
  app.delete("/note-templates/:id", async (request) => {
    const { id } = parse(params, request.params);
    await editable(request, id);
    await app.db.query("DELETE FROM note_templates WHERE id=$1", [id]);
    return { ok: true };
  });
}
