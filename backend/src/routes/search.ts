/** Global search (docs/architecture.md "Search"): `GET /api/search`, `GET /api/search/status`. */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireUser } from "../lib/auth.js";
import { badRequest, notFound, parse } from "../lib/http.js";
import { findStudy, STUDY_MISSING } from "../lib/studies/access.js";
import { search, searchMode, searchSources } from "../lib/search/index.js";
import { MAX_QUERY_LENGTH } from "../lib/search/text.js";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const query = z.object({
  q: z.string().max(MAX_QUERY_LENGTH * 2).default(""),
  types: z.string().max(200).optional(),
  studyId: z.string().min(1).max(80).optional(),
  author: z.union([z.literal("me"), z.uuid()]).optional(),
  from: date.optional(),
  to: date.optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  mode: z.enum(["auto", "keyword"]).optional(),
});

const searchRoutes: FastifyPluginAsync = async (app) => {
  app.get("/search", async (request, reply) => {
    const user = await requireUser(request);
    const input = parse(query, request.query, "搜尋條件不正確。");
    const known = searchSources().map((s) => s.type);
    const types = input.types
      ? input.types.split(",").map((t) => t.trim()).filter(Boolean)
      : undefined;
    if (types?.some((t) => !known.includes(t))) throw badRequest("不支援的搜尋類型。");
    let studyId: string | undefined;
    if (input.studyId) {
      const study = await findStudy(app.db, input.studyId);
      if (!study) throw notFound(STUDY_MISSING);
      studyId = study.id;
    }
    const result = await search(app.db, input.q, {
      types,
      studyId,
      authorId: input.author === "me" ? user.id : input.author,
      from: input.from,
      to: input.to,
      limit: input.limit,
      mode: input.mode,
      user,
    });
    return reply.header("Cache-Control", "no-store").send(result);
  });

  app.get("/search/status", async (request, reply) => {
    await requireUser(request);
    const st = await searchMode();
    return reply.header("Cache-Control", "no-store").send({ search_mode: st.mode, notice_zh: st.reason_zh, types: searchSources().map((s) => s.type) });
  });
};

export default searchRoutes;
