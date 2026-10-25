/**
 * Long outputs as units through the real engine (scripted mock model, stubbed scholarly search / import, a fake preview
 * worker): a note whose section unit is cut at the output limit is continued alone (no fix round, no other unit redone),
 * a unit failing its check gets a fix round of only that unit, the note is stitched by code in outline order; and the
 * topic deck pipeline — thin library → one keyword search batch → picks → per-paper extraction steps (after approval) →
 * a survey outline with layouts / roles / source papers → page-by-page writers that see only their pages' sources →
 * deterministic per-page source lines in the deck.
 */
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ChatResult } from "../src/ai/types.js";
import { runWorkflow } from "../src/workflows/engine.js";
import { approveWorkflow, createWorkflow } from "../src/workflows/service.js";
import { getRun, getSteps } from "../src/workflows/store.js";
import { setTopicResearchDeps, type OnlineHit } from "../src/workflows/playbooks/research.js";
import { addPaperToStudy, insertPaper } from "../src/lib/library/store.js";
import type { ModelPort } from "../src/workflows/types.js";
import { createTestContext, hasTestDb, hasTestS3, type TestContext } from "./helpers.js";
import { insertStudy } from "./study-fixtures.js";
import { setWorkflowAvailability } from "../src/routes/workflows.js";

process.env.PROVIDER_TOKEN_KEY ??= randomBytes(32).toString("base64");
const integration = hasTestDb && hasTestS3 ? describe : describe.skip;

type Req = { messages: { role: string; content: unknown }[] };
type Out = string | { text: string; stopReason: ChatResult["stopReason"] };
const result = (o: Out): ChatResult => {
  const text = typeof o === "string" ? o : o.text;
  return { text, reasoning: "", toolCalls: [], stopReason: typeof o === "string" ? "end_turn" : o.stopReason, usage: { inputTokens: 100, outputTokens: 50 }, message: { role: "assistant", content: text } };
};
const userText = (req: Req) => req.messages.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
const allPass = (req: Req) => JSON.stringify({ results: [...userText(req).matchAll(/- \[([a-z0-9_]+)\]/g)].map((m) => ({ id: m[1], pass: true, evidence: "內容", reason: "ok" })) });

function mockModel(replies: Record<string, (req: Req) => Out>) {
  const log: { purpose: string; prompt: string }[] = [];
  const port: ModelPort = {
    async chat(_role, req, ctx) {
      log.push({ purpose: ctx.purpose, prompt: userText(req as Req) });
      const fn = replies[ctx.purpose] ?? replies["*"];
      return result(fn ? fn(req as Req) : "{}");
    },
    available: async () => true,
    vision: async () => false,
  };
  return { port, log, count: (p: string) => log.filter((l) => l.purpose === p).length, prompts: (p: string) => log.filter((l) => l.purpose === p).map((l) => l.prompt) };
}

integration("workflow units", () => {
  let t: TestContext;
  let alice: { id: string; cookie: string };
  let study: { id: string; slug: string };
  let stop = false;
  let worker: Promise<void> | null = null;
  const asUser = async (id: string) => {
    const { toCurrentUser, CURRENT_USER_COLUMNS } = await import("../src/lib/auth.js");
    return toCurrentUser((await t.db.query(`SELECT ${CURRENT_USER_COLUMNS} FROM users u WHERE u.id=$1`, [id])).rows[0]);
  };
  const deps = (port: ModelPort) => ({ db: t.db, storage: t.storage, app: t.app, model: port, log: t.app.log, signal: new AbortController().signal, jobId: null, previewWaitMs: 15_000 });

  beforeAll(async () => {
    t = await createTestContext();
    alice = await t.login("student", "alice-units");
    study = await insertStudy(t.db, alice.id, "串流語音辨識");
    setWorkflowAvailability(async () => true);
    // Fake worker: completes preview renders, with screenshots + clean layout metrics when asked.
    worker = (async () => {
      while (!stop) {
        const jobs = (await t.db.query<{ id: string; payload: { previewId: string; deckId: string; shots?: boolean } }>("SELECT id, payload FROM jobs WHERE kind='slide_preview' AND status='queued'")).rows;
        for (const j of jobs) {
          const pv = (await t.db.query<{ output_prefix: string }>("UPDATE deck_previews SET status='ready', entry_html='index.html', finished_at=now() WHERE id=$1 RETURNING output_prefix", [j.payload.previewId])).rows[0];
          if (!j.payload.shots || !pv) {
            await t.db.query("UPDATE jobs SET status='succeeded', finished_at=now() WHERE id=$1", [j.id]);
            continue;
          }
          const qmd = (await t.db.query<{ content: string }>("SELECT content FROM deck_sources WHERE deck_id=$1 AND path='index.qmd'", [j.payload.deckId])).rows[0]?.content ?? "";
          const titles = ["", ...[...qmd.matchAll(/^## (.+?)(?:\s*\{[^}]*\})?$/gm)].map((x) => x[1]!.trim())];
          const metrics = { words: 20, bullets: 2, minFont: 22, maxFont: 40, overflowY: 0, overflowX: 0, visuals: 1, tables: 1, diagrams: 0, diagramErrors: 0, rawDiagramCode: 0, codeBlocks: 0, emptyBand: 0.1 };
          await t.storage.put(`${pv.output_prefix}_hub/shots.json`, Buffer.from(JSON.stringify({ version: 1, width: 1280, height: 800, total: titles.length, truncated: false, pages: titles.map((title, i) => ({ index: i + 1, h: i, title, metrics })) })), "application/json");
          await t.db.query("UPDATE jobs SET result=$2, status='succeeded', finished_at=now() WHERE id=$1", [j.id, JSON.stringify({ shots: { count: titles.length } })]);
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    })();
  });
  afterAll(async () => {
    stop = true;
    await worker;
    await t?.close();
  });

  const PAD = "這一段依據研究資料整理，說明各做法的核心想法、適用情境與限制，並保留原本的出處。";
  const BACKGROUND = `## 背景\n\n串流語音辨識常把罕見的專有名詞辨識錯，熱詞偏置讓解碼偏向使用者提供的清單，是常見的補救方式。${PAD}`;
  const METHOD_CUT = `## 方法\n\n淺層融合在解碼時對熱詞加分，不需要重新訓練模型。${PAD}深層偏置用注意力讀取熱詞清單，`;
  // The continuation restates the last words (models do): the overlap is dropped when joining.
  const METHOD_REST = "深層偏置用注意力讀取熱詞清單，需要和模型一起訓練，但對罕見詞的效果較好。\n";
  const COMPARE = `## 比較\n\n淺層融合簡單、不用重訓；深層偏置較準但要訓練，延遲也較高，需要依部署情境取捨。${PAD}`;

  it("a note: one section unit cut at the output limit is continued alone; a failing unit alone gets a fix round; stitched by code", async () => {
    let s3 = 0;
    const m = mockModel({
      plan_generic: () => JSON.stringify({ title: "熱詞方法筆記", objective: "整理熱詞方法", criteria: ["涵蓋兩種做法"], steps: [
        { key: "s1", title: "背景", role: "writer", section: "背景", chars: 600, instructions: "寫背景" },
        { key: "s2", title: "方法", role: "writer", section: "方法", chars: 1500, instructions: "寫方法", depends_on: ["s1"] },
        { key: "s3", title: "比較", role: "writer", section: "比較", chars: 800, instructions: "寫比較", depends_on: ["s1"] },
        // An integrator that would rewrite the whole note is dropped: the note is stitched by code.
        { key: "s4", title: "整合全文", role: "integrator", instructions: "整合成一份文件", depends_on: ["s2", "s3"] },
      ] }),
      "write:generic": (req) => {
        const u = userText(req);
        if (u.includes("寫方法")) return { text: METHOD_CUT, stopReason: "max_tokens" };
        if (u.includes("寫比較")) return ++s3 === 1 ? `## 比較\n\n兩種做法的比較：TODO 之後補上。${PAD}` : COMPARE;
        return BACKGROUND;
      },
      "write:generic:continue": () => METHOD_REST,
      verify: () => '{"verdict":"pass","issues":[]}',
      verify_final: allPass,
    });
    const run = await createWorkflow(t.app, await asUser(alice.id), { request: "整理一份熱詞方法的筆記", playbook: "generic", context: { studyId: study.id } });
    expect((await runWorkflow(deps(m.port), run.id)).status).toBe("awaiting_plan_approval");
    const planned = (await getRun(t.db, run.id))!;
    expect((await getSteps(t.db, run.id)).map((s) => s.key)).toEqual(["s1", "s2", "s3", "assemble", "final"]);
    expect(planned.plan!.outline!.map((o) => o.title)).toEqual(["背景", "方法", "比較"]);
    expect((planned.state.units as { budget: { chars: number } }[]).map((u) => u.budget.chars)).toEqual([600, 1500, 800]);
    await approveWorkflow(t.app, await asUser(alice.id), run.id, {});
    const fin = await runWorkflow(deps(m.port), run.id);
    expect(fin.status, JSON.stringify((await getRun(t.db, run.id))!.report?.issues)).toBe("done");
    const steps = await getSteps(t.db, run.id);
    const by = (k: string) => steps.find((s) => s.key === k)!;
    // s2: cut → continued in the same round (one extra call), never a fix round; s3: placeholder → only s3 redone.
    expect(by("s2").round).toBe(0);
    expect(by("s2").output!.summary).toContain("接續寫完 1 次");
    expect(m.count("write:generic:continue")).toBe(1);
    expect(by("s3").round).toBe(1);
    expect(by("s1").round).toBe(0);
    expect(m.count("write:generic")).toBe(4);
    // Each unit got its budget and its neighbours (s2 sees the written s1).
    const s2Prompt = m.prompts("write:generic").find((p) => p.includes("寫方法"))!;
    expect(s2Prompt).toContain("約 1500 字");
    expect(s2Prompt).toContain("上一個單元「背景」：已寫：");
    const note = (await t.db.query<{ content_md: string }>("SELECT content_md FROM notes WHERE id=$1", [(await getRun(t.db, run.id))!.artifacts.find((a) => a.kind === "note")!.id])).rows[0]!.content_md;
    expect(note).toBe(`# 熱詞方法筆記\n\n${BACKGROUND}\n\n${METHOD_CUT}${METHOD_REST.slice("深層偏置用注意力讀取熱詞清單，".length).trimEnd()}\n\n${COMPARE}\n`);
    expect(m.count("plan_generic")).toBe(1);
  });

  describe("topic deck pipeline", () => {
    const HITS: OnlineHit[] = [
      { title: "Deep Context Biasing for RNN-T", authors: "A. Lee", year: 2023, venue: "Interspeech", doi: null, arxiv_id: "2301.00001", abstract: "deep biasing", in_library: null, open_access: true },
      { title: "Shallow Fusion Hotwords in Streaming ASR", authors: "B. Wu", year: 2022, venue: "ICASSP", doi: "10.1000/sf", arxiv_id: null, abstract: "shallow fusion", in_library: null, open_access: true },
    ];
    let searches: string[];
    let imports: string[];
    beforeEach(() => {
      searches = [];
      imports = [];
      setTopicResearchDeps({
        async search(_env, query) {
          searches.push(query);
          return HITS;
        },
        async snowball() {
          return [];
        },
        async importPaper(env, studyId, hit) {
          imports.push(hit.title);
          const paper = await insertPaper(t.db, { type: "paper-conference", title: hit.title, authors: [{ family: "Lee", given: "A" }], year: hit.year ?? undefined, ...(hit.arxiv_id ? { arxivId: hit.arxiv_id } : {}), ...(hit.doi ? { doi: hit.doi } : {}) }, env.user.id).catch(async () => (await t.db.query("SELECT * FROM papers WHERE title=$1", [hit.title])).rows[0]);
          const r = await addPaperToStudy(t.db, { studyId, paper, userId: env.user.id });
          return { paper_id: paper.id, cite_key: r.citeKey, title: paper.title, year: paper.year, has_pdf: true };
        },
      });
    });
    afterEach(() => setTopicResearchDeps(null));

    const reader = (req: Req) => {
      const u = userText(req);
      const key = /引用鍵 \[@([\w:.-]+)\]/.exec(u)?.[1] ?? "x";
      const deep = u.includes("Deep Context");
      return `### [@${key}] 論文\n\n#### 一句話\n${deep ? "以 cross-attention 讀取熱詞清單" : "解碼時對熱詞前綴加分"} [@${key}]（p. 1）。\n\n#### 方法\n${deep ? "DEEPMARK 方法以 cross-attention 讀取熱詞清單（p. 3）。" : "SHALLOWMARK 方法在 beam search 對熱詞加分（p. 2）。"}\n\n#### 注入位置與訓練／推論\n${deep ? "encoder 之後，需要訓練（p. 3）" : "只在推論時（p. 2）"}。\n\n#### 數字表\n| 設定 | 資料集 | 指標 | 基線 | 結果 | 出處 |\n|---|---|---|---|---|---|\n| x | LibriSpeech | WER | 5.2 | ${deep ? "4.1" : "4.6"} | 表 2（p. 6） |\n\n#### 限制\n清單很大時變慢。\n\n${"補充說明。".repeat(60)}`;
    };
    const page = (title: string) => `## ${title}\n\n| 項目 | 內容 |\n|---|---|\n| 做法 | 依摘錄 |\n\n- 依摘錄整理的「${title}」重點\n\n::: {.notes}\n這一頁說明「${title}」的重點，內容都來自這頁的來源論文摘錄，報告時大約一分鐘。\n:::`;
    const pagesOf = (req: Req) => {
      const block = /<data name="your_pages"[^>]*>\n([\s\S]*?)\n<\/data>/.exec(userText(req))?.[1] ?? "";
      return [...block.matchAll(/^\d+\. (.+?)(?:（[^）]*）)*$/gm)].map((x) => x[1]!);
    };
    const OUTLINE = { pages: [
      { title: "熱詞偏置簡介", purpose: "題目", points: ["主題"], layout: "F", kind: "title" },
      { title: "做法分類", purpose: "兩類做法", points: ["淺層融合與深層偏置"], layout: "T", kind: "taxonomy", sources: ["P1", "P2"] },
      { title: "Deep biasing", purpose: "方法", points: ["注入位置 encoder"], layout: "A", kind: "method", sources: ["P1"], item: "Deep biasing" },
      { title: "Shallow fusion", purpose: "方法", points: ["只在推論"], layout: "A", kind: "method", sources: ["P2"], item: "Shallow fusion" },
      { title: "結果比較", purpose: "比較", points: ["WER"], layout: "T", kind: "comparison", sources: ["P1", "P2"] },
      { title: "綜合與開放問題", purpose: "綜合", points: ["取捨"], layout: "F", kind: "synthesis" },
    ] };

    it("thin library → one keyword search, picks, approval before import, per-paper extraction, page writers with only their sources", async () => {
      const m = mockModel({
        topic_plan: () => JSON.stringify({ title: "串流 ASR 熱詞偏置", topic: "串流 ASR 的 contextual biasing", subquestions: [{ q: "有哪幾類做法？", keywords: ["contextual biasing"], queries: ["contextual biasing RNN-T"] }, { q: "結果如何比較？", keywords: ["WER"], queries: ["hotword streaming ASR"] }], queries: [] }),
        topic_select: (req) => {
          const u = userText(req);
          const n = (s: string) => Number(new RegExp(`\\[(\\d+)\\] ${s}`).exec(u)?.[1] ?? -1);
          return JSON.stringify({ library: [], candidates: [{ n: n("Deep Context"), reason: "直接相關", role: "recent" }, { n: n("Shallow Fusion"), reason: "代表作", role: "core" }] });
        },
        outline: () => JSON.stringify(OUTLINE),
        topic_read: reader,
        "topic_read:final": reader,
        write_slides: (req) => pagesOf(req).map(page).join("\n\n"),
        verify: () => '{"verdict":"pass","issues":[]}',
        verify_final: allPass,
      });
      const run = await createWorkflow(t.app, await asUser(alice.id), { request: "做一份關於串流 ASR contextual biasing 做法的主題簡報，6 頁，幫我上網找論文", playbook: "slides", inputs: { pages: 6 }, context: { studyId: study.id } });
      expect((await runWorkflow(deps(m.port), run.id)).status).toBe("awaiting_plan_approval");
      let r = (await getRun(t.db, run.id))!;
      expect(r.state.deck_style).toBe("topic");
      // One keyword batch; nothing imported before the user approves the import write.
      expect(searches).toEqual(["contextual biasing RNN-T", "hotword streaming ASR"]);
      expect(imports).toEqual([]);
      expect(r.plan!.writes.map((w) => w.kind)).toEqual(["deck", "paper"]);
      expect(r.plan!.writes[1]!.effect).toBeUndefined();
      expect(r.plan!.notes).toContain("線上搜尋只送出關鍵字");
      // The outline keeps the planner's layout / role / sources; the outline prompt offered the layout library.
      expect(r.plan!.outline!.map((o) => (o as { layout?: string }).layout)).toEqual(["F", "T", "A", "A", "T", "F"]);
      expect(m.prompts("outline")[0]).toContain("survey 簡報");
      expect(m.prompts("outline")[0]).toContain("P1–P2");
      const steps = await getSteps(t.db, run.id);
      expect(steps.map((s) => s.key)).toEqual(["research", "outline", "paper_1", "paper_2", "write_1", "write_2", "write_3", "write_4", "write_5", "write_6", "assemble", "notes", "constraints", "visual_qa", "final"]);
      const dep = (k: string) => steps.find((s) => s.key === k)!.depends_on;
      expect(dep("write_1")).toEqual(["outline"]);
      expect(dep("write_3")).toEqual(["outline", "paper_1"]);
      expect(dep("write_4")).toEqual(["outline", "paper_2"]);
      expect(dep("write_5")).toEqual(["outline", "paper_1", "paper_2"]);

      await approveWorkflow(t.app, await asUser(alice.id), run.id, {});
      const out = await runWorkflow(deps(m.port), run.id);
      r = (await getRun(t.db, run.id))!;
      expect(out.status, JSON.stringify(r.report?.issues)).toBe("done");
      expect(imports.sort()).toEqual(["Deep Context Biasing for RNN-T", "Shallow Fusion Hotwords in Streaming ASR"]);
      expect(searches).toHaveLength(2);
      // Each method page's writer saw only its own source paper's extraction (the judge gets the same block).
      const writers = m.prompts("write_slides");
      expect(writers).toHaveLength(6);
      const writerOf = (n: number) => writers.find((p) => p.includes(`這一步的範圍：只寫第 ${n} 頁（共 1 頁）`))!;
      const deepPage = writerOf(3);
      expect(deepPage).toContain("DEEPMARK");
      expect(deepPage).not.toContain("SHALLOWMARK");
      expect(deepPage).toContain("第 3 頁用版型 A");
      expect(deepPage).toContain("上一個單元「做法分類」");
      expect(writerOf(1)).toContain("這頁沒有指定來源論文");
      const cmp = writerOf(5);
      expect(cmp).toContain("4.1");
      expect(cmp).toContain("4.6");
      // The deck: 6 pages, each page with source papers carries a 「來源」 line added by code.
      const deck = r.artifacts.find((a) => a.kind === "deck")!;
      const qmd = (await t.db.query<{ content: string }>("SELECT content FROM deck_sources WHERE deck_id=$1 AND path='index.qmd'", [deck.id])).rows[0]!.content;
      expect((qmd.match(/^## /gm) ?? []).length).toBe(6);
      expect(qmd).toMatch(/## Deep biasing[\s\S]*?::: \{\.page-source\}\n來源: Deep Context Biasing for RNN-T \(2023\)\n:::/);
      expect(qmd).not.toMatch(/## 熱詞偏置簡介\n[\s\S]*?\.page-source[\s\S]*?## 做法分類/);
      expect(r.criteria.find((c) => c.id === "pages")!.status).toBe("pass");
      // The final verification judges against the extractions (not the planning brief's abstracts).
      expect(String(r.state.brief)).toContain("DEEPMARK");
      expect(String(r.state.brief)).toContain("SHALLOWMARK");
    });

    it("a library with enough full-text papers is read without searching online", async () => {
      const rich = await insertStudy(t.db, alice.id, "熱詞研究");
      for (const title of ["Deep Context Biasing for RNN-T", "Shallow Fusion Hotwords in Streaming ASR", "TCPGen Tree Constrained Pointer", "Contextual Adapters"]) {
        const paper = await insertPaper(t.db, { type: "paper-conference", title: `${title} v2`, authors: [{ family: "Lee", given: "A" }], year: 2023 }, alice.id);
        await t.db.query("UPDATE papers SET pdf_key=$2 WHERE id=$1", [paper.id, `library/papers/${paper.id}.pdf`]);
        await addPaperToStudy(t.db, { studyId: rich.id, paper, userId: alice.id });
      }
      const m = mockModel({
        topic_plan: () => JSON.stringify({ title: "熱詞", topic: "熱詞偏置", subquestions: [{ q: "做法？", keywords: ["biasing"], queries: ["contextual biasing"] }, { q: "比較？", keywords: ["WER"], queries: ["hotword"] }] }),
        topic_select: (req) => JSON.stringify({ library: [...userText(req).matchAll(/^([0-9a-f-]{36})｜/gm)].slice(0, 2).map((x) => ({ id: x[1], reason: "相關", role: "core" })), candidates: [] }),
        outline: () => JSON.stringify({ pages: OUTLINE.pages.slice(0, 4) }),
      });
      const run = await createWorkflow(t.app, await asUser(alice.id), { request: "做一份關於熱詞偏置做法的主題簡報，4 頁", playbook: "slides", inputs: { pages: 4 }, context: { studyId: rich.id } });
      expect((await runWorkflow(deps(m.port), run.id)).status).toBe("awaiting_plan_approval");
      const r = (await getRun(t.db, run.id))!;
      expect(searches).toEqual([]);
      expect(r.plan!.writes.map((w) => w.kind)).toEqual(["deck"]);
      expect(r.plan!.notes).toMatch(/讀 \d+ 篇論文的全文/);
      expect((await getSteps(t.db, run.id)).filter((s) => s.key.startsWith("paper_")).map((s) => s.title)).toEqual([expect.stringContaining("精讀〈"), expect.stringContaining("精讀〈")]);
    });

    /** A library like production 0668a3d7's: every paper with a PDF, a venue (one arXiv-only) and authors. */
    async function hotwordLibrary(title: string, papers: [string, string, number, string | null, string | null][]) {
      const st = await insertStudy(t.db, alice.id, title);
      for (const [name, family, year, venue, arxiv] of papers) {
        // The same paper in two studies is one library record (titles / arXiv ids are unique).
        const paper = (await t.db.query("SELECT * FROM papers WHERE title=$1", [name])).rows[0] ?? await insertPaper(t.db, { type: "paper-conference", title: name, authors: [{ family, given: "A" }, { family: "Lee", given: "B" }], year }, alice.id);
        await t.db.query("UPDATE papers SET pdf_key=$2, venue=$3, arxiv_id=$4 WHERE id=$1", [paper.id, `library/papers/${paper.id}.pdf`, venue, arxiv]);
        await addPaperToStudy(t.db, { studyId: st.id, paper, userId: alice.id });
      }
      return st;
    }
    const HOTWORD_PAPERS: [string, string, number, string | null, string | null][] = [
      ["Deep Context: End-to-end Contextual Speech Recognition", "Pundak", 2018, "SLT", null],
      ["Shallow-Fusion End-to-End Contextual Biasing", "Zhao", 2019, "Interspeech", null],
      ["Contextual RNN-T For Open Domain ASR", "Jain", 2020, "Interspeech", null],
      ["Contextual Density Ratio for Language Model Biasing of Sequence to Sequence ASR Systems", "Andreev", 2021, "Interspeech", null],
      ["Contextual Adapters for Personalized Speech Recognition in Neural Transducers", "Sathyendra", 2022, "ICASSP", null],
      ["Fast Context-Biasing for CTC and Transducer ASR models with CTC-based Word Spotter", "Andrusenko", 2024, null, "2406.07096"],
    ];

    it("79ab0678: a spoken library survey reads every library paper, writers get venues, the topic is the request's (not the study name)", async () => {
      const { REQUEST_A } = await import("./fixtures-79ab.js");
      const st = await hotwordLibrary("串流 ASR 的動態熱詞效率研究", HOTWORD_PAPERS);
      const m = mockModel({
        topic_plan: () => JSON.stringify({ title: "動態熱詞效率", topic: "串流 ASR 動態熱詞的效率", subquestions: [{ q: "如何定義效率？", keywords: ["efficiency"] }, { q: "有哪幾類做法？", keywords: ["contextual biasing"] }] }),
        // A cheap planner that picks only two library papers.
        topic_select: (req) => JSON.stringify({ library: [...userText(req).matchAll(/^([0-9a-f-]{36})｜/gm)].slice(0, 2).map((x) => ({ id: x[1], reason: "相關", role: "core" })), candidates: [] }),
        outline: (req) => {
          const n = Number(/P1–P(\d+)/.exec(userText(req))?.[1] ?? 2);
          return JSON.stringify({ pages: [
            { title: "Hotword Mechanisms", purpose: "題目", points: ["主題"], layout: "F", kind: "title" },
            { title: "Taxonomy", purpose: "分類", points: ["所有做法"], layout: "T", kind: "taxonomy", sources: ["P1"] },
            ...Array.from({ length: n }, (_, i) => ({ title: `Method ${i + 1}`, purpose: "方法", points: ["架構"], layout: "A", kind: "method", sources: [`P${i + 1}`], item: `Method ${i + 1}` })),
          ].slice(0, 8) });
        },
        topic_read: reader,
        "topic_read:final": reader,
        write_slides: (req) => pagesOf(req).map(page).join("\n\n"),
        verify: () => '{"verdict":"pass","issues":[]}',
        verify_final: allPass,
      });
      const run = await createWorkflow(t.app, await asUser(alice.id), { request: REQUEST_A, playbook: "slides", inputs: { pages: 8 }, context: { studyId: st.id } });
      expect((await runWorkflow(deps(m.port), run.id)).status).toBe("awaiting_plan_approval");
      let r = (await getRun(t.db, run.id))!;
      // Every library paper is read (the planner's 2 + the rest), and the card says how many and why.
      expect((await getSteps(t.db, run.id)).filter((s) => s.key.startsWith("paper_"))).toHaveLength(6);
      expect(r.plan!.notes).toContain("讀 6 篇論文的全文");
      expect(r.plan!.notes).toContain("全部讀");
      expect((r.plan!.outline as { kind?: string; sources?: string[] }[]).find((p) => p.kind === "taxonomy")!.sources).toEqual(["P1", "P2", "P3", "P4", "P5", "P6"]);
      // The planner saw venues; the topic is the request's subject, never the study's name.
      expect(m.prompts("topic_select")[0]).toContain("Andrusenko et al., 2024, arXiv preprint (arXiv:2406.07096)");
      expect(m.prompts("topic_select")[0]).toContain("Sathyendra et al., 2022, ICASSP");
      expect(String(r.state.topic_title)).toContain("Zipformer");
      expect(String(r.state.topic_title)).not.toContain("效率");
      await approveWorkflow(t.app, await asUser(alice.id), run.id, {});
      const out = await runWorkflow(deps(m.port), run.id);
      r = (await getRun(t.db, run.id))!;
      expect(["done", "partial"]).toContain(out.status);
      // Every writer gets the bibliography (first author et al., year, venue); the taxonomy writer reads all six papers.
      const writers = m.prompts("write_slides");
      expect(writers.every((p) => p.includes("# 書目"))).toBe(true);
      const tax = writers.find((p) => p.includes("只寫第 2 頁"))!;
      expect(tax).toContain("Zhao et al., 2019, Interspeech");
      expect(tax).toContain("Andrusenko et al., 2024, arXiv preprint");
      expect((tax.match(/### P\d〈/g) ?? []).length).toBe(6);
    });

    it("79ab0678: a coverage failure no read paper covers adds the library paper and rewrites that page once; a family the library lacks is 「重新規劃」, not another rewrite", async () => {
      const st = await hotwordLibrary(`熱詞 ${randomBytes(2).toString("hex")}`, HOTWORD_PAPERS.slice(0, 4).concat(HOTWORD_PAPERS.slice(5)).concat(Array.from({ length: 8 }, (_, i) => [`Unrelated Paper ${i}`, "Wu", 2020, "ICASSP", null] as [string, string, number, string | null, string | null])));
      let finals = 0;
      const m = mockModel({
        topic_plan: () => JSON.stringify({ title: "熱詞", topic: "熱詞偏置", subquestions: [{ q: "做法？", keywords: ["biasing"] }, { q: "比較？", keywords: ["WER"] }] }),
        topic_select: (req) => {
          const u = userText(req);
          const id = (name: string) => new RegExp(`^([0-9a-f-]{36})｜${name}`, "m").exec(u)?.[1];
          return JSON.stringify({ library: [id("Deep Context"), id("Shallow-Fusion")].map((x) => ({ id: x, reason: "相關", role: "core" })), candidates: [] });
        },
        outline: () => JSON.stringify({ pages: OUTLINE.pages.slice(0, 4) }),
        topic_read: reader,
        "topic_read:final": reader,
        write_slides: (req) => pagesOf(req).map(page).join("\n\n"),
        verify: () => '{"verdict":"pass","issues":[]}',
        verify_final: (req) => {
          finals++;
          const ids = [...userText(req).matchAll(/- \[([a-z0-9_]+)\]/g)].map((x) => x[1]!);
          // Round 1: the taxonomy lacks two families; round 2 (after the paper was added): only the one no paper covers.
          return JSON.stringify({ results: ids.map((id) => id === "coverage"
            ? { id, pass: false, kind: "wrong", evidence: "依摘錄整理的「做法分類」重點", reason: finals === 1 ? "分類頁缺少 Contextual density-ratio，也缺少 Phoneme-aware hotword spotting。" : "分類頁缺少 Phoneme-aware hotword spotting。" }
            : { id, pass: true, evidence: "內容", reason: "ok" }) });
        },
      });
      const run = await createWorkflow(t.app, await asUser(alice.id), { request: "做一份關於熱詞偏置做法的主題簡報，4 頁", playbook: "slides", inputs: { pages: 4 }, context: { studyId: st.id } });
      expect((await runWorkflow(deps(m.port), run.id)).status).toBe("awaiting_plan_approval");
      expect((await getSteps(t.db, run.id)).filter((s) => s.key.startsWith("paper_"))).toHaveLength(2);
      await approveWorkflow(t.app, await asUser(alice.id), run.id, {});
      const writesBefore = m.count("write_slides");
      const out = await runWorkflow(deps(m.port), run.id);
      const r = (await getRun(t.db, run.id))!;
      expect(out.status).toBe("partial");
      // The density-ratio paper was added and read; only the taxonomy page was rewritten, once.
      const steps = await getSteps(t.db, run.id);
      const added = steps.filter((s) => s.key.startsWith("paper_"));
      expect(added).toHaveLength(3);
      expect(added[2]!.title).toContain("Contextual Density Ratio");
      expect(steps.find((s) => s.key === "write_2")!.depends_on).toContain("paper_3");
      expect(m.count("write_slides") - writesBefore).toBe(4 + 1);
      expect(finals).toBe(2);
      // The family no paper covers needs a new plan: listed apart with 「重新規劃」, not another rewrite.
      expect(r.state.replan_needed).toEqual([{ id: "coverage", why: expect.stringContaining("Phoneme-aware hotword spotting") }]);
      const notice = (await t.db.query<{ content: { items?: string[]; replan?: string[] }[]; text: string }>("SELECT content, text FROM agent_messages WHERE role='notice' AND content @> $1::jsonb ORDER BY seq DESC LIMIT 1", [JSON.stringify([{ workflowId: run.id }])])).rows[0];
      if (notice) expect(notice.content[0]!.replan?.[0]).toContain("重新規劃");
    });
  });
});
