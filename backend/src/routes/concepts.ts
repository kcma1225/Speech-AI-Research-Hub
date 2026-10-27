/**
 * The user's own concept memory (`/concepts`, 設定 → 記憶 → 懂的概念): what 「先確認先備知識」 remembered about which
 * concepts the user knows (src/agent/tutor.ts). List, change the level, delete one or all. Private: no route shows
 * another user's concepts, admins included. A user edit is a self-report (`source self_report`).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../lib/auth.js";
import { notFound, parse } from "../lib/http.js";
import { CONCEPT_LEVELS, LEVEL_LABEL, normaliseKey, type ConceptLevel, type ConceptSource } from "../agent/tutor.js";

const keyParams = z.object({ key: z.string().min(1).max(200) });
const patchInput = z.object({ level: z.enum(CONCEPT_LEVELS) });

type Row = { concept_key: string; term_zh: string; term_en: string; level: ConceptLevel; source: ConceptSource; paper_id: string | null; paper_title: string | null; updated_at: string };
const view = (r: Row) => ({
  key: r.concept_key,
  term_zh: r.term_zh,
  term_en: r.term_en,
  level: r.level,
  level_label: LEVEL_LABEL[r.level],
  source: r.source,
  source_label: r.source === "checked" ? "已確認" : "自己標記",
  paper: r.paper_id ? { id: r.paper_id, title: r.paper_title ?? "" } : null,
  updated_at: r.updated_at,
});
const SELECT = `SELECT uc.concept_key, uc.term_zh, uc.term_en, uc.level, uc.source, uc.paper_id, p.title AS paper_title, uc.updated_at
  FROM user_concepts uc LEFT JOIN papers p ON p.id = uc.paper_id`;

export default async function concepts(app: FastifyInstance) {
  const keyOf = (params: unknown) => {
    const { key } = parse(keyParams, params, "找不到這個概念。");
    const k = normaliseKey(key);
    if (!k || k !== key) throw notFound("找不到這個概念。");
    return k;
  };

  app.get("/concepts", async (request, reply) => {
    const user = await requireUser(request);
    const rows = (await app.db.query<Row>(`${SELECT} WHERE uc.user_id=$1 ORDER BY uc.updated_at DESC, uc.concept_key LIMIT 1000`, [user.id])).rows;
    reply.header("Cache-Control", "no-store");
    return { concepts: rows.map(view) };
  });

  app.patch("/concepts/:key", async (request) => {
    const user = await requireUser(request);
    const key = keyOf(request.params);
    const input = parse(patchInput, request.body, "請選擇 懂、有聽過 或 不懂。");
    const r = await app.db.query("UPDATE user_concepts SET level=$3, source='self_report', updated_at=now() WHERE user_id=$1 AND concept_key=$2", [user.id, key, input.level]);
    if (!r.rowCount) throw notFound("找不到這個概念。");
    const row = (await app.db.query<Row>(`${SELECT} WHERE uc.user_id=$1 AND uc.concept_key=$2`, [user.id, key])).rows[0]!;
    return { concept: view(row) };
  });

  app.delete("/concepts/:key", async (request) => {
    const user = await requireUser(request);
    const key = keyOf(request.params);
    const r = await app.db.query("DELETE FROM user_concepts WHERE user_id=$1 AND concept_key=$2", [user.id, key]);
    if (!r.rowCount) throw notFound("找不到這個概念。");
    return { ok: true };
  });

  app.delete("/concepts", async (request) => {
    const user = await requireUser(request);
    const r = await app.db.query("DELETE FROM user_concepts WHERE user_id=$1", [user.id]);
    return { ok: true, deleted: r.rowCount ?? 0 };
  });
}
