import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LightMyRequestResponse } from "fastify";
import type { AiJobContext } from "../src/ai-worker/registry.js";
import { AiPlatform } from "../src/ai/platform/platform.js";
import { AiError } from "../src/ai/errors.js";
import { runAnalyze } from "../src/ai-jobs/meetings/analyze.js";
import { runTranscribe } from "../src/ai-jobs/meetings/transcribe.js";
import type { AnalyzePayload, TranscribePayload } from "../src/lib/meetings/media.js";
import { createTestContext, hasTestDb, hasTestS3, ORIGIN, type TestContext } from "./helpers.js";
import { addStudyMember, insertStudy } from "./study-fixtures.js";
import { MockServer } from "./ai-providers-mock.js";
import { getAgentTool } from "../src/agent/tools/registry.js";

process.env.PROVIDER_TOKEN_KEY ??= randomBytes(32).toString("base64");

type Session = { id: string; cookie: string };
const json = (r: LightMyRequestResponse) => r.json() as Record<string, any>;

function multipart(fields: Record<string, string>, file?: { name: string; content: Buffer | string; type?: string }) {
  const boundary = `----hub${randomBytes(6).toString("hex")}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type ?? "application/octet-stream"}\r\n\r\n`));
    parts.push(Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content));
    parts.push(Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

const SRT = `1
00:00:01,000 --> 00:00:05,000
林雅婷：我這週把語者分離的實驗跑完了，DER 降到百分之十二。

2
00:00:06,000 --> 00:00:10,000
王教授：很好，下週把結果整理成表格，也和 baseline 比較。

3
00:00:11,000 --> 00:00:16,000
陳柏宇：我的資料集標註還差三百筆，預計週五前完成。

4
00:00:17,000 --> 00:00:20,000
王教授：柏宇記得先跟助教確認標註規範。
`;

/** Scripted ai for job contexts: `chat` returns the next reply. */
function scripted(replies: (string | Error | { text: string; stopReason: string })[]) {
  const calls: any[] = [];
  return {
    calls,
    ai: {
      async chat(_role: string, req: any) {
        calls.push(req);
        const next = replies.shift();
        if (next === undefined) throw new Error("no more scripted replies");
        if (next instanceof Error) throw next;
        if (typeof next === "object") return { ...next, usage: {}, route: { providerKind: "mock", model: "m1" } };
        return { text: next, stopReason: "end_turn", route: { providerKind: "mock", model: "m1" } };
      },
    },
  };
}

function jobCtx<P>(t: TestContext, ai: unknown, payload: P, checkpoint: unknown = null, kind = "ai_meeting_analyze") {
  const saved: unknown[] = [];
  const ctx = {
    job: { id: "00000000-0000-4000-8000-000000000001", kind, payload, attempts: 1, maxAttempts: 3, createdBy: null },
    db: t.db, storage: t.storage, ai, log: { info() {}, warn() {}, error() {} }, signal: new AbortController().signal,
    async progress() {}, checkpoint, async saveCheckpoint(v: unknown) { saved.push(v); },
  } as unknown as AiJobContext<P>;
  return { ctx, saved };
}

describe.skipIf(!hasTestDb)("meetings", () => {
  let t: TestContext;
  let ya: Session; // 林雅婷: owner of study A
  let bo: Session; // 陳柏宇: owner of study C
  let dee: Session; // member of study C
  let prof: Session; // 王教授: advisor of C
  let outsider: Session;
  let studyA: { id: string; slug: string };
  let studyC: { id: string; slug: string };
  let meetingId: string;

  const send = (who: Session | null, method: "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: object) =>
    t.app.inject({ method, url, headers: { origin: ORIGIN, ...(who ? { cookie: who.cookie } : {}) }, ...(payload ? { payload } : {}) });
  const get = (who: Session, url: string) => t.app.inject({ method: "GET", url, headers: { cookie: who.cookie } });

  beforeAll(async () => {
    t = await createTestContext();
    ya = await t.login("student", "林雅婷");
    bo = await t.login("student", "陳柏宇");
    dee = await t.login("student", "Dee");
    prof = await t.login("professor", "王教授");
    outsider = await t.login("student", "Out");
    studyA = await insertStudy(t.db, ya.id, "林雅婷的研究2");
    studyC = await insertStudy(t.db, bo.id, "陳柏宇的研究1");
    await addStudyMember(t.db, studyC.id, dee.id, "member");
    await addStudyMember(t.db, studyC.id, prof.id, "advisor");
  });
  afterAll(async () => {
    await t?.close();
  });

  it("validates the create wizard", async () => {
    const base = { title: "週會", held_at: "2026-10-20T06:00:00Z", study_ids: [studyA.id], participant_ids: [] };
    expect((await send(ya, "POST", "/api/meetings", { ...base, study_ids: [] })).statusCode).toBe(400);
    expect((await send(ya, "POST", "/api/meetings", { ...base, held_at: "not a date" })).statusCode).toBe(400);
    expect((await send(ya, "POST", "/api/meetings", { ...base, title: "" })).statusCode).toBe(400);
    expect((await send(ya, "POST", "/api/meetings", { ...base, study_ids: ["no-such-study"] })).statusCode).toBe(400);
    expect((await send(ya, "POST", "/api/meetings", { ...base, participant_ids: [randomUUID()] })).statusCode).toBe(400);
    // A deck of a study that is not in the meeting.
    const deck = (await t.db.query<{ id: string }>("INSERT INTO decks(study_id,title,slug,share_key,created_by,updated_by) VALUES($1,'C 簡報','c-deck',$2,$3,$3) RETURNING id", [studyC.id, randomBytes(8).toString("hex"), bo.id])).rows[0]!.id;
    expect((await send(ya, "POST", "/api/meetings", { ...base, decks: [{ deck_id: deck }] })).statusCode).toBe(400);
    expect((await send(null, "POST", "/api/meetings", base)).statusCode).toBe(401);
  });

  it("creates a cross-study meeting (A creates, includes C's study, by slug and id)", async () => {
    const deck = (await t.db.query<{ id: string }>("SELECT id FROM decks WHERE slug='c-deck'")).rows[0]!.id;
    const res = await send(ya, "POST", "/api/meetings", {
      title: "10/20 實驗室週會", held_at: "2026-10-20T06:00:00Z", notes: "討論兩個研究",
      study_ids: [studyA.slug, studyC.id], participant_ids: [bo.id, prof.id], decks: [{ deck_id: deck }],
    });
    expect(res.statusCode).toBe(201);
    const body = json(res);
    meetingId = body.meeting.id;
    expect(body.meeting.status).toBe("draft");
    expect(body.studies.map((s: any) => s.title)).toEqual(["林雅婷的研究2", "陳柏宇的研究1"]);
    expect(body.studies[1].owner.name).toBe("陳柏宇");
    expect(body.participants.map((p: any) => p.name).sort()).toEqual(["林雅婷", "王教授", "陳柏宇"].sort());
    expect(body.decks).toHaveLength(1);
    expect(body.permissions.edit).toBe(true);
    expect(body.permissions.studies).toEqual([studyA.id]);

    // Lists: lab-wide, by study, by person; study tab.
    expect(json(await get(outsider, "/api/meetings")).meetings.map((m: any) => m.id)).toContain(meetingId);
    expect(json(await get(outsider, `/api/meetings?study=${studyC.slug}`)).meetings).toHaveLength(1);
    expect(json(await get(outsider, `/api/meetings?person=${outsider.id}`)).meetings).toHaveLength(0);
    const tab = json(await get(dee, `/api/studies/${studyC.slug}/meetings`));
    expect(tab.meetings[0].studies[1].draft_status).toBeNull();
    expect(json(await get(ya, `/api/meetings/deck-options?studies=${studyA.id},${studyC.slug}`)).decks).toHaveLength(1);
  });

  it("enforces who may edit the meeting", async () => {
    // Outsider: not creator/participant/member → read only.
    const detail = json(await get(outsider, `/api/meetings/${meetingId}`));
    expect(detail.permissions.edit).toBe(false);
    expect((await send(outsider, "PATCH", `/api/meetings/${meetingId}`, { title: "x" })).statusCode).toBe(403);
    // Member of an included study (not a participant) may edit.
    expect((await send(dee, "PATCH", `/api/meetings/${meetingId}`, { notes: "Dee 補充" })).statusCode).toBe(200);
    // Delete: the creator or an owner/member of a linked study; participants (the professor), advisors and
    // outsiders may not — the detail and the list cards say so (`permissions.delete`, `can_delete`).
    expect((await send(outsider, "DELETE", `/api/meetings/${meetingId}`)).statusCode).toBe(403);
    expect((await send(prof, "DELETE", `/api/meetings/${meetingId}`)).statusCode).toBe(403);
    expect(json(await get(bo, `/api/meetings/${meetingId}`)).permissions.delete).toBe(true);
    expect(json(await get(dee, `/api/meetings/${meetingId}`)).permissions.delete).toBe(true);
    expect(json(await get(prof, `/api/meetings/${meetingId}`)).permissions.delete).toBe(false);
    const card = (who: Session) => get(who, "/api/meetings").then(r => json(r).meetings.find((m: any) => m.id === meetingId));
    expect((await card(ya)).can_delete).toBe(true);
    expect((await card(dee)).can_delete).toBe(true);
    expect((await card(prof)).can_delete).toBe(false);
    expect((await card(outsider)).can_delete).toBe(false);
    expect(json(await get(dee, `/api/studies/${studyC.slug}/meetings`)).meetings[0].can_delete).toBe(true);
    // Anyone may give feedback (professor here).
    const fb = await send(prof, "POST", `/api/meetings/${meetingId}/feedback`, { body_md: "柏宇的標註規範要先定好；雅婷的 DER 表格要有 baseline。" });
    expect(fb.statusCode).toBe(201);
    expect(json(fb).feedback).toHaveLength(1);
    expect((await send(outsider, "PATCH", `/api/meetings/${meetingId}/feedback/${json(fb).feedback[0].id}`, { body_md: "hack" })).statusCode).toBe(403);
  });

  it("uploads a transcript (SRT with speaker names) and queues the analysis", async () => {
    const up = multipart({}, { name: "週會.srt", content: SRT });
    const res = await t.app.inject({ method: "POST", url: `/api/meetings/${meetingId}/transcripts`, headers: { origin: ORIGIN, cookie: bo.cookie, ...up.headers }, payload: up.payload });
    expect(res.statusCode).toBe(201);
    const body = json(res);
    expect(body.transcript.source).toBe("upload");
    expect(body.transcript.segments).toHaveLength(4);
    expect(body.transcript.segments[0]).toMatchObject({ start: 1, end: 5, speaker: "林雅婷" });
    // Names matching accounts are mapped automatically.
    expect(body.speaker_map.map((s: any) => s.user_name).sort()).toEqual(["林雅婷", "王教授", "陳柏宇"].sort());
    expect(body.jobs.analyze.status).toBe("queued");
    expect(body.meeting.status).toBe("analyzing");
    // Bad file type.
    const bad = multipart({}, { name: "x.pdf", content: "%PDF" });
    expect((await t.app.inject({ method: "POST", url: `/api/meetings/${meetingId}/transcripts`, headers: { origin: ORIGIN, cookie: bo.cookie, ...bad.headers }, payload: bad.payload })).statusCode).toBe(400);
  });

  it("analysis job: repairs invalid JSON once, validates assignees, writes drafts", async () => {
    const job = (await t.db.query<{ id: string; payload: AnalyzePayload }>("SELECT id,payload FROM jobs WHERE kind='ai_meeting_analyze' ORDER BY created_at DESC LIMIT 1")).rows[0]!;
    // People refs: participants first (by name: 林雅婷, 王教授, 陳柏宇 → P1..P3), then members (Dee → P4).
    const good = JSON.stringify({
      studies: [
        { study: "R1", summary_md: "- 語者分離實驗完成，DER 12%", feedback_md: "- 整理成表格並和 baseline 比較", tasks: [
          { title: "整理 DER 結果表格", detail: "含 baseline", assignee: "P1", due: "2026-10-27" },
          { title: "不該指派給別的研究的人", detail: "", assignee: "P3", due: "not-a-date" },
        ], evidence: [{ time: "00:06", quote: "下週把結果整理成表格" }] },
        { study: "R2", summary_md: "- 資料集標註還差三百筆", feedback_md: "- 先確認標註規範", tasks: [
          { title: "完成三百筆標註", detail: "", assignee: "P3", due: "2026-10-23" },
          { title: "確認標註規範", detail: "跟助教", assignee: "P4", due: null },
        ], evidence: [{ time: "0:11", quote: "標註還差三百筆" }, { time: "17", quote: "確認標註規範" }] },
        { study: "R9", summary_md: "不存在", feedback_md: "", tasks: [], evidence: [] },
      ],
      other_md: "",
      speakers: [],
    });
    const { ai, calls } = scripted(["這不是 JSON", "```json\n" + good + "\n```"]);
    const { ctx } = jobCtx<AnalyzePayload>(t, ai, job.payload);
    (ctx.job as any).id = job.id;
    const result = await runAnalyze(ctx);
    expect(calls).toHaveLength(2);
    expect(calls[0].responseFormat.type).toBe("json_schema");
    expect(result).toMatchObject({ drafts: 2, chunks: 1, repaired: true });
    const drafts = (await t.db.query("SELECT * FROM meeting_study_drafts WHERE meeting_id=$1 ORDER BY (study_id=$2) DESC", [meetingId, studyA.id])).rows;
    expect(drafts).toHaveLength(2);
    expect(drafts[0].proposed_tasks.map((x: any) => x.assignee_id)).toEqual([ya.id, null]); // P3 is not a member of A
    expect(drafts[0].proposed_tasks[1].due).toBeNull();
    expect(drafts[1].proposed_tasks.map((x: any) => x.assignee_id)).toEqual([bo.id, dee.id]);
    expect(drafts[1].evidence.map((e: any) => e.start)).toEqual([11, 17]);
    // The prompt carried the feedback and the people/study refs, never ids.
    const prompt = calls[0].messages[1].content as string;
    expect(prompt).toContain("R2「陳柏宇的研究1」");
    expect(prompt).toContain("柏宇的標註規範");
    expect(prompt).not.toContain(studyA.id);
    // Members of the drafts' studies were notified.
    const notes = (await t.db.query("SELECT user_id FROM notifications WHERE kind='meeting' AND title='會議草稿待確認'")).rows.map(r => r.user_id).sort();
    expect(notes).toEqual([ya.id, bo.id, dee.id].sort());
    await t.db.query("UPDATE jobs SET status='succeeded', finished_at=now() WHERE id=$1", [job.id]);
    const detail = json(await get(ya, `/api/meetings/${meetingId}`));
    expect(detail.meeting.status).toBe("review");
    expect(detail.drafts.map((d: any) => d.can_edit)).toEqual([true, false]);
  });

  it("only members of THAT study confirm its draft; professors cannot", async () => {
    const detail = json(await get(bo, `/api/meetings/${meetingId}`));
    const draftC = detail.drafts.find((d: any) => d.study_id === studyC.id);
    const draftA = detail.drafts.find((d: any) => d.study_id === studyA.id);
    expect((await send(ya, "POST", `/api/meetings/${meetingId}/drafts/${draftC.id}/confirm`, {})).statusCode).toBe(403); // creator, other study
    expect((await send(prof, "POST", `/api/meetings/${meetingId}/drafts/${draftC.id}/confirm`, {})).statusCode).toBe(403); // advisor
    expect((await send(prof, "PATCH", `/api/meetings/${meetingId}/drafts/${draftC.id}`, { summary_md: "x" })).statusCode).toBe(403);
    // Bad assignee in edited tasks → 400.
    expect((await send(dee, "POST", `/api/meetings/${meetingId}/drafts/${draftC.id}/confirm`, { tasks: [{ title: "x", assignee_id: ya.id }] })).statusCode).toBe(400);

    const edited = await send(dee, "PATCH", `/api/meetings/${meetingId}/drafts/${draftC.id}`, { summary_md: "- 標註還差 300 筆（Dee 修訂）" });
    expect(edited.statusCode).toBe(200);
    const res = await send(dee, "POST", `/api/meetings/${meetingId}/drafts/${draftC.id}/confirm`, {});
    expect(res.statusCode).toBe(200);
    const confirmed = json(res).confirmed;
    expect(confirmed.task_ids).toHaveLength(2);
    const note = (await t.db.query("SELECT n.*,t.kind AS template_kind FROM notes n LEFT JOIN note_templates t ON t.id=n.template_id WHERE n.id=$1", [confirmed.note_id])).rows[0]!;
    expect(note.study_id).toBe(studyC.id);
    expect(note.kind).toBe("meeting");
    expect(note.template_kind).toBe("meeting");
    expect(note.content_md).toContain("Dee 修訂");
    expect(note.content_md).toContain("## 逐字稿片段");
    expect(note.content_md).toContain(`/meetings/${meetingId}?t=11`);
    expect(note.content_md).toContain("先確認標註規範");
    const tasks = (await t.db.query("SELECT * FROM tasks WHERE id = ANY($1) ORDER BY title", [confirmed.task_ids])).rows;
    expect(tasks.every((x: any) => x.source === "meeting" && x.source_ref === meetingId && x.study_id === studyC.id)).toBe(true);
    const activity = (await t.db.query("SELECT * FROM study_activity WHERE study_id=$1 AND kind='meeting_confirmed'", [studyC.id])).rows;
    expect(activity).toHaveLength(1);
    const notified = (await t.db.query("SELECT user_id FROM notifications WHERE title=$1", ["Dee 確認了會議紀錄"])).rows.map(r => r.user_id).sort();
    expect(notified).toEqual([bo.id, prof.id].sort());
    expect((await send(bo, "POST", `/api/meetings/${meetingId}/drafts/${draftC.id}/confirm`, {})).statusCode).toBe(409);

    // A dismisses its draft → meeting done; reopen → review.
    expect((await send(ya, "POST", `/api/meetings/${meetingId}/drafts/${draftA.id}/dismiss`)).statusCode).toBe(200);
    expect(json(await get(ya, `/api/meetings/${meetingId}`)).meeting.status).toBe("done");
    expect((await send(ya, "POST", `/api/meetings/${meetingId}/drafts/${draftA.id}/reopen`)).statusCode).toBe(200);
    const after = json(await get(ya, `/api/meetings/${meetingId}`));
    expect(after.meeting.status).toBe("review");
    expect(json(await get(dee, `/api/studies/${studyC.slug}/meetings`)).meetings[0].studies.find((s: any) => s.id === studyC.id).draft_status).toBe("confirmed");
  });

  it("speaker mapping and transcript export", async () => {
    const res = await send(bo, "PUT", `/api/meetings/${meetingId}/speakers`, { speakers: [{ label: "林雅婷", user_id: null, name: "雅婷（訪客）" }, { label: "王教授", user_id: null, name: null }] });
    expect(res.statusCode).toBe(200);
    const map = json(res).speaker_map;
    expect(map.find((s: any) => s.speaker_label === "林雅婷").name).toBe("雅婷（訪客）");
    expect(map.find((s: any) => s.speaker_label === "王教授")).toBeUndefined();
    const detail = json(await get(bo, `/api/meetings/${meetingId}`));
    const srt = await get(bo, `/api/meetings/${meetingId}/transcripts/${detail.transcript.id}/export`);
    expect(srt.statusCode).toBe(200);
    expect(srt.body).toContain("00:00:01,000 --> 00:00:05,000\n雅婷（訪客）：");
  });

  it("retries without thinking when a reasoning model spends the whole budget", async () => {
    const finalReply = JSON.stringify({ studies: [], other_md: "", speakers: [] });
    const { ai, calls } = scripted([{ text: "", stopReason: "max_tokens" }, finalReply]);
    const { ctx } = jobCtx<AnalyzePayload>(t, ai, { meetingId, userId: ya.id });
    const result = await runAnalyze(ctx);
    expect(result.repaired).toBe(false);
    expect(calls[0].reasoning).toEqual({ effort: "low" });
    expect(calls[1].reasoning.enabled).toBe(false);
    expect(calls[1].maxTokens).toBe(calls[0].maxTokens * 2);
  });

  it("degrades the response format on bad_request and map-reduces long transcripts", async () => {
    const mapReply = JSON.stringify({ notes: [{ study: "R1", kind: "progress", text: "DER 12%", time: "0:01", who: "P1" }] });
    const finalReply = JSON.stringify({ studies: [{ study: "R1", summary_md: "- ok", feedback_md: "", tasks: [], evidence: [] }], other_md: "- 行政：下週停課", speakers: [{ speaker: "#1", person: "P1", reason: "自稱跑實驗" }] });
    const { ai, calls } = scripted([new AiError("bad_request"), mapReply, mapReply, mapReply, mapReply, finalReply]);
    const { ctx, saved } = jobCtx<AnalyzePayload>(t, ai, { meetingId, userId: ya.id });
    const result = await runAnalyze(ctx, { mapThreshold: 50, windowChars: 40 });
    expect(result.chunks).toBe(4);
    expect(calls[0].responseFormat.type).toBe("json_schema");
    expect(calls[1].responseFormat.type).toBe("json_object");
    expect(calls.at(-1).messages[1].content).toContain("<notes>");
    expect(saved).toHaveLength(4);
    const meeting = (await t.db.query("SELECT analysis FROM meetings WHERE id=$1", [meetingId])).rows[0]!;
    expect(meeting.analysis.other_md).toContain("下週停課");
    expect(meeting.analysis.speaker_guesses[0]).toMatchObject({ label: "林雅婷", user_id: ya.id });
    // A resumed attempt skips finished windows.
    const again = scripted([finalReply]);
    const resumed = jobCtx<AnalyzePayload>(t, again.ai, { meetingId, userId: ya.id }, saved.at(-1));
    await runAnalyze(resumed.ctx, { mapThreshold: 50, windowChars: 40 });
    expect(again.calls).toHaveLength(1);
  });

  it("agent tools read meetings and transcript excerpts", async () => {
    const user = { id: outsider.id, name: "Out", role: "student", is_admin: false, is_owner: false } as any;
    const ctx = { app: t.app, db: t.db, user, source: "agent", conversationId: null, runId: null, autopilot: false } as any;
    const list = await getAgentTool("list_meetings")!.execute({ study: studyC.slug }, ctx);
    expect((list.data as any).meetings[0].id).toBe(meetingId);
    const meeting = await getAgentTool("get_meeting")!.execute({ meeting_id: meetingId }, ctx);
    expect(meeting.untrusted).toBe(true);
    expect((meeting.data as any).drafts).toHaveLength(2);
    const excerpt = await getAgentTool("get_transcript_excerpt")!.execute({ meeting_id: meetingId, q: "標註" }, ctx);
    expect((excerpt.data as any).lines.join("\n")).toContain("[0:11] 陳柏宇：我的資料集標註還差三百筆");
    const ranged = await getAgentTool("get_transcript_excerpt")!.execute({ meeting_id: meetingId, from: "0:06", to: "0:10" }, ctx);
    expect((ranged.data as any).lines).toHaveLength(1);
  });

  it("live captions WebSocket: checks origin and access, reports an unbound asr_live role", async () => {
    const url = `/api/meetings/${meetingId}/live?rate=16000`;
    await expect(t.app.injectWS(url, { headers: { cookie: ya.cookie, origin: "http://evil.test" } })).rejects.toThrow();
    await expect(t.app.injectWS(url, { headers: { cookie: outsider.cookie, origin: ORIGIN } })).rejects.toThrow();
    const ws = await t.app.injectWS(url, { headers: { cookie: ya.cookie, origin: ORIGIN } });
    const message = await new Promise<any>(resolve => ws.on("message", (data: Buffer) => resolve(JSON.parse(data.toString()))));
    expect(message).toMatchObject({ type: "error", code: "llm_unavailable" });
    ws.terminate();
  });

  describe.skipIf(!hasTestS3)("media", () => {
    let recMeeting: string;
    beforeAll(async () => {
      recMeeting = json(await send(ya, "POST", "/api/meetings", { title: "錄音測試", held_at: new Date().toISOString(), study_ids: [studyA.id] })).meeting.id;
    });

    it("chunked browser recording: parts survive a reload, finish assembles and queues the transcode", async () => {
      const start = await send(ya, "POST", `/api/meetings/${recMeeting}/recordings`, { mime: "audio/webm;codecs=opus" });
      expect(start.statusCode).toBe(201);
      const mediaId = json(start).media.id;
      const put = (part: number, seq: number, body: string, who = ya) =>
        t.app.inject({ method: "PUT", url: `/api/meetings/${recMeeting}/recordings/${mediaId}/chunks/${part}/${seq}`, headers: { origin: ORIGIN, cookie: who.cookie, "content-type": "audio/webm" }, payload: Buffer.from(body) });
      expect((await put(0, 0, "AAA")).statusCode).toBe(200);
      expect((await put(0, 1, "BBB")).statusCode).toBe(200);
      expect((await put(0, 1, "BBB")).statusCode).toBe(200); // retry is idempotent
      expect((await put(1, 0, "CCC")).statusCode).toBe(200); // after a reload: new part
      expect((await put(0, 2, "x", outsider)).statusCode).toBe(403);
      expect(json(await get(ya, `/api/meetings/${recMeeting}`)).meeting.status).toBe("recorded");
      const fin = await send(ya, "POST", `/api/meetings/${recMeeting}/recordings/${mediaId}/finish`, { duration_sec: 21 });
      expect(fin.statusCode).toBe(202);
      expect(json(fin).media.status).toBe("processing");
      expect((await put(0, 3, "late")).statusCode).toBe(409);
      expect((await send(ya, "POST", `/api/meetings/${recMeeting}/recordings/${mediaId}/finish`, {})).statusCode).toBe(409);
      const job = (await t.db.query("SELECT * FROM jobs WHERE kind='media_transcode' ORDER BY created_at DESC LIMIT 1")).rows[0]!;
      expect(job.payload).toMatchObject({ itemId: mediaId, sourceKey: `media/uploads/${mediaId}/source`, extraSourceKeys: [`media/uploads/${mediaId}/part-1`], outputKey: `media/items/${recMeeting}/${mediaId}.m4a` });
      expect((await t.storage.getBuffer(`media/uploads/${mediaId}/source`))!.toString()).toBe("AAABBB");
      expect((await t.storage.getBuffer(`media/uploads/${mediaId}/part-1`))!.toString()).toBe("CCC");
      expect(await t.storage.getBuffer(`meetings/${recMeeting}/rec/${mediaId}/0/000000.webm`)).toBeNull();

      // Worker finished: the finalizer marks the media ready and queues ASR.
      await t.storage.put(job.payload.outputKey, Buffer.from("fake-m4a-audio-bytes"), "audio/mp4");
      await t.db.query("UPDATE jobs SET status='succeeded', finished_at=now(), result=$2 WHERE id=$1", [job.id, JSON.stringify({ outputKey: job.payload.outputKey, bytes: 20, durationSeconds: 21.5, peaks: [0.1, 0.5, 2], hasVideo: false, keptSource: false })]);
      await t.finalizer.drain();
      const detail = json(await get(ya, `/api/meetings/${recMeeting}`));
      expect(detail.media[0]).toMatchObject({ status: "ready", duration_sec: 21.5, peaks: null, audio_url: `/api/meetings/${recMeeting}/media/${mediaId}/audio` });
      expect(detail.jobs.transcribe.status).toBe("queued");
      expect(detail.meeting.status).toBe("processing");
      const audio = await t.app.inject({ method: "GET", url: detail.media[0].audio_url, headers: { cookie: outsider.cookie, range: "bytes=0-3" } });
      expect(audio.statusCode).toBe(206);
      expect(audio.body).toBe("fake");
    });

    it("uploads a video file: playable small video is kept for playback", async () => {
      const up = multipart({}, { name: "meeting.mp4", content: Buffer.alloc(2048, 1), type: "video/mp4" });
      const res = await t.app.inject({ method: "POST", url: `/api/meetings/${recMeeting}/media`, headers: { origin: ORIGIN, cookie: ya.cookie, ...up.headers }, payload: up.payload });
      expect(res.statusCode).toBe(202);
      const media = json(res).media;
      const job = (await t.db.query("SELECT * FROM jobs WHERE kind='media_transcode' ORDER BY created_at DESC LIMIT 1")).rows[0]!;
      expect(job.payload).toMatchObject({ itemId: media.id, keepSource: true });
      await t.db.query("UPDATE jobs SET status='succeeded', finished_at=now(), result=$2 WHERE id=$1", [job.id, JSON.stringify({ outputKey: job.payload.outputKey, bytes: 20, durationSeconds: 3, hasVideo: true, keptSource: true })]);
      await t.finalizer.drain();
      const detail = json(await get(ya, `/api/meetings/${recMeeting}`));
      const m = detail.media.find((x: any) => x.id === media.id);
      expect(m).toMatchObject({ status: "ready", has_video: true, video_url: `/api/meetings/${recMeeting}/media/${media.id}/video` });
      const bad = multipart({}, { name: "x.exe", content: "MZ" });
      expect((await t.app.inject({ method: "POST", url: `/api/meetings/${recMeeting}/media`, headers: { origin: ORIGIN, cookie: ya.cookie, ...bad.headers }, payload: bad.payload })).statusCode).toBe(400);
    });

    it("transcription job (mock ASR route): resumes from the saved checkpoint and queues analysis", async () => {
      const admin = await t.ownerCookie();
      const asr = new MockServer();
      await asr.start();
      asr.on("GET", "/health", { body: { status: "ok" } });
      const provider = json(await send(admin, "POST", "/api/admin/ai/providers", { family: "asr", kind: "speaches", name: "mock-asr", config: { base_url: asr.url }, secrets: {} }));
      const route = json(await send(admin, "POST", "/api/admin/ai/routes", { name: "asr-main", capability: "asr", strategy: "single", members: [{ provider_id: provider.provider?.id ?? provider.id, model: "whisper-test" }] }));
      expect((await send(admin, "PUT", "/api/admin/ai/roles/asr", { route_id: route.route.id })).statusCode).toBe(200);

      const calls: any[] = [];
      const platform = new AiPlatform(t.db, t.app.log, {
        transcribeImpl: async (_cfg, req) => {
          calls.push(req);
          if (calls.length === 1) {
            await req.onCheckpoint?.({ vendorJobs: { "0": "vendor-1" }, done: {} });
            throw new AiError("timeout");
          }
          return {
            schema: 1, language: "zh-TW", durationSec: 21.5, warnings: [], speakers: [{ id: "S1", label: "A" }, { id: "S2", label: "B" }],
            segments: [{ id: 0, start: 0.5, end: 4, text: "我們開始開會", speaker: "S1" }, { id: 1, start: 4.5, end: 9, text: "雅婷先報告", speaker: "S2" }],
            words: [{ start: 0.5, end: 1, text: "我們" }],
            source: { kind: "speaches", model: "whisper-test", requestIds: [], chunks: [], scriptConversion: "s2twp" },
          };
        },
      });
      const job = (await t.db.query<{ id: string; payload: TranscribePayload }>("SELECT id,payload FROM jobs WHERE kind='ai_meeting_transcribe' ORDER BY created_at LIMIT 1")).rows[0]!;
      const first = jobCtx<TranscribePayload>(t, platform, job.payload, null, "ai_meeting_transcribe");
      (first.ctx.job as any).id = job.id;
      await expect(runTranscribe(first.ctx)).rejects.toMatchObject({ code: "llm_unavailable" });
      expect(first.saved).toHaveLength(1);
      expect(calls[0].language).toBe("zh-TW");
      expect(calls[0].diarize).toBe(true);
      expect(calls[0].keyterms).toEqual(expect.arrayContaining(["林雅婷的研究2", "林雅婷"]));

      const second = jobCtx<TranscribePayload>(t, platform, job.payload, first.saved[0], "ai_meeting_transcribe");
      (second.ctx.job as any).id = job.id;
      const result = await runTranscribe(second.ctx);
      expect(calls[1].resume).toEqual({ vendorJobs: { "0": "vendor-1" }, done: {} });
      expect(result).toMatchObject({ segments: 2, speakers: 2 });
      expect(result.analyzeJobId).toBeTruthy();
      await t.db.query("UPDATE jobs SET status='succeeded', finished_at=now() WHERE id=$1", [job.id]);
      const detail = json(await get(ya, `/api/meetings/${recMeeting}`));
      expect(detail.transcript).toMatchObject({ source: "asr", has_words: true });
      expect(detail.transcript.segments[1].speaker).toBe("S2");
      expect(detail.meeting.status).toBe("analyzing");
      await platform.logger.flush();
      await platform.stop();
      await asr.stop();
      await send(admin, "PUT", "/api/admin/ai/roles/asr", { route_id: null });
    });

    it("ASR finishing after a user upload keeps the upload current and does not re-analyze", async () => {
      const admin = await t.ownerCookie();
      const asr = new MockServer();
      await asr.start();
      asr.on("GET", "/health", { body: { status: "ok" } });
      const provider = json(await send(admin, "POST", "/api/admin/ai/providers", { family: "asr", kind: "speaches", name: "mock-asr-2", config: { base_url: asr.url }, secrets: {} }));
      const route = json(await send(admin, "POST", "/api/admin/ai/routes", { name: "asr-upload-wins", capability: "asr", strategy: "single", members: [{ provider_id: provider.provider?.id ?? provider.id, model: "whisper-test" }] }));
      expect((await send(admin, "PUT", "/api/admin/ai/roles/asr", { route_id: route.route.id })).statusCode).toBe(200);
      const platform = new AiPlatform(t.db, t.app.log, {
        transcribeImpl: async () => ({
          schema: 1, language: "zh-TW", durationSec: 5, warnings: [], speakers: [{ id: "S1", label: "A" }],
          segments: [{ id: 0, start: 0, end: 4, text: "ASR 版本", speaker: "S1" }],
          source: { kind: "speaches", model: "whisper-test", requestIds: [], chunks: [], scriptConversion: "s2twp" },
        }),
      });
      try {
        const mid = json(await send(ya, "POST", "/api/meetings", { title: "上傳優先", held_at: new Date().toISOString(), study_ids: [studyA.id] })).meeting.id;
        const audioKey = `media/items/${mid}/x.m4a`;
        await t.storage.put(audioKey, Buffer.from("fake-audio"), "audio/mp4");
        const mediaId = (await t.db.query<{ id: string }>("INSERT INTO meeting_media(meeting_id,kind,status,audio_key,duration_sec) VALUES($1,'upload','ready',$2,5) RETURNING id", [mid, audioKey])).rows[0]!.id;
        const up = multipart({ analyze: "0" }, { name: "週會.srt", content: SRT });
        const upRes = await t.app.inject({ method: "POST", url: `/api/meetings/${mid}/transcripts`, headers: { origin: ORIGIN, cookie: ya.cookie, ...up.headers }, payload: up.payload });
        expect(upRes.statusCode).toBe(201);
        const run = async () => {
          const { ctx } = jobCtx<TranscribePayload>(t, platform, { meetingId: mid, mediaId, userId: ya.id }, null, "ai_meeting_transcribe");
          return runTranscribe(ctx);
        };
        const first = await run();
        expect(first).toMatchObject({ current: false, analyzeJobId: null });
        let detail = json(await get(ya, `/api/meetings/${mid}`));
        expect(detail.transcript.source).toBe("upload");
        expect(detail.transcripts.map((x: any) => x.source).sort()).toEqual(["asr", "upload"]);
        expect(detail.jobs.analyze).toBeNull();
        // The user switches to the ASR transcript.
        const sw = await send(ya, "PUT", `/api/meetings/${mid}/transcript`, { transcript_id: first.transcriptId });
        expect(json(sw).transcript.source).toBe("asr");
        // A later ASR run replaces an ASR current transcript, but an existing analysis is never re-run automatically.
        await t.db.query(`UPDATE meetings SET analysis='{"other_md":"","other_evidence":[],"speaker_guesses":[],"model":null,"analyzed_at":"2026-01-01","chunks":1}' WHERE id=$1`, [mid]);
        const second = await run();
        expect(second).toMatchObject({ current: true, analyzeJobId: null });
        detail = json(await get(ya, `/api/meetings/${mid}`));
        expect(detail.transcript.id).toBe(second.transcriptId);
        // No analysis and no drafts: the ASR transcript becoming current queues the analysis.
        await t.db.query("UPDATE meetings SET analysis=NULL WHERE id=$1", [mid]);
        const third = await run();
        expect(third.current).toBe(true);
        expect(third.analyzeJobId).toBeTruthy();
      } finally {
        await platform.logger.flush();
        await platform.stop();
        await asr.stop();
        await send(admin, "PUT", "/api/admin/ai/roles/asr", { route_id: null });
      }
    });

    it("deleting a meeting removes its objects (creator or linked-study members)", async () => {
      expect((await send(outsider, "DELETE", `/api/meetings/${recMeeting}`)).statusCode).toBe(403);
      expect((await send(ya, "DELETE", `/api/meetings/${recMeeting}`)).statusCode).toBe(200);
      expect((await get(ya, `/api/meetings/${recMeeting}`)).statusCode).toBe(404);
    });
  });
});
