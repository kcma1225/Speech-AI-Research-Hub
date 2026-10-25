/**
 * Scenario setup on STAGING: the entry (page context), a fresh copy of the fixture deck an edit works on, and the
 * conversation history —
 *   none       a new conversation;
 *   artifact   an earlier run in this conversation created the deck: the transcript of a finished 「交給 Agent」 start
 *              (user turn, assistant start_workflow call + result, done notice) and its `workflow_runs` row (done, the
 *              deck as its artifact, the study, English standing preference on an English deck) are inserted directly —
 *              the same rows a real run leaves, without spending a full run per case;
 *   unrelated  an earlier chat exchange the assistant answered (not part of the task).
 * The direct inserts go through `docker exec <project>-db-1 psql` and refuse the production project.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { PROJECT, sleep, type Hub } from "../client.js";
import { createDeck, type Fixtures } from "../fixtures.js";
import { FIXTURE_DECKS } from "../tasks.js";
import { DECK_FOR, type Scenario } from "./matrix.js";

const run = promisify(execFile);
if (PROJECT === "hub") throw new Error("Refusing to seed scenarios on production.");

/** Runs SQL on the staging database (seeding only). */
async function stagingWrite(sql: string): Promise<void> {
  const child = run("docker", ["exec", "-i", `${PROJECT}-db-1`, "psql", "-v", "ON_ERROR_STOP=1", "-q", "-U", process.env.EVAL_DB_USER ?? "research_hub", "-d", process.env.EVAL_DB_NAME ?? "research_hub"], { maxBuffer: 8 * 1024 * 1024 });
  child.child.stdin?.end(sql);
  await child;
}
const lit = (s: string) => {
  const tag = `q${randomUUID().slice(0, 8)}`;
  return `$${tag}$${s}$${tag}$`;
};
const json = (v: unknown) => `${lit(JSON.stringify(v))}::jsonb`;

export type Setup = { conversationId: string; context: Record<string, unknown>; deckId: string | null; seededRunId: string | null };

export function contextFor(s: Pick<Scenario, "entry">, fx: Fixtures, deckId: string | null): Record<string, unknown> {
  if (s.entry === "home") return { path: "/" };
  if (s.entry === "study") return { path: `/studies/${fx.main.slug}`, studyId: fx.main.id, studySlug: fx.main.slug };
  return { path: `/studies/${fx.main.slug}/decks/${deckId}/edit`, studyId: fx.main.id, studySlug: fx.main.slug, ...(deckId ? { deckId } : {}) };
}

/** Waits for the conversation's assistant run to finish (chat turns of the history). */
export async function waitChat(hub: Hub, conv: string, timeoutMs = 4 * 60_000): Promise<{ status: string; toolCalls: { tool: string; status: string; result?: unknown }[]; messages: { role: string; text?: string }[] }> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    await sleep(4_000);
    const d = await hub.api<{ toolCalls: { tool: string; status: string; result?: unknown }[]; run: { status: string } | null; messages: { role: string; text?: string }[] }>("GET", `/agent/conversations/${conv}`);
    const st = d.run?.status ?? "done";
    if (!["running", "awaiting_llm"].includes(st) || Date.now() > end) return { status: st, toolCalls: d.toolCalls, messages: d.messages };
  }
}

export async function chatTurn(hub: Hub, conv: string, text: string, context: Record<string, unknown>) {
  await hub.api("POST", `/agent/conversations/${conv}/messages`, { text, context });
  return waitChat(hub, conv);
}

export async function setupScenario(hub: Hub, fx: Fixtures, s: Scenario, tag: string, userId: string): Promise<Setup> {
  const deckLang = DECK_FOR[s.intent] ?? (s.history === "artifact" ? "en" : null);
  const needsDeck = s.entry === "deck" || s.history === "artifact" || !!DECK_FOR[s.intent];
  let deckId: string | null = null;
  if (needsDeck && (s.entry === "deck" || s.history === "artifact")) {
    const f = FIXTURE_DECKS[deckLang ?? "en"];
    deckId = await createDeck(hub, fx.main.id, `${f.title}〔scenario ${s.id} ${tag}〕`, f.body);
  } else if (s.entry === "deck") {
    deckId = await createDeck(hub, fx.main.id, `${FIXTURE_DECKS.en.title}〔scenario ${s.id} ${tag}〕`, FIXTURE_DECKS.en.body);
  }
  const context = contextFor(s, fx, deckId);
  const conv = (await hub.api<{ conversation: { id: string } }>("POST", "/agent/conversations", { autopilot: false, context: s.entry === "home" ? null : context })).conversation.id;
  let seededRunId: string | null = null;
  if (s.history === "artifact" && deckId) seededRunId = await seedEarlierRun(fx, conv, deckId, deckLang ?? "en", userId, s.entry === "home" ? null : context);
  if (s.history === "unrelated") await chatTurn(hub, conv, "CER 和 WER 有什麼差別？用兩三句話回答就好。", context);
  for (const t of s.extraTurns ?? []) await chatTurn(hub, conv, t, context);
  return { conversationId: conv, context, deckId, seededRunId };
}

/** Inserts the transcript + run row of a finished earlier run that created `deckId` (see the module comment). */
async function seedEarlierRun(fx: Fixtures, conv: string, deckId: string, lang: "zh" | "en", userId: string, pageContext: Record<string, unknown> | null): Promise<string> {
  const runId = randomUUID();
  const callId = `wf_seed${runId.slice(0, 6)}`;
  const request = lang === "en" ? "幫我做一份熱詞偏置的英文簡報，整理文獻庫的方法" : "幫我做一份熱詞偏置的簡報，整理文獻庫的方法";
  const title = lang === "en" ? FIXTURE_DECKS.en.title : FIXTURE_DECKS.zh.title;
  const langReq = { id: "r1", type: "language", text: "成果全部用English（封面、標題、內文、圖表標籤與講稿都不留中文）", params: { language: "en" }, source: "request", quote: "英文簡報" };
  const reqs = lang === "en" ? [langReq] : [];
  const at = new Date(Date.now() - 40 * 60_000).toISOString();
  const brief = { version: 1, deliverable: { kind: "deck", label: "簡報", hard: true }, user_words: [request], base: 1, paraphrase: null, requirements: reqs, unspecified: ["頁數"], checklist: [], source: "plan", at };
  const state = { route: { kind: "deck", deck: "topic", playbook: "slides", deliverable: "deck", batch: false, informed: true, reason: "主題簡報（用文獻庫）", at }, requirements: reqs, deck: { deck_id: deckId, deck_title: title } };
  const result = `<tool_result tool="start_workflow" trust="user">\n${JSON.stringify({ workflow_id: runId, status: "planning", playbook: "slides", message: "工作流程已開始規劃；計畫卡片已顯示給使用者，確認後才會執行。不要描述結果，等工作流程回報。" })}\n</tool_result>`;
  const artifacts = [{ kind: "deck", id: deckId, url: `/studies/${fx.main.slug}/decks/${deckId}/edit`, title, role: "draft" }];
  await stagingWrite(`
BEGIN;
INSERT INTO agent_messages(conversation_id, role, content, text, page_context, created_at) VALUES ('${conv}', 'user', ${json([{ type: "text", text: `（交給 Agent）${request}` }])}, ${lit(request)}, ${pageContext ? json(pageContext) : "NULL"}, now() - interval '40 minutes');
INSERT INTO agent_messages(conversation_id, role, content, text, created_at) VALUES ('${conv}', 'assistant', ${json([{ type: "text", text: "好的，我把這件事交給工作流程：先擬出目標、驗收標準與計畫給你確認，確認後才開始寫入草稿。" }, { type: "tool_use", id: callId, name: "start_workflow", input: { request } }])}, ${lit("好的，我把這件事交給工作流程：先擬出目標、驗收標準與計畫給你確認，確認後才開始寫入草稿。")}, now() - interval '40 minutes');
INSERT INTO agent_messages(conversation_id, role, content, created_at) VALUES ('${conv}', 'tool', ${json([{ type: "tool_result", tool_use_id: callId, content: result }])}, now() - interval '40 minutes');
INSERT INTO workflow_runs(id, user_id, study_id, conversation_id, playbook, title, request, objective, criteria, plan, inputs, context, state, status, autopilot, artifacts, report, brief, created_at, updated_at, started_at, finished_at)
VALUES ('${runId}', '${userId}', '${fx.main.id}', '${conv}', 'slides', ${lit(`主題簡報：${title}`)}, ${lit(request)}, ${lit("建立主題簡報")}, '[]'::jsonb,
        ${json({ summary: "主題簡報", writes: [{ kind: "deck", label: `新簡報「${title}」（草稿，不會發布版本）`, effect: "new" }], requirements: reqs })}, '{}'::jsonb, ${pageContext ? json(pageContext) : "'{}'::jsonb"}, ${json(state)}, 'done', false, ${json(artifacts)},
        ${json({ summary_md: "完成，所有驗收標準都通過。", done: ["撰寫簡報"], issues: [] })}, ${json(brief)}, now() - interval '40 minutes', now() - interval '20 minutes', now() - interval '40 minutes', now() - interval '20 minutes');
INSERT INTO agent_messages(conversation_id, role, content, text, created_at) VALUES ('${conv}', 'notice', ${json([{ type: "notice", kind: "workflow_done", workflowId: runId }])}, ${lit(`工作流程「主題簡報：${title}」已完成，所有驗收標準都通過。`)}, now() - interval '20 minutes');
${lang === "en" ? `UPDATE decks SET agent_prefs = ${json({ requirements: [{ type: "language", text: langReq.text, params: { language: "en" } }], run_id: runId, updated_at: at })} WHERE id = '${deckId}';` : ""}
COMMIT;`);
  return runId;
}
