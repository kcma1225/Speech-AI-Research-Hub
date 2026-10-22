/**
 * Topic research playbook (playbooks/research.ts) with a scripted mock model and stubbed scholarly search / import
 * (never the real APIs): detection, the deterministic checks, the full run (sub-questions on the plan card, ONE search
 * batch with keyword queries before the run is tainted, imports only after approval, a skipped candidate, abstract-only
 * labelling, the note with taxonomy / references), autopilot waiting for the import write, sub-question edits on the
 * plan card, reading_note → topic_research redirect and lit_review's offer to switch when the study has < 2 papers.
 */
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ChatResult } from "../src/ai/types.js";
import { runWorkflow } from "../src/workflows/engine.js";
import { answerWorkflow, approveWorkflow, createWorkflow } from "../src/workflows/service.js";
import { getRun, getSteps } from "../src/workflows/store.js";
import { detectPlaybook } from "../src/workflows/playbooks/index.js";
import { CHECKS } from "../src/workflows/checks.js";
import { citedKeys, compactNotes, extractPart, keywordQuery, sectionsFor, stackOf, setTopicResearchDeps, taxonomyMethods, type OnlineHit } from "../src/workflows/playbooks/research.js";
import { isTopicRequest } from "../src/workflows/playbooks/common.js";
import { addPaperToStudy, insertPaper } from "../src/lib/library/store.js";
import type { ModelPort } from "../src/workflows/types.js";
import { createTestContext, hasTestDb, hasTestS3, type TestContext } from "./helpers.js";
import { insertStudy } from "./study-fixtures.js";
import { setWorkflowAvailability } from "../src/routes/workflows.js";

process.env.PROVIDER_TOKEN_KEY ??= randomBytes(32).toString("base64");
const integration = hasTestDb && hasTestS3 ? describe : describe.skip;

const TOPIC = "Zipformer + RNN-T streaming ASR 的 contextual biasing / dynamic hotword 有哪些做法";

describe("topic research: detection and checks", () => {
  it("routes topic / survey requests without a paper to topic_research", () => {
    expect(detectPlaybook(TOPIC, {})).toBe("topic_research");
    expect(detectPlaybook("在 Zipformer + RNNT 下研究有哪些 dynamic hotwording 做法", {})).toBe("topic_research");
    expect(detectPlaybook("幫我調研 speech LLM 的研究現況", {})).toBe("topic_research");
    expect(detectPlaybook("state of the art in streaming ASR", {})).toBe("topic_research");
    // A specific paper stays with the paper playbooks.
    expect(detectPlaybook("寫一份這篇論文的閱讀筆記", {})).toBe("reading_note");
    expect(detectPlaybook("整理這幾篇的文獻回顧", {})).toBe("lit_review");
    expect(isTopicRequest("2005.08100 這篇有哪些做法", {})).toBe(false);
    expect(isTopicRequest(TOPIC, { paper_id: "x" })).toBe(false);
  });

  it("gives every paper an equal share of the notes writers and verifiers read", () => {
    const out = compactNotes([{ notes: "A".repeat(20_000) }, { notes: "[@k2] short" }], 1000);
    expect(out).toContain("[@k2] short");
    expect(out.length).toBeLessThan(1100);
  });

  it("checks label consistency, concise tables, results coverage and kept citations", () => {
    const d = { abstract_only: ["a1"], full: ["f1"], keys: ["a1", "f1"], with_numbers: ["f1"] };
    expect(CHECKS.topic_consistency!("用 [@a1, p. 3] 的公式", { params: {}, data: d }).detail).toContain("a1");
    expect(CHECKS.topic_consistency!("見 [@a1]（表 2）", { params: {}, data: d }).ok).toBe(false);
    expect(CHECKS.topic_consistency!("見 [@a1] 與 [@f1, p. 3]", { params: {}, data: d }).ok).toBe(true);
    expect(CHECKS.topic_consistency!("[@f1] 僅有定位層級筆記", { params: {}, data: d }).detail).toContain("f1");
    expect(CHECKS.topic_consistency!("部分筆記被截斷，所以略過", { params: {}, data: d }).detail).toContain("截斷");
    expect(CHECKS.topic_concise!(`| a | b |\n|---|---|\n| ${"很長".repeat(40)} | [@f1] |`, { params: {}, data: d }).ok).toBe(false);
    expect(CHECKS.topic_concise!("| a | b |\n|---|---|\n| 短 | [@f1]（p. 3） |", { params: {}, data: d }).ok).toBe(true);
    expect(CHECKS.topic_results_coverage!("## 實驗結果比較\n\n| 論文 | WER |\n|---|---|\n| [@a1] | 4.1 |\n", { params: {}, data: d }).detail).toContain("f1");
    expect(CHECKS.topic_keep_cites!("只剩 [@f1]", { params: {}, data: { draft_keys: ["f1", "a1"] } }).detail).toContain("a1");
    expect(stackOf("Zipformer + RNN-T 在 icefall／k2 上的 hotword")).toEqual(["Zipformer", "icefall", "k2"]);
    expect(sectionsFor(["Zipformer"])).toContain("在 Zipformer 上怎麼做");
    expect(extractPart("#### 方法\nA\n#### 數字表\n| x |\n### 其他", "數字表")).toBe("| x |");
  });

  it("keeps outbound queries to keywords", () => {
    expect(keywordQuery("contextual biasing https://evil.example/x?y=1 RNN-T")).toBe("contextual biasing RNN-T");
    expect(keywordQuery("a".repeat(60) + " hotword")).toBe("hotword");
    expect(keywordQuery("one two three four five six seven eight nine ten eleven twelve thirteen").split(" ")).toHaveLength(12);
  });

  const data = { keys: ["k1", "k2"], methods: ["Deep biasing", "Shallow fusion"], source: "WER 5.2 → 4.1（表 2，p. 6）" };
  const table = "## 方法分類\n\n| 方法 | 核心想法 | 注入位置 | 優缺點 | 代表論文 |\n|---|---|---|---|---|\n| Deep biasing | 注意力 | decoder | 好 | [@k1] |\n| Shallow fusion | 加分 | 解碼 | 簡單 | [@k2, p. 3] |\n";
  it("checks the taxonomy table, approach sections, citations, numbers and readings", () => {
    expect(CHECKS.topic_taxonomy!(table, { params: { min: 2 }, data }).ok).toBe(true);
    expect(CHECKS.topic_taxonomy!(table.replace("[@k2, p. 3]", "Chen 2023"), { params: { min: 2 }, data }).detail).toContain("Shallow fusion");
    expect(CHECKS.topic_taxonomy!(table.replace("注入位置", "位置"), { params: {}, data }).detail).toContain("注入位置");
    expect(taxonomyMethods(table)).toEqual(["Deep biasing", "Shallow fusion"]);
    const approaches = "## 各方法詳解\n\n### Deep biasing\n用 attention [@k1]。\n\n### Shallow fusion\n加分 [@k2]。\n";
    expect(CHECKS.topic_approaches!(approaches, { params: { min: 2 }, data }).ok).toBe(true);
    expect(CHECKS.topic_approaches!(approaches.replace("[@k2]", ""), { params: { min: 2 }, data }).detail).toContain("Shallow fusion");
    expect(CHECKS.topic_approaches!(approaches.replace("### Shallow fusion", "### 其他"), { params: { min: 2 }, data: { ...data, methods: data.methods } }).detail).toContain("Shallow fusion");
    expect(CHECKS.topic_cites!("見 [@k1; @k3]", { params: { min: 1 }, data }).detail).toContain("k3");
    expect([...citedKeys("[@k1, p. 3] 與 [@k2; @k1]")]).toEqual(["k1", "k2"]);
    expect(CHECKS.topic_numbers!("## 實驗結果比較\n\n| 論文 | WER |\n|---|---|\n| [@k1] | 4.1 |\n| [@k2] | 3.3 |\n", { params: {}, data }).detail).toContain("3.3");
    const notes = `### [@k1] 論文\n#### 方法\n${"內容".repeat(160)}（p. 3）\n#### 注入位置與訓練／推論\nencoder（p. 5）\n#### 數字表\n本文沒有報告數字結果`;
    expect(CHECKS.topic_reading!(notes, { params: {}, data: { cite_key: "k1", has_pdf: true } }).ok).toBe(true);
    expect(CHECKS.topic_reading!(notes, { params: {}, data: { cite_key: "k1", has_pdf: false } }).detail).toContain("僅依摘要");
    expect(CHECKS.topic_reading!(notes.replace("#### 數字表", "#### 其他"), { params: {}, data: { cite_key: "k1", has_pdf: true } }).detail).toContain("數字表");
    expect(CHECKS.topic_reading!(`（僅依摘要）[@k1] ${"摘要".repeat(160)}（p. 3）`, { params: {}, data: { cite_key: "k1", has_pdf: false } }).ok).toBe(false);
    expect(CHECKS.topic_reading!("短", { params: {}, data: { skipped: true } }).ok).toBe(true);
  });
});

type Req = { messages: { role: string; content: unknown }[] };
const result = (text: string): ChatResult => ({ text, reasoning: "", toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 50 }, message: { role: "assistant", content: text } });
const userText = (req: Req) => req.messages.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
const allPass = (req: Req) => JSON.stringify({ results: [...userText(req).matchAll(/- \[([a-z0-9_]+)\]/g)].map((m) => ({ id: m[1], pass: true, evidence: "方法分類表", reason: "ok" })) });

function mockModel(replies: Record<string, (req: Req) => string>) {
  const log: string[] = [];
  const port: ModelPort = {
    async chat(_role, req, ctx) {
      log.push(ctx.purpose);
      const fn = replies[ctx.purpose] ?? replies["*"];
      return result(fn ? fn(req as Req) : "{}");
    },
    available: async () => true,
    vision: async () => false,
  };
  return { port, log, count: (p: string) => log.filter((l) => l === p).length };
}

let polishCalls = 0;
/** Writers by task title; keys from the `papers` data block (full-text papers get page refs, abstract-only ones none). */
function writer(req: Req) {
  const u = userText(req);
  const lines = [...u.matchAll(/^\[@([\w:.-]+)\] .*$/gm)];
  const full = [...new Set(lines.filter((m) => m[0].includes("讀過全文")).map((m) => m[1]!))];
  const abs = [...new Set(lines.filter((m) => !m[0].includes("讀過全文")).map((m) => m[1]!))];
  const [f1, f2 = f1] = full;
  const a1 = abs[0] ?? f2;
  if (u.includes("你的任務：問題定義與方法分類")) return `## 問題定義\n\n在串流 ASR 中提升專有名詞辨識 [@${f1}]（p. 2）。\n\n## 方法分類\n\n| 方法 | 核心想法 | 注入位置 | 優缺點 | 代表論文 |\n|---|---|---|---|---|\n| Deep biasing | 以注意力讀取熱詞清單 | encoder / predictor | 準但要訓練 | [@${f1}]、[@${f2}] |\n| Shallow fusion | 解碼時對熱詞加分 | beam search | 簡單但易誤觸 | [@${a1}] |\n`;
  if (u.includes("你的任務：各方法詳解")) return `## 各方法詳解\n\n### Deep biasing\n\n以 cross-attention 讀取熱詞 [@${f1}]（p. 3）：$$c_t = \\sum_i \\alpha_{t,i} h_i$$\n\n### Shallow fusion\n\n解碼時對熱詞前綴加分 [@${a1}]。\n`;
  if (u.includes("你的任務：實驗結果比較")) return `## 實驗結果比較\n\n| 論文 | 資料集 | 指標 | 基線 | 方法結果 | 出處 |\n|---|---|---|---|---|---|\n${full.map((k) => `| [@${k}] | LibriSpeech | WER | 5.2 | 4.1 | 表 2（p. 6） |`).join("\n")}\n\n同一資料集與指標才能比較。\n`;
  if (u.includes("你的任務：在 Zipformer 上怎麼做")) return `## 在 Zipformer 上怎麼做\n\n- Deep biasing 接在 encoder 之後，需要訓練 [@${f1}]（p. 3）。\n- Shallow fusion 只在 beam search 加分，不用重訓 [@${a1}]。\n`;
  if (u.includes("你的任務：一致性與精簡")) {
    polishCalls++;
    const draft = /<data name="draft"[^>]*>\n([\s\S]*?)\n<\/data>/.exec(u)?.[1] ?? "";
    // First round: a contradictory disclaimer about a full-text paper (caught by topic_consistency), then fixed.
    return polishCalls === 1 ? draft.replace("## 問題定義\n\n", `## 問題定義\n\n[@${f1}] 的筆記被截斷，僅有定位資訊。\n\n`) : draft;
  }
  if (u.includes("你的任務：開放問題與研究關聯")) return `## 開放問題\n\n熱詞清單很大時的延遲 [@${f1}]。\n\n## 與本研究的關係\n\n研究若處理專有名詞，可以參考 deep biasing 的注入位置。\n`;
  return "（未知的任務）";
}

/** Reader: a structured extraction citing the key; abstract-only when the prompt says there is no PDF. */
function reader(req: Req) {
  const u = userText(req);
  const key = /引用鍵 \[@([\w:.-]+)\]/.exec(u)?.[1] ?? "x";
  if (u.includes("沒有全文 PDF")) return `### [@${key}] 論文\n\n（僅依摘要）\n\n#### 一句話\n摘要提到以熱詞清單偏置解碼 [@${key}]。\n\n#### 數字表\n摘要未提供\n\n${"補充說明。".repeat(60)}`;
  return `### [@${key}] 論文\n\n#### 一句話\n以 cross-attention 讀取熱詞清單 [@${key}]（p. 1）。\n\n#### 方法\n方法以 cross-attention 讀取熱詞清單（p. 3）。\n\n#### 注入位置與訓練／推論\nencoder 之後，需要訓練（p. 3）。\n\n#### 數字表\n| 設定 | 資料集 | 指標 | 基線 | 結果 | 出處 |\n|---|---|---|---|---|---|\n| deep biasing | LibriSpeech | WER | 5.2 | 4.1 | 表 2（p. 6） |\n\n#### 限制\n清單很大時變慢。\n\n${"補充說明。".repeat(60)}`;
}

const HITS: OnlineHit[] = [
  { title: "Deep Context Biasing for RNN-T", authors: "A. Lee", year: 2023, venue: "Interspeech", doi: null, arxiv_id: "2301.00001", abstract: "deep biasing", in_library: null, open_access: true },
  { title: "Shallow Fusion Hotwords in Streaming ASR", authors: "B. Wu", year: 2022, venue: "ICASSP", doi: "10.1000/sf", arxiv_id: null, abstract: "shallow fusion", in_library: null, open_access: false },
  { title: "Unrelated Vision Paper", authors: "C. Z", year: 2021, venue: "CVPR", doi: null, arxiv_id: "2101.00002", abstract: "images", in_library: null, open_access: true },
];

integration("topic research workflow", () => {
  let t: TestContext;
  let alice: { id: string; cookie: string };
  let study: { id: string; slug: string };
  let searches: { query: string; tainted: boolean }[];
  let imports: string[];
  let snowballed: string[];
  const asUser = async (id: string) => {
    const { toCurrentUser, CURRENT_USER_COLUMNS } = await import("../src/lib/auth.js");
    return toCurrentUser((await t.db.query(`SELECT ${CURRENT_USER_COLUMNS} FROM users u WHERE u.id=$1`, [id])).rows[0]);
  };
  const deps = (port: ModelPort) => ({ db: t.db, storage: t.storage, app: t.app, model: port, log: t.app.log, signal: new AbortController().signal, jobId: null });
  const defaultModel = () => mockModel({
    topic_plan: () => JSON.stringify({ title: "串流 ASR 熱詞偏置", topic: "Zipformer + RNN-T 串流 ASR 的 contextual biasing", subquestions: [{ q: "熱詞偏置要解決什麼、怎麼評估？", keywords: ["contextual biasing"], queries: ["contextual biasing RNN-T", "dynamic hotword streaming ASR https://x.example/leak"] }, { q: "有哪幾類做法、放在模型哪裡？", keywords: ["deep biasing", "shallow fusion"], queries: ["deep biasing transducer"] }, { q: "結果如何比較？", keywords: ["WER"] }], queries: ["contextual biasing survey"] }),
    topic_select: (req) => {
      // Indices by title (the pool is ranked: the much-cited snowballed paper comes first).
      const u = userText(req);
      const n = (t: string) => Number(new RegExp(`\\[(\\d+)\\] ${t}`).exec(u)?.[1] ?? -1);
      return JSON.stringify({ library: [], candidates: [{ n: n("Deep Context"), reason: "Interspeech 2023，直接相關", role: "recent" }, { n: n("Shallow Fusion"), reason: "ICASSP 2022，代表性做法", role: "core" }, { n: n("Unrelated"), reason: "對照" }, { n: n("Contextual RNN-T"), reason: "被引 300 的經典", role: "seminal" }], excluded: [] });
    },
    topic_read: reader,
    "topic_read:final": reader,
    "write:topic_research": writer,
    "write:topic_polish": writer,
    verify: () => '{"verdict":"pass","issues":[]}',
    verify_final: allPass,
  });

  beforeAll(async () => {
    t = await createTestContext();
    alice = await t.login("student", "alice-topic");
    study = await insertStudy(t.db, alice.id, "串流語音辨識");
    setWorkflowAvailability(async () => true);
  });
  afterAll(async () => t?.close());
  beforeEach(() => {
    searches = [];
    imports = [];
    snowballed = [];
    polishCalls = 0;
    setTopicResearchDeps({
      async snowball(env, seed) {
        snowballed.push(seed.arxiv_id ?? seed.doi ?? "");
        return [{ title: "Contextual RNN-T for Open Domain ASR", year: 2020, venue: "Interspeech", doi: null, arxiv_id: "2006.00003", abstract: "contextual rnn-t", in_library: null, open_access: true, cited_by: 300, via: [`引用〈${seed.title}〉`] }];
      },
      async search(env, query) {
        searches.push({ query, tainted: env.run.tainted });
        return HITS;
      },
      async importPaper(env, studyId, hit) {
        imports.push(hit.title);
        const paper = await insertPaper(t.db, { type: "paper-conference", title: hit.title, authors: [{ family: "Lee", given: "A" }], year: hit.year ?? undefined, ...(hit.arxiv_id ? { arxivId: hit.arxiv_id } : {}), ...(hit.doi ? { doi: hit.doi } : {}) }, env.user.id).catch(async () => (await t.db.query("SELECT * FROM papers WHERE title=$1", [hit.title])).rows[0]);
        const r = await addPaperToStudy(t.db, { studyId, paper, userId: env.user.id });
        // The first candidate has an open-access PDF, the second only an abstract.
        return { paper_id: paper.id, cite_key: r.citeKey, title: paper.title, year: paper.year, has_pdf: hit.open_access === true };
      },
    });
  });
  afterEach(() => setTopicResearchDeps(null));

  it("plans sub-questions + candidates, searches once with keywords, imports only after approval, writes the note", async () => {
    const m = defaultModel();
    const run = await createWorkflow(t.app, await asUser(alice.id), { request: TOPIC, context: { studyId: study.id } });
    expect(run.playbook).toBe("topic_research");
    expect((await runWorkflow(deps(m.port), run.id)).status).toBe("awaiting_plan_approval");
    let r = (await getRun(t.db, run.id))!;
    // Plan card: the sub-questions (outline), the queries sent out, the import write (no draft effect).
    expect(r.plan!.outline!.map((o) => o.title)).toEqual(["熱詞偏置要解決什麼、怎麼評估？", "有哪幾類做法、放在模型哪裡？", "結果如何比較？"]);
    expect(r.plan!.writes.find((w) => w.kind === "paper")).toMatchObject({ label: expect.stringContaining("匯入 4 篇") });
    expect(r.plan!.writes.find((w) => w.kind === "paper")!.effect).toBeUndefined();
    // One batch before anything untrusted: every query ran while the run was untainted, keyword-only (URL dropped).
    // Query expansion: one query per sub-question first, then the survey query, then the rest.
    expect(searches.map((s) => s.query)).toEqual(["contextual biasing RNN-T", "deep biasing transducer", "contextual biasing survey", "dynamic hotword streaming ASR"]);
    expect(searches.every((s) => !s.tainted)).toBe(true);
    // Citation snowballing of the top hits by identifier only.
    expect(snowballed.length).toBeGreaterThan(0);
    expect(snowballed.every((id) => /^\d{4}\.\d{5}$|^10\./.test(id))).toBe(true);
    expect(r.tainted).toBe(true);
    // Nothing is imported before approval.
    expect(imports).toEqual([]);
    const steps = await getSteps(t.db, run.id);
    expect(steps.map((s) => s.key)).toEqual(["research", "paper_1", "paper_2", "paper_3", "paper_4", "taxonomy", "approaches", "results", "practice", "discussion", "polish", "assemble", "final"]);
    expect(steps.find((s) => s.key === "practice")!.title).toBe("在 Zipformer 上怎麼做");
    expect(steps.find((s) => s.key === "research")!.status).toBe("passed");
    expect(steps.find((s) => s.key === "paper_1")!.title).toContain("Deep Context Biasing");
    // The user switches the unrelated candidate off on the plan card.
    await approveWorkflow(t.app, await asUser(alice.id), run.id, { steps: [{ key: "paper_3", skip: true }] });
    expect((await runWorkflow(deps(m.port), run.id)).status).toBe("done");
    expect(imports.sort()).toEqual(["Contextual RNN-T for Open Domain ASR", "Deep Context Biasing for RNN-T", "Shallow Fusion Hotwords in Streaming ASR"]);
    // No open-world search after the run was tainted.
    expect(searches).toHaveLength(4);
    r = (await getRun(t.db, run.id))!;
    expect(r.criteria.every((c) => c.status === "pass")).toBe(true);
    const done = await getSteps(t.db, run.id);
    expect(done.find((s) => s.key === "paper_2")!.output!.summary).toContain("僅依摘要");
    const note = r.artifacts.find((a) => a.kind === "note")!;
    const body = (await t.db.query<{ content_md: string; title: string }>("SELECT content_md, title FROM notes WHERE id=$1", [note.id])).rows[0]!;
    expect(body.title).toBe("主題調研：串流 ASR 熱詞偏置");
    for (const h of ["## 問題定義", "## 方法分類", "## 各方法詳解", "## 實驗結果比較", "## 在 Zipformer 上怎麼做", "## 開放問題", "## 與本研究的關係", "## 參考文獻", "## 搜尋紀錄"]) expect(body.content_md).toContain(h);
    // The consistency pass: its contradictory first round failed topic_consistency and was fixed.
    const pol = done.find((s) => s.key === "polish")!;
    expect(pol.status).toBe("passed");
    expect(pol.history[0]!.verdict.checks.find((c) => c.id === "topic_consistency")!.ok).toBe(false);
    expect(body.content_md).not.toContain("被截斷");
    // 搜尋紀錄: queries, citation tracking, kept with role, the switched-off candidate with its reason.
    const log = body.content_md.slice(body.content_md.indexOf("## 搜尋紀錄"));
    expect(log).toContain("`contextual biasing RNN-T`");
    expect(log).toContain("引用追蹤");
    expect(log).toContain("［經典］");
    expect(log).toMatch(/Unrelated Vision Paper〉：你在計畫中關掉/);
    // Every paper with a numbers table has a row in the results table (deterministic coverage criterion).
    expect(r.criteria.find((c) => c.id === "coverage")!.status).toBe("pass");
    expect(body.content_md).toMatch(/Shallow Fusion Hotwords in Streaming ASR（2022）（僅依摘要）/);
    const keys = (await t.db.query<{ cite_key: string }>("SELECT cite_key FROM study_papers WHERE study_id=$1", [study.id])).rows.map((x) => x.cite_key);
    // Each writer's material is also its verifier's sources (one share per paper; the results writer gets the numbers tables).
    for (const k of [...citedKeys(body.content_md)]) expect(String(r.state.brief_taxonomy)).toContain(`[@${k}]`);
    expect(String(r.state.brief_results)).toContain("| deep biasing | LibriSpeech | WER | 5.2 | 4.1 |");
    expect([...citedKeys(body.content_md)].every((k) => keys.includes(k))).toBe(true);
  });

  it("a job interrupted after the search resumes with the stored candidates (and re-searches only when they were lost)", async () => {
    const m = defaultModel();
    const select = (m as unknown as { port: ModelPort }).port;
    let crash = true;
    const port: ModelPort = { ...select, async chat(role, req, ctx) {
      if (ctx.purpose === "topic_select" && crash) {
        crash = false;
        throw new Error("simulated worker crash");
      }
      return select.chat(role, req, ctx);
    } };
    const run = await createWorkflow(t.app, await asUser(alice.id), { request: TOPIC, context: { studyId: study.id } });
    await expect(runWorkflow(deps(port), run.id)).rejects.toThrow("simulated worker crash");
    let r = (await getRun(t.db, run.id))!;
    expect(r.status).toBe("planning");
    expect(r.tainted).toBe(true);
    expect((r.state.topic_search as { hits: unknown[] }).hits.length).toBeGreaterThan(0);
    const searched = searches.length;
    // Resume: the stored batch is used, no new outbound search, the candidates are intact.
    expect((await runWorkflow(deps(port), run.id)).status).toBe("awaiting_plan_approval");
    expect(searches.length).toBe(searched);
    r = (await getRun(t.db, run.id))!;
    expect(r.plan!.writes.find((w) => w.kind === "paper")!.label).toContain("匯入 4 篇");
    // Results lost but the run is tainted only by its own search: searching again is allowed (queries from the request).
    const lost = await createWorkflow(t.app, await asUser(alice.id), { request: TOPIC, context: { studyId: study.id } });
    await t.db.query(`UPDATE workflow_runs SET tainted=true, taint_sources='["線上搜尋結果"]'::jsonb WHERE id=$1`, [lost.id]);
    const before = searches.length;
    expect((await runWorkflow(deps(port), lost.id)).status).toBe("awaiting_plan_approval");
    expect(searches.length).toBeGreaterThan(before);
    // Tainted by other content: no open-world search at all.
    const other = await createWorkflow(t.app, await asUser(alice.id), { request: TOPIC, context: { studyId: study.id } });
    await t.db.query(`UPDATE workflow_runs SET tainted=true, taint_sources='["文獻〈某篇〉"]'::jsonb WHERE id=$1`, [other.id]);
    const n = searches.length;
    await runWorkflow(deps(port), other.id);
    expect(searches.length).toBe(n);
  });

  it("autopilot (完全自動) approves the import plan; without it the plan waits and sub-question edits re-derive the steps", async () => {
    const m = defaultModel();
    const auto = await createWorkflow(t.app, await asUser(alice.id), { request: "研究現況：streaming ASR 的 hotword 方法", playbook: "topic_research", context: { studyId: study.id }, autopilot: true });
    expect((await runWorkflow(deps(m.port), auto.id)).status).not.toBe("awaiting_plan_approval");
    const autoLogs = (await t.db.query<{ data: { text?: string } }>("SELECT data FROM workflow_events WHERE run_id=$1 AND type='log'", [auto.id])).rows.map((e) => e.data.text ?? "");
    expect(autoLogs.some((e) => e.includes("（完全自動）") && e.includes("匯入"))).toBe(true);
    await t.db.query("UPDATE workflow_runs SET status='cancelled' WHERE id=$1 AND status NOT IN ('done','partial','failed','cancelled')", [auto.id]);
    imports.length = 0;
    const run = await createWorkflow(t.app, await asUser(alice.id), { request: "研究現況：streaming ASR 的 hotword 方法", playbook: "topic_research", context: { studyId: study.id } });
    expect((await runWorkflow(deps(m.port), run.id)).status).toBe("awaiting_plan_approval");
    expect(imports).toEqual([]);
    await approveWorkflow(t.app, await asUser(alice.id), run.id, { outline: [{ title: "有哪幾類做法？", points: ["deep biasing"] }, { title: "延遲與準確率的取捨？", points: [] }] });
    const r = (await getRun(t.db, run.id))!;
    expect(r.plan!.outline!.map((o) => o.title)).toEqual(["有哪幾類做法？", "延遲與準確率的取捨？"]);
    expect((r.state.topic as { subqs: { q: string }[] }).subqs.map((s) => s.q)).toEqual(["有哪幾類做法？", "延遲與準確率的取捨？"]);
    const keys = (await getSteps(t.db, run.id)).map((s) => s.key);
    expect(keys).toContain("research");
    expect(keys).toContain("paper_1");
  });

  it("a reading note asked for a topic without a paper hands over to topic research", async () => {
    const m = defaultModel();
    const run = await createWorkflow(t.app, await asUser(alice.id), { request: "建立研究筆記：Zipformer 架構下有哪些 dynamic hotwording 做法", playbook: "reading_note", context: { studyId: study.id } });
    expect((await runWorkflow(deps(m.port), run.id)).status).toBe("awaiting_plan_approval");
    const r = (await getRun(t.db, run.id))!;
    expect(r.playbook).toBe("topic_research");
    expect(r.question).toBeNull();
    expect(r.title).toContain("主題調研");
  });

  it("lit_review with fewer than 2 study papers offers to switch to topic research", async () => {
    const m = defaultModel();
    const lonely = await insertStudy(t.db, alice.id, "空的研究");
    const run = await createWorkflow(t.app, await asUser(alice.id), { request: "幫我寫文獻回顧", playbook: "lit_review", context: { studyId: lonely.id } });
    expect((await runWorkflow(deps(m.port), run.id)).status).toBe("awaiting_input");
    let r = (await getRun(t.db, run.id))!;
    const card = (r.state.asks as Record<string, { questions: { options: { value: string }[] }[] }>).lit_too_few!;
    expect(card.questions[0]!.options.map((o) => o.value)).toEqual(["topic", "add"]);
    await answerWorkflow(t.app, await asUser(alice.id), run.id, { card_id: "lit_too_few", answers: [{ id: "how", value: "topic" }] });
    expect((await runWorkflow(deps(m.port), run.id)).status).toBe("awaiting_plan_approval");
    r = (await getRun(t.db, run.id))!;
    expect(r.playbook).toBe("topic_research");
    expect(r.plan!.outline!.length).toBe(3);
  });
});
