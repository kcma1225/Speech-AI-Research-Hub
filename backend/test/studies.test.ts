import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LightMyRequestResponse } from "fastify";
import { slugifyTitle, validStudySlug } from "../src/lib/studies/slug.js";
import { createTestContext, hasTestDb, ORIGIN, type TestContext } from "./helpers.js";

type Session = { id: string; cookie: string };

describe("study slugs (unit)", () => {
  const day = new Date("2026-10-21T03:00:00Z");
  it("keeps ASCII titles and dates lossy ones", () => {
    expect(slugifyTitle("Speech Emotion Recognition", day)).toBe("speech-emotion-recognition");
    expect(slugifyTitle("語音情緒辨識", day)).toBe("study-2026-10-21");
    expect(slugifyTitle("ASR 研究", day)).toBe("asr-2026-10-21");
    expect(slugifyTitle("Café ünïcode", day)).toBe("cafe-unicode");
  });
  it("rejects UUID-shaped and malformed slugs", () => {
    expect(validStudySlug("asr-study")).toBe(true);
    expect(validStudySlug("123e4567-e89b-12d3-a456-426614174000")).toBe(false);
    expect(validStudySlug("Bad Slug")).toBe(false);
    expect(validStudySlug("a".repeat(81))).toBe(false);
  });
});

describe.skipIf(!hasTestDb)("studies API", () => {
  let t: TestContext;
  let owner: Session; // bootstrap initial admin (system-only)
  let alice: Session; // student, creates studies
  let bob: Session; // student, member
  let carol: Session; // student, outsider
  let prof: Session; // professor
  let admin: Session; // a second (system-only) admin account
  const json = (response: LightMyRequestResponse) => response.json() as Record<string, any>;
  const send = (who: Session | null, method: "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: object) =>
    t.app.inject({ method, url, headers: { origin: ORIGIN, ...(who ? { cookie: who.cookie } : {}) }, ...(payload ? { payload } : {}) });
  const get = (who: Session | null, url: string) => t.app.inject({ method: "GET", url, headers: who ? { cookie: who.cookie } : {} });

  beforeAll(async () => {
    t = await createTestContext();
    owner = await t.ownerCookie();
    alice = await t.login("student", "Alice");
    bob = await t.login("student", "Bob");
    carol = await t.login("student", "Carol");
    prof = await t.login("professor", "Prof Wang");
    admin = await t.login("admin", "Admin Ann");
  });
  afterAll(async () => {
    await t?.close();
  });

  let study: { id: string; slug: string };

  it("creates a study with default stages, the creator as owner and initial members", async () => {
    const response = await send(alice, "POST", "/api/studies", {
      title: "語音情緒辨識",
      summary_md: "- 問題：情緒\n- 方法：SSL",
      summary_format: "bullets", // legacy field: accepted and ignored
      members: [{ userId: bob.id, role: "member" }, { userId: prof.id, role: "advisor" }],
    });
    expect(response.statusCode).toBe(201);
    const body = json(response);
    study = { id: body.study.id, slug: body.study.slug };
    expect(body.study.slug).toMatch(/^study-\d{4}-\d{2}-\d{2}$/);
    expect(body.study).toMatchObject({ title: "語音情緒辨識", status: "active" });
    expect(body.study).not.toHaveProperty("summary_format");
    expect(body.stages.map((s: any) => s.name)).toEqual(["題目發想", "文獻探討", "實驗", "撰寫", "投稿/口試"]);
    expect(body.stages[0]).toMatchObject({ is_current: true, completed_at: null });
    expect(body.stages[0].started_at).toBeTruthy();
    expect(body.study.current_stage_id).toBe(body.stages[0].id);
    expect(body.members.map((m: any) => [m.name, m.role])).toEqual([["Alice", "owner"], ["Bob", "member"], ["Prof Wang", "advisor"]]);
    expect(body.permissions).toEqual({ edit: true, manage: true, comment: true, role: "owner" });
    // Same lossy title on the same day gets a unique suffix.
    const second = json(await send(alice, "POST", "/api/studies", { title: "語音情緒辨識" }));
    expect(second.study.slug).toBe(`${study.slug}-2`);
    await send(alice, "DELETE", `/api/studies/${second.study.id}`);
  });

  it("validates creation input", async () => {
    expect((await send(alice, "POST", "/api/studies", { title: "" })).statusCode).toBe(400);
    expect((await send(alice, "POST", "/api/studies", { title: "X", slug: "Bad Slug" })).statusCode).toBe(400);
    expect((await send(alice, "POST", "/api/studies", { title: "X", members: [{ userId: carol.id, role: "advisor" }] })).statusCode).toBe(400);
    expect((await send(alice, "POST", "/api/studies", { title: "X", slug: study.slug })).statusCode).toBe(409);
    expect((await send(null, "POST", "/api/studies", { title: "X" })).statusCode).toBe(401);
  });

  it("lets everyone read, members edit, and the owner manage; admin accounts get no workspace access", async () => {
    for (const who of [carol, prof]) expect((await get(who, `/api/studies/${study.slug}`)).statusCode).toBe(200);
    for (const who of [owner, admin]) {
      const refused = await get(who, `/api/studies/${study.slug}`);
      expect(refused.statusCode).toBe(403);
      expect(json(refused).error).toBe("管理員帳號只能管理系統設定與使用者。");
    }
    expect(json(await get(carol, `/api/studies/${study.id}`)).permissions).toEqual({ edit: false, manage: false, comment: true, role: null });
    expect(json(await get(prof, `/api/studies/${study.id}`)).permissions).toEqual({ edit: false, manage: false, comment: true, role: "advisor" });

    expect((await send(bob, "PATCH", `/api/studies/${study.id}`, { summary_md: "Bob was here" })).statusCode).toBe(200);
    expect((await send(carol, "PATCH", `/api/studies/${study.id}`, { summary_md: "nope" })).statusCode).toBe(403);
    expect((await send(prof, "PATCH", `/api/studies/${study.id}`, { summary_md: "nope" })).statusCode).toBe(403);
    expect((await send(admin, "PATCH", `/api/studies/${study.id}`, { status: "archived" })).statusCode).toBe(403);
    expect((await send(bob, "PATCH", `/api/studies/${study.id}`, { status: "archived" })).statusCode).toBe(403);
    expect((await send(bob, "PATCH", `/api/studies/${study.id}`, { status: "paused" })).statusCode).toBe(200);
    const archived = json(await send(alice, "PATCH", `/api/studies/${study.id}`, { status: "archived" }));
    expect(archived.study.status).toBe("archived");
    expect(archived.study.archived_at).toBeTruthy();
    expect(json(await send(alice, "PATCH", `/api/studies/${study.id}`, { status: "active" })).study.archived_at).toBeNull();
    expect((await get(alice, "/api/studies/no-such-study")).statusCode).toBe(404);
  });

  it("renames a study (members only), keeps the slug and records study_renamed", async () => {
    const created = json(await send(alice, "POST", "/api/studies", { title: "Rename me", members: [{ userId: bob.id, role: "member" }, { userId: prof.id, role: "advisor" }] }));
    const id = created.study.id;
    const slugBefore = created.study.slug;
    for (const who of [carol, prof]) expect((await send(who, "PATCH", `/api/studies/${id}`, { title: "Hijacked" })).statusCode).toBe(403);
    expect((await send(bob, "PATCH", `/api/studies/${id}`, { title: "   " })).statusCode).toBe(400);
    expect((await send(bob, "PATCH", `/api/studies/${id}`, { title: "x".repeat(201) })).statusCode).toBe(400);
    const renamed = json(await send(bob, "PATCH", `/api/studies/${id}`, { title: "  Renamed study  ", summary_format: "prose" }));
    expect(renamed.study).toMatchObject({ title: "Renamed study", slug: slugBefore });
    expect(json(await get(carol, `/api/studies/${slugBefore}`)).study.title).toBe("Renamed study");
    // Same title again: no new timeline entry.
    await send(bob, "PATCH", `/api/studies/${id}`, { title: "Renamed study" });
    const rows = (await t.db.query("SELECT actor_id,title,url,metadata FROM study_activity WHERE study_id=$1 AND kind='study_renamed'", [id])).rows;
    expect(rows).toEqual([{ actor_id: bob.id, title: "Renamed study", url: `/studies/${slugBefore}`, metadata: { from: "Rename me" } }]);
    expect((await send(alice, "DELETE", `/api/studies/${id}`)).statusCode).toBe(200);
  });

  it("manages members: advisors must be professors, transfer, leave", async () => {
    const url = `/api/studies/${study.id}/members`;
    expect((await send(bob, "POST", url, { userId: carol.id, role: "member" })).statusCode).toBe(403);
    expect((await send(alice, "POST", url, { userId: carol.id, role: "advisor" })).statusCode).toBe(400);
    expect((await send(alice, "POST", url, { userId: bob.id, role: "member" })).statusCode).toBe(409);
    expect((await send(alice, "POST", url, { userId: carol.id, role: "member" })).statusCode).toBe(201);
    const notice = await t.db.query("SELECT kind,title FROM notifications WHERE user_id=$1", [carol.id]);
    expect(notice.rows).toContainEqual({ kind: "study", title: "Alice 將你加入研究" });
    expect((await send(alice, "PATCH", `${url}/${carol.id}`, { role: "advisor" })).statusCode).toBe(400);
    expect((await send(alice, "PATCH", `${url}/${alice.id}`, { role: "member" })).statusCode).toBe(400);
    expect((await send(alice, "DELETE", `${url}/${alice.id}`)).statusCode).toBe(400);
    // Carol leaves on her own.
    expect((await send(carol, "DELETE", `${url}/${carol.id}`)).statusCode).toBe(200);
    expect((await send(carol, "DELETE", `${url}/${bob.id}`)).statusCode).toBe(403);
    // Admin accounts cannot be added; the owner adds Carol back; transfer to an advisor is refused, to a member works.
    expect((await send(alice, "POST", url, { userId: admin.id, role: "member" })).statusCode).toBe(400);
    expect((await send(admin, "POST", url, { userId: carol.id, role: "member" })).statusCode).toBe(403);
    expect((await send(alice, "POST", url, { userId: carol.id, role: "member" })).statusCode).toBe(201);
    expect((await send(alice, "POST", `/api/studies/${study.id}/transfer`, { userId: prof.id })).statusCode).toBe(400);
    const transferred = json(await send(alice, "POST", `/api/studies/${study.id}/transfer`, { userId: bob.id }));
    expect(transferred.members.find((m: any) => m.id === bob.id).role).toBe("owner");
    expect(transferred.members.find((m: any) => m.id === alice.id).role).toBe("member");
    expect(json(await get(alice, `/api/studies/${study.id}`)).permissions).toMatchObject({ edit: true, manage: false, role: "member" });
    expect((await send(bob, "POST", `/api/studies/${study.id}/transfer`, { userId: alice.id })).statusCode).toBe(200);
    expect((await send(alice, "DELETE", `${url}/${carol.id}`)).statusCode).toBe(200);
  });

  it("refuses to turn an advisor's account into a student", async () => {
    expect((await send(owner, "PATCH", `/api/users/${prof.id}`, { role: "student" })).statusCode).toBe(409);
  });

  it("moves through stages: set current, complete, reorder, rename, add, delete", async () => {
    const base = `/api/studies/${study.id}/stages`;
    let stages = json(await get(carol, base)).stages as any[];
    const [idea, review, experiment] = stages;
    expect((await send(carol, "POST", `${base}/${review.id}/current`)).statusCode).toBe(403);
    let result = json(await send(bob, "POST", `${base}/${experiment.id}/current`));
    expect(result.current_stage_id).toBe(experiment.id);
    stages = result.stages;
    expect(stages[0].completed_at).toBeTruthy();
    expect(stages[1].completed_at).toBeTruthy();
    expect(stages[2]).toMatchObject({ is_current: true, completed_at: null });
    // Back to an earlier stage clears completion of later ones.
    result = json(await send(bob, "POST", `${base}/${review.id}/current`));
    expect(result.stages[1].completed_at).toBeNull();
    expect(result.stages[2].completed_at).toBeNull();
    expect(result.stages[0].completed_at).toBeTruthy();
    // Completing the current stage advances to the next one.
    result = json(await send(bob, "POST", `${base}/${review.id}/complete`, { completed: true }));
    expect(result.current_stage_id).toBe(experiment.id);
    expect(result.stages[1].completed_at).toBeTruthy();
    // Rename, add, reorder, delete.
    expect(json(await send(bob, "PATCH", `${base}/${idea.id}`, { name: "題目" })).stages[0].name).toBe("題目");
    const added = json(await send(bob, "POST", base, { name: "發表" }));
    expect(added.stages.at(-1)).toMatchObject({ name: "發表", position: 5 });
    const ids = (added.stages as any[]).map(s => s.id).reverse();
    expect(json(await send(bob, "PUT", `${base}/order`, { ids })).stages.map((s: any) => s.id)).toEqual(ids);
    expect((await send(bob, "PUT", `${base}/order`, { ids: ids.slice(1) })).statusCode).toBe(400);
    expect((await send(bob, "DELETE", `${base}/${experiment.id}`)).statusCode).toBe(409);
    const afterDelete = json(await send(bob, "DELETE", `${base}/${idea.id}`)).stages as any[];
    expect(afterDelete.map(s => s.position)).toEqual([0, 1, 2, 3, 4]);
    const activity = (await t.db.query("SELECT kind,title FROM study_activity WHERE study_id=$1 AND kind='stage_changed' ORDER BY id", [study.id])).rows;
    expect(activity.map(a => a.title)).toEqual(["實驗", "文獻探討", "實驗"]);
  });

  it("creates and completes milestones", async () => {
    const base = `/api/studies/${study.id}/milestones`;
    expect((await send(prof, "POST", base, { title: "nope" })).statusCode).toBe(403);
    expect((await send(bob, "POST", base, { title: "Bad", due_on: "2026-02-30" })).statusCode).toBe(400);
    const late = json(await send(bob, "POST", base, { title: "口試", due_on: "2027-06-30" })).milestone;
    const soon = json(await send(bob, "POST", base, { title: "投稿 ICASSP", due_on: "2026-10-30" })).milestone;
    expect(soon).toMatchObject({ title: "投稿 ICASSP", due_on: "2026-10-30", done_at: null });
    const done = json(await send(alice, "PATCH", `${base}/${soon.id}`, { done: true })).milestone;
    expect(done.done_at).toBeTruthy();
    const list = json(await get(carol, base)).milestones as any[];
    expect(list.map(m => m.id)).toEqual([late.id, soon.id]);
    expect(json(await send(alice, "PATCH", `${base}/${late.id}`, { due_on: null })).milestone.due_on).toBeNull();
    const kinds = (await t.db.query("SELECT kind,title FROM study_activity WHERE study_id=$1", [study.id])).rows;
    expect(kinds).toContainEqual({ kind: "milestone_done", title: "投稿 ICASSP" });
  });

  let taskId: string;

  it("manages tasks: assignees must be members, done records activity, assignment notifies", async () => {
    const base = `/api/studies/${study.id}/tasks`;
    expect((await send(carol, "POST", base, { title: "nope" })).statusCode).toBe(403);
    expect((await send(alice, "POST", base, { title: "Read paper", assignee_id: carol.id })).statusCode).toBe(400);
    const created = await send(alice, "POST", base, { title: "Read paper", assignee_id: bob.id, due_on: "2026-10-25", detail_md: "**HuBERT**" });
    expect(created.statusCode).toBe(201);
    const task = json(created).task;
    taskId = task.id;
    expect(task).toMatchObject({ title: "Read paper", assignee: { id: bob.id, name: "Bob" }, due_on: "2026-10-25", status: "open", source: "manual", creator_name: "Alice" });
    const notice = (await t.db.query("SELECT kind,title,url FROM notifications WHERE user_id=$1 AND kind='task'", [bob.id])).rows;
    expect(notice).toEqual([{ kind: "task", title: "Alice 指派了待辦給你", url: `/studies/${study.slug}?tab=tasks` }]);
    await send(alice, "POST", base, { title: "Unassigned" });
    await send(bob, "POST", base, { title: "Mine too", assignee_id: bob.id });

    expect(json(await get(carol, `${base}?assignee=none`)).tasks.map((x: any) => x.title)).toEqual(["Unassigned"]);
    expect(json(await get(bob, `${base}?assignee=me`)).tasks).toHaveLength(2);
    expect((await get(bob, `${base}?assignee=bad`)).statusCode).toBe(400);

    const patched = json(await send(bob, "PATCH", `${base}/${taskId}`, { status: "done" })).task;
    expect(patched.status).toBe("done");
    expect(patched.completed_at).toBeTruthy();
    expect(json(await send(bob, "PATCH", `${base}/${taskId}`, { status: "open" })).task.completed_at).toBeNull();
    await send(bob, "PATCH", `${base}/${taskId}`, { status: "done" });
    expect(json(await get(bob, `${base}?status=open`)).tasks.map((x: any) => x.title).sort()).toEqual(["Mine too", "Unassigned"]);
    expect((await send(prof, "DELETE", `${base}/${taskId}`)).statusCode).toBe(403);
    const activity = (await t.db.query("SELECT kind,title FROM study_activity WHERE study_id=$1 AND kind='task_done'", [study.id])).rows;
    expect(activity).toHaveLength(2);
  });

  it("lists my tasks across studies, soonest first", async () => {
    const other = json(await send(bob, "POST", "/api/studies", { title: "Bob's side project" })).study;
    await send(bob, "POST", `/api/studies/${other.id}/tasks`, { title: "Urgent", assignee_id: bob.id, due_on: "2026-10-22" });
    const mine = json(await get(bob, "/api/tasks")).tasks as any[];
    expect(mine.map(x => x.title)).toEqual(["Urgent", "Mine too"]);
    expect(mine[0].study).toEqual({ id: other.id, slug: other.slug, title: "Bob's side project" });
    expect(json(await get(bob, `/api/tasks?study=${study.slug}`)).tasks.map((x: any) => x.title)).toEqual(["Mine too"]);
    expect(json(await get(bob, "/api/tasks?status=done")).tasks.map((x: any) => x.title)).toEqual(["Read paper"]);
    expect(json(await get(carol, "/api/tasks")).tasks).toEqual([]);
  });

  it("lists studies with filters, stage, next milestone and open task counts", async () => {
    const all = json(await get(carol, "/api/studies")).studies as any[];
    const card = all.find(s => s.id === study.id);
    expect(card).toMatchObject({
      title: "語音情緒辨識", status: "active", current_stage: { name: "實驗" }, stage_count: 5, open_task_count: 2,
      next_milestone: { title: "口試", due_on: null }, my_role: null,
    });
    expect(card.summary_excerpt).toBe("Bob was here");
    expect(card.members.map((m: any) => m.name)).toEqual(["Alice", "Bob", "Prof Wang"]);
    expect(json(await get(carol, `/api/studies?member=${prof.id}`)).studies.map((s: any) => s.id)).toEqual([study.id]);
    expect(json(await get(bob, "/api/studies?member=me")).studies).toHaveLength(2);
    expect(json(await get(carol, "/api/studies?member=me")).studies).toEqual([]);
    // Scope switch: counts for both scopes share the other filters.
    const labView = json(await get(alice, "/api/studies"));
    expect(labView.counts).toEqual({ mine: 1, lab: 2 });
    expect(labView.studies).toHaveLength(2);
    const mineView = json(await get(alice, "/api/studies?scope=mine"));
    expect(mineView.counts).toEqual({ mine: 1, lab: 2 });
    expect(mineView.studies.map((s: any) => s.id)).toEqual([study.id]);
    expect(mineView.studies[0].my_role).toBe("owner");
    expect(json(await get(carol, "/api/studies?scope=mine")).counts).toEqual({ mine: 0, lab: 2 });
    expect(json(await get(alice, "/api/studies?scope=lab&q=side")).counts).toEqual({ mine: 0, lab: 1 });
    expect((await get(alice, "/api/studies?scope=bogus")).statusCode).toBe(400);
    expect(json(await get(carol, `/api/studies?stage=${encodeURIComponent("實驗")}`)).studies.map((s: any) => s.id)).toEqual([study.id]);
    expect(json(await get(carol, "/api/studies?q=side")).studies.map((s: any) => s.title)).toEqual(["Bob's side project"]);
    expect(json(await get(carol, "/api/studies?q=%25")).studies).toEqual([]);
    expect(json(await get(carol, "/api/studies?status=paused")).studies).toEqual([]);
    expect((await get(carol, "/api/studies?status=bogus")).statusCode).toBe(400);
  });

  it("builds the dashboard from my studies, tasks and lab activity", async () => {
    const body = json(await get(bob, "/api/dashboard"));
    expect(body.myStudies.map((s: any) => s.title).sort()).toEqual(["Bob's side project", "語音情緒辨識"]);
    expect(body.myTasks.map((x: any) => x.title)).toEqual(["Urgent", "Mine too"]);
    expect(body.counts).toMatchObject({ myStudies: 2, labStudies: 2, openTasks: 2 });
    expect(typeof body.counts.overdueTasks).toBe("number");
    const kinds = new Set((body.activity as any[]).map(a => a.kind));
    for (const kind of ["study_created", "stage_changed", "milestone_done", "task_done"]) expect(kinds.has(kind)).toBe(true);
    const created = (body.activity as any[]).find(a => a.kind === "study_created" && a.study.id === study.id);
    expect(created).toMatchObject({ actor: { id: alice.id, name: "Alice" }, title: "語音情緒辨識", url: `/studies/${study.slug}` });
    const empty = json(await get(carol, "/api/dashboard"));
    expect(empty.myStudies).toEqual([]);
    expect(empty.myTasks).toEqual([]);
    expect(empty.activity.length).toBeGreaterThan(0); // lab-wide
    expect((await get(null, "/api/dashboard")).statusCode).toBe(401);
  });

  it("deletes a study (study owner only) with everything in it", async () => {
    const doomed = json(await send(carol, "POST", "/api/studies", { title: "Doomed" })).study;
    await send(carol, "POST", `/api/studies/${doomed.id}/tasks`, { title: "t" });
    expect((await send(bob, "DELETE", `/api/studies/${doomed.id}`)).statusCode).toBe(403);
    expect((await send(admin, "DELETE", `/api/studies/${doomed.id}`)).statusCode).toBe(403);
    expect((await send(carol, "DELETE", `/api/studies/${doomed.id}`)).statusCode).toBe(200);
    expect((await get(carol, `/api/studies/${doomed.id}`)).statusCode).toBe(404);
    expect((await t.db.query("SELECT 1 FROM tasks WHERE study_id=$1", [doomed.id])).rowCount).toBe(0);
  });
});
