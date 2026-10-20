import { Shell } from "@/components/shell";
import { NotesBrowser } from "@/components/notes-browser";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatDate } from "@/lib/format";
import { markdownExcerpt } from "@/lib/markdown-excerpt";
import { listTags, NO_TAG, type Tag } from "@/lib/tags";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const escapeLike = (value: string) => value.replace(/[\\%_]/g, char => `\\${char}`);

export default async function NotesPage({ searchParams }: { searchParams: Promise<{ q?: string; tags?: string }> }) {
  const user = await requireUser();
  const params = await searchParams;
  const query = (params.q ?? "").trim().slice(0, 200);
  const pool = await db();
  const tags = await listTags(pool);
  // Missing `tags` means every option is checked; an empty value means none.
  const selected = params.tags === undefined ? null : params.tags.split(",").filter(value => value === NO_TAG || (uuid.test(value) && tags.some(tag => tag.id === value)));
  const tagIds = selected?.filter(value => value !== NO_TAG) ?? [];
  const result = await pool.query<{ id: string; title: string; content: string; event_date: string; file_name: string | null; tags: Tag[] }>(
    `SELECT i.id,i.title,i.content,i.event_date,i.file_name,
       COALESCE(json_agg(json_build_object('id',t.id,'name',t.name) ORDER BY lower(t.name)) FILTER (WHERE t.id IS NOT NULL),'[]') AS tags
     FROM items i LEFT JOIN item_tags it ON it.item_id=i.id LEFT JOIN tags t ON t.id=it.tag_id
     WHERE ($1='' OR i.title ILIKE $1 OR i.content ILIKE $1)
       AND ($2::boolean OR EXISTS (SELECT 1 FROM item_tags x WHERE x.item_id=i.id AND x.tag_id=ANY($3::uuid[]))
            OR ($4::boolean AND NOT EXISTS (SELECT 1 FROM item_tags x WHERE x.item_id=i.id)))
     GROUP BY i.id ORDER BY i.event_date DESC,i.created_at DESC`,
    [query ? `%${escapeLike(query)}%` : "", selected === null, tagIds, selected?.includes(NO_TAG) ?? true],
  );
  const notes = result.rows.map(row => ({ id: row.id, title: row.title, date: formatDate(row.event_date), excerpt: markdownExcerpt(row.content) || row.file_name || "尚無文字內容", tags: row.tags }));
  return <Shell>
    <section className="page-head compact-head"><h1>研究筆記</h1></section>
    <NotesBrowser notes={notes} tags={tags} query={query} selected={selected} canEdit={user.role !== "professor"}/>
  </Shell>;
}
