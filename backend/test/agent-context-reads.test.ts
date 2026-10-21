/** Agent read tools added by the AI-capability audit: deck reviews, study BibTeX, recent activity, richer progress and search over meetings. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAgentTool } from "../src/agent/tools/index.js";
import { addPaperToStudy, insertPaper } from "../src/lib/library/store.js";
import { recordActivity } from "../src/lib/studies/activity.js";
import { createTestContext, hasTestDb, type TestContext } from "./helpers.js";
import { addStudyMember, insertStudy } from "./study-fixtures.js";

describe.skipIf(!hasTestDb)("agent context read tools", () => {
  let t: TestContext;
  let alice: { id: string; cookie: string };
  let prof: { id: string; cookie: string };
  let study: { id: string; slug: string };
  let deckId: string;
  const ctxOf = (id: string, role = "student") => ({ app: t.app, db: t.db, user: { id, name: "x", role, is_admin: false, is_owner: false }, source: "agent", conversationId: null, runId: null, autopilot: false }) as any;
  const run = (name: string, args: object, who = alice.id) => getAgentTool(name)!.execute(args as never, ctxOf(who));

  beforeAll(async () => {
    t = await createTestContext();
    alice = await t.login("student", "Alice");
    prof = await t.login("professor", "Prof");
    study = await insertStudy(t.db, alice.id, "串流 CTC");
    await addStudyMember(t.db, study.id, prof.id, "advisor");
    deckId = (await t.db.query<{ id: string }>("INSERT INTO decks(study_id,title,slug,share_key,created_by,updated_by) VALUES($1,'週報','qa-ctx-deck','k',$2,$2) RETURNING id", [study.id, alice.id])).rows[0]!.id;
    const review = (await t.db.query<{ id: string }>("INSERT INTO slide_reviews(deck_id,author_id,body,page) VALUES($1,$2,'第 2 頁的表格要加 baseline',2) RETURNING id", [deckId, prof.id])).rows[0]!.id;
    await t.db.query("INSERT INTO slide_review_replies(review_id,author_id,body) VALUES($1,$2,'好的')", [review, alice.id]);
    const paper = await insertPaper(t.db, { type: "paper-conference", title: "Connectionist Temporal Classification", authors: [{ family: "Graves", given: "Alex" }], year: 2006, venue: "ICML" }, alice.id);
    await addPaperToStudy(t.db, { studyId: study.id, paper, userId: alice.id, citeKey: "graves2006ctc" });
    await recordActivity(t.db, { studyId: study.id, actorId: alice.id, kind: "task_done", title: "跑 zip-xs" });
    const meeting = (await t.db.query<{ id: string }>("INSERT INTO meetings(title,held_at,created_by) VALUES('週會 QA',now() - interval '3 days',$1) RETURNING id", [alice.id])).rows[0]!.id;
    await t.db.query("INSERT INTO meeting_studies(meeting_id,study_id) VALUES($1,$2)", [meeting, study.id]);
    await t.db.query("INSERT INTO meeting_feedback(meeting_id,author_id,body_md) VALUES($1,$2,'CER 表格要附信賴區間')", [meeting, prof.id]);
  });
  afterAll(async () => t?.close());

  it("get_deck_reviews returns the advisor's page comments with replies, by deck or by study", async () => {
    const byDeck = (await run("get_deck_reviews", { deck_id: deckId })) as { data: any; untrusted?: boolean };
    expect(byDeck.data.reviews).toHaveLength(1);
    expect(byDeck.data.reviews[0]).toMatchObject({ page: 2, author_role: "教授", body: "第 2 頁的表格要加 baseline", replies: [{ body: "好的" }] });
    expect(byDeck.untrusted).toBe(true);
    const byStudy = (await run("get_deck_reviews", { study: study.slug })) as { data: any };
    expect(byStudy.data.reviews[0].deck).toBe("週報");
    await expect(run("get_deck_reviews", {})).rejects.toThrow();
  });

  it("get_study_bibtex returns the export with study cite keys and a download link", async () => {
    const r = (await run("get_study_bibtex", { study: study.slug })) as { data: any; links?: { url: string }[] };
    expect(r.data.count).toBe(1);
    expect(r.data.cite_keys).toEqual(["graves2006ctc"]);
    expect(r.data.bibtex).toContain("@inproceedings{graves2006ctc");
    expect(r.links?.[0]?.url).toBe(`/api/studies/${study.slug}/papers/export?format=bibtex`);
  });

  it("get_recent_activity lists the timeline of the user's studies", async () => {
    const mine = (await run("get_recent_activity", {})) as { data: any };
    expect(mine.data.items.map((i: { kind_label: string; title: string }) => `${i.kind_label}:${i.title}`)).toContain("完成待辦:跑 zip-xs");
    const old = (await run("get_recent_activity", { study: study.slug, since: "2999-01-01" })) as { data: any };
    expect(old.data.items).toHaveLength(0);
    // The professor is an advisor (a member row), so the cross-study view includes the study too.
    const theirs = (await run("get_recent_activity", { actor: "me" }, prof.id)) as { data: any };
    expect(theirs.data.items).toHaveLength(0);
  });

  it("get_study_progress carries meeting feedback and deck reviews", async () => {
    const r = (await run("get_study_progress", { study: study.slug })) as { data: any; untrusted?: boolean };
    expect(r.data.recent_meetings[0].feedback).toContain("信賴區間");
    expect(r.data.recent_deck_reviews[0]).toMatchObject({ page: 2, deck: "週報" });
    expect(r.untrusted).toBe(true);
  });

  it("list_studies filters by another member's user id", async () => {
    const r = (await run("list_studies", { member: alice.id }, prof.id)) as { data: any };
    expect(r.data.studies.map((x: { id: string }) => x.id)).toContain(study.id);
    await expect(run("list_studies", { member: "雅婷" }, prof.id)).rejects.toThrow();
  });

  it("search accepts meeting/deck/milestone types", async () => {
    const r = (await run("search", { query: "週會 QA", types: ["meeting", "deck"] })) as { data: any; untrusted?: boolean };
    expect(r.data.results.some((h: { type: string }) => h.type === "meeting")).toBe(true);
    expect(r.untrusted).toBe(true);
  });
});
