/**
 * Workflow invariants (src/workflows/invariants.ts, docs/research/agent-invariants.md) on the stored shapes of the
 * production conversation 79ab0678 (2026-10-25): run A 0668a3d7 (spoken-style topic deck, partial) and run B e6d552fc
 * (「講稿改成中文」 on that deck from a home-page chat, stuck in awaiting_input). Each invariant must catch its failure
 * on the real shape AND stay silent on a corrected copy of the same shape (no false positive).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INVARIANTS, checkConversation, checkRun, clauses, contentClauses, languageClaims, setupAnswers, taskTurns, type ConversationBundle, type RunBundle, type StoredMessage, type StoredRun } from "../src/workflows/invariants.js";

type Fx = {
  now: string; conversation: { id: string; study_id: string | null; context: Record<string, unknown> };
  runs: StoredRun[]; events: (RunBundle["events"] extends (infer E)[] | undefined ? E & { run_id: string } : never)[];
  steps: (NonNullable<RunBundle["steps"]>[number] & { run_id: string })[]; messages: StoredMessage[];
  artifact_studies: Record<string, string>; studies: { id: string; title: string }[]; library: NonNullable<RunBundle["library"]>;
};
const fx = JSON.parse(readFileSync(new URL("./fixtures/invariants/conv-79ab0678.json", import.meta.url), "utf8")) as Fx;
const RUN_A = "0668a3d7-5e96-4a00-a752-2181e9475f09";
const RUN_B = "e6d552fc-fbe0-4b93-8954-17ecfdcf007b";
const DECK_STUDY = "654c8823-4fc9-4ab2-bb70-a7af313f92fd";
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

function bundle(id: string, patch: (b: RunBundle) => void = () => undefined): RunBundle {
  const run = clone(fx.runs.find((r) => r.id === id)!);
  const b: RunBundle = {
    run, events: clone(fx.events.filter((e) => e.run_id === id)), steps: clone(fx.steps.filter((s) => s.run_id === id)),
    conversation: clone(fx.conversation), messages: clone(fx.messages), siblings: clone(fx.runs.filter((r) => r.id !== id)),
    artifactStudies: clone(fx.artifact_studies), studies: clone(fx.studies), library: clone(fx.library), now: fx.now,
  };
  patch(b);
  return b;
}
const ids = (b: RunBundle, only?: string[]) => checkRun(b, only).map((f) => f.invariant);
const count = (b: RunBundle, id: string) => checkRun(b, [id]).length;

const A_WORDS = fx.runs.find((r) => r.id === RUN_A)!.brief!.user_words![0]!;
const B_WORDS = "有個東西我想要你幫我改這個簡報裡面的講稿要是中文的當然你應該要多用一點英文的專用名詞這個講稿要我能夠一比一的念出來不會有違和";

describe("text helpers", () => {
  it("segments a spoken run-on request (no punctuation) into its asks", () => {
    const cs = contentClauses(A_WORDS);
    expect(cs.map((c) => c.clause)).toEqual([
      "我要你幫我做一個簡報", "這個簡報裡面詳細描述了目前時數界是怎麼在Zipformer和RNNT的架構下做熱詞機制的", "我要你參考我們的文獻庫", "那請你詳細統計一下有哪幾種方法",
      "並且詳細敘述每一種方法的好處跟壞處", "我要這份報告簡報是用英文的", "並且在講解方法的時候要搭配模型的架構圖來更好的演示", "並且在提到方法的時候要講到這一篇論文是哪一篇", "還有他們的會議或是期刊是哪一個",
    ]);
    expect(cs[0]!.core).toBe(true);
    expect(cs.filter((c) => c.core)).toHaveLength(1);
    expect(contentClauses(B_WORDS).filter((c) => !c.core).map((c) => c.clause)).toEqual(["這個簡報裡面的講稿要是中文的", "當然你應該要多用一點英文的專用名詞", "這個講稿要我能夠一比一的念出來不會有違和"]);
  });
  it("reads per-part language and ignores the language of technical terms", () => {
    expect(languageClaims(B_WORDS)).toEqual([{ part: "notes", lang: "zh", clause: "這個簡報裡面的講稿要是中文的" }]);
    expect(languageClaims("我要這份報告簡報是用英文的")).toEqual([{ part: "all", lang: "en", clause: "我要這份報告簡報是用英文的" }]);
    expect(languageClaims("投影片用英文，講稿用中文。")).toEqual([{ part: "slides", lang: "en", clause: "投影片用英文" }, { part: "notes", lang: "zh", clause: "講稿用中文" }]);
    expect(languageClaims("Slides in English, speaker notes in Chinese.").map((c) => `${c.part}:${c.lang}`)).toEqual(["slides:en", "notes:zh"]);
    expect(languageClaims("專有名詞保留英文")).toEqual([]);
  });
  it("splits typed and English requests too", () => {
    expect(clauses("幫我做一份 8 頁的進度報告，投影片用英文。")).toEqual(["幫我做一份 8 頁的進度報告", "投影片用英文"]);
    expect(clauses("Make an English deck. Also include a comparison table, and make sure each method has pros and cons.").length).toBeGreaterThanOrEqual(3);
    // Comma-joined English asks split; a comma list of names does not.
    expect(clauses("Make a deck on hotword biasing for Zipformer and RNN-T ASR, use our study library and count which methods exist, give the pros and cons of each method.")).toHaveLength(3);
    expect(clauses("Add a comparison-table slide to this deck, comparing shallow fusion, CLAS and contextual adapters.")).toHaveLength(1);
  });
  it("finds the task's own turns before the start call (earlier exchange and 「ok」 are not)", () => {
    const t = taskTurns(fx.messages, RUN_B)!;
    expect(t.turns.map((m) => m.seq)).toEqual([1371]);
    expect(t.earlier.map((m) => m.seq)).toEqual([1358, 1365, 1369]);
    expect(taskTurns(fx.messages, RUN_A)!.turns.map((m) => m.seq)).toEqual([1358]);
  });
  it("recognises the answer to the which-study question as a setup answer", () => {
    expect(setupAnswers(bundle(RUN_A))).toEqual(["串流 ASR 的動態熱詞效率研究"]);
    expect(setupAnswers(bundle(RUN_B))).toEqual(["就剛剛的那個研究 同一個簡報繼續做"]);
  });
});

describe("every invariant is catalogued", () => {
  it("has unique ids, a severity and a category", () => {
    const set = new Set(INVARIANTS.map((i) => i.id));
    expect(set.size).toBe(INVARIANTS.length);
    expect(INVARIANTS.length).toBeGreaterThanOrEqual(20);
    for (const i of INVARIANTS) expect(i.title.length).toBeGreaterThan(5);
  });
});

// ------------------------------------------------------------------- run B: 「講稿改成中文」, stuck

/** Run B as it should have been: study from the deck, the user's notes language as a requirement, no question. */
const fixedB = () =>
  bundle(RUN_B, (b) => {
    b.run.study_id = DECK_STUDY;
    b.run.status = "awaiting_plan_approval";
    b.run.guidance = [];
    b.run.question = null;
    b.run.title = "修改簡報：講稿改成中文";
    b.run.state = { route: b.run.state!.route, requirements: [] };
    b.run.plan = { summary: "保留投影片，只把講稿改成可照念的繁體中文", writes: [{ kind: "deck", label: "簡報新修訂（舊版保留）", effect: "overwrite" }], edit_kind: "revise" };
    b.run.brief = {
      ...b.run.brief!, user_words: [B_WORDS], base: 1,
      requirements: [
        { id: "r1", type: "language", text: "講稿用繁體中文", params: { language: "zh", part: "notes" }, source: "request", quote: "這個簡報裡面的講稿要是中文的" },
        { id: "r2", type: "language", text: "投影片維持英文", params: { language: "en", part: "slides" }, source: "standing" },
        { id: "r3", type: "other", text: "講稿多用英文專有名詞", source: "request", quote: "當然你應該要多用一點英文的專用名詞" },
        { id: "r4", type: "tone", text: "講稿可以一比一照念、自然", source: "request", quote: "這個講稿要我能夠一比一的念出來不會有違和" },
      ],
    };
    b.events = [];
  });

describe("run B e6d552fc (notes-language revise from a home chat)", () => {
  const found = ids(bundle(RUN_B));
  it.each([
    ["route.no_new_artifact_option", 2], ["route.wording", 1], ["req.clause_coverage", 3], ["req.contradicts_newest", 1], ["req.standing_not_override", 1],
    ["req.user_words_scope", 2], ["ctx.input_artifact_study", 1], ["ctx.no_derivable_study_question", 1], ["q.not_repeated", 1], ["q.options_match", 2], ["outcome.not_stuck_awaiting", 1],
  ])("%s fires %i×", (id, n) => {
    expect(found.filter((x) => x === id)).toHaveLength(n);
  });
  it("evidence names the contradicting standing requirement and the deck's study", () => {
    const [c] = checkRun(bundle(RUN_B), ["req.contradicts_newest"]);
    expect(c!.evidence).toMatchObject({ claim: { part: "notes", lang: "zh" }, requirement: { source: "standing", params: { language: "en" } } });
    const [s] = checkRun(bundle(RUN_B), ["ctx.input_artifact_study"]);
    expect(s!.evidence).toMatchObject({ artifact_study: DECK_STUDY, run_study: null });
  });
  it("the corrected run passes every invariant", () => {
    expect(checkRun(fixedB())).toEqual([]);
  });
  it("standing slides language with the user's notes language is not an override", () => {
    expect(count(fixedB(), "req.standing_not_override")).toBe(0);
  });
  it("an answered question that moved on is not stuck", () => {
    expect(count(bundle(RUN_B, (b) => (b.now = "2026-10-25T04:30:00Z")), "outcome.not_stuck_awaiting")).toBe(0);
  });
});

// ------------------------------------------------------------------- run A: spoken topic deck, partial

const fixedA = () =>
  bundle(RUN_A, (b) => {
    const st = b.run.state!;
    b.run.status = "done";
    b.run.guidance = [{ at: "2026-10-25T03:29:49.019Z", text: "串流 ASR 的動態熱詞效率研究", setup: true }];
    b.run.brief = {
      ...b.run.brief!, user_words: [A_WORDS], base: 1,
      requirements: [
        { id: "r1", type: "language", text: "全部英文", params: { language: "en" }, source: "request", quote: "我要這份報告簡報是用英文的" },
        { id: "r2", type: "other", text: "用研究文獻庫", source: "request", quote: "我要你參考我們的文獻庫" },
        { id: "r3", type: "include_topics", text: "統計有哪幾種方法", source: "request", quote: "那請你詳細統計一下有哪幾種方法" },
        { id: "r4", type: "per_item_fields", text: "每種方法：好處、壞處、架構圖、論文、venue", source: "request", quote: "並且詳細敘述每一種方法的好處跟壞處" },
        { id: "r5", type: "per_item_fields", text: "每種方法搭配模型架構圖", source: "request", quote: "並且在講解方法的時候要搭配模型的架構圖來更好的演示" },
        { id: "r6", type: "per_item_fields", text: "每種方法註明論文", source: "request", quote: "並且在提到方法的時候要講到這一篇論文是哪一篇" },
        { id: "r7", type: "per_item_fields", text: "每種方法註明會議或期刊", source: "request", quote: "還有他們的會議或是期刊是哪一個" },
      ],
    };
    b.run.state = { ...st, requirements: [], topic_title: "Zipformer 與 RNN-T 的熱詞機制", topic: { ...(st.topic as object), picks: fx.library.map((p) => ({ title: p.title, reason: `${p.venue} ${p.year}` })) } };
    b.run.title = "主題簡報：Zipformer 與 RNN-T 的熱詞機制";
    b.run.criteria = b.run.criteria!.map((c) => ({ ...c, status: "pass", reason: "通過" }));
    b.run.report = { summary_md: "完成", issues: [] };
    b.events = b.events!.filter((e) => e.type !== "workflow" || !["partial"].includes((e.data.workflow as { status: string }).status));
    b.steps = b.steps!.map((s) => ({ ...s, output_text: null, conv: null }));
  });

describe("run A 0668a3d7 (spoken-style topic deck)", () => {
  const found = ids(bundle(RUN_A));
  it.each([
    ["req.clause_coverage", 6], ["req.setup_not_content", 3], ["repair.same_failures", 1], ["repair.structural_not_rewrite", 1], ["repair.actionable_reason", 1],
    ["outcome.partial_explained", 1], ["grounding.library_fields", 1], ["grounding.library_coverage", 1],
  ])("%s fires %i×", (id, n) => {
    expect(found.filter((x) => x === id)).toHaveLength(n);
  });
  it("the topic leak names the study answer and the topic field", () => {
    const leak = checkRun(bundle(RUN_A), ["req.setup_not_content"]).find((f) => f.evidence.where === "state.topic_title");
    expect(leak?.evidence).toMatchObject({ answer: "串流 ASR 的動態熱詞效率研究", text: "串流 ASR 的動態熱詞效率研究" });
  });
  it("venue claims are found in the readers' outputs while the library has venues", () => {
    const [g] = checkRun(bundle(RUN_A), ["grounding.library_fields"]);
    expect(g!.evidence).toMatchObject({ library_with_venue: 10, library: 10 });
  });
  it("the corrected run passes every invariant", () => {
    expect(checkRun(fixedA())).toEqual([]);
  });
  it("a progress deck may carry the study's name as its title", () => {
    const b = bundle(RUN_A, (x) => ((x.run.state!.route as { deck: string }).deck = "progress"));
    expect(checkRun(b, ["req.setup_not_content"]).filter((f) => String(f.evidence.where ?? "").length)).toHaveLength(0);
  });
});

// ------------------------------------------------------------------- shapes not in this conversation

describe("other failure shapes", () => {
  it("deliverable drift: a deck Brief that wrote a note", () => {
    const b = bundle(RUN_A, (x) => (x.run.artifacts = [{ kind: "note", id: "n1", title: "筆記" }]));
    expect(checkRun(b, ["deliverable.consistent"])[0]!.evidence).toMatchObject({ brief: "deck" });
    expect(count(fixedA(), "deliverable.consistent")).toBe(0);
  });
  it("route/plan mismatch: an edit route that plans a new deck", () => {
    const b = bundle(RUN_B, (x) => (x.run.plan = { writes: [{ kind: "deck", label: "新簡報", effect: "new" }], edit_kind: "expand" }));
    expect(checkRun(b, ["route.plan_matches"]).map((f) => f.message)).toHaveLength(2);
  });
  it("a fix round that repeats a step's failures twice in a row", () => {
    const b = bundle(RUN_A, (x) => (x.steps = [{ key: "write_3", title: "第 3 頁", conv: { rounds: [{ round: 0, failures: ["j:task:a"] }, { round: 1, failures: ["j:task:a"] }, { round: 2, failures: ["j:task:a"] }] } }]));
    expect(checkRun(b, ["repair.same_failures"]).some((f) => f.evidence.step === "write_3")).toBe(true);
  });
  it("a page-count contradiction with the newest words", () => {
    const b = fixedB();
    b.run.brief!.user_words = ["幫我做 8 頁", "改成 10 頁"];
    b.run.brief!.base = 2;
    b.messages = [];
    b.run.brief!.requirements = [{ id: "p", type: "page_count", params: { exact: 8 }, source: "request", quote: "幫我做 8 頁" }];
    expect(checkRun(b, ["req.contradicts_newest"])[0]!.message).toContain("10 頁");
  });
  it("a paper question whose options list no paper", () => {
    const b = fixedB();
    b.run.state!.asks = { clarify_paper: { id: "clarify_paper", title: "要報告哪一篇論文？", questions: [{ id: "q", type: "single_choice", options: [{ label: "先停下來", value: "stop" }] }] } };
    expect(count(b, "q.options_match")).toBe(1);
    b.run.state!.asks = { clarify_paper: { id: "clarify_paper", title: "要報告哪一篇論文？", questions: [{ id: "q", type: "single_choice", options: [{ label: fx.library[0]!.title, value: "p1" }] }] } };
    expect(count(b, "q.options_match")).toBe(0);
  });
});

describe("assistant claims about an artifact need a read", () => {
  const conv: ConversationBundle = { conversation: fx.conversation, messages: fx.messages };
  it("flags the 「偏向 Hot Word 還是 Contextual Biasing」 answer built on get_workflow only", () => {
    const f = checkConversation(conv);
    expect(f.map((x) => x.invariant)).toEqual(["assistant.read_before_claim"]);
    expect(f[0]!.evidence).toMatchObject({ user_message: 1365, tools: ["get_workflow"] });
  });
  it("accepts the same answer after reading the deck", () => {
    const ms = clone(fx.messages);
    const m = ms.find((x) => x.seq === 1366)!;
    (m.content as unknown[]).push({ type: "tool_use", id: "c2", name: "get_deck", input: { deck_id: "f7da00dc" } });
    expect(checkConversation({ conversation: fx.conversation, messages: ms })).toEqual([]);
  });
});

describe("assistant.target_grounded (scenario matrix g22: a deck picked by search was edited)", () => {
  const DECK = "11111111-2222-3333-4444-555555555555";
  const conv = { id: "c-g22", study_id: null };
  const user = (seq: number, text: string, page: Record<string, unknown> | null = null): StoredMessage => ({ seq, role: "user", text, content: [{ type: "text", text }], page_context: page });
  const search: StoredMessage[] = [
    { seq: 2, role: "assistant", text: "", content: [{ type: "tool_use", id: "s1", name: "list_decks", input: { study: "x" } }] },
    { seq: 3, role: "tool", content: [{ type: "tool_result", tool_use_id: "s1", content: `{"decks":[{"id":"${DECK}","title":"Eval deck"}]}` }] },
  ];
  const act: StoredMessage = { seq: 4, role: "assistant", text: "", content: [{ type: "tool_use", id: "w1", name: "start_workflow", input: { deck_id: DECK, request: "刪掉第 3 頁" } }] };
  it("catches an action on a deck that only came from a search result", () => {
    const f = checkConversation({ conversation: conv, messages: [user(1, "刪掉第 3 頁"), ...search, act] }, ["assistant.target_grounded"]);
    expect(f.map((x) => x.invariant)).toEqual(["assistant.target_grounded"]);
  });
  it("stays silent when the deck is the page's or the conversation's own", () => {
    expect(checkConversation({ conversation: conv, messages: [user(1, "刪掉第 3 頁", { deckId: DECK }), ...search, act] }, ["assistant.target_grounded"])).toEqual([]);
    expect(checkConversation({ conversation: conv, messages: [user(1, "刪掉第 3 頁"), ...search, act], runs: [{ id: "r", status: "done", artifacts: [{ kind: "deck", id: DECK }] } as unknown as StoredRun] }, ["assistant.target_grounded"])).toEqual([]);
  });
});

describe("chat.no_silent_supersede (a new message cancelled a pending consent card)", () => {
  const conv = { id: "c-sup", study_id: null };
  const call = (result_text: string, deny_reason: string | null = null) => ({ id: "tc1", tool: "create_task", status: "denied", summary: "新增待辦：整理數據", result_text, deny_reason });
  it("catches the old silent supersede (the user never confirmed)", () => {
    const f = checkConversation({ conversation: conv, messages: [], toolCalls: [call("使用者沒有同意，改提了其他要求。")] }, ["chat.no_silent_supersede"]);
    expect(f.map((x) => x.invariant)).toEqual(["chat.no_silent_supersede"]);
    expect(f[0]!.evidence).toMatchObject({ tool_call: "tc1", tool: "create_task" });
    expect(checkConversation({ conversation: conv, messages: [], toolCalls: [{ ...call("使用者改提了其他要求，這個操作沒有執行。"), status: "cancelled" }] }, ["chat.no_silent_supersede"])).toHaveLength(1);
  });
  it("stays silent after an explicit confirmation, a denial or a cancel", () => {
    const ok = [call("使用者確認取消這個操作，改提了其他要求；這個操作沒有執行。", "使用者確認取消，改提其他要求"), call("使用者拒絕了這個操作。"), { ...call("已被使用者中止，沒有執行。"), status: "cancelled" }];
    expect(checkConversation({ conversation: conv, messages: [], toolCalls: ok }, ["chat.no_silent_supersede"])).toEqual([]);
  });
});

describe("chat.duplicate_workflow (a second run for the same deliverable while the first was active)", () => {
  const DECK = "f7da00dc-0000-4000-8000-000000000001";
  const base = (over: Partial<StoredRun> = {}): StoredRun => ({ id: "r2", status: "planning", conversation_id: "c", study_id: "s1", created_at: "2026-10-26T10:10:00Z", inputs: { deck_id: DECK }, brief: { deliverable: { kind: "deck" }, user_words: ["把講稿改成中文"] }, ...over });
  const first = (over: Partial<StoredRun> = {}): StoredRun => ({ id: "r1", status: "running", conversation_id: "c", study_id: "s1", created_at: "2026-10-26T10:00:00Z", finished_at: null, inputs: {}, artifacts: [{ kind: "deck", id: DECK }], brief: { deliverable: { kind: "deck" } }, ...over });
  it("catches a run on the deck an active run is writing", () => {
    const f = checkRun({ run: base(), siblings: [first()] }, ["chat.duplicate_workflow"]);
    expect(f).toHaveLength(1);
    expect(f[0]!.evidence).toMatchObject({ earlier: "r1", shared: [DECK] });
  });
  it("catches the same deliverable kind in the same study with no target named", () => {
    const f = checkRun({ run: base({ inputs: {}, brief: { deliverable: { kind: "deck" }, user_words: ["改成 8 頁"] } }), siblings: [first({ artifacts: [] })] }, ["chat.duplicate_workflow"]);
    expect(f).toHaveLength(1);
  });
  it("stays silent when the first had finished, the user asked for another one, or it is a different paper / study / kind", () => {
    const quiet = (run: StoredRun, sib: StoredRun) => expect(checkRun({ run, siblings: [sib] }, ["chat.duplicate_workflow"])).toEqual([]);
    quiet(base(), first({ status: "partial", finished_at: "2026-10-26T10:05:00Z" }));
    quiet(base({ inputs: {}, brief: { deliverable: { kind: "deck" }, user_words: ["另外再做一份英文的簡報"] } }), first({ artifacts: [] }));
    quiet(base({ inputs: { paper_id: "p2" } }), first({ artifacts: [], inputs: { paper_id: "p1" } }));
    quiet(base({ inputs: {}, study_id: "s2" }), first({ artifacts: [] }));
    quiet(base({ inputs: {}, brief: { deliverable: { kind: "note" } } }), first({ artifacts: [] }));
    quiet(base({ batch_id: "b" }), first({ batch_id: "b" }));
  });
});

describe("wf.chat_answer_lost (production e6d552fc shape: a reply typed in chat never reached the waiting workflow)", () => {
  const typed = (seq: number, at: string, page: Record<string, unknown> | null = null): StoredMessage => ({ seq, role: "user", text: "就剛剛那個研究，同一個簡報繼續做", content: [{ type: "text", text: "就剛剛那個研究，同一個簡報繼續做" }], created_at: at, page_context: page });
  const withTurn = (m: StoredMessage, patch: (b: RunBundle) => void = () => undefined) => bundle(RUN_B, (b) => {
    b.messages = [...b.messages!, m];
    patch(b);
  });
  it("catches a chat turn during the awaiting_input window that the workflow never got", () => {
    const f = checkRun(withTurn(typed(1377, "2026-10-25T04:40:00Z")), ["wf.chat_answer_lost"]);
    expect(f).toHaveLength(1);
    expect(f[0]!.evidence).toMatchObject({ message_seq: 1377, status: "awaiting_input" });
    expect(String(f[0]!.evidence.question)).toContain("要怎麼繼續");
  });
  it("stays silent when the reply reached the workflow, the user opted out, or it was outside the window", () => {
    const answered = withTurn(typed(1377, "2026-10-25T04:40:00Z"), (b) => {
      b.run.guidance = [...(b.run.guidance ?? []), { at: "2026-10-25T04:40:00.500Z", text: "就剛剛那個研究，同一個簡報繼續做" }];
    });
    expect(count(answered, "wf.chat_answer_lost")).toBe(0);
    expect(count(withTurn(typed(1377, "2026-10-25T04:40:00Z", { chatOnly: RUN_B })), "wf.chat_answer_lost")).toBe(0);
    expect(count(withTurn(typed(1377, "2026-10-25T04:22:56Z")), "wf.chat_answer_lost")).toBe(0);
    // The fixture as stored: the answer came through the card, no chat turn inside a window.
    expect(count(bundle(RUN_B), "wf.chat_answer_lost")).toBe(0);
  });
});
