/**
 * 「先確認先備知識」 tools (conversation switch `prereq_check`; src/agent/tutor.ts holds the rules): the model reads a
 * paper and submits its concepts (`extract_prerequisites`); code orders them and fills the `concept_check` card
 * (`ask_user`); `next_concept` says which gap to teach next and whether to offer the one explain-back;
 * `add_subconcepts` is the lazy recursion; `mark_concepts` records outcomes and remembers them (`user_concepts`, no
 * consent card: the user is the source, and 設定 → 記憶 → 懂的概念 shows / edits / deletes them). All risk read (they
 * only change the conversation's tutoring state and the user's own concept memory), chat only, never on MCP.
 */
import { z } from "zod";
import { transaction } from "../../db.js";
import { badRequest, conflict, notFound } from "../../lib/http.js";
import { getPaper } from "../../lib/library/store.js";
import {
  addSubConcepts,
  applyOutcomes,
  buildSession,
  cardRows,
  conceptInput,
  LEVEL_LABEL,
  loadMemory,
  loadSession,
  MAX_SUB_PER_PARENT,
  nextConcept,
  normaliseKey,
  OUTCOMES,
  saveSession,
  savedLine,
  termLabel,
  writeMemory,
  type Session,
  type SessionConcept,
} from "../tutor.js";
import { registerAgentTool, type AgentToolContext } from "./registry.js";
import { clip, isUuid, uuidArg } from "./util.js";

const paperArg = uuidArg("Paper (the library paper you read with read_paper)");
const CARD_PROMPT = "這篇論文會用到這些概念，你熟悉哪些？";

function conversationOf(ctx: AgentToolContext): string {
  if (ctx.source !== "agent" || !ctx.conversationId) throw badRequest("先備知識確認只能在對話中使用。");
  return ctx.conversationId;
}

async function paperOf(ctx: AgentToolContext, id: string) {
  const paper = isUuid(id) ? await getPaper(ctx.db, id) : null;
  if (!paper) throw notFound("文獻不存在。");
  return paper;
}

/** Runs `work` on the locked session of (conversation, paper); saves it afterwards. */
async function withSession<T>(ctx: AgentToolContext, paperId: string, work: (s: Session, db: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const conv = conversationOf(ctx);
  if (!isUuid(paperId)) throw notFound("文獻不存在。");
  return transaction(ctx.db, async (client) => {
    const s = await loadSession(client, conv, paperId, true);
    if (!s) throw conflict("這篇論文還沒有整理先備概念：先 read_paper，再呼叫 extract_prerequisites。");
    const out = await work(s, client);
    await saveSession(client, conv, s);
    return out;
  });
}

const brief = (c: SessionConcept) => ({
  key: c.key,
  term: termLabel(c),
  gloss: c.gloss,
  ...(c.section ? { section: c.section } : {}),
  centrality: c.centrality,
  ...(c.depends_on.length ? { depends_on: c.depends_on } : {}),
  ...(c.depth ? { depth: c.depth, parent: c.parent } : {}),
  status: c.status,
  ...(c.level ? { level: c.level } : {}),
});

registerAgentTool({
  name: "extract_prerequisites",
  title: "整理先備概念",
  titleEn: "Extract prerequisites",
  risk: "read",
  mcp: false,
  conversationFlag: "prereq_check",
  description:
    "After reading a paper (read_paper: abstract, method, key equations), list the concepts it builds on. kind prerequisite = background the paper assumes " +
    "(aim for 6–10; mark core vs supporting and depends_on between them), paper_defined = terms the paper introduces, symbol = notation (these two are explained in context, never asked). " +
    "One-line gloss each, in the paper's own wording when it defines the term. The system orders them (leaves first), checks the user's concept memory and tells you how to ask.",
  input: z.object({
    paper_id: paperArg,
    concepts: z.array(conceptInput).min(1).max(30),
  }),
  summarize: (a) => `整理論文的先備概念（${a.concepts.filter((c) => c.kind === "prerequisite").length} 個）`,
  async execute(a, ctx) {
    const conv = conversationOf(ctx);
    const paper = await paperOf(ctx, a.paper_id);
    const read = await ctx.db.query("SELECT 1 FROM tool_calls WHERE conversation_id=$1 AND tool='read_paper' AND status='done' AND args->>'paper_id'=$2 LIMIT 1", [conv, paper.id]);
    if (!read.rowCount) throw conflict("先用 read_paper 讀這篇論文（摘要、方法與關鍵公式），再整理先備概念。");
    const memory = await loadMemory(ctx.db, ctx.user.id, a.concepts.map((c) => normaliseKey(c.key || c.term_en)).filter(Boolean));
    const built = buildSession(paper.id, a.concepts, memory);
    const s = built.session;
    const prereqs = s.concepts.filter((c) => c.kind === "prerequisite");
    if (!prereqs.length) s.answered = true;
    await transaction(ctx.db, (client) => saveSession(client, conv, s));
    const rows = cardRows(s);
    const verified = prereqs.filter((c) => c.status === "done");
    const call = { questions: [{ id: "concepts", type: "concept_check", prompt: CARD_PROMPT, paper_id: paper.id }] };
    const next = !prereqs.length
      ? "沒有需要先確認的先備概念：直接講解論文，論文自己定義的詞與符號在講到時說明。"
      : rows.length
        ? `下一步：呼叫 ask_user ${JSON.stringify(call)}（卡片要列哪些概念由系統填入，不要自己列；也不要在文字裡重複列出），然後結束這一輪。`
        : "這些先備概念使用者之前都已確認懂了：不用出卡片，直接講解論文。";
    return {
      data: {
        paper_id: paper.id,
        title: clip(paper.title, 120),
        prerequisites: prereqs.map(brief),
        paper_defined: s.concepts.filter((c) => c.kind !== "prerequisite").map((c) => ({ key: c.key, term: termLabel(c), gloss: c.gloss, kind: c.kind, ...(c.section ? { section: c.section } : {}) })),
        card_rows: rows.length,
        already_verified: verified.map((c) => c.key),
        ...(built.dropped.length ? { dropped: built.dropped } : {}),
        ...(built.merged.length ? { merged_duplicates: built.merged } : {}),
        ...(built.cyclesBroken.length ? { cycles_broken_at: built.cyclesBroken } : {}),
      },
      text: [
        `已整理〈${clip(paper.title, 60)}〉的概念：先備 ${prereqs.length} 個（教學順序：${prereqs.map((c) => c.key).join(" → ") || "無"}），論文自己定義的詞／符號 ${s.concepts.length - prereqs.length} 個（講到時在脈絡中說明，不要問）。`,
        verified.length ? `使用者之前已確認懂：${verified.map((c) => c.key).join("、")}（不用再問也不用講）。` : "",
        built.dropped.length ? `超過上限沒有收進來：${built.dropped.join("、")}。` : "",
        built.cyclesBroken.length ? `依賴關係有循環，已在 ${built.cyclesBroken.join("、")} 斷開。` : "",
        next,
      ].filter(Boolean).join("\n"),
    };
  },
});

registerAgentTool({
  name: "next_concept",
  title: "下一個要補的概念",
  titleEn: "Next concept",
  risk: "read",
  mcp: false,
  conversationFlag: "prereq_check",
  description:
    "Which prerequisite to teach next (decided by the system: dependencies first, sub-prerequisites before their parent). Call it after the concept_check answer, " +
    "and again before walking through a paper section with `section` (only the gaps that section needs). Teach ONE concept, then call it again until it says none are left.",
  input: z.object({
    paper_id: paperArg,
    section: z.string().trim().max(40).optional().describe("The paper section you are about to explain, e.g. '3' or '3.2' or 'Method'"),
  }),
  summarize: (a) => (a.section ? `取得講 §${a.section} 前要補的概念` : "取得下一個要補的概念"),
  async execute(a, ctx) {
    return withSession(ctx, a.paper_id, async (s) => {
      const n = nextConcept(s, a.section ?? null);
      if (n.kind === "card_needed") throw conflict(`使用者還沒回答概念確認卡片：先呼叫 ask_user ${JSON.stringify({ questions: [{ id: "concepts", type: "concept_check", prompt: CARD_PROMPT, paper_id: s.paper_id }] })}。`);
      if (n.kind === "none") {
        return {
          data: { next: null, section: n.section, remaining: n.remaining },
          text: n.section
            ? `§${n.section} 之前沒有需要先補的概念（整篇還有 ${n.remaining} 個要補）：直接講這一節。`
            : "沒有要補的概念了：繼續講解論文。",
        };
      }
      const c = n.concept;
      const how = n.mode === "recap" ? "使用者說「有聽過」：用 2–4 句簡短複習重點，連到這篇論文怎麼用它。" : "使用者說「不懂」：從直覺講起，配一個具體例子，再連到這篇論文怎麼用它；不要用使用者還沒懂的詞。";
      const verify = n.verify
        ? `這是核心概念：講完後可以（選擇性）邀請使用者用一句話說明，例如「用一句話說：${c.term_zh || c.term_en} 在做什麼？（想跳過也可以）」，然後結束這一輪；之後用 mark_concepts 記錄 explain_back_passed / explain_back_failed / skipped。`
        : "不要出確認題；講完依使用者的反應用 mark_concepts 記錄 understood / unclear / skipped（使用者沒有表示時，可以在下一個概念開始前一起記錄）。";
      return {
        data: { next: brief(c), mode: n.mode, verify: n.verify, before_section: n.before_section, remaining_after: n.remaining, ...(n.chain.length ? { needed_for: n.chain } : {}) },
        text: [
          `下一個：[${c.key}] ${termLabel(c)}${c.section ? `（論文 §${c.section} 需要）` : ""}${n.chain.length ? `，是為了理解 ${n.chain.join(" ← ")}` : ""}。`,
          `一句話說明：${c.gloss}`,
          how,
          verify,
          `講完這個之後還有 ${n.remaining} 個要補。使用者還是不懂時，用 add_subconcepts 列出它依賴的更基礎概念（每個最多 ${MAX_SUB_PER_PARENT} 個）。`,
        ].join("\n"),
      };
    });
  },
});

registerAgentTool({
  name: "add_subconcepts",
  title: "拆出更基礎的概念",
  titleEn: "Add sub-prerequisites",
  risk: "read",
  mcp: false,
  conversationFlag: "prereq_check",
  description:
    "The user still does not understand a prerequisite: add the 1–3 more basic concepts it rests on (they are taught first, then the parent again). " +
    "The system limits depth (3 levels) and the total; concepts the user is known to understand are skipped.",
  input: z.object({
    paper_id: paperArg,
    parent: z.string().trim().min(1).max(120).describe("Key of the concept the user did not understand"),
    concepts: z.array(conceptInput.omit({ kind: true, centrality: true, depends_on: true, section: true })).min(1).max(MAX_SUB_PER_PARENT),
  }),
  summarize: (a) => `拆出「${a.parent}」需要的基礎概念（${a.concepts.length} 個）`,
  async execute(a, ctx) {
    const memory = await loadMemory(ctx.db, ctx.user.id, a.concepts.map((c) => normaliseKey(c.key || c.term_en)).filter(Boolean));
    return withSession(ctx, a.paper_id, async (s) => {
      let out;
      try {
        out = addSubConcepts(s, a.parent, a.concepts.map((c) => ({ ...c, kind: "prerequisite" as const })), memory);
      } catch (e) {
        throw conflict((e as Error).message);
      }
      return {
        data: out,
        text: [
          out.added.length ? `已加入：${out.added.join("、")}（會先講這些，再回到 ${normaliseKey(a.parent)}）。` : "",
          out.linked.length ? `已在清單中，改為先講：${out.linked.join("、")}。` : "",
          out.known.length ? `使用者之前標記懂，不用講：${out.known.join("、")}。` : "",
          out.refused.length ? `沒有加入：${out.refused.map((r) => `${r.key}（${r.why}）`).join("、")}。` : "",
          "接著呼叫 next_concept 取得要講的概念。",
        ].filter(Boolean).join("\n"),
      };
    });
  },
});

registerAgentTool({
  name: "mark_concepts",
  title: "記錄概念理解",
  titleEn: "Mark concepts",
  risk: "read",
  mcp: false,
  conversationFlag: "prereq_check",
  description:
    "Record how teaching went, per concept key: understood (the user says they get it), unclear (still lost — explain differently or add_subconcepts), " +
    "explain_back_passed / explain_back_failed (only after the explain-back next_concept offered), skipped (the user skipped it or the explain-back). " +
    "Set stop_checks when the user does not want to be asked (「直接講」). Outcomes are remembered in the user's concept memory.",
  input: z.object({
    paper_id: paperArg,
    updates: z.array(z.object({ key: z.string().trim().min(1).max(120), outcome: z.enum(OUTCOMES) })).max(12),
    stop_checks: z.boolean().optional().describe("The user does not want explain-back questions any more"),
  }),
  summarize: (a) => `記錄 ${a.updates.length} 個概念的理解狀況`,
  async execute(a, ctx) {
    const res = await withSession(ctx, a.paper_id, async (s, client) => {
      const r = applyOutcomes(s, a.updates, !!a.stop_checks);
      const saved = await writeMemory(client, ctx.user.id, s.paper_id, r.writes);
      return { ...r, saved, s };
    });
    const byKey = new Map(res.s.concepts.map((c) => [c.key, c]));
    const line = savedLine(res.saved, byKey);
    const left = res.s.concepts.filter((c) => c.kind === "prerequisite" && c.status !== "done").length;
    return {
      data: {
        saved: res.saved.map((w) => ({ key: w.key, level: w.level, level_label: LEVEL_LABEL[w.level], source: w.source })),
        ...(res.unknown.length ? { unknown_keys: res.unknown } : {}),
        checks_off: res.s.checks_off,
        remaining: left,
      },
      text: [
        line ? `${line}（用一句話轉告使用者即可）。` : "",
        res.unknown.length ? `找不到這些概念：${res.unknown.join("、")}（只能用 extract_prerequisites／add_subconcepts 的 key）。` : "",
        ...res.notes,
        res.s.checks_off ? "之後不要再出確認題。" : "",
        left ? `還有 ${left} 個概念要補：需要時呼叫 next_concept。` : "先備概念都處理完了：繼續講解論文。",
      ].filter(Boolean).join("\n"),
      links: res.saved.length ? [{ label: "管理懂的概念", url: "/settings?tab=assistant#concepts", kind: "memory" as const }] : [],
    };
  },
});

/** `ask_user` prepare (tools/ask.ts): fills a concept_check question's rows from the conversation's session. */
export async function prepareConceptCheck(q: { paper_id?: string; concepts?: unknown }, ctx: AgentToolContext) {
  const conv = conversationOf(ctx);
  const on = (await ctx.db.query<{ prereq_check: boolean }>("SELECT prereq_check FROM conversations WHERE id=$1", [conv])).rows[0]?.prereq_check;
  if (!on) throw badRequest("這個對話沒有開啟「先確認先備知識」，不能出概念確認卡片；請用一般問題。");
  const s = q.paper_id && isUuid(q.paper_id) ? await loadSession(ctx.db, conv, q.paper_id) : null;
  if (!s) throw conflict("這篇論文還沒有整理先備概念：先 read_paper，再呼叫 extract_prerequisites。");
  const rows = cardRows(s);
  if (!rows.length) throw conflict("這些先備概念使用者都已確認懂了：不需要出卡片，直接講解論文。");
  return rows;
}
