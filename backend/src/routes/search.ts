import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireUser } from "../lib/auth.js";
import { parse } from "../lib/http.js";
import { markdownExcerpt } from "../lib/notes/excerpt.js";
import { escapeLike } from "../lib/notes/items.js";

const LIMIT = 6;
const searchQuery = z.object({ q: z.string().trim().min(1).max(100) });

/** Quick search (command palette): decks, notes and tags whose names contain `q`, newest first. */
const search: FastifyPluginAsync = async app => {
  app.get("/search", async (request, reply) => {
    await requireUser(request);
    const { q } = parse(searchQuery, request.query, "請輸入 1–100 字的搜尋內容。");
    const pattern = `%${escapeLike(q)}%`;
    const [slides, notes, tags] = await Promise.all([
      app.db.query<{ id: string; title: string; slug: string }>(
        `SELECT id,title,slug FROM slide_projects WHERE title ILIKE $1 OR slug ILIKE $1
          ORDER BY updated_at DESC, id LIMIT ${LIMIT}`,
        [pattern],
      ),
      app.db.query<{ id: string; title: string; content: string; audio_name: string | null; has_audio: boolean }>(
        `SELECT id,title,left(content,4000) AS content,audio_name,(audio_key IS NOT NULL) AS has_audio FROM items
          WHERE title ILIKE $1 OR content ILIKE $1
          ORDER BY updated_at DESC, id LIMIT ${LIMIT}`,
        [pattern],
      ),
      app.db.query<{ id: string; name: string; kind: "note" | "slide" }>(
        `SELECT id,name,kind FROM (
           SELECT id,name,'note' AS kind,created_at FROM tags WHERE name ILIKE $1
           UNION ALL
           SELECT id,name,'slide' AS kind,created_at FROM slide_tags WHERE name ILIKE $1
         ) t ORDER BY created_at DESC, id LIMIT ${LIMIT}`,
        [pattern],
      ),
    ]);
    return reply.header("Cache-Control", "no-store").send({
      slides: slides.rows,
      notes: notes.rows.map(row => ({ id: row.id, title: row.title, excerpt: markdownExcerpt(row.content) || row.audio_name || "", hasAudio: row.has_audio })),
      tags: tags.rows,
    });
  });
};

export default search;
