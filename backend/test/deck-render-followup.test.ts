/**
 * Production 61666f10, end to end with a scripted model: an AI deck edit that would break the build is refused
 * (suggest_deck_edit validates the edited file), `pages` / `earlier_suggestions` / `warning` tell the assistant where its
 * text landed and that an earlier copy is still on another page, and a preview that fails after an AI suggestion was
 * accepted goes back to that conversation (notice + an automatic fix_render turn reading get_deck_render_error) — once
 * per failing revision, at most twice.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LightMyRequestResponse } from "fastify";
import type { ChatEvent } from "../src/ai/types.js";
import type { RoleChatRequest } from "../src/ai/platform/index.js";
import { agentFor, type ModelCall } from "../src/agent/runtime.js";
import { createSuggestion } from "../src/lib/suggestions/service.js";
import { setBuildCheck } from "../src/lib/artifacts/build-check.js";
import { createTestContext, hasTestDb, hasTestS3, ORIGIN, type TestContext } from "./helpers.js";
import { insertStudy } from "./study-fixtures.js";

let ids = 0;
const calls = (...list: [string, unknown][]): ChatEvent[] => [
  ...list.flatMap(([name, input]) => {
    const id = `call_${++ids}`;
    return [{ type: "tool_call_start", index: 0, id, name } as ChatEvent, { type: "tool_call_end", index: 0, id, name, input, argsJson: JSON.stringify(input) } as ChatEvent];
  }),
  { type: "done", stopReason: "tool_use" },
];
const say = (text: string): ChatEvent[] => [{ type: "text_delta", text }, { type: "done", stopReason: "end_turn" }];

describe.skipIf(!(hasTestDb && hasTestS3))("deck edits that break the build (61666f10)", () => {
  let t: TestContext;
  let alice: { id: string; cookie: string };
  let study: { id: string; slug: string };
  let deckId: string;
  let script: ChatEvent[][] = [];
  const requests: RoleChatRequest[] = [];
  const json = (r: LightMyRequestResponse) => r.json() as Record<string, any>;
  const req = (method: "POST" | "PUT" | "GET", url: string, payload?: object) =>
    t.app.inject({ method, url, headers: { origin: ORIGIN, cookie: alice.cookie }, ...(payload ? { payload } : {}) });
  const runtime = () => agentFor(t.app);
  const model: ModelCall = async function* (r) {
    requests.push(r);
    for (const e of script.shift() ?? say("（沒有更多腳本）")) yield e;
  };
  const entry = async () => (await t.db.query<{ id: string; content: string }>("SELECT s.id, s.content FROM deck_sources s JOIN deck_source_trees tr ON tr.deck_id=s.deck_id AND tr.entry=s.path WHERE s.deck_id=$1", [deckId])).rows[0]!;
  const toolResults = async (conv: string) =>
    (await t.db.query<{ content: { type: string; content?: string }[] }>("SELECT content FROM agent_messages WHERE conversation_id=$1 AND role='tool' ORDER BY seq", [conv])).rows.flatMap((r) => r.content.map((b) => b.content ?? ""));
  async function send(conv: string, text: string) {
    const r = await req("POST", `/api/agent/conversations/${conv}/messages`, { text, context: { deckId, studySlug: study.slug, path: `/studies/${study.slug}/decks/${deckId}/edit` } });
    expect(r.statusCode, r.body).toBe(202);
    await runtime().settle();
  }
  /** Plays the worker: the newest preview of the deck fails; the finalizer runs its after-commit follow-up. */
  async function failPreview() {
    // Accepting a suggestion queues a preview in the background: let it land, then fail every queued one of the deck.
    await new Promise((r) => setTimeout(r, 300));
    const p = json(await req("POST", `/api/slides/${deckId}/source/preview`)).preview.latest;
    await t.db.query(
      "UPDATE jobs SET status='failed',error=$2,finished_at=now() WHERE id IN (SELECT job_id FROM deck_previews WHERE deck_id=$1) AND status='queued'",
      [deckId, "\u001b[91mERROR: YAMLException: duplicated mapping key (index.qmd, 4:1)\u001b[39m"],
    );
    await t.finalizer.drain();
    await runtime().settle();
    return p.id as string;
  }

  beforeAll(async () => {
    t = await createTestContext();
    alice = await t.login("student", "Alice");
    study = await insertStudy(t.db, alice.id, "串流 ASR");
    deckId = json(await req("POST", "/api/slides", { studyId: study.slug, title: "Fast Context-Biasing", kind: "progress" })).id;
    const rt = runtime();
    rt.options.model = model;
    rt.options.fast = async () => "標題";
  });
  afterAll(async () => {
    await runtime().settle();
    await t?.close();
  });
  beforeEach(() => {
    script = [];
    requests.length = 0;
  });

  it("refuses an edit that adds a second subtitle; the fixed edit lands on page 1 and says so", async () => {
    const conv = json(await req("POST", "/api/agent/conversations", { context: { deckId }, autopilot: true })).conversation.id as string;
    const qmd = (await entry()).content;
    const titleLine = qmd.match(/^title: .+$/m)![0];
    // The template has no subtitle: give it one the way the workflow does, so the AI can duplicate it.
    await req("PUT", `/api/slides/${deckId}/source/files`, { path: "index.qmd", content: qmd.replace(titleLine, `${titleLine}\nsubtitle: "Paper report"`) });
    script = [
      calls(["suggest_deck_edit", { deck_id: deckId, edits: [{ before: titleLine, after: `${titleLine}\nsubtitle: "Interspeech 2024"` }], title: "封面加出處" }]),
      calls(["suggest_deck_edit", { deck_id: deckId, edits: [{ before: 'subtitle: "Paper report"', after: 'subtitle: "Andrusenko et al., Interspeech 2024"' }], title: "封面加出處" }]),
      say("已改在封面"),
    ];
    await send(conv, "我是要第一頁加，不是第二頁");
    const results = await toolResults(conv);
    expect(results[0]).toContain('status="error"');
    expect(results[0]).toContain("subtitle 寫了兩次");
    expect(results[1]).toContain('"pages":[1]');
    expect((await t.db.query("SELECT count(*)::int AS n FROM suggestions WHERE created_by_conversation=$1", [conv])).rows[0]!.n).toBe(1);
  });

  it("warns when the edit puts on another page what an earlier edit of the conversation still has", async () => {
    const conv = json(await req("POST", "/api/agent/conversations", { context: { deckId }, autopilot: true })).conversation.id as string;
    const qmd = (await entry()).content;
    const firstSlide = qmd.match(/^## .+$/m)![0];
    script = [calls(["suggest_deck_edit", { deck_id: deckId, edits: [{ before: firstSlide, after: `${firstSlide}\n\n**發表會議：Interspeech 2024**` }], title: "第 2 頁加出處" }]), say("好")];
    await send(conv, "放上會議");
    const first = (await t.db.query<{ id: string }>("SELECT id FROM suggestions WHERE created_by_conversation=$1", [conv])).rows[0]!.id;
    expect((await req("POST", `/api/suggestions/${first}/accept-all`)).statusCode).toBe(200);
    const sub = (await entry()).content.match(/^subtitle: .+$/m)![0];
    script = [calls(["suggest_deck_edit", { deck_id: deckId, edits: [{ before: sub, after: 'subtitle: "發表會議：Interspeech 2024"' }], title: "封面加出處" }]), say("好")];
    await send(conv, "我是要第一頁");
    const last = (await toolResults(conv)).at(-1)!;
    expect(last).toContain('"pages":[1]');
    expect(last).toContain("earlier_suggestions");
    expect(last).toMatch(/已經在第 2 頁加了相似的內容/);
  });

  it("a preview failing after an accepted AI suggestion goes back to its conversation, once per revision, at most twice", async () => {
    const conv = json(await req("POST", "/api/agent/conversations", { context: { deckId }, autopilot: true })).conversation.id as string;
    const file = await entry();
    // An AI suggestion that breaks the YAML (created below the tool's validation, as an older suggestion would be).
    const sub = file.content.match(/^subtitle: .+$/m)![0];
    const s = await createSuggestion({ db: t.db }, { targetType: "deck_source", targetId: file.id, hunks: [{ from: file.content.indexOf(sub), to: file.content.indexOf(sub) + sub.length, before: sub, after: `${sub}\nsubtitle: "Paper report"` }], title: "封面", source: "ai", actorId: alice.id, conversationId: conv });
    expect((await req("POST", `/api/suggestions/${s.id}/accept-all`)).statusCode).toBe(200);
    script = [calls(["get_deck_render_error", { deck_id: deckId }]), say("原因是 subtitle 寫了兩次")];
    await failPreview();
    const notices = (await t.db.query<{ text: string; content: { kind: string; auto: boolean }[] }>("SELECT text, content FROM agent_messages WHERE conversation_id=$1 AND role='notice'", [conv])).rows;
    expect(notices).toHaveLength(1);
    expect(notices[0]!.content[0]).toMatchObject({ kind: "deck_render_failed", auto: true });
    expect(notices[0]!.text).toContain("編譯失敗");
    const users = (await t.db.query<{ text: string }>("SELECT text FROM agent_messages WHERE conversation_id=$1 AND role='user' ORDER BY seq", [conv])).rows.map((r) => r.text);
    expect(users.at(-1)).toContain("〔自動〕");
    expect(JSON.stringify(requests[0]!.messages.at(-1))).toContain('<task kind=\\"fix_render\\"');
    const diag = (await toolResults(conv)).at(-1)!;
    expect(diag).toContain("subtitle 寫了兩次");
    expect(diag).toContain("from_this_conversation");
    expect(diag).not.toContain("\u001b[");

    // The same revision failing again (a second preview job) does not post again.
    await failPreview();
    expect((await t.db.query("SELECT 1 FROM agent_messages WHERE conversation_id=$1 AND role='notice'", [conv])).rowCount).toBe(1);
    // Two automatic turns per deck and conversation: the third failure only tells the user.
    for (let i = 0; i < 2; i++) {
      const cur = await entry();
      await req("PUT", `/api/slides/${deckId}/source/files`, { path: "index.qmd", content: `${cur.content}\n` });
      const again = await createSuggestion({ db: t.db }, { targetType: "deck_source", targetId: cur.id, proposedText: `${cur.content}\n\n` , title: `第 ${i + 2} 次`, source: "ai", actorId: alice.id, conversationId: conv });
      await req("POST", `/api/suggestions/${again.id}/accept-all`);
      script = [say("看過了")];
      await failPreview();
    }
    const all = (await t.db.query<{ content: { auto: boolean }[]; text: string }>("SELECT content, text FROM agent_messages WHERE conversation_id=$1 AND role='notice' ORDER BY seq", [conv])).rows;
    expect(all.map((n) => n.content[0]!.auto)).toEqual([true, true, false]);
    expect(all.at(-1)!.text).toContain("不再自動處理");
  });

  it("the turn's own requirements: 「第一頁加，不是第二頁」 with an edit on page 2 is flagged and the turn goes on until the cover has it", async () => {
    const conv = json(await req("POST", "/api/agent/conversations", { context: { deckId }, autopilot: true })).conversation.id as string;
    const qmd = (await entry()).content;
    const firstSlide = qmd.match(/^## .+$/m)![0];
    const titleLine = qmd.match(/^title: .+$/m)![0];
    script = [
      calls(["suggest_deck_edit", { deck_id: deckId, edits: [{ before: firstSlide, after: `${firstSlide}\n\n會議：Interspeech 2024` }], title: "加會議" }]),
      say("已加上會議。"),
      calls(["suggest_deck_edit", { deck_id: deckId, edits: [{ before: titleLine, after: 'title: "Fast Context-Biasing（Interspeech 2024）"' }], title: "封面加會議" }]),
      say("改在封面了。"),
    ];
    await send(conv, "我是要第一頁加會議，不是第二頁");
    const results = await toolResults(conv);
    expect(results[0]).toContain("unmet_requirements");
    expect(results[0]).toMatch(/使用者要的是第 1 頁.*這次修改的新內容在第 2 頁/);
    expect(JSON.stringify(requests.map((r) => r.messages.at(-1)))).toContain("沒有符合使用者這一輪的要求");
    expect(results[1]).toContain('"pages":[1]');
    expect(results[1]).not.toContain("unmet_requirements");
  });

  it("the edit gate: an edit whose dry-run render fails is refused with the build error, and the turn does not end as if it went through", async () => {
    const conv = json(await req("POST", "/api/agent/conversations", { context: { deckId }, autopilot: true })).conversation.id as string;
    const qmd = (await entry()).content;
    const firstSlide = qmd.match(/^## .+$/m)![0];
    const previewsBefore = (await t.db.query("SELECT 1 FROM deck_previews WHERE deck_id=$1", [deckId])).rowCount;
    // Play the worker for dry runs (slide_preview jobs without a deck_previews row): the first fails, later ones pass.
    setBuildCheck({ enabled: true, waitMs: 20_000 });
    let dry = 0;
    const timer = setInterval(async () => {
      const jobs = (await t.db.query<{ id: string }>("SELECT j.id FROM jobs j WHERE j.kind='slide_preview' AND j.status='queued' AND NOT EXISTS (SELECT 1 FROM deck_previews p WHERE p.job_id=j.id)")).rows;
      for (const j of jobs) {
        dry++;
        if (dry === 1) await t.db.query("UPDATE jobs SET status='failed', error=$2, finished_at=now() WHERE id=$1", [j.id, "\u001b[91mERROR: could not find file figures/missing.png\u001b[39m"]);
        else await t.db.query("UPDATE jobs SET status='succeeded', result=$2, finished_at=now() WHERE id=$1", [j.id, JSON.stringify({ entryHtml: "index.html", fileCount: 1, quartoVersion: "x" })]);
      }
    }, 200);
    try {
      script = [
        calls(["suggest_deck_edit", { deck_id: deckId, edits: [{ before: firstSlide, after: `${firstSlide}\n\n![](figures/missing.png)` }], title: "加圖" }]),
        say("已經幫你在第 2 頁加上圖了。"),
        calls(["suggest_deck_edit", { deck_id: deckId, edits: [{ before: firstSlide, after: `${firstSlide}\n\n（圖：見論文 Fig. 1）` }], title: "加圖說" }]),
        say("原本的圖檔不存在，改成文字說明。"),
      ];
      await send(conv, "第 2 頁加一張圖");
    } finally {
      clearInterval(timer);
      setBuildCheck({ enabled: false });
    }
    const results = await toolResults(conv);
    expect(results[0]).toContain("這個修改沒有通過檢查");
    expect(results[0]).toContain("could not find file figures/missing.png");
    expect(results[0]).not.toContain("\u001b[");
    // The completion review sent the model back: the first claim was not the end of the turn.
    expect(JSON.stringify(requests.map((r) => r.messages.at(-1)))).toContain("因為會讓成果編譯／解析失敗而沒有建立");
    expect(results[1]).toContain('"build_check":"built"');
    // No preview row was written by the dry runs; the scratch objects are cleaned by the finalizer.
    expect((await t.db.query("SELECT 1 FROM deck_previews WHERE deck_id=$1", [deckId])).rowCount).toBe(previewsBefore);
  });

  it("a failure without an AI suggestion (the user's own edit) posts nothing", async () => {
    const before = (await t.db.query("SELECT 1 FROM agent_messages WHERE role='notice'")).rowCount;
    await t.db.query("UPDATE suggestions SET decided_at = now() - interval '2 days' WHERE target_type='deck_source'");
    await req("PUT", `/api/slides/${deckId}/source/files`, { path: "index.qmd", content: "---\ntitle: t\n---\n\n## B\n" });
    await failPreview();
    expect((await t.db.query("SELECT 1 FROM agent_messages WHERE role='notice'")).rowCount).toBe(before);
  });
});
