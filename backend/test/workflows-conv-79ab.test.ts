/**
 * Production conversation 79ab0678 end to end (real DB + S3, scripted model), with its exact texts:
 * 1. the notes-language request on the deck an earlier run of the same home-page chat made (e6d552fc): the study comes
 *    from the deck, no question, a revise named 「修改簡報」, only this turn's words, notes 繁中 + slides English;
 * 2. the topic request from a home-page chat with two studies (0668a3d7): a study-picker card whose answer is an input —
 *    not the user's words, not a requirement, not the topic;
 * 3. an answer 「就剛剛的那個研究」 resolves to the conversation's last workflow study.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ChatResult } from "../src/ai/types.js";
import { runWorkflow } from "../src/workflows/engine.js";
import { getRun } from "../src/workflows/store.js";
import { getAgentTool } from "../src/agent/tools/registry.js";
import { pendingAsk } from "../src/workflows/questions.js";
import { answerWorkflow, createWorkflow, workflowDetail } from "../src/workflows/service.js";
import { setTopicResearchDeps } from "../src/workflows/playbooks/research.js";
import type { ModelPort } from "../src/workflows/types.js";
import { createTestContext, hasTestDb, hasTestS3, type TestContext } from "./helpers.js";
import { insertStudy } from "./study-fixtures.js";
import { setWorkflowAvailability } from "../src/routes/workflows.js";
import "../src/workflows/playbooks/index.js";
import "../src/workflows/agent-tools.js";
import { REQUEST_A, REQUEST_B } from "./fixtures-79ab.js";

process.env.PROVIDER_TOKEN_KEY ??= randomBytes(32).toString("base64");
const run = hasTestDb && hasTestS3 ? describe : describe.skip;

type Req = { messages: { role: string; content: unknown }[] };
const result = (text: string): ChatResult => ({ text, reasoning: "", toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 50 }, message: { role: "assistant", content: text } });
const textOf = (req: Req) => req.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
const QUESTION = "我想要知道我們目前這個簡報它是偏向Hot Word還是Contextual Biasing";
const STUDY = "串流 ASR 的動態熱詞效率研究";

function mockModel() {
  const replies = new Map<string, string | ((req: Req) => string)>();
  const log: { purpose: string; prompt: string }[] = [];
  const port: ModelPort = {
    async chat(_role, req, ctx) {
      log.push({ purpose: ctx.purpose, prompt: textOf(req as Req) });
      const r = replies.get(ctx.purpose) ?? "{}";
      return result(typeof r === "function" ? r(req as Req) : r);
    },
    available: async () => true,
    vision: async () => false,
  };
  return { port, log, set: (p: string, r: string | ((req: Req) => string)) => replies.set(p, r), prompts: (p: string) => log.filter((l) => l.purpose === p).map((l) => l.prompt) };
}

/** An English deck (slides + English speaker notes) the earlier run wrote. */
const EN_DECK = ["Dynamic Hotwording in Streaming ASR", "Taxonomy of Methods", "Shallow Fusion"].map((t) => `## ${t}\n\n- ${t} as described in the library papers\n\n::: {.notes}\nThis slide introduces ${t.toLowerCase()} and explains where the contextual bias is injected in the model.\n:::`).join("\n\n");

run("production conversation 79ab0678", () => {
  let t: TestContext;
  let user: { id: string; cookie: string };
  let studyS: { id: string; slug: string };
  let studyOther: { id: string; slug: string };
  let m: ReturnType<typeof mockModel>;
  const deps = () => ({ db: t.db, storage: t.storage, app: t.app, model: m.port, log: t.app.log, signal: new AbortController().signal, jobId: null, previewWaitMs: 2_000 });
  const asUser = async () => {
    const { toCurrentUser, CURRENT_USER_COLUMNS } = await import("../src/lib/auth.js");
    return toCurrentUser((await t.db.query(`SELECT ${CURRENT_USER_COLUMNS} FROM users u WHERE u.id=$1`, [user.id])).rows[0]);
  };
  /** A home-page chat: no study in the conversation or its messages' page context. */
  const homeChat = async () => (await t.db.query<{ id: string }>("INSERT INTO conversations(user_id,mode,context) VALUES($1,'chat','{}') RETURNING id", [user.id])).rows[0]!.id;
  const msg = (conv: string, role: string, text: string, content: unknown[] = [{ type: "text", text }]) =>
    t.db.query("INSERT INTO agent_messages(conversation_id,role,content,text,page_context) VALUES($1,$2,$3,$4,$5)", [conv, role, JSON.stringify(content), text, role === "user" ? JSON.stringify({ path: "/" }) : null]);
  const toolCtx = async (conv: string) => ({ app: t.app, db: t.db, user: await asUser(), source: "agent" as const, conversationId: conv, runId: null, autopilot: false });

  beforeAll(async () => {
    t = await createTestContext();
    user = await t.login("student", "brian9429-test");
    studyS = await insertStudy(t.db, user.id, STUDY);
    studyOther = await insertStudy(t.db, user.id, "低資源語音辨識");
    setWorkflowAvailability(async () => true);
    setTopicResearchDeps({ async search() { return []; }, async snowball() { return []; } });
  });
  afterAll(async () => {
    setTopicResearchDeps(null);
    await t?.close();
  });
  beforeEach(() => {
    m = mockModel();
    m.set("requirements", '{"requirements":[]}');
    m.set("verify", '{"verdict":"pass","issues":[]}');
    m.set("title_translate", "Hotword Mechanisms under Zipformer and RNN-T");
  });

  it("1. 「講稿要是中文的」 on the earlier run's deck: study from the deck, no question, a revise, notes 繁中 + slides English", async () => {
    // The deck run 0668a3d7 made in study S (English, with English notes; its standing preference is English).
    const { createTree } = await import("../src/lib/slides/sources.js");
    const deckId = (await t.db.query<{ id: string }>("INSERT INTO decks(study_id,kind,title,slug,share_key,created_by,updated_by,agent_prefs) VALUES($1,'progress',$2,$3,$4,$5,$5,$6) RETURNING id",
      [studyS.id, "Efficiency Study of Dynamic Hotwording in Streaming ASR", `hw-${randomBytes(3).toString("hex")}`, `sk-${randomBytes(6).toString("hex")}`, user.id,
        JSON.stringify({ requirements: [{ type: "language", text: "成果全部用English（封面、標題、內文、圖表標籤與講稿都不留中文）", params: { language: "en" }, source: "standing" }] })])).rows[0]!.id;
    await createTree(t.db, deckId, user.id, "ai", [{ path: "index.qmd", content: `---\ntitle: "Efficiency Study of Dynamic Hotwording in Streaming ASR"\n---\n\n${EN_DECK}\n` }]);
    await t.db.query("UPDATE deck_source_trees SET revision=9 WHERE deck_id=$1", [deckId]);
    const conv = await homeChat();
    await msg(conv, "user", REQUEST_A);
    await msg(conv, "assistant", "好的，我把這件事交給工作流程。", [{ type: "tool_use", id: "wf_a", name: "start_workflow", input: { request: REQUEST_A } }]);
    await t.db.query(
      "INSERT INTO workflow_runs(user_id,study_id,conversation_id,playbook,title,request,status,artifacts,state) VALUES($1,$2,$3,'slides','主題簡報',$4,'partial',$5,$6)",
      [user.id, studyS.id, conv, REQUEST_A, JSON.stringify([{ kind: "deck", id: deckId, title: "Efficiency Study", url: "/x", role: "draft" }]), JSON.stringify({ deck: { deck_id: deckId, body: EN_DECK } })],
    );
    await msg(conv, "user", QUESTION);
    await msg(conv, "assistant", "", [{ type: "tool_use", id: "c1", name: "get_workflow", input: {} }]);
    await msg(conv, "assistant", "目前這份簡報整體偏向 Contextual Biasing。");
    await msg(conv, "user", "ok");
    await msg(conv, "assistant", "好的。");
    await msg(conv, "user", REQUEST_B);

    const out = await getAgentTool("start_workflow")!.execute({ deck_id: deckId, request: REQUEST_B, playbook: "slides" } as never, await toolCtx(conv) as never);
    const id = (out.data as { workflow_id: string }).workflow_id;
    const created = (await getRun(t.db, id))!;
    // The study comes from the deck at creation: the route decision is informed (deck = edit, revise).
    expect(created.study_id).toBe(studyS.id);
    expect(created.state.route).toMatchObject({ deck: "edit", edit: "revise", informed: true });
    expect(created.brief!.user_words).toEqual([REQUEST_B]);

    m.set("outline", JSON.stringify({ pages: ["Dynamic Hotwording in Streaming ASR", "Taxonomy of Methods", "Shallow Fusion"].map((title, i) => ({ title, points: ["Same slide, notes in Chinese"], from: i + 1 })) }));
    // The model restates what the deterministic detection already has (staging eval: two duplicates on the card).
    m.set("requirements", JSON.stringify({ requirements: [
      { type: "other", text: "講稿中多使用英文的專用名詞", quote: "當然你應該要多用一點英文的專用名詞" },
      { type: "tone", text: "講稿要能夠一字一句直接照念", quote: "這個講稿要我能夠一比一的念出來不會有違和" },
    ] }));
    expect((await runWorkflow(deps(), id)).status).toBe("awaiting_plan_approval");
    const r = (await getRun(t.db, id))!;
    expect(r.question).toBeNull();
    expect(Object.keys((r.state.asks as object | undefined) ?? {})).toEqual([]);
    expect(r.plan!.edit_kind).toBe("revise");
    expect(r.title.startsWith("修改簡報") || r.plan!.summary.includes("讀取現有")).toBe(true);
    const reqs = r.brief!.requirements;
    expect(reqs.map((x) => [x.type, x.params?.language ?? null, x.params?.part ?? null, x.source])).toEqual([
      ["language", "zh", "notes", "request"],
      ["tone", null, "notes", "request"],
      ["language", "en", "slides", "standing"],
    ]);
    expect(r.criteria.find((c) => c.id === "req_r1")!.check).toMatchObject({ id: "req_language", params: { language: "zh", part: "notes" } });
    expect(r.criteria.find((c) => c.id === "req_r3")!.check).toMatchObject({ id: "req_language", params: { language: "en", part: "slides" } });
    // No 0→1 wording anywhere the user sees: card, route log, run view.
    const view = await workflowDetail(t.app, await asUser(), id);
    expect(view.workflow.playbook_title).toBe("修改簡報");
    expect(JSON.stringify(view)).not.toContain("從 0 到 1");
    const logs = (await t.db.query<{ data: { text?: string } }>("SELECT data FROM workflow_events WHERE run_id=$1 AND type='log'", [id])).rows.map((x) => x.data.text ?? "");
    expect(logs.some((l) => l.includes("修改簡報"))).toBe(true);
    expect(logs.join("\n")).not.toContain("從 0 到 1");
    // Every writer is told: notes in 繁中 with English terms, slides stay English.
    const block = m.prompts("outline").join("\n");
    expect(block).toContain("講稿（::: {.notes}）語言：繁體中文");
    expect(block).toContain("投影片本體（封面、頁面標題、條列、表格、圖表與流程圖標籤、圖說）語言：English");
  });

  it("2. a home-page topic request with two studies: a study-picker card; the answer is not the topic or a requirement", async () => {
    const conv = await homeChat();
    await msg(conv, "user", REQUEST_A);
    await msg(conv, "assistant", "好的。", [{ type: "tool_use", id: "wf_b", name: "start_workflow", input: { request: REQUEST_A } }]);
    const out = await getAgentTool("start_workflow")!.execute({ request: REQUEST_A } as never, await toolCtx(conv) as never);
    const id = (out.data as { workflow_id: string }).workflow_id;
    expect((await getRun(t.db, id))!.study_id).toBeNull();
    expect((await runWorkflow(deps(), id)).status).toBe("awaiting_input");
    const card = pendingAsk((await getRun(t.db, id))!.state)!;
    expect(card.title).toBe("要把簡報放在哪個研究？");
    expect(card.questions[0]!.options!.map((o) => o.label)).toEqual(expect.arrayContaining([STUDY, "低資源語音辨識"]));
    // The user types the study's name (「其他」), as in production.
    m.set("topic_plan", JSON.stringify({ title: "Zipformer 與 RNN-T 的熱詞機制", topic: "Zipformer 與 RNN-T 架構下的熱詞機制", subquestions: [{ q: "有哪幾類熱詞做法？", keywords: ["contextual biasing"] }, { q: "注入位置？", keywords: ["RNN-T"] }] }));
    m.set("topic_select", '{"library":[],"candidates":[]}');
    m.set("outline", JSON.stringify({ pages: Array.from({ length: 10 }, (_, i) => ({ title: `Page ${i + 1}`, points: ["x"] })) }));
    await answerWorkflow(t.app, await asUser(), id, { card_id: card.id, answers: [{ id: "study", other: STUDY }] });
    expect((await runWorkflow(deps(), id)).status).toBe("awaiting_plan_approval");
    const r = (await getRun(t.db, id))!;
    expect(r.study_id).toBe(studyS.id);
    // An input, not the user's words / a requirement / the topic.
    expect(r.brief!.user_words).toEqual([REQUEST_A.replace(/\s+/g, " ").trim()]);
    expect(r.brief!.requirements.some((x) => (x.quote ?? "").includes("效率"))).toBe(false);
    expect(String(r.state.topic_title)).toContain("Zipformer");
    expect(String(r.state.topic_title)).not.toContain("效率");
    expect(r.title).not.toContain("效率");
    expect(m.prompts("topic_plan")[0]).toContain("只是背景");
    // All six asks of the spoken request are on the card (language, per-item fields, the rest in the user's words).
    const texts = r.brief!.requirements.map((x) => x.text).join("\n");
    expect(texts).toContain("每個方法都要有：優點、缺點、架構圖、論文、發表會議／期刊");
    expect(texts).toContain("成果全部用English");
    expect(texts).toContain("以研究文獻庫的論文為來源，統計並列出有哪幾種方法");
    // The topic clause, in the user's own words.
    expect(texts).toContain("照你說的：「我要你幫我做一個簡報這個簡報裡面詳細描述了");
  });

  it("3. 「就剛剛的那個研究」 answers the study card with the conversation's last workflow study", async () => {
    const conv = await homeChat();
    await msg(conv, "user", "幫我做一份熱詞做法的主題簡報");
    const id = (await createWorkflow(t.app, await asUser(), { request: "幫我做一份熱詞做法的主題簡報", playbook: "slides", conversationId: conv })).id;
    expect((await runWorkflow(deps(), id)).status).toBe("awaiting_input");
    const card = pendingAsk((await getRun(t.db, id))!.state)!;
    // Meanwhile the conversation's other workflow ran in the second study.
    await t.db.query("INSERT INTO workflow_runs(user_id,study_id,conversation_id,playbook,title,request,status) VALUES($1,$2,$3,'slides','x','x','done')", [user.id, studyOther.id, conv]);
    m.set("topic_plan", JSON.stringify({ title: "熱詞", topic: "熱詞做法", subquestions: [{ q: "做法？", keywords: ["biasing"] }, { q: "比較？", keywords: ["WER"] }] }));
    m.set("topic_select", '{"library":[],"candidates":[]}');
    m.set("outline", JSON.stringify({ pages: Array.from({ length: 10 }, (_, i) => ({ title: `Page ${i + 1}`, points: ["x"] })) }));
    await answerWorkflow(t.app, await asUser(), id, { card_id: card.id, answers: [{ id: "study", other: "就剛剛的那個研究 同一個簡報繼續做" }] });
    expect((await runWorkflow(deps(), id)).status).toBe("awaiting_plan_approval");
    expect((await getRun(t.db, id))!.study_id).toBe(studyOther.id);
  });

  /** A deck the conversation's earlier run wrote (study S, English). */
  async function earlierDeck(conv: string) {
    const { createTree } = await import("../src/lib/slides/sources.js");
    const deckId = (await t.db.query<{ id: string }>("INSERT INTO decks(study_id,kind,title,slug,share_key,created_by,updated_by) VALUES($1,'progress',$2,$3,$4,$5,$5) RETURNING id",
      [studyS.id, `Hotword survey ${randomBytes(2).toString("hex")}`, `hw-${randomBytes(3).toString("hex")}`, `sk-${randomBytes(6).toString("hex")}`, user.id])).rows[0]!.id;
    await createTree(t.db, deckId, user.id, "ai", [{ path: "index.qmd", content: `---\ntitle: "Hotword survey"\n---\n\n${EN_DECK}\n` }]);
    await t.db.query("UPDATE deck_source_trees SET revision=5 WHERE deck_id=$1", [deckId]);
    await t.db.query("INSERT INTO workflow_runs(user_id,study_id,conversation_id,playbook,title,request,status,artifacts,state) VALUES($1,$2,$3,'slides','x','x','done',$4,$5)",
      [user.id, studyS.id, conv, JSON.stringify([{ kind: "deck", id: deckId, title: "Hotword survey", url: "/x", role: "draft" }]), JSON.stringify({ deck: { deck_id: deckId, body: EN_DECK } })]);
    return deckId;
  }

  it("4. 「剛剛那個簡報」 with no deck page open edits the deck the conversation's last workflow wrote", async () => {
    const conv = await homeChat();
    const deckId = await earlierDeck(conv);
    const run = await createWorkflow(t.app, await asUser(), { request: "幫我改剛剛那個簡報的講稿，講稿要是中文的，專有名詞保留英文，講稿要能一比一照著念。", playbook: "slides", conversationId: conv });
    const r = (await getRun(t.db, run.id))!;
    expect(r.inputs.deck_id).toBe(deckId);
    expect(r.study_id).toBe(studyS.id);
    expect(r.state.route).toMatchObject({ deck: "edit", edit: "revise" });
  });

  it("5. a NEW deck asked on a deck page is a new deck, not an edit of that deck", async () => {
    const conv = await homeChat();
    const deckId = await earlierDeck(conv);
    const run = await createWorkflow(t.app, await asUser(), { request: "幫我做一份這週的研究進度報告簡報，大概 8 頁，投影片用英文，講稿用中文。", playbook: "slides", conversationId: conv, context: { studyId: studyS.id, deckId } });
    const r = (await getRun(t.db, run.id))!;
    expect(r.inputs.deck_id).toBeUndefined();
    expect((r.state.route as { deck?: string }).deck).not.toBe("edit");
  });

  it("6. the assistant cannot hand over a deck it only found by search (not this conversation's, not named)", async () => {
    const other = await homeChat();
    const unrelated = await earlierDeck(other);
    const conv = await homeChat();
    await msg(conv, "user", "刪掉第 3 頁");
    await expect(getAgentTool("start_workflow")!.execute({ deck_id: unrelated, request: "刪掉第 3 頁", playbook: "slides" } as never, await toolCtx(conv) as never)).rejects.toThrow(/不要對用搜尋或列表挑出來的成果動手/);
    // Named by its exact title: allowed.
    const title = (await t.db.query<{ title: string }>("SELECT title FROM decks WHERE id=$1", [unrelated])).rows[0]!.title;
    await msg(conv, "user", `把〈${title}〉刪掉第 3 頁`);
    const out = await getAgentTool("start_workflow")!.execute({ deck_id: unrelated, request: "刪掉第 3 頁", playbook: "slides" } as never, await toolCtx(conv) as never);
    expect((out.data as { workflow_id: string }).workflow_id).toBeTruthy();
  });
});
