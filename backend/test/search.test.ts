import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LightMyRequestResponse } from "fastify";
import { aiFor, type AiPlatform } from "../src/ai/platform/index.js";
import "../src/ai/embedding/reindex-job.js";
import { drainSearchQueue } from "../src/lib/search/index-job.js";
import { setSearchAccessFilter } from "../src/lib/search/index.js";
import { AiJobRunner } from "../src/ai-worker/runner.js";
import { createTestContext, hasTestDb, ORIGIN, type TestContext } from "./helpers.js";
import { MockServer } from "./ai-providers-mock.js";
import { insertStudy } from "./study-fixtures.js";
import { mockEmbed } from "./search-embedder.js";
import { getAgentTool } from "../src/agent/tools/registry.js";
import "../src/agent/tools/index.js";

process.env.PROVIDER_TOKEN_KEY ??= randomBytes(32).toString("base64");

type Session = { id: string; cookie: string };
const DIMS = 256;

describe.skipIf(!hasTestDb)("search", () => {
  let t: TestContext;
  let platform: AiPlatform;
  let admin: Session;
  let alice: Session;
  let bob: Session;
  const emb = new MockServer();
  let embDown = false;
  const ids = {} as Record<"meeting" | "noteA" | "noteB" | "noteEn" | "paper" | "space" | "studyA" | "studyB" | "task" | "transcript", string>;
  const slugs = {} as Record<"a" | "b", string>;
  const json = (r: LightMyRequestResponse) => r.json() as Record<string, any>;
  const send = (who: Session, method: "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: object) =>
    t.app.inject({ method, url, headers: { origin: ORIGIN, cookie: who.cookie }, ...(payload ? { payload } : {}) });
  const get = (who: Session | null, url: string) => t.app.inject({ method: "GET", url, headers: who ? { cookie: who.cookie } : {} });
  const find = async (who: Session, params: Record<string, string>) => {
    const r = await get(who, `/api/search?${new URLSearchParams(params)}`);
    expect(r.statusCode).toBe(200);
    return json(r);
  };
  const group = (body: Record<string, any>, type: string) => (body.groups as { type: string; results: any[] }[]).find((g) => g.type === type)?.results ?? [];

  beforeAll(async () => {
    await emb.start();
    emb.on("GET", "/v1/models", { body: { object: "list", data: [{ id: "mock-embed" }] } });
    emb.on("POST", "/v1/embeddings", (req) =>
      embDown
        ? { status: 503, body: { error: { message: "down" } } }
        : { body: { object: "list", model: req.json.model, data: (req.json.input as string[]).map((x, index) => ({ index, embedding: mockEmbed(x, DIMS) })), usage: { prompt_tokens: 1 } } },
    );
    t = await createTestContext();
    platform = aiFor(t.app);
    admin = await t.ownerCookie();
    alice = await t.login("student", "Alice");
    bob = await t.login("student", "Bob");

    const a = await insertStudy(t.db, alice.id, "語音情緒辨識研究");
    const b = await insertStudy(t.db, bob.id, "機器翻譯品質評估");
    Object.assign(ids, { studyA: a.id, studyB: b.id });
    Object.assign(slugs, { a: a.slug, b: b.slug });
    await t.db.query("UPDATE studies SET summary_md=$2 WHERE id=$1", [a.id, "以自監督模型分析**語者情緒**。"]);

    const note = async (who: Session, slug: string, title: string, content_md: string) => {
      const r = await send(who, "POST", `/api/studies/${slug}/notes`, { title, content_md, event_date: "2026-10-01" });
      expect(r.statusCode).toBe(201);
      return json(r).note.id as string;
    };
    ids.noteA = await note(alice, a.slug, "實驗紀錄 1", "## 方法\n\n我們使用 wav2vec 2.0 進行情緒的語音辨識實驗，資料集為 IEMOCAP。");
    ids.noteEn = await note(alice, a.slug, "Reading log", "Speech emotion recognition with self-supervised features works well on IEMOCAP.");
    ids.noteB = await note(bob, b.slug, "BLEU 分析", "比較 BLEU 與 COMET 分數，翻譯品質的評估方法。");
    ids.task = (await t.db.query("INSERT INTO tasks(study_id,title,created_by) VALUES($1,'整理語音辨識的錯誤分析',$2) RETURNING id", [a.id, alice.id])).rows[0].id;
    ids.paper = (
      await t.db.query(
        `INSERT INTO papers(record,type,title,title_norm,authors_text,year,abstract,added_by)
         VALUES('{}','article-journal','wav2vec 2.0: Self-Supervised Learning of Speech Representations','wav2vec 20 selfsupervised learning of speech representations','Baevski, Alexei',2020,'We show for the first time that learning powerful representations from speech audio alone…',$1) RETURNING id`,
        [alice.id],
      )
    ).rows[0].id;
    await t.db.query("INSERT INTO study_papers(study_id,paper_id,cite_key,notes_md,added_by) VALUES($1,$2,'baevski2020',$3,$4)", [a.id, ids.paper, "可以拿來當情緒辨識的特徵抽取器。", alice.id]);
    ids.meeting = (await t.db.query("INSERT INTO meetings(title,held_at,notes,created_by) VALUES('十月組會','2026-10-15T06:00:00Z','',$1) RETURNING id", [alice.id])).rows[0].id;
    await t.db.query("INSERT INTO meeting_studies(meeting_id,study_id) VALUES($1,$2),($1,$3)", [ids.meeting, a.id, b.id]);
    const segments = [{ id: 0, start: 0, end: 4, text: "老師建議把資料增強的比較補上。" }, { id: 1, start: 4, end: 9, text: "下週要交口試簡報。" }];
    ids.transcript = (await t.db.query("INSERT INTO transcripts(meeting_id,source,segments) VALUES($1,'upload',$2) RETURNING id", [ids.meeting, JSON.stringify(segments)])).rows[0].id;
    await t.db.query("UPDATE meetings SET transcript_id=$2 WHERE id=$1", [ids.meeting, ids.transcript]);
  });

  afterAll(async () => {
    setSearchAccessFilter(null);
    await platform?.logger.flush();
    await t?.close();
    await emb.stop();
  });

  it("checks access and input", async () => {
    expect((await get(null, "/api/search?q=x")).statusCode).toBe(401);
    expect((await get(alice, "/api/search?q=x&types=bogus")).statusCode).toBe(400);
    expect((await get(alice, "/api/search?q=x&studyId=nope-nope")).statusCode).toBe(404);
    const empty = await find(alice, { q: "  " });
    expect(empty).toMatchObject({ groups: [], total: 0, search_mode: "keyword_only" });
    expect(json(await get(alice, "/api/search/status"))).toMatchObject({ search_mode: "keyword_only", types: ["study", "note", "paper", "meeting", "task", "milestone", "deck"] });
  });

  it("finds CJK substrings, relaxed bigram matches and mixed queries (keyword only)", async () => {
    const r = await find(alice, { q: "語音辨識" });
    expect(r.search_mode).toBe("keyword_only");
    expect(r.notice_zh).toBeTruthy();
    // Strict substring in the note, relaxed bigrams (語音 … 辨識) in the study title.
    const notes = group(r, "note");
    expect(notes.map((n) => n.id)).toContain(ids.noteA);
    expect(notes[0]).toMatchObject({ url: `/studies/${slugs.a}/notes/${ids.noteA}`, study: { id: ids.studyA, slug: slugs.a }, author: { id: alice.id, name: "Alice" }, matched: ["keyword"] });
    const [s, e] = notes[0].highlights[0];
    expect(notes[0].snippet.slice(s, e)).toBe("語音辨識");
    expect(group(r, "study").map((x) => x.id)).toEqual([ids.studyA]);
    expect(group(r, "task").map((x) => x.id)).toEqual([ids.task]);
    expect(group(r, "task")[0].url).toBe(`/studies/${slugs.a}?tab=tasks&task=${ids.task}`);
    // Two-character query.
    expect(group(await find(alice, { q: "辨識" }), "note").map((x) => x.id)).toContain(ids.noteA);
    // Mixed ASCII + CJK: every word must appear.
    expect(group(await find(alice, { q: "wav2vec 實驗" }), "note").map((x) => x.id)).toEqual([ids.noteA]);
    expect(group(await find(alice, { q: "BLEU 評估" }), "note").map((x) => x.id)).toEqual([ids.noteB]);
    // Papers: title, abstract and study reading notes; links depend on the study filter.
    const papers = group(await find(alice, { q: "特徵抽取" }), "paper");
    expect(papers).toHaveLength(1);
    expect(papers[0]).toMatchObject({ id: ids.paper, url: `/library/${ids.paper}`, meta: { year: 2020 } });
    // Meetings: transcript text, linked to every study of the meeting.
    const meetings = group(await find(alice, { q: "資料增強" }), "meeting");
    expect(meetings[0]).toMatchObject({ id: ids.meeting, url: `/meetings/${ids.meeting}`, study: null });
    expect(meetings[0].snippet).toContain("資料增強");
    expect(group(await find(alice, { q: "資料增強", studyId: slugs.b }), "meeting")).toHaveLength(1);
    const scoped = group(await find(alice, { q: "wav2vec", studyId: slugs.a }), "paper");
    expect(scoped[0].url).toBe(`/studies/${slugs.a}?tab=papers&paper=${ids.paper}`);
  });

  it("agent search tool uses the CJK-aware search service in keyword-only mode", async () => {
    const user = { id: alice.id, name: "Alice", role: "student", is_admin: false, is_owner: false } as any;
    const ctx = { app: t.app, db: t.db, user, source: "agent", conversationId: null, runId: null, autopilot: false } as any;
    // 「語音辨識」 is not a substring of the study title 「語音情緒辨識研究」: only the service's relaxed bigrams find it.
    const r = await getAgentTool("search")!.execute({ query: "語音辨識", types: ["study", "note"] }, ctx);
    const data = r.data as { mode: string; results: { type: string; id: string }[] };
    expect(data.mode).toBe("keyword");
    expect(data.results).toEqual(expect.arrayContaining([expect.objectContaining({ type: "study", id: ids.studyA }), expect.objectContaining({ type: "note", id: ids.noteA })]));
  });

  it("applies type, study, author and date filters", async () => {
    const onlyNotes = await find(alice, { q: "語音", types: "note" });
    expect(onlyNotes.groups.map((g: { type: string }) => g.type)).toEqual(["note"]);
    expect(group(await find(alice, { q: "語音", studyId: slugs.b }), "note")).toHaveLength(0);
    expect(group(await find(bob, { q: "翻譯", author: "me" }), "note").map((x) => x.id)).toEqual([ids.noteB]);
    expect(group(await find(alice, { q: "翻譯", author: "me" }), "note")).toHaveLength(0);
    expect(group(await find(alice, { q: "語音", from: "2026-10-01", to: "2026-10-01", types: "note" }), "note").length).toBeGreaterThan(0);
    expect(group(await find(alice, { q: "語音", from: "2026-10-02", types: "note" }), "note")).toHaveLength(0);
    const limited = await find(alice, { q: "IEMOCAP", types: "note", limit: "1" });
    expect(limited.groups[0]).toMatchObject({ has_more: true });
    expect(limited.groups[0].results).toHaveLength(1);
  });

  it("honours the access filter hook", async () => {
    setSearchAccessFilter(async () => ({ studyIds: [ids.studyB] }));
    try {
      const r = await find(alice, { q: "語音" });
      expect(group(r, "note")).toHaveLength(0);
      expect(group(r, "study")).toHaveLength(0);
      expect(group(await find(alice, { q: "特徵抽取" }), "paper").length).toBe(1); // lab-wide content stays visible
      expect(group(await find(alice, { q: "翻譯" }), "note")).toHaveLength(1);
    } finally {
      setSearchAccessFilter(null);
    }
  });

  it("keeps the notes list on its own keyword search while semantic search is off", async () => {
    const r = json(await get(alice, `/api/studies/${slugs.a}/notes?q=${encodeURIComponent("語音")}`));
    expect(r.search_mode).toBe("keyword");
  });

  it("indexes every source when the embedding role is bound and searches semantically", async () => {
    const prov = await send(admin, "POST", "/api/admin/ai/providers", { family: "llm", kind: "openai-compatible", name: "mock embed", config: { baseUrl: `${emb.url}/v1` }, secrets: { apiKey: "sk-mock" } });
    expect(prov.statusCode).toBe(201);
    const route = await send(admin, "POST", "/api/admin/ai/routes", { name: "嵌入", capability: "embedding", strategy: "single", members: [{ provider_id: json(prov).provider.id, model: "mock-embed" }] });
    expect(route.statusCode).toBe(201);
    const bind = json(await send(admin, "PUT", "/api/admin/ai/roles/embedding", { route_id: json(route).route.id }));
    expect(bind.created_space).toMatchObject({ status: "active", dims: DIMS });
    ids.space = bind.created_space.id;

    const runner = new AiJobRunner(t.db, t.storage, platform, t.app.log, { heartbeatMs: 60_000 });
    const job = (await runner.claim())!;
    expect(job.kind).toBe("ai_embedding_reindex");
    expect(await runner.execute(job)).toBe("succeeded");
    const owners = (await t.db.query("SELECT owner_type, count(DISTINCT owner_id)::int AS n FROM embeddings WHERE space_id=$1 GROUP BY 1 ORDER BY 1", [ids.space])).rows;
    expect(owners).toEqual([
      { owner_type: "meeting", n: 1 },
      { owner_type: "note", n: 3 },
      { owner_type: "paper", n: 1 },
      { owner_type: "study", n: 2 },
      { owner_type: "study_paper", n: 1 },
      { owner_type: "transcript", n: 1 },
    ]);

    // Keyword misses this (no word is a substring of any document); the mock embedder's n-gram overlap finds the English note.
    const kwOnly = await find(alice, { q: "emotional recognizer for speeches", mode: "keyword", types: "note" });
    expect(group(kwOnly, "note")).toHaveLength(0);
    const r = await find(alice, { q: "emotional recognizer for speeches", types: "note" });
    expect(r).toMatchObject({ search_mode: "semantic", notice_zh: null });
    const hit = group(r, "note")[0];
    expect(hit).toMatchObject({ id: ids.noteEn, matched: ["semantic"] });
    expect(hit.snippet).toContain("Speech emotion recognition");
    // Hybrid: keyword + semantic agree → fused first.
    const both = group(await find(alice, { q: "wav2vec 語音辨識實驗", types: "note" }), "note");
    expect(both[0]).toMatchObject({ id: ids.noteA, matched: ["keyword", "semantic"] });
    // Semantic hits respect filters and the access hook too.
    expect(group(await find(alice, { q: "emotional recognizer for speeches", types: "note", studyId: slugs.b }), "note")).toHaveLength(0);
    setSearchAccessFilter(async () => ({ studyIds: [ids.studyB] }));
    expect(group(await find(alice, { q: "emotional recognizer for speeches", types: "note" }), "note")).toHaveLength(0);
    setSearchAccessFilter(null);
    // The notes list uses the hybrid provider now.
    const list = json(await get(alice, `/api/studies/${slugs.a}/notes?q=${encodeURIComponent("emotional recognizer for speeches")}`));
    expect(list.search_mode).toBe("semantic");
    expect(list.notes.map((n: { id: string }) => n.id)).toContain(ids.noteEn);
    expect(json(await get(alice, "/api/search/status")).search_mode).toBe("semantic");
  });

  it("re-embeds changed content through the queue and forgets deleted content", async () => {
    await t.db.query("UPDATE notes SET content_md=$2 WHERE id=$1", [ids.noteEn, "Dysarthric speech assessment using articulatory features."]);
    const queued = (await t.db.query("SELECT owner_type FROM search_index_queue WHERE owner_id=$1", [ids.noteEn])).rows;
    expect(queued).toEqual([{ owner_type: "note" }]);
    const job = (await t.db.query("SELECT id, run_after > now() AS later FROM jobs WHERE kind='ai_search_index' AND status='queued'")).rows;
    expect(job).toHaveLength(1);
    expect(job[0].later).toBe(true); // debounced
    // Run it through the ai-worker runner.
    await t.db.query("UPDATE jobs SET run_after=now() WHERE id=$1", [job[0].id]);
    await t.db.query("UPDATE search_index_queue SET enqueued_at=now() - interval '1 minute'");
    const runner = new AiJobRunner(t.db, t.storage, platform, t.app.log, { heartbeatMs: 60_000 });
    const claimed = (await runner.claim())!;
    expect(claimed.kind).toBe("ai_search_index");
    expect(await runner.execute(claimed)).toBe("succeeded");
    expect((await t.db.query("SELECT result FROM jobs WHERE id=$1", [claimed.id])).rows[0].result).toMatchObject({ owners: 1, chunks: 1 });
    expect((await t.db.query("SELECT count(*)::int AS n FROM search_index_queue")).rows[0].n).toBe(0);
    const r = group(await find(alice, { q: "articulatory assessment of dysarthria", types: "note" }), "note");
    expect(r[0]?.id).toBe(ids.noteEn);

    // Unchanged content: nothing re-embedded.
    await t.db.query("SELECT search_enqueue('note', $1)", [ids.noteEn]);
    expect(await drainSearchQueue(t.db, platform, { quietSeconds: 0 })).toMatchObject({ owners: 1, chunks: 0 });

    // Deleting removes the vectors at once.
    expect((await send(alice, "DELETE", `/api/notes/${ids.noteEn}`)).statusCode).toBeLessThan(300);
    expect((await t.db.query("SELECT count(*)::int AS n FROM embeddings WHERE owner_id=$1", [ids.noteEn])).rows[0].n).toBe(0);
  });

  it("degrades to keyword search when embedding the query fails", async () => {
    embDown = true;
    try {
      const r = await find(alice, { q: "語音情緒 分析方法" });
      expect(r.search_mode).toBe("keyword_only");
      expect(r.notice_zh).toBeTruthy();
      const notes = json(await get(alice, `/api/studies/${slugs.a}/notes?q=${encodeURIComponent("情緒")}`));
      expect(notes.search_mode).toBe("keyword");
      expect(notes.notes.map((n: { id: string }) => n.id)).toContain(ids.noteA);
    } finally {
      embDown = false;
    }
  });

  it("reports keyword_only once the embedding role is unbound", async () => {
    expect((await send(admin, "PUT", "/api/admin/ai/roles/embedding", { route_id: null })).statusCode).toBe(200);
    const r = await find(alice, { q: "emotion speech" });
    expect(r.search_mode).toBe("keyword_only");
    expect(r.notice_zh).toContain("尚未設定語意搜尋");
  });
});
