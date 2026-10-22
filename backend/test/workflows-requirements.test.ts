/**
 * Requirement probe suite (requirements.ts) with a scripted mock model — "test one dimension and something else breaks"
 * caught before users. The mock writers behave like an obedient model: they write English only when the prompt carries
 * the requirements block, so every scenario also proves the block reaches that step. Scenarios:
 * 1. translate a Chinese deck to English incl. the cover; a render fix that brings Chinese back is caught by the
 *    no-regression guard and repaired; the deck's title / standing preferences follow;
 * 2. follow-up 「再詳細一點，每個方法要有架構、Pros/Cons」 without repeating the language → still English (standing),
 *    expand mode with per-item fields checked on the item pages;
 * 3. remove a page + include a topic the model extracted; 4. an exact page count on a new deck;
 * 5. an English note (generic): a Chinese draft fails the language criterion and only that writer is repaired;
 * 6. a partial run: the chat notice lists what is unmet; under autopilot one 繼續改 round starts by itself.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ChatResult } from "../src/ai/types.js";
import { runWorkflow } from "../src/workflows/engine.js";
import { approveWorkflow, createWorkflow } from "../src/workflows/service.js";
import { getRun, getSteps } from "../src/workflows/store.js";
import { registerWorkflowPlaybook } from "../src/workflows/playbooks/index.js";
import { languageViolations } from "../src/workflows/requirements.js";
import { toModelMessages, type StoredMessage } from "../src/agent/prompt.js";
import type { ModelPort } from "../src/workflows/types.js";
import { createTestContext, hasTestDb, hasTestS3, type TestContext } from "./helpers.js";
import { insertStudy } from "./study-fixtures.js";
import { setWorkflowAvailability } from "../src/routes/workflows.js";

process.env.PROVIDER_TOKEN_KEY ??= randomBytes(32).toString("base64");
const run = hasTestDb && hasTestS3 ? describe : describe.skip;

type Req = { messages: { role: string; content: unknown }[] };
type Reply = string | ((req: Req, purpose: string) => string);
const result = (text: string): ChatResult => ({ text, reasoning: "", toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 50 }, message: { role: "assistant", content: text } });
const textOf = (req: Req, role?: string) => req.messages.filter((m) => !role || m.role === role).map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
/** The prompt carries the English requirement (the block every producer gets). */
const wantsEnglish = (req: Req) => textOf(req).includes("Write every visible word of the output in English");

function mockModel() {
  const queues = new Map<string, Reply[]>();
  const defaults = new Map<string, Reply>();
  const log: { purpose: string; prompt: string }[] = [];
  const port: ModelPort = {
    async chat(_role, req, ctx) {
      log.push({ purpose: ctx.purpose, prompt: textOf(req as Req) });
      const q = queues.get(ctx.purpose);
      const reply = q?.length ? q.shift()! : defaults.get(ctx.purpose) ?? defaults.get("*") ?? "{}";
      return result(typeof reply === "function" ? reply(req as Req, ctx.purpose) : reply);
    },
    available: async () => true,
    vision: async () => false,
  };
  return {
    port, log,
    queue(purpose: string, ...replies: Reply[]) { queues.set(purpose, [...(queues.get(purpose) ?? []), ...replies]); },
    set(purpose: string, reply: Reply) { defaults.set(purpose, reply); },
    count(purpose: string) { return log.filter((l) => l.purpose === purpose).length; },
    prompts(purpose: string) { return log.filter((l) => l.purpose === purpose).map((l) => l.prompt); },
  };
}

const PASS = '{"verdict":"pass","issues":[]}';
const allPass = (req: Req) => JSON.stringify({ results: [...textOf(req, "user").matchAll(/- \[([a-z0-9_]+)\]/g)].map((m) => ({ id: m[1], pass: true, evidence: "Problem", reason: "ok" })) });

const EN: Record<string, string> = { 問題定義: "Problem", 方法: "Method", 卡住: "Blocked", 結果: "Results" };
const table = (en: boolean) => (en ? "| Item | Status |\n|---|---|\n| Data | Done |" : "| 項目 | 狀態 |\n|---|---|\n| 資料 | 完成 |");
/** One slide in English or Chinese (the item pages carry the per-item fields). */
function page(title: string, en: boolean, extra = "") {
  return `## ${title}\n\n${en ? "- Key point taken from the study data" : "- 依據研究資料的重點"}${extra}\n\n${table(en)}\n\n::: {.notes}\n${en ? `This page explains ${title} using what the study data actually records.` : `這一頁說明${title}的內容與資料來源，報告時大約一分鐘，重點放在研究資料裡實際記錄的進展與數字。`}\n:::`;
}
const itemFields = "\n- Architecture: a biasing module next to the decoder\n- Pros: no retraining\n- Cons: over-biasing on common words";
/** Titles of the pages a writer was asked for (`your_pages`). */
const askedPages = (req: Req) => {
  const block = /<data name="your_pages"[^>]*>\n([\s\S]*?)\n<\/data>/.exec(textOf(req, "user"))?.[1] ?? "";
  return [...block.matchAll(/^\d+\. (.+?)(?:（學生自填）)?(?:（介紹：(.+?)）)?$/gm)].map((x) => ({ title: x[1]!, item: x[2] }));
};
const writer = (req: Req) => askedPages(req).map((p) => page(p.title, wantsEnglish(req), p.item ? itemFields : "")).join("\n\n");
/** The targeted fix: every page block rewritten in English (titles translated). */
const englishFix = (req: Req) => [...textOf(req, "user").matchAll(/<data name="page_\d+"[^>]*>\n## (.+)\n/g)].map((m) => page(EN[m[1]!.trim()] ?? m[1]!.trim(), true)).join("\n\n");

const ORIGINAL = ["問題定義", "方法", "卡住"].map((t) => page(t, false)).join("\n\n");

run("workflow requirements (probe suite)", () => {
  let t: TestContext;
  let alice: { id: string; cookie: string };
  let study: { id: string; slug: string };
  let m: ReturnType<typeof mockModel>;
  let stop = false;
  let worker: Promise<void>;
  /** Deck ids whose next preview render fails once (to exercise the render fix). */
  const failNext = new Set<string>();
  const deps = () => ({ db: t.db, storage: t.storage, app: t.app, model: m.port, log: t.app.log, signal: new AbortController().signal, jobId: null, previewWaitMs: 15_000 });
  const asUser = async (id: string) => {
    const { toCurrentUser, CURRENT_USER_COLUMNS } = await import("../src/lib/auth.js");
    return toCurrentUser((await t.db.query(`SELECT ${CURRENT_USER_COLUMNS} FROM users u WHERE u.id=$1`, [id])).rows[0]);
  };
  const qmdOf = async (deckId: string) => (await t.db.query<{ content: string }>("SELECT s.content FROM deck_sources s JOIN deck_source_trees tr ON tr.deck_id=s.deck_id AND s.path=tr.entry WHERE s.deck_id=$1", [deckId])).rows[0]!.content;
  async function newDeck(title: string, body: string) {
    const { createTree } = await import("../src/lib/slides/sources.js");
    const id = (await t.db.query<{ id: string }>("INSERT INTO decks(study_id,kind,title,slug,share_key,created_by,updated_by) VALUES($1,'progress',$2,$3,$4,$5,$5) RETURNING id", [study.id, title, `req-${randomBytes(4).toString("hex")}`, `sk-${randomBytes(6).toString("hex")}`, alice.id])).rows[0]!.id;
    await createTree(t.db, id, alice.id, "ai", [{ path: "index.qmd", content: `---\ntitle: ${title}\n---\n\n${body}\n` }]);
    await t.db.query("UPDATE deck_source_trees SET revision=3 WHERE deck_id=$1", [id]);
    return id;
  }
  async function planAndRun(request: string, extra: Record<string, unknown> = {}) {
    const r = await createWorkflow(t.app, await asUser(alice.id), { request, context: { studyId: study.id }, ...extra });
    expect((await runWorkflow(deps(), r.id)).status).toBe("awaiting_plan_approval");
    const planned = (await getRun(t.db, r.id))!;
    await approveWorkflow(t.app, await asUser(alice.id), r.id, {});
    const out = await runWorkflow(deps(), r.id);
    return { id: r.id, planned, status: out.status, run: (await getRun(t.db, r.id))! };
  }

  beforeAll(async () => {
    t = await createTestContext();
    alice = await t.login("student", "alice-req");
    study = await insertStudy(t.db, alice.id, "熱詞研究");
    setWorkflowAvailability(async () => true);
    // Fake worker: completes preview renders (one failure when asked), screenshots with clean metrics.
    worker = (async () => {
      while (!stop) {
        const jobs = (await t.db.query<{ id: string; payload: { previewId: string; deckId: string; shots?: boolean } }>("SELECT id, payload FROM jobs WHERE kind='slide_preview' AND status='queued'")).rows;
        for (const j of jobs) {
          if (failNext.delete(j.payload.deckId)) {
            await t.db.query("UPDATE deck_previews SET status='failed', finished_at=now() WHERE id=$1", [j.payload.previewId]);
            await t.db.query("UPDATE jobs SET status='failed', error='quarto: YAML parse error', finished_at=now() WHERE id=$1", [j.id]);
            continue;
          }
          const pv = (await t.db.query<{ output_prefix: string }>("UPDATE deck_previews SET status='ready', entry_html='index.html', finished_at=now() WHERE id=$1 RETURNING output_prefix", [j.payload.previewId])).rows[0];
          if (!j.payload.shots || !pv) {
            await t.db.query("UPDATE jobs SET status='succeeded', finished_at=now() WHERE id=$1", [j.id]);
            continue;
          }
          const qmd = (await t.db.query<{ content: string }>("SELECT content FROM deck_sources WHERE deck_id=$1 AND path='index.qmd'", [j.payload.deckId])).rows[0]?.content ?? "";
          const titles = ["", ...[...qmd.matchAll(/^## (.+)$/gm)].map((x) => x[1]!.trim())];
          const metrics = { words: 20, bullets: 2, minFont: 22, maxFont: 40, overflowY: 0, overflowX: 0, visuals: 1, tables: 1, diagrams: 0, diagramErrors: 0, rawDiagramCode: 0, codeBlocks: 0, emptyBand: 0.1 };
          await t.storage.put(`${pv.output_prefix}_hub/shots.json`, Buffer.from(JSON.stringify({ version: 1, width: 1280, height: 800, total: titles.length, truncated: false, pages: titles.map((title, i) => ({ index: i + 1, h: i, title, metrics })) })), "application/json");
          await t.db.query("UPDATE jobs SET result=$2, status='succeeded', finished_at=now() WHERE id=$1", [j.id, JSON.stringify({ shots: { count: titles.length } })]);
        }
        await new Promise((r) => setTimeout(r, 150));
      }
    })();
  });
  afterAll(async () => {
    stop = true;
    await worker;
    await t?.close();
  });
  beforeEach(() => {
    m = mockModel();
    m.set("requirements", '{"requirements":[]}');
    m.set("verify", PASS);
    m.set("verify_final", allPass);
    m.set("title_translate", "Dynamic Hotwording Progress");
    m.set("write_slides", writer);
    m.set("requirement_fix", englishFix);
    m.set("speaker_notes", '{"notes":[]}');
  });

  let deckId = "";

  it("1. translate to English incl. the cover; a render fix that brings Chinese back is repaired; title + preferences follow", async () => {
    deckId = await newDeck("動態熱詞進度", ORIGINAL);
    m.set("outline", JSON.stringify({ pages: ["Problem", "Method", "Blocked"].map((title) => ({ title, points: ["From the original page"] })) }));
    // The first render fails; the render fix "repairs" the syntax but drifts back to Chinese (the production failure).
    failNext.add(deckId);
    m.set("render_fix", () => ["問題定義", "方法", "卡住"].map((x) => page(x, false)).join("\n\n"));
    const { planned, status, run: r } = await planAndRun("整份改成英文", { inputs: { deck_id: deckId } });
    expect(planned.plan!.requirements!.map((x) => [x.type, x.params?.language, x.source])).toEqual([["language", "en", "request"]]);
    expect(planned.plan!.edit_kind).toBe("revise");
    expect(planned.plan!.front_title).toBe("Dynamic Hotwording Progress");
    expect(planned.criteria.find((c) => c.id === "req_r1")!.check!.id).toBe("req_language");
    expect(status, JSON.stringify(r.report?.issues)).toBe("done");
    // Every writer got the English block; the regression was caught and only those pages were rewritten.
    expect(m.prompts("write_slides").every((p) => p.includes("Write every visible word"))).toBe(true);
    expect(m.count("render_fix")).toBe(1);
    expect(m.count("requirement_fix")).toBeGreaterThanOrEqual(1);
    const qmd = await qmdOf(deckId);
    expect(languageViolations(qmd, "en")).toEqual([]);
    expect(qmd).toContain('title: "Dynamic Hotwording Progress"');
    const deck = (await t.db.query<{ title: string; metadata: { original_title?: string }; agent_prefs: { requirements: { type: string; params: { language: string } }[] } }>("SELECT title, metadata, agent_prefs FROM decks WHERE id=$1", [deckId])).rows[0]!;
    expect(deck.title).toBe("Dynamic Hotwording Progress");
    expect(deck.metadata.original_title).toBe("動態熱詞進度");
    expect(deck.agent_prefs.requirements.map((x) => [x.type, x.params.language])).toEqual([["language", "en"]]);
  });

  it("1b. student pages with earlier answers, an AI-filled mark and a skipped placeholder are translated too, incl. the cover", async () => {
    // The production deck: Lab-Hub student pages filled earlier (AI-filled answers, a skipped page) and a Chinese cover.
    const { applyStudentPages } = await import("../src/workflows/student-input.js");
    const body = applyStudentPages(["## 問題定義\n\n- x\n\n" + table(false) + "\n\n::: {.notes}\n" + "說明問題與資料來源，報告時大約一分鐘，重點放在研究資料裡實際記錄的進展與數字。" + "\n:::", "## 卡住\n\n〔　〕", "## 下週與要問\n\n〔　〕"].join("\n\n"), [
      { title: "卡住", lines: ["資料量不足：標註資料太少"], skipped: false, source: "option", ai_filled: true },
      { title: "下週與要問", lines: [], skipped: true, source: "skipped" },
    ]);
    const id = await newDeck("Zipformer + RNNT 動態熱詞：學術現況", body);
    m.set("title_translate", "Zipformer + RNN-T Dynamic Hotwording: State of the Art");
    m.set("outline", JSON.stringify({ pages: ["Problem", "Blocked", "Next Week and Questions"].map((title) => ({ title, points: ["From the original page"] })) }));
    // A lazy writer: translates what it writes itself but copies label-looking lines (marks, placeholders, fixed notes) verbatim.
    const label = /AI 代填|AI draft|〔|\[ |由報告者補充|To be added|Left for you/;
    m.set("write_slides", (req) => {
      const u = textOf(req, "user");
      const originals = (/<data name="original_pages"[^>]*>\n([\s\S]*?)\n<\/data>/.exec(u)?.[1] ?? "").split(/<!-- 第 \d+ 頁 -->\n/).filter((x) => x.trim());
      return askedPages(req).map((p, i) => {
        const orig = originals[i] ?? "";
        // …and, like the cheap model on staging, fills a page the student left open with its own content.
        const open = /〔|Left for you/.test(orig);
        const kept = open ? [] : orig.split("\n").filter((l) => label.test(l) && !l.startsWith("##"));
        const notes = open ? "" : /::: \{\.notes\}\n([\s\S]*?)\n:::/.exec(orig)?.[1] ?? "";
        return `## ${p.title}\n\n${kept.filter((l) => !notes.includes(l)).join("\n")}\n- The presenter's point in English\n\n${table(true)}\n\n::: {.notes}\n${label.test(notes) ? notes : "This page explains the point using what the study data actually records."}\n:::`;
      }).join("\n\n");
    });
    const { planned, status, run: r } = await planAndRun("全英文翻譯", { inputs: { deck_id: id } });
    expect(planned.plan!.front_title).toBe("Zipformer + RNN-T Dynamic Hotwording: State of the Art");
    // No student-input step on a revision: earlier answers cannot be re-injected in the original language.
    expect((await getSteps(t.db, r.id)).some((s) => s.key === "student_input")).toBe(false);
    expect(status, JSON.stringify(r.report?.issues)).toBe("done");
    const qmd = await qmdOf(id);
    expect(languageViolations(qmd, "en")).toEqual([]);
    expect(qmd).toContain('title: "Zipformer + RNN-T Dynamic Hotwording: State of the Art"');
    expect(qmd).toContain("AI draft, please confirm");
    // The page the student left for themselves stays theirs: only the prompt changed language, nothing AI-written.
    expect(qmd).toMatch(/## Next Week and Questions\n\n\[ Left for you to write: add your own thoughts here \]\n\n::: \{\.notes\}\n\(To be added by the presenter\.\)/);
    // The labels were localized before the writers saw them: no page needed a language repair.
    expect(m.count("requirement_fix")).toBe(0);
  });

  it("2. follow-up 「再詳細一點，每個方法要有架構、Pros/Cons」 without the language: English kept, expand with per-item fields", async () => {
    expect(deckId).toBeTruthy();
    m.set("outline", (req) => {
      // The outline planner is told the per-item rule (one page per method, named in `item`).
      expect(textOf(req, "user")).toContain("JSON 的 item 欄位");
      return JSON.stringify({ pages: [
        { title: "Problem", points: ["Rare words in streaming ASR"] },
        { title: "Shallow fusion", points: ["Architecture", "Pros", "Cons"], item: "Shallow fusion" },
        { title: "TCPGen", points: ["Architecture", "Pros", "Cons"], item: "TCPGen" },
        { title: "Comparison", points: ["Side by side"] },
        { title: "Blocked", points: ["Data"] },
      ] });
    });
    // The study's notes about the focus ground the methods the expansion presents.
    await t.db.query("INSERT INTO notes(study_id,kind,title,content_md,created_by,updated_by) VALUES($1,'research','熱詞方法筆記',$2,$3,$3)", [study.id, "Shallow fusion 與 TCPGen 是兩種動態熱詞做法，各有 Pros 和 Cons。", alice.id]);
    const { planned, status, run: r } = await planAndRun("再詳細一點，每個方法要有架構、Pros/Cons", { inputs: { deck_id: deckId } });
    const reqs = planned.plan!.requirements!;
    expect(reqs.find((x) => x.type === "language")).toMatchObject({ source: "standing", params: { language: "en" } });
    expect(reqs.find((x) => x.type === "per_item_fields")!.params!.items).toEqual(["Shallow fusion", "TCPGen"]);
    expect(planned.plan!.edit_kind).toBe("expand");
    expect(planned.criteria.some((c) => c.id === "expanded")).toBe(true);
    expect(planned.criteria.some((c) => c.id === "revised")).toBe(false);
    expect(planned.criteria.find((c) => c.check?.id === "req_fields")).toBeTruthy();
    expect(status, JSON.stringify(r.report?.issues)).toBe("done");
    expect(r.criteria.find((c) => c.check?.id === "req_fields")!.status).toBe("pass");
    const qmd = await qmdOf(deckId);
    expect(languageViolations(qmd, "en")).toEqual([]);
    expect((qmd.match(/^## /gm) ?? []).length).toBe(5);
  });

  it("3. remove a page and include a topic the model extracted: the page is dropped at planning, the topic is checked", async () => {
    const id = await newDeck("熱詞週報", ORIGINAL);
    m.set("requirements", JSON.stringify({ requirements: [{ type: "include_topics", text: "一定要提到 shallow fusion", quote: "一定要提到 shallow fusion", params: { topics: [{ name: "shallow fusion", aliases: ["淺層融合"] }] } }] }));
    m.set("outline", JSON.stringify({ pages: [{ title: "問題定義", points: ["罕見詞"] }, { title: "方法", points: ["淺層融合"] }, { title: "卡住", points: ["資料"] }] }));
    m.set("write_slides", (req) => askedPages(req).map((p) => page(p.title, false, p.title === "方法" ? "\n- 淺層融合（shallow fusion）" : "")).join("\n\n"));
    const { planned, status, run: r } = await planAndRun("刪掉「卡住」這頁，一定要提到 shallow fusion", { inputs: { deck_id: id } });
    expect(planned.plan!.outline!.map((o) => o.title)).toEqual(["問題定義", "方法"]);
    expect(planned.plan!.requirements!.map((x) => x.type).sort()).toEqual(["exclude", "include_topics"]);
    expect(status, JSON.stringify(r.report?.issues)).toBe("done");
    expect(r.criteria.filter((c) => c.id.startsWith("req_")).every((c) => c.status === "pass")).toBe(true);
    expect(await qmdOf(id)).not.toMatch(/^## 卡住/m);
  });

  it("4. an exact page count on a new deck becomes a checked requirement", async () => {
    m.set("outline", JSON.stringify({ pages: ["問題定義", "方法", "結果", "下一步"].map((title) => ({ title, points: ["依資料"] })) }));
    const { planned, status, run: r } = await planAndRun("幫我做這個研究的進度報告簡報，做成 4 頁", { playbook: "slides", inputs: { mode: "progress" } });
    expect(planned.plan!.outline!.length).toBe(4);
    expect(planned.criteria.find((c) => c.check?.id === "req_pages")!.check!.params).toMatchObject({ exact: 4 });
    expect(status, JSON.stringify(r.report?.issues)).toBe("done");
  });

  it("5. an English note: a Chinese draft fails the language criterion, only that writer is repaired; title + headings in English", async () => {
    m.set("plan_generic", JSON.stringify({ title: "熱詞方法比較", objective: "比較熱詞方法", criteria: ["涵蓋 WFST"], steps: [{ key: "s1", title: "背景", role: "writer", instructions: "寫背景" }, { key: "s2", title: "方法比較", role: "writer", instructions: "寫方法", depends_on: ["s1"] }] }));
    m.set("requirements", JSON.stringify({ requirements: [{ type: "include_topics", text: "要提到 WFST", quote: "要提到 WFST", params: { topics: [{ name: "WFST" }] } }] }));
    let s2 = 0;
    m.set("write:generic", (req) => {
      const u = textOf(req, "user");
      if (u.includes("寫方法")) {
        s2++;
        // The first draft ignores the requirement (a cheap model drifting back to the default language).
        if (s2 === 1) return "## 方法比較\n\nWFST 解碼圖把熱詞編進搜尋空間，TCPGen 用字首樹指標產生器，兩者各有取捨，需要依延遲、資料量與部署環境選擇；串流情境下還要考慮每個熱詞對解碼速度的影響，以及熱詞清單很長時的記憶體用量。";
        return "## Method comparison\n\nA WFST decoding graph compiles the hotwords into the search space, while TCPGen uses a prefix-tree pointer generator; the right choice depends on latency and data.";
      }
      return "## Background\n\nStreaming ASR often misses rare entity names; dynamic hotwording biases decoding towards a user-provided list without retraining the model.";
    });
    const { planned, status, run: r } = await planAndRun("用英文寫一份熱詞方法比較筆記，要提到 WFST", { playbook: "generic" });
    expect(planned.plan!.requirements!.map((x) => x.type).sort()).toEqual(["include_topics", "language"]);
    expect(planned.criteria.find((c) => c.check?.id === "req_language")!.check!.params).toMatchObject({ doc: true });
    expect(status, JSON.stringify(r.report?.issues)).toBe("done");
    const steps = await getSteps(t.db, r.id);
    expect(steps.find((s) => s.key === "s1")!.round).toBe(0);
    expect(steps.find((s) => s.key === "s2")!.round).toBeGreaterThan(0);
    const note = (await t.db.query<{ title: string; content_md: string; agent_prefs: { requirements: { type: string }[] } }>("SELECT title, content_md, agent_prefs FROM notes WHERE id=$1", [r.artifacts.find((a) => a.kind === "note")!.id])).rows[0]!;
    expect(note.title).toBe("Dynamic Hotwording Progress");
    expect(languageViolations(note.content_md, "en", [], true)).toEqual([]);
    expect(note.agent_prefs.requirements.map((x) => x.type)).toEqual(["language"]);
  });

  it("6. partial: the chat notice lists the unmet items (also for the model); autopilot starts one 繼續改 round by itself", async () => {
    let calls = 0;
    registerWorkflowPlaybook({
      id: "test_req", title: "要求測試", titleEn: "Req", description: "", descriptionEn: "", autoApprovable: true, detect: () => 0,
      async plan() {
        return { kind: "plan", title: "要求", objective: "寫一段", plan: { summary: "一段", writes: [{ kind: "note", label: "沒有", effect: "new" }] }, criteria: [],
          steps: [{ key: "w", role: "writer", title: "撰寫", instructions: "寫", verify: { checks: [], judge: false } }, { key: "final", role: "verifier", kind: "final", title: "最終驗收", instructions: "", depends_on: ["w"] }] };
      },
      async execute(env, step) {
        const r = await env.call({ purpose: "w", role: "writer", messages: [{ role: "user", content: step.instructions }] }, step.id);
        return { summary: "x", text: r.text };
      },
      async finalText(env) {
        return { text: (await getSteps(env.db, env.run.id)).find((s) => s.key === "w")?.output?.text ?? "", data: null };
      },
    });
    // Chinese for the first draft and both final repair rounds; English afterwards.
    m.set("w", () => (++calls <= 3 ? "## 結果\n\n中文的結果段落。" : "## Results\n\nThe results paragraph in English."));
    const conv = (await t.db.query<{ id: string }>("INSERT INTO conversations(user_id,mode,context) VALUES($1,'chat','{}') RETURNING id", [alice.id])).rows[0]!.id;
    const manual = await planAndRun("用英文寫結果", { playbook: "test_req", conversationId: conv });
    expect(manual.status).toBe("partial");
    const notice = (await t.db.query<{ text: string; content: { items?: string[]; model?: boolean; workflowId?: string }[] }>("SELECT text, content FROM agent_messages WHERE conversation_id=$1 AND role='notice' ORDER BY seq DESC LIMIT 1", [conv])).rows[0]!;
    expect(notice.text).toContain("要我修這幾項嗎？");
    expect(notice.content[0]!.items![0]).toContain("成果全部用English");
    expect(notice.content[0]!.workflowId).toBe(manual.id);
    // The model sees it with the user's next turn (never between a tool call and its result).
    const rows = [
      { id: "1", seq: "1", role: "user", content: [{ type: "text", text: "寫結果" }], text: "寫結果", reasoning: "", provider_state: null, status: "complete" },
      { id: "2", seq: "2", role: "notice", content: notice.content as never, text: notice.text, reasoning: "", provider_state: null, status: "complete" },
      { id: "3", seq: "3", role: "user", content: [{ type: "text", text: "好，修" }], text: "好，修", reasoning: "", provider_state: null, status: "complete" },
    ] as StoredMessage[];
    const msgs = toModelMessages(rows);
    expect(JSON.stringify(msgs.at(-1))).toContain("要我修這幾項嗎");
    expect(JSON.stringify(msgs.at(-1))).toContain("好，修");

    calls = 0;
    const created = await createWorkflow(t.app, await asUser(alice.id), { request: "用英文寫結果", playbook: "test_req", context: { studyId: study.id }, autopilot: true });
    const out = await runWorkflow(deps(), created.id);
    const auto = (await getRun(t.db, created.id))!;
    expect(out.status, JSON.stringify(auto.report?.issues)).toBe("done");
    expect(auto.state.auto_continued).toBe(true);
    expect(calls).toBe(4);
  });
});
