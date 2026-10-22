/**
 * Paper reading in the agent (scripted mock model, mock scholarly APIs, real DB + S3): import_paper fetches the
 * open-access PDF at once (and queues a job when slow), POST /library/papers does too, read_paper (TOC → sections →
 * pagination, sidecar cache), view_paper_pages (images to a vision model / a note without vision), fetch_paper_pdf
 * permissions, create_deck (deck + tree + ai_slides_generate job; advisors refused), and 「整理成筆記」 (intent
 * make_note: the model gets the task + the user's earlier questions and writes them into the note).
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LightMyRequestResponse } from "fastify";
import type { ChatEvent } from "../src/ai/types.js";
import { agentFor, type ModelCall } from "../src/agent/runtime.js";
import type { RoleChatRequest } from "../src/ai/platform/index.js";
import { createLibraryService, RateLimiter } from "../src/lib/library/index.js";
import { setLibraryServiceFactory } from "../src/lib/library/settings.js";
import { autoFetchPdf, setAutoPdfService } from "../src/lib/library/auto-pdf.js";
import { clearFullTextMemo, fulltextKey } from "../src/lib/library/fulltext.js";
import { setPageRenderer } from "../src/lib/library/page-images.js";
import { setSlidesReady } from "../src/agent/tools/deck-create.js";
import { getPaper } from "../src/lib/library/store.js";
import { LIBRARY_IMPORT_JOB } from "../src/ai-jobs/library/kinds.js";
import { createTestContext, hasTestDb, hasTestS3, ORIGIN, type TestContext } from "./helpers.js";
import { addStudyMember, insertStudy } from "./study-fixtures.js";
import { fixture, mockServer, sendJson, sendText } from "./library-fixtures/helpers.js";
import { PAPER_PDF } from "./library-fixtures/paper-pdf.js";
import { progressContext } from "../src/lib/slides/ai-context.js";

process.env.PROVIDER_TOKEN_KEY ??= randomBytes(32).toString("base64");
const run = hasTestDb && hasTestS3 ? describe : describe.skip;
const fast = () => new RateLimiter({ intervalMs: 1, burst: 50, concurrency: 10 });
const DOI = "10.21437/interspeech.2020-3015";

type Step = ChatEvent[] | ((req: RoleChatRequest) => ChatEvent[]);
let ids = 0;
const calls = (...list: [string, unknown][]): ChatEvent[] => [
  ...list.flatMap(([name, input]) => {
    const id = `call_${++ids}`;
    return [{ type: "tool_call_start", index: 0, id, name } as ChatEvent, { type: "tool_call_end", index: 0, id, name, input, argsJson: JSON.stringify(input) } as ChatEvent];
  }),
  { type: "done", stopReason: "tool_use" },
];
const say = (text: string): ChatEvent[] => [{ type: "text_delta", text }, { type: "done", stopReason: "end_turn" }];

run("paper reading tools", () => {
  let t: TestContext;
  let alice: { id: string; cookie: string };
  let outsider: { id: string; cookie: string };
  let prof: { id: string; cookie: string };
  let study: { id: string; slug: string };
  let srv: Awaited<ReturnType<typeof mockServer>>;
  let slowPdf = false;
  let script: Step[] = [];
  const requests: RoleChatRequest[] = [];
  let vision = true;
  const json = (r: LightMyRequestResponse) => r.json() as Record<string, any>;
  const post = (who: { cookie: string }, url: string, payload: object = {}) => t.app.inject({ method: "POST", url, headers: { origin: ORIGIN, cookie: who.cookie }, payload });
  const get = (who: { cookie: string }, url: string) => t.app.inject({ method: "GET", url, headers: { cookie: who.cookie } });
  const runtime = () => agentFor(t.app);
  const model: ModelCall = async function* (req) {
    requests.push(req);
    const step = script.shift() ?? say("（完）");
    for (const e of typeof step === "function" ? step(req) : step) yield e;
  };
  const newConv = async (who = alice) => json(await post(who, "/api/agent/conversations", {})).conversation.id as string;
  async function send(conv: string, text: string, who = alice, extra: object = {}) {
    const r = await post(who, `/api/agent/conversations/${conv}/messages`, { text, context: { path: `/studies/${study.slug}`, studySlug: study.slug }, ...extra });
    expect(r.statusCode, r.body).toBe(202);
    await runtime().settle();
  }
  const state = async (conv: string, who = alice) => json(await get(who, `/api/agent/conversations/${conv}`));
  async function approveAll(conv: string, who = alice) {
    for (let i = 0; i < 5; i++) {
      const s = await state(conv, who);
      const pending = s.toolCalls.filter((c: any) => c.status === "pending_approval");
      if (!pending.length) return s;
      for (const c of pending) await post(who, `/api/agent/tool-calls/${c.id}/decision`, { decision: "approve" });
      await runtime().settle();
    }
    return state(conv, who);
  }
  const resultText = (req: RoleChatRequest, tool: string) => {
    for (const m of [...req.messages].reverse()) {
      if (m.role !== "tool" || !Array.isArray(m.content)) continue;
      for (const b of m.content as any[]) {
        const text = typeof b.content === "string" ? b.content : b.content.find((c: any) => c.type === "text")?.text;
        if (text?.includes(`tool="${tool}"`)) return { text: text as string, block: b };
      }
    }
    return null;
  };

  beforeAll(async () => {
    srv = await mockServer(async (req, res) => {
      const p = req.url.pathname;
      if (p.startsWith("/crossref/works/")) {
        const doi = decodeURIComponent(p.slice("/crossref/works/".length)).toLowerCase();
        return doi === DOI ? sendJson(res, fixture("crossref-work.json")) : sendText(res, "nf", "text/plain", 404);
      }
      if (p.startsWith("/unpaywall/")) {
        const doi = decodeURIComponent(p.slice("/unpaywall/".length)).toLowerCase();
        if (doi === DOI || doi === "10.9999/slow.1") return sendJson(res, { doi, is_oa: true, best_oa_location: { url_for_pdf: `${srv.url}/files/${doi === DOI ? "paper" : "slow"}.pdf` } });
        return sendJson(res, { message: "nf" }, 404);
      }
      if (p === "/files/paper.pdf") return sendText(res, PAPER_PDF, "application/pdf");
      if (p === "/files/slow.pdf") {
        if (slowPdf) await new Promise((r) => setTimeout(r, 1500));
        return sendText(res, PAPER_PDF, "application/pdf");
      }
      sendJson(res, { error: p }, 404);
    });
    const factory = (config: Parameters<typeof createLibraryService>[0] = {}) =>
      createLibraryService({
        ...config,
        unpaywallEmail: "speech-ai-hub@example.org",
        baseUrls: { crossref: `${srv.url}/crossref`, openalex: `${srv.url}/openalex`, arxiv: `${srv.url}/arxiv`, unpaywall: `${srv.url}/unpaywall`, isca: `${srv.url}/isca`, acl: `${srv.url}/acl`, s2: `${srv.url}/s2` },
        limiters: { crossref: fast(), openalex: fast(), arxiv: fast(), unpaywall: fast(), isca: fast(), acl: fast(), s2: fast(), download: fast() },
        allowPrivateDownloads: true,
      });
    setLibraryServiceFactory(factory);
    t = await createTestContext();
    await t.db.query("INSERT INTO system_settings(key,value) VALUES('library.contact_email', '\"speech-ai-hub@example.org\"') ON CONFLICT (key) DO NOTHING");
    alice = await t.login("student", "Alice");
    outsider = await t.login("student", "Outsider");
    prof = await t.login("professor", "Prof");
    study = await insertStudy(t.db, alice.id, "語音情緒辨識");
    await addStudyMember(t.db, study.id, prof.id, "advisor");
    const rt = runtime();
    rt.options.model = model;
    rt.options.fast = async () => "論文討論";
    rt.options.vision = async () => vision;
    setSlidesReady(async () => true);
  });
  afterAll(async () => {
    await runtime().settle();
    setLibraryServiceFactory(undefined);
    setAutoPdfService(null);
    setPageRenderer(null);
    setSlidesReady(null);
    await srv?.close();
    await t?.close();
  });
  beforeEach(() => {
    script = [];
    requests.length = 0;
    vision = true;
  });

  let paperId = "";

  it("import_paper fetches the open-access PDF right away and reports has_pdf", async () => {
    const conv = await newConv();
    script = [calls(["import_paper", { study: study.slug, identifier: DOI }]), say("已匯入。")];
    await send(conv, "幫我匯入這篇論文");
    const s = await approveAll(conv);
    const call = s.toolCalls.find((c: any) => c.tool === "import_paper");
    expect(call.status, JSON.stringify(call)).toBe("done");
    expect(call.result.data.paper.has_pdf).toBe(true);
    expect(call.result.data.pdf.status).toBe("stored");
    paperId = call.result.data.paper.id;
    const paper = await getPaper(t.db, paperId);
    expect(paper!.pdf_key).toMatch(/^library\/papers\//);
    expect(resultText(requests.at(-1)!, "import_paper")!.text).toContain("read_paper");
  });

  it("slow downloads continue as an ai_library_import job (queued, has_pdf false)", async () => {
    const row = (await t.db.query<{ id: string }>("INSERT INTO papers(type,title,title_norm,record,doi,doi_key,added_by) VALUES('article-journal','Slow Paper','slow paper',$1,'10.9999/slow.1','10.9999/slow.1',$2) RETURNING id", [JSON.stringify({ type: "article-journal", title: "Slow Paper", authors: [], doi: "10.9999/slow.1" }), alice.id])).rows[0]!;
    const paper = (await getPaper(t.db, row.id))!;
    slowPdf = true;
    try {
      const out = await autoFetchPdf(t.db, t.storage, paper, alice.id, { budgetMs: 300 });
      expect(out.status).toBe("queued");
      const job = (await t.db.query("SELECT kind,payload FROM jobs WHERE id=$1", [out.jobId])).rows[0];
      expect(job).toMatchObject({ kind: LIBRARY_IMPORT_JOB, payload: { batchId: null, paperIds: [row.id], userId: alice.id } });
    } finally {
      slowPdf = false;
    }
  });

  it("POST /library/papers by identifier also fetches the PDF (existing paper: exists)", async () => {
    const r = await post(alice, "/api/library/papers", { identifier: DOI });
    expect(r.statusCode, r.body).toBe(200);
    expect(json(r).paper.has_pdf).toBe(true);
    expect(json(r).pdf.status).toBe("exists");
  });

  it("read_paper: TOC first, then a section with subsections, paginated; extraction cached in an S3 sidecar", async () => {
    clearFullTextMemo();
    const conv = await newConv();
    script = [
      calls(["read_paper", { paper_id: paperId }]),
      calls(["read_paper", { paper_id: paperId, section: "3" }]),
      calls(["read_paper", { paper_id: paperId, section: "2", max_chars: 1000, offset: 40 }]),
      say("讀完了。"),
    ];
    await send(conv, "解釋這篇論文的方法");
    const toc = resultText(requests[1]!, "read_paper")!.text;
    expect(toc).toContain('trust="untrusted"');
    expect(toc).toContain("目錄");
    expect(toc).toMatch(/\[s\d+\] 3 Method（p\. 2/);
    expect(toc).not.toContain("Baevski"); // references dropped
    expect(toc).toContain("view_paper_pages"); // vision available: look at equations
    const method = resultText(requests[2]!, "read_paper")!.text;
    expect(method).toContain("## 3 Method（p. 2–3）");
    expect(method).toContain("L = -sum y log p");
    expect(method).toContain("### 3.1 Training（p. 3）");
    expect(method).toContain("We train for 10 epochs");
    const page = resultText(requests[3]!, "read_paper")!.text;
    expect(page).toContain("［從 offset 40］");
    const paper = (await getPaper(t.db, paperId))!;
    const side = await t.storage.getBuffer(fulltextKey(paper.pdf_key!));
    expect(JSON.parse(side!.toString()).sections.length).toBeGreaterThan(5);
    // Cached: works from the sidecar even when the PDF object is unreadable.
    const original = await t.storage.getBuffer(paper.pdf_key!);
    await t.storage.put(paper.pdf_key!, Buffer.from("not a pdf"), "application/pdf");
    clearFullTextMemo();
    script = [calls(["read_paper", { paper_id: paperId, section: "experiments" }]), say("ok")];
    await send(conv, "實驗結果？");
    expect(resultText(requests.at(-1)!, "read_paper")!.text).toContain("71.2%");
    await t.storage.put(paper.pdf_key!, original!, "application/pdf");
  });

  it("view_paper_pages sends page images to a vision model; without vision it says so", async () => {
    const rendered: unknown[] = [];
    setPageRenderer(async (_pdf, reqs) => {
      rendered.push(reqs);
      return reqs.map((r) => Buffer.from(`jpeg-${r.page}`));
    });
    const conv = await newConv();
    script = [calls(["view_paper_pages", { paper_id: paperId, pages: [2], regions: [{ page: 2, top: 0.6, bottom: 0.2 }] }]), say("公式是交叉熵。")];
    await send(conv, "第 2 頁的公式是什麼意思？");
    expect(rendered).toEqual([[{ page: 2, width: 1200 }, { page: 2, width: 1400, crop: { top: 0.2, bottom: 0.6 } }]]);
    const hit = resultText(requests.at(-1)!, "view_paper_pages")!;
    const imgs = (hit.block.content as any[]).filter((c) => c.type === "image");
    expect(imgs).toHaveLength(2);
    expect(imgs[0].source).toEqual({ kind: "base64", mediaType: "image/jpeg", data: Buffer.from("jpeg-2").toString("base64") });
    const s = await state(conv);
    expect(s.toolCalls[0].result.data).toMatchObject({ images: 2, vision: true });
    expect(JSON.stringify(s.toolCalls[0])).not.toContain("hub-s3:"); // storage keys stay server-side
    // Too many pages / missing pages are refused.
    script = [calls(["view_paper_pages", { paper_id: paperId, pages: [9] }]), say("ok")];
    await send(conv, "第 9 頁？");
    expect(resultText(requests.at(-1)!, "view_paper_pages")!.text).toContain("只有 3 頁");

    vision = false;
    const c2 = await newConv();
    script = [calls(["view_paper_pages", { paper_id: paperId, pages: [1] }]), say("ok")];
    await send(c2, "看第一頁");
    const noVision = resultText(requests.at(-1)!, "view_paper_pages")!;
    expect(noVision.text).toContain("無法看圖");
    expect(typeof noVision.block.content).toBe("string");
    // Earlier images in the first conversation are not sent once the model cannot see them.
    script = [say("ok")];
    await send(conv, "再說一次");
    expect(JSON.stringify(requests.at(-1)!.messages)).not.toContain(Buffer.from("jpeg-2").toString("base64"));
    expect(JSON.stringify(requests.at(-1)!.messages)).toContain("無法看圖");
  });

  it("fetch_paper_pdf needs paper edit rights", async () => {
    const conv = await newConv(outsider);
    script = [calls(["fetch_paper_pdf", { paper_id: paperId }]), say("無法")];
    await send(conv, "下載全文", outsider);
    const s = await state(conv, outsider);
    expect(s.toolCalls[0]).toMatchObject({ tool: "fetch_paper_pdf", status: "failed" });
    expect(s.toolCalls[0].error).toContain("只有加入這篇文獻的人");
    // The adder: already has a PDF.
    const c2 = await newConv();
    script = [calls(["fetch_paper_pdf", { paper_id: paperId }]), say("ok")];
    await send(c2, "下載全文");
    const s2 = await approveAll(c2);
    expect(s2.toolCalls[0].result.data).toMatchObject({ has_pdf: true, status: "exists" });
  });

  it("create_deck creates a paper-report deck with a source tree and queues the AI draft; advisors are refused", async () => {
    const conv = await newConv();
    const structure = "1. 研究問題 2. 方法（式 1 的交叉熵）3. 實驗 71.2%";
    script = [calls(["create_deck", { study: study.slug, kind: "paper_report", paper_id: paperId, instructions: structure }]), say("已建立。")];
    await send(conv, "幫我做這篇論文的報告簡報");
    let s = await state(conv);
    expect(s.toolCalls[0]).toMatchObject({ tool: "create_deck", status: "pending_approval", risk: "write" });
    s = await approveAll(conv);
    const data = s.toolCalls[0].result.data;
    expect(data.draft).toBe("queued");
    expect(data.deck.url).toBe(`/studies/${study.slug}/decks/${data.deck.id}`);
    const deck = (await t.db.query("SELECT kind,paper_id,title FROM decks WHERE id=$1", [data.deck.id])).rows[0];
    expect(deck).toMatchObject({ kind: "paper_report", paper_id: paperId });
    expect((await t.db.query("SELECT 1 FROM deck_source_trees WHERE deck_id=$1", [data.deck.id])).rowCount).toBe(1);
    const job = (await t.db.query("SELECT payload,created_by FROM jobs WHERE id=$1", [data.job_id])).rows[0];
    expect(job.payload).toMatchObject({ deckId: data.deck.id, mode: "paper_report", userId: alice.id, instructions: structure });

    const c2 = await newConv(prof);
    script = [calls(["create_deck", { study: study.slug, kind: "progress" }]), say("不行")];
    await send(c2, "做一份進度報告", prof);
    const s2 = await state(c2, prof);
    expect(s2.toolCalls[0].status).toBe("failed");
    expect(s2.toolCalls[0].error).toContain("〈語音情緒辨識〉的指導教授");
  });

  it("「整理成筆記」 sends the task with the conversation; the note keeps the user's questions", async () => {
    const conv = await newConv();
    script = [say("交叉熵是在比較預測分布 $p$ 和標籤 $y$。")];
    await send(conv, "式 (1) 裡的 y 和 p 分別是什麼？為什麼要取 log？");
    let seen: RoleChatRequest | null = null;
    script = [
      (req) => {
        seen = req;
        // The mock "model" writes the note from the user questions it can see in the transcript.
        const questions = req.messages.filter((m) => m.role === "user").flatMap((m) => (m.content as any[]).map((b) => b.text as string)).filter((x) => x.includes("？"));
        return calls(["create_note", { study: study.slug, title: "閱讀筆記：Tiny Transformers", template: "reading", content_md: `## 我的疑問與解答\n\n**Q：** ${questions[0]}\n**A：** $$L = -\\sum_i y_i \\log p_i$$` }]);
      },
      say("筆記已建立。"),
    ];
    const r = await post(alice, `/api/agent/conversations/${conv}/messages`, { text: "請把我們這段對話整理成一篇閱讀筆記。", intent: "make_note" });
    expect(r.statusCode, r.body).toBe(202);
    await runtime().settle();
    const last = JSON.stringify(seen!.messages.at(-1));
    expect(last).toContain('<task kind=\\"make_note\\"');
    expect(last).toContain("我的疑問與解答");
    const s = await approveAll(conv);
    // the UI shows only the user's text
    expect(s.messages.filter((m: any) => m.role === "user").at(-1).text).toBe("請把我們這段對話整理成一篇閱讀筆記。");
    const note = (await t.db.query<{ content_md: string }>("SELECT content_md FROM notes WHERE study_id=$1 AND title='閱讀筆記：Tiny Transformers'", [study.id])).rows[0]!;
    expect(note.content_md).toContain("式 (1) 裡的 y 和 p 分別是什麼？");
    expect(note.content_md).toContain("\\log p_i");
    // regenerate keeps the task
    script = [say("好")];
    const regen = await post(alice, `/api/agent/conversations/${conv}/regenerate`);
    expect(regen.statusCode, regen.body).toBe(202);
    await runtime().settle();
    expect(JSON.stringify(requests.at(-1)!.messages.at(-1))).toContain("make_note");
    // unknown intents are rejected
    const bad = await post(alice, `/api/agent/conversations/${conv}/messages`, { text: "x", intent: "delete_all" });
    expect(bad.statusCode).toBe(400);
  });

  it("an empty / cut-off reply is retried once with a nudge; still cut off → notice limit_output with 「繼續」", async () => {
    const conv = await newConv();
    script = [[{ type: "reasoning_delta", text: "想很久".repeat(50) }, { type: "done", stopReason: "max_tokens" }] as ChatEvent[], say("這是直接的回答。")];
    await send(conv, "解釋一下 attention");
    let s = await state(conv);
    expect(s.messages.filter((m: any) => m.role === "assistant").at(-1).text).toBe("這是直接的回答。");
    expect(JSON.stringify(requests[1]!.messages.at(-1))).toContain("系統提示");
    expect(requests[1]!.maxTokens).toBeGreaterThanOrEqual(12000);
    expect(requests[1]!.reasoning).toEqual({ effort: "low" });
    expect(s.run.status).toBe("done");

    script = [[{ type: "text_delta", text: "第一段" }, { type: "done", stopReason: "max_tokens" }] as ChatEvent[], [{ type: "text_delta", text: "第一段，還沒" }, { type: "done", stopReason: "max_tokens" }] as ChatEvent[]];
    await send(conv, "再詳細一點");
    s = await state(conv);
    expect(s.run.stop_reason).toBe("limit_output");
    expect(s.messages.at(-1)).toMatchObject({ role: "notice", kind: "limit_output" });
    expect(s.messages.filter((m: any) => m.role === "assistant").at(-1).text).toBe("第一段，還沒");
  });

  it("get_deck_pages reads titles, notes and (with vision) page images; layout reviews need edit rights", async () => {
    const deck = (await t.db.query<{ id: string }>("INSERT INTO decks(study_id,kind,title,slug,share_key,created_by,updated_by) VALUES($1,'progress','週報','weekly-pages-test','sk-pages-test',$2,$2) RETURNING id", [study.id, alice.id])).rows[0]!;
    const prefix = `slides/${deck.id}/v1/output/`;
    const v = (await t.db.query<{ id: string }>(
      "INSERT INTO slide_versions(deck_id,version,source_type,entry_qmd,source_name,source_key,output_prefix,status,page_count,manifest_key,created_by) VALUES($1,1,'pdf','','a.pdf','x',$2,'published',2,$3,$4) RETURNING id",
      [deck.id, prefix, `${prefix}_hub/pages.json`, alice.id],
    )).rows[0]!;
    await t.db.query("UPDATE decks SET active_version_id=$2 WHERE id=$1", [deck.id, v.id]);
    await t.storage.put(`${prefix}_hub/pages.json`, Buffer.from(JSON.stringify({ version: 1, sourceType: "pdf", width: 16, height: 9, pages: [{ index: 1, title: "動機", thumb: "x", notes: { text: "先講問題" } }, { index: 2, title: "結果", thumb: "y" }] })), "application/json");
    await t.storage.put(`${prefix}_hub/pages/2-full.webp`, Buffer.from("RIFFxxxxWEBPVP8 "), "image/webp");
    const conv = await newConv();
    script = [calls(["get_deck_pages", { deck_id: deck.id, images: [2] }]), say("ok")];
    await send(conv, "看看我的簡報第 2 頁");
    const hit = resultText(requests.at(-1)!, "get_deck_pages")!;
    expect(hit.text).toContain("先講問題");
    expect(hit.text).toContain("結果");
    expect((hit.block.content as any[]).filter((c) => c.type === "image")).toHaveLength(1);

    const c2 = await newConv(prof);
    script = [calls(["review_deck_layout", { deck_id: deck.id }]), say("no")];
    await send(c2, "檢查排版", prof);
    const s2 = await state(c2, prof);
    expect(s2.toolCalls[0]).toMatchObject({ tool: "review_deck_layout", status: "failed" });
    expect(s2.toolCalls[0].error).toContain("不是〈語音情緒辨識〉的成員");
  });

  it("progress drafts include recent meeting feedback", async () => {
    const m = (await t.db.query<{ id: string }>("INSERT INTO meetings(title,held_at,created_by) VALUES('週會',now() - interval '3 days',$1) RETURNING id", [alice.id])).rows[0]!;
    await t.db.query("INSERT INTO meeting_studies(meeting_id,study_id) VALUES($1,$2)", [m.id, study.id]);
    await t.db.query("INSERT INTO meeting_feedback(meeting_id,author_id,body_md) VALUES($1,$2,'請補上 IEMOCAP 的混淆矩陣')", [m.id, prof.id]);
    const deck = (await t.db.query<{ id: string }>("SELECT id FROM decks WHERE study_id=$1 LIMIT 1", [study.id])).rows[0]!;
    const text = await progressContext(t.db, deck.id, study.id);
    expect(text).toContain("最近會議中的回饋");
    expect(text).toContain("請補上 IEMOCAP 的混淆矩陣");
  });

  it("a run left awaiting approval with only approved calls (approval raced the wait) is resumed by the ticker", async () => {
    const conv = await newConv();
    script = [calls(["create_task", { study: study.slug, title: "比對 baseline" }]), say("已建立。")];
    await send(conv, "新增待辦：比對 baseline");
    let s = await state(conv);
    expect(s.run.status).toBe("awaiting_approval");
    // Simulate the race: the call got approved but the run was not flipped back to running.
    await t.db.query("UPDATE tool_calls SET status='approved', approved_via='user', decided_at=now() WHERE id=$1", [s.toolCalls[0].id]);
    await t.db.query("UPDATE agent_runs SET updated_at=now() - interval '1 minute' WHERE id=$1", [s.run.id]);
    await runtime().tick();
    await runtime().settle();
    s = await state(conv);
    expect(s.run.status).toBe("done");
    expect(s.toolCalls[0].status).toBe("done");
  });
});
