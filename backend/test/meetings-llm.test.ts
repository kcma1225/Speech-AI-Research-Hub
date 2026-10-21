/**
 * Live meeting analysis against the user's test gateway (skipped unless TEST_LLM_BASE_URL / TEST_LLM_API_KEY and a
 * test DB are set). Cheapest model only (glm/glm-5.3-flash, fallback glm/glm-5-turbo), a ~2.5 min synthetic zh-TW
 * transcript. Checks the structured output path end to end: drafts per study, assignees from that study only.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AiJobContext } from "../src/ai-worker/registry.js";
import { aiFor } from "../src/ai/platform/index.js";
import { runAnalyze } from "../src/ai-jobs/meetings/analyze.js";
import type { AnalyzePayload } from "../src/lib/meetings/media.js";
import { createTestContext, hasTestDb, ORIGIN, type TestContext } from "./helpers.js";
import { addStudyMember, insertStudy } from "./study-fixtures.js";

process.env.PROVIDER_TOKEN_KEY ??= randomBytes(32).toString("base64");
const base = process.env.TEST_LLM_BASE_URL;
const key = process.env.TEST_LLM_API_KEY;

const LINES: [number, string, string][] = [
  [0, "王教授", "好，我們開始今天的週會，先請雅婷報告語者分離的進度。"],
  [6, "林雅婷", "這週我把 EEND 的模型在 AMI 資料集上重新訓練，DER 從百分之十八降到百分之十二。"],
  [15, "林雅婷", "主要是加了資料增強，加上把 chunk 長度調成十秒。"],
  [22, "王教授", "不錯，但要跟 pyannote 的 baseline 比較，而且要報告信賴區間。"],
  [30, "林雅婷", "好，我下週三之前把比較表格做出來。"],
  [36, "王教授", "另外錯誤分析也要做，看看是重疊語音還是短句出錯。"],
  [44, "林雅婷", "了解，我會分重疊和非重疊兩類統計。"],
  [50, "王教授", "接下來柏宇，你的台語語音辨識資料集進度如何？"],
  [56, "陳柏宇", "目前收了大概四十小時，標註完成三十二小時，還差八小時。"],
  [65, "陳柏宇", "標註規範有一些不一致，例如數字要寫漢字還是阿拉伯數字。"],
  [73, "王教授", "這個要先統一，你寫一份標註規範給大家看，週五前寄給我。"],
  [81, "陳柏宇", "好的，我週五前寫好。"],
  [85, "王教授", "還有，先用 Whisper 微調跑一個 baseline，不用等全部標完。"],
  [93, "陳柏宇", "了解，我用現有的三十二小時先跑。"],
  [99, "林雅婷", "柏宇，如果需要 GPU 可以用我們實驗室那台，我這週比較少用。"],
  [106, "陳柏宇", "太好了，謝謝。"],
  [110, "王教授", "最後提醒大家，下個月的實驗室聚餐請在表單登記。"],
  [118, "王教授", "還有期中報告的投影片下週一前上傳到系統。"],
  [126, "林雅婷", "好的。"],
  [130, "陳柏宇", "收到。"],
  [134, "王教授", "那今天就到這裡，謝謝大家。"],
];

describe.skipIf(!(base && key && hasTestDb))("live meeting analysis (cheapest model)", () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestContext();
  });
  afterAll(async () => {
    await aiFor(t.app).logger.flush();
    await t?.close();
  });

  it("splits a short synthetic zh-TW meeting into per-study drafts", async () => {
    const owner = await t.ownerCookie();
    const send = (url: string, payload: object, method: "POST" | "PUT" = "POST") => t.app.inject({ method, url, headers: { origin: ORIGIN, cookie: owner.cookie }, payload });
    const p = (await send("/api/admin/ai/providers", { family: "llm", kind: "openai-compatible", name: "test gateway", config: { baseUrl: base, timeoutMs: 120_000 }, secrets: { apiKey: key } })).json();
    const r = (await send("/api/admin/ai/routes", {
      name: "analysis-cheapest", capability: "chat", strategy: "fallback",
      members: [{ provider_id: p.provider.id, model: "glm/glm-5.3-flash" }, { provider_id: p.provider.id, model: "glm/glm-5-turbo" }],
    })).json();
    expect((await send("/api/admin/ai/roles/analysis", { route_id: r.route.id }, "PUT")).statusCode).toBe(200);

    const ya = await t.login("student", "林雅婷");
    const bo = await t.login("student", "陳柏宇");
    const prof = await t.login("professor", "王教授");
    const a = await insertStudy(t.db, ya.id, "林雅婷的研究2：EEND 語者分離");
    const c = await insertStudy(t.db, bo.id, "陳柏宇的研究1：台語語音辨識資料集");
    await addStudyMember(t.db, a.id, prof.id, "advisor");
    await addStudyMember(t.db, c.id, prof.id, "advisor");
    const meetingId = (await t.db.query<{ id: string }>("INSERT INTO meetings(title,held_at,created_by) VALUES('實驗室週會',now(),$1) RETURNING id", [ya.id])).rows[0]!.id;
    await t.db.query("INSERT INTO meeting_studies(meeting_id,study_id,position) VALUES($1,$2,0),($1,$3,1)", [meetingId, a.id, c.id]);
    await t.db.query("INSERT INTO meeting_participants(meeting_id,user_id) VALUES($1,$2),($1,$3),($1,$4)", [meetingId, ya.id, bo.id, prof.id]);
    const segments = LINES.map(([start, speaker, text], i) => ({ id: i, start, end: (LINES[i + 1]?.[0] ?? start + 4) - 0.5, text, speaker }));
    const tid = (await t.db.query<{ id: string }>("INSERT INTO transcripts(meeting_id,source,language,segments) VALUES($1,'upload','zh-TW',$2) RETURNING id", [meetingId, JSON.stringify(segments)])).rows[0]!.id;
    await t.db.query("UPDATE meetings SET transcript_id=$2 WHERE id=$1", [meetingId, tid]);
    await t.db.query("INSERT INTO speaker_map(meeting_id,speaker_label,user_id) VALUES($1,'林雅婷',$2),($1,'陳柏宇',$3),($1,'王教授',$4)", [meetingId, ya.id, bo.id, prof.id]);

    const ctx = {
      job: { id: "00000000-0000-4000-8000-0000000000aa", kind: "ai_meeting_analyze", payload: { meetingId, userId: ya.id }, attempts: 1, maxAttempts: 3, createdBy: ya.id },
      db: t.db, storage: t.storage, ai: aiFor(t.app), log: console, signal: AbortSignal.timeout(240_000),
      async progress() {}, checkpoint: null, async saveCheckpoint() {},
    } as unknown as AiJobContext<AnalyzePayload>;
    const started = Date.now();
    const result = await runAnalyze(ctx);
    console.log("live analysis:", JSON.stringify({ ...result, ms: Date.now() - started }));
    expect(result.drafts).toBe(2);
    const drafts = (await t.db.query("SELECT study_id,summary_md,feedback_md,proposed_tasks,evidence FROM meeting_study_drafts WHERE meeting_id=$1", [meetingId])).rows;
    const da = drafts.find(d => d.study_id === a.id)!;
    const dc = drafts.find(d => d.study_id === c.id)!;
    console.log("draft A:", JSON.stringify(da).slice(0, 1200));
    console.log("draft C:", JSON.stringify(dc).slice(0, 1200));
    expect(da.summary_md.length).toBeGreaterThan(5);
    expect(dc.summary_md.length).toBeGreaterThan(5);
    expect(da.proposed_tasks.length + dc.proposed_tasks.length).toBeGreaterThan(0);
    // Assignees, when set, are members (not advisors) of that study.
    for (const task of da.proposed_tasks) expect([null, ya.id]).toContain(task.assignee_id);
    for (const task of dc.proposed_tasks) expect([null, bo.id]).toContain(task.assignee_id);
    const meeting = (await t.db.query("SELECT analysis FROM meetings WHERE id=$1", [meetingId])).rows[0]!;
    console.log("other:", meeting.analysis.other_md);
  }, 300_000);
});
