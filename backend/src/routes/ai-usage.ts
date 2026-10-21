/**
 * 「AI 用量」 (admin, `/admin/system`): aggregates of `ai_call_log` and `workflow_runs` over the last 7 or 30 days —
 * call counts, tokens in/out and failures per user, account type, AI role and provider/model, top users by tokens,
 * workflow runs by status. Numbers only: the call log never stores prompts or responses, and nothing here reads
 * conversations, messages or documents. Health probes are excluded.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "../lib/auth.js";
import { parse } from "../lib/http.js";

const query = z.object({ days: z.enum(["7", "30"]).default("7") });

type Agg = { calls: number; attempts: number; errors: number; tokens_in: number; tokens_out: number };
const AGG = `count(*) FILTER (WHERE l.final)::int AS calls, count(*)::int AS attempts,
  count(*) FILTER (WHERE l.final AND NOT l.ok)::int AS errors,
  coalesce(sum(l.tokens_in),0)::bigint AS tokens_in, coalesce(sum(l.tokens_out),0)::bigint AS tokens_out`;
const num = <T extends Partial<Agg>>(r: T) => ({ ...r, tokens_in: Number(r.tokens_in ?? 0), tokens_out: Number(r.tokens_out ?? 0) });

export default async function aiUsage(app: FastifyInstance) {
  app.get("/admin/ai/usage", async (request, reply) => {
    await requireAdmin(request);
    const { days } = parse(query, request.query);
    const since = new Date(Date.now() - Number(days) * 86_400_000);
    const where = "l.started_at >= $1 AND NOT l.probe";
    const db = app.db;

    const [totals, byRole, byModel, byUser, byAccount, workflows] = await Promise.all([
      db.query(`SELECT ${AGG}, count(DISTINCT l.user_id)::int AS users FROM ai_call_log l WHERE ${where}`, [since]),
      db.query(`SELECT coalesce(l.role,'') AS role, ${AGG} FROM ai_call_log l WHERE ${where} GROUP BY 1 ORDER BY calls DESC`, [since]),
      db.query(
        `SELECT l.provider_kind, p.name AS provider_name, l.model, ${AGG}
           FROM ai_call_log l LEFT JOIN ai_providers p ON p.id = l.provider_id
          WHERE ${where} AND l.model IS NOT NULL
          GROUP BY 1, 2, 3 ORDER BY (coalesce(sum(l.tokens_in),0) + coalesce(sum(l.tokens_out),0)) DESC, attempts DESC LIMIT 50`,
        [since],
      ),
      db.query(
        `SELECT l.user_id, u.name, u.username, u.role AS account_role, ${AGG}
           FROM ai_call_log l LEFT JOIN users u ON u.id = l.user_id
          WHERE ${where}
          GROUP BY 1, 2, 3, 4 ORDER BY (coalesce(sum(l.tokens_in),0) + coalesce(sum(l.tokens_out),0)) DESC, calls DESC LIMIT 100`,
        [since],
      ),
      db.query(
        `SELECT CASE WHEN l.user_id IS NULL THEN 'system' ELSE coalesce(u.role, 'deleted') END AS account_role, ${AGG}
           FROM ai_call_log l LEFT JOIN users u ON u.id = l.user_id
          WHERE ${where} GROUP BY 1 ORDER BY calls DESC`,
        [since],
      ),
      db.query<{ status: string; n: number; tokens: string }>(
        `SELECT status, count(*)::int AS n, coalesce(sum(coalesce((usage->>'tokens_in')::bigint,0) + coalesce((usage->>'tokens_out')::bigint,0)),0)::bigint AS tokens
           FROM workflow_runs WHERE created_at >= $1 GROUP BY status ORDER BY n DESC`,
        [since],
      ),
    ]);

    const users = byUser.rows.map((r) => {
      const x = num(r as Agg & { user_id: string | null; name: string | null; username: string | null; account_role: string | null });
      return { user: x.user_id ? { id: x.user_id, name: x.name ?? "", username: x.username ?? "", role: x.account_role } : null, calls: x.calls, attempts: x.attempts, errors: x.errors, tokens_in: x.tokens_in, tokens_out: x.tokens_out };
    });
    reply.header("Cache-Control", "no-store");
    return {
      days: Number(days),
      since: since.toISOString(),
      totals: num(totals.rows[0] as Agg & { users: number }),
      by_role: byRole.rows.map((r) => num(r as Agg & { role: string })),
      by_model: byModel.rows.map((r) => num(r as Agg & { provider_kind: string | null; provider_name: string | null; model: string })),
      by_account_role: byAccount.rows.map((r) => num(r as Agg & { account_role: string })),
      by_user: users,
      top_users: users.filter((u) => u.user).slice(0, 10),
      workflows: workflows.rows.map((r) => ({ status: r.status, runs: r.n, tokens: Number(r.tokens) })),
    };
  });
}
