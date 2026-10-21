import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LightMyRequestResponse } from "fastify";
import { createTestContext, hasTestDb, hasTestS3, ORIGIN, type TestContext } from "./helpers.js";
import { addStudyMember, insertStudy } from "./study-fixtures.js";

/** CRUD gap fixes: admin password reset links, own slide review/reply edit + delete, deck delete cascade. */
describe.skipIf(!hasTestDb)("crud gaps", () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestContext();
  });
  afterAll(async () => {
    await t?.close();
  });

  const json = (response: LightMyRequestResponse) => response.json() as Record<string, any>;
  const req = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, cookie?: string, payload?: object) =>
    t.app.inject({ method, url, headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) }, ...(payload ? { payload } : {}) });
  const sessionCookie = (response: LightMyRequestResponse) => {
    const cookie = response.cookies.find(c => c.name === "hub_session");
    return cookie ? `hub_session=${cookie.value}` : undefined;
  };

  describe("admin password reset links", () => {
    it("only admins issue links, never for themselves, the initial admin or disabled accounts", async () => {
      const admin = await t.login("admin");
      const owner = await t.ownerCookie();
      const student = await t.login("student");
      const other = await t.login("professor");
      expect((await req("POST", `/api/users/${other.id}/password-reset`, student.cookie, {})).statusCode).toBe(403);
      expect((await req("POST", `/api/users/${admin.id}/password-reset`, admin.cookie, {})).statusCode).toBe(400);
      expect((await req("POST", `/api/users/${owner.id}/password-reset`, admin.cookie, {})).statusCode).toBe(400);
      expect((await req("POST", "/api/users/00000000-0000-4000-8000-000000000000/password-reset", admin.cookie, {})).statusCode).toBe(404);
      expect((await req("POST", `/api/users/${other.id}/password-reset`, admin.cookie, { expiresIn: "9y" })).statusCode).toBe(400);
      await t.db.query("UPDATE users SET disabled_at=now() WHERE id=$1", [other.id]);
      expect((await req("POST", `/api/users/${other.id}/password-reset`, admin.cookie, {})).statusCode).toBe(409);
    });

    it("issues a single-use link that sets the password, ends sessions, signs in and is audited", async () => {
      const admin = await t.login("admin");
      const user = await t.login("student", "resetme");
      const issued = await req("POST", `/api/users/${user.id}/password-reset`, admin.cookie, { expiresIn: "1h" });
      expect(issued.statusCode).toBe(201);
      const body = json(issued);
      expect(body.url).toBe(`${ORIGIN}/reset/${encodeURIComponent(body.token)}`);
      expect(body.reset.revoked_sessions).toBe(1);
      // Sessions revoked when the link is issued (revokeSessions defaults to true).
      expect(json(await req("GET", "/api/auth/me", user.cookie)).user).toBeNull();
      // The stored row has only the hash.
      expect((await t.db.query("SELECT 1 FROM password_resets WHERE token_hash=$1", [body.token])).rowCount).toBe(0);

      const info = await req("GET", `/api/password-reset/${encodeURIComponent(body.token)}`);
      expect(info.statusCode).toBe(200);
      expect(json(info).account).toEqual({ name: "resetme", username: "resetme" });

      expect((await req("POST", "/api/password-reset", undefined, { token: body.token, password: "short" })).statusCode).toBe(400);
      expect((await req("POST", "/api/password-reset", undefined, { token: body.token, password: "new-password-1", passwordConfirm: "other-pass-1" })).statusCode).toBe(400);
      const used = await req("POST", "/api/password-reset", undefined, { token: body.token, password: "new-password-1", passwordConfirm: "new-password-1" });
      expect(used.statusCode).toBe(200);
      expect(json(used)).toMatchObject({ signedIn: true, account: { id: user.id, username: "resetme" } });
      const cookie = sessionCookie(used)!;
      expect(json(await req("GET", "/api/auth/me", cookie)).user.id).toBe(user.id);

      // Single use; the new password works, the old one does not.
      expect((await req("POST", "/api/password-reset", undefined, { token: body.token, password: "another-pass-1" })).statusCode).toBe(410);
      expect((await req("GET", `/api/password-reset/${encodeURIComponent(body.token)}`)).statusCode).toBe(404);
      expect((await req("POST", "/api/auth/login", undefined, { username: "resetme", password: "new-password-1" })).statusCode).toBe(200);
      expect((await req("POST", "/api/auth/login", undefined, { username: "resetme", password: "owner-password-123" })).statusCode).toBe(401);

      const actions = (await t.db.query<{ action: string; actor_id: string }>("SELECT action,actor_id FROM audit_log WHERE target_id=$1 AND action LIKE 'user_password_reset%' ORDER BY id", [user.id])).rows;
      expect(actions).toEqual([
        { action: "user_password_reset_issued", actor_id: admin.id },
        { action: "user_password_reset_used", actor_id: user.id },
      ]);
    });

    it("a newer link revokes the older one; revoke and expiry invalidate links", async () => {
      const admin = await t.login("admin");
      const user = await t.login("student");
      const first = json(await req("POST", `/api/users/${user.id}/password-reset`, admin.cookie, { revokeSessions: false }));
      expect(first.reset.revoked_sessions).toBe(0);
      expect(json(await req("GET", "/api/auth/me", user.cookie)).user.id).toBe(user.id);
      const second = json(await req("POST", `/api/users/${user.id}/password-reset`, admin.cookie, {}));
      expect((await req("GET", `/api/password-reset/${encodeURIComponent(first.token)}`)).statusCode).toBe(404);
      expect((await req("GET", `/api/password-reset/${encodeURIComponent(second.token)}`)).statusCode).toBe(200);
      expect(json(await req("DELETE", `/api/users/${user.id}/password-reset`, admin.cookie))).toEqual({ ok: true, revoked: 1 });
      expect((await req("POST", "/api/password-reset", undefined, { token: second.token, password: "new-password-1" })).statusCode).toBe(410);
      const third = json(await req("POST", `/api/users/${user.id}/password-reset`, admin.cookie, {}));
      await t.db.query("UPDATE password_resets SET expires_at=now()-interval '1 minute' WHERE user_id=$1 AND used_at IS NULL AND revoked_at IS NULL", [user.id]);
      expect((await req("POST", "/api/password-reset", undefined, { token: third.token, password: "new-password-1" })).statusCode).toBe(410);
    });

    it("a link of an account disabled afterwards no longer works", async () => {
      const admin = await t.login("admin");
      const user = await t.login("student");
      const issued = json(await req("POST", `/api/users/${user.id}/password-reset`, admin.cookie, {}));
      await t.db.query("UPDATE users SET disabled_at=now() WHERE id=$1", [user.id]);
      expect((await req("POST", "/api/password-reset", undefined, { token: issued.token, password: "new-password-1" })).statusCode).toBe(410);
    });
  });

  describe("own slide reviews and replies", () => {
    it("only the author edits or deletes a review or reply; deleting a review removes its replies", async () => {
      const student = await t.login("student");
      const other = await t.login("student");
      const prof = await t.login("professor");
      const prof2 = await t.login("professor");
      const study = await insertStudy(t.db, student.id, "Review study");
      await addStudyMember(t.db, study.id, other.id);
      const deck = json(await req("POST", "/api/slides", student.cookie, { studyId: study.id, title: "Deck R", source: "editor" }));
      const review = json(await req("POST", `/api/slides/${deck.id}/reviews`, prof.cookie, { body: "Good start" })).review;
      expect(review.edited_at).toBeNull();
      const reply = json(await req("POST", `/api/slides/${deck.id}/reviews/${review.id}/replies`, student.cookie, { body: "Thanks" })).reply;
      const base = `/api/slides/${deck.id}/reviews/${review.id}`;

      expect((await req("PATCH", base, prof2.cookie, { body: "x" })).statusCode).toBe(403);
      expect((await req("PATCH", base, student.cookie, { body: "x" })).statusCode).toBe(403);
      expect((await req("PATCH", base, prof.cookie, { body: "" })).statusCode).toBe(400);
      const edited = await req("PATCH", base, prof.cookie, { body: "Good start, fix slide 3" });
      expect(edited.statusCode).toBe(200);
      expect(json(edited).review).toMatchObject({ body: "Good start, fix slide 3" });
      expect(json(edited).review.edited_at).toBeTruthy();

      expect((await req("PATCH", `${base}/replies/${reply.id}`, prof.cookie, { body: "x" })).statusCode).toBe(403);
      expect((await req("PATCH", `${base}/replies/${reply.id}`, other.cookie, { body: "x" })).statusCode).toBe(403);
      expect(json(await req("PATCH", `${base}/replies/${reply.id}`, student.cookie, { body: "Thanks, done" })).reply.body).toBe("Thanks, done");
      const detail = json(await req("GET", `/api/slides/${deck.id}`, other.cookie));
      expect(detail.reviews[0]).toMatchObject({ body: "Good start, fix slide 3", replies: [{ body: "Thanks, done" }] });
      expect(detail.reviews[0].edited_at).toBeTruthy();
      expect(detail.reviews[0].replies[0].edited_at).toBeTruthy();

      // A reply id under another review is not found.
      const review2 = json(await req("POST", `/api/slides/${deck.id}/reviews`, prof.cookie, { body: "Second" })).review;
      expect((await req("DELETE", `/api/slides/${deck.id}/reviews/${review2.id}/replies/${reply.id}`, student.cookie)).statusCode).toBe(404);
      expect((await req("DELETE", `${base}/replies/${reply.id}`, prof.cookie)).statusCode).toBe(403);
      expect((await req("DELETE", `${base}/replies/${reply.id}`, student.cookie)).statusCode).toBe(200);

      const reply2 = json(await req("POST", `/api/slides/${deck.id}/reviews/${review.id}/replies`, other.cookie, { body: "Me too" })).reply;
      expect((await req("DELETE", base, student.cookie)).statusCode).toBe(403);
      expect((await req("DELETE", base, prof.cookie)).statusCode).toBe(200);
      expect((await t.db.query("SELECT 1 FROM slide_review_replies WHERE id=$1", [reply2.id])).rowCount).toBe(0);
      expect((await req("DELETE", base, prof.cookie)).statusCode).toBe(404);
      expect(json(await req("GET", `/api/slides/${deck.id}`, other.cookie)).reviews.map((r: any) => r.id)).toEqual([review2.id]);
    });
  });

  describe.skipIf(!hasTestS3)("deck delete cascade", () => {
    it("cancels AI draft jobs, drops workflow artifacts and meeting links, removes suggestions, records activity", async () => {
      const student = await t.login("student");
      const prof = await t.login("professor");
      const study = await insertStudy(t.db, student.id, "Cascade study");
      await addStudyMember(t.db, study.id, prof.id, "advisor");
      const deck = json(await req("POST", "/api/slides", student.cookie, { studyId: study.id, title: "Doomed deck", source: "editor" }));
      const keep = json(await req("POST", "/api/slides", student.cookie, { studyId: study.id, title: "Kept deck", source: "editor" }));
      const job = (await t.db.query<{ id: string }>(
        "INSERT INTO jobs(kind,payload,created_by,status) VALUES('ai_slides_generate',$1,$2,'queued') RETURNING id",
        [JSON.stringify({ deckId: deck.id, userId: student.id, mode: "progress" }), student.id],
      )).rows[0]!.id;
      const otherJob = (await t.db.query<{ id: string }>(
        "INSERT INTO jobs(kind,payload,created_by,status) VALUES('ai_slides_generate',$1,$2,'queued') RETURNING id",
        [JSON.stringify({ deckId: keep.id, userId: student.id, mode: "progress" }), student.id],
      )).rows[0]!.id;
      const artifacts = [
        { kind: "deck", id: deck.id, url: "/x", title: "Doomed", role: "draft" },
        { kind: "deck", id: keep.id, url: "/y", title: "Kept", role: "draft" },
      ];
      const run = (await t.db.query<{ id: string }>(
        "INSERT INTO workflow_runs(user_id,study_id,playbook,request,status,artifacts) VALUES($1,$2,'slides','make a deck','done',$3) RETURNING id",
        [student.id, study.id, JSON.stringify(artifacts)],
      )).rows[0]!.id;
      const source = json(await req("GET", `/api/slides/${deck.id}/source`, student.cookie));
      const fileId = source.files[0].id as string;
      await t.db.query(
        "INSERT INTO suggestions(target_type,target_id,study_id,title,source,hunks,created_by) VALUES('deck_source',$1,$2,'s','user','[]',$3)",
        [fileId, study.id, student.id],
      );
      const meeting = json(await req("POST", "/api/meetings", student.cookie, { title: "Weekly", held_at: new Date().toISOString(), study_ids: [study.id] }));
      await t.db.query("INSERT INTO meeting_decks(meeting_id,deck_id) VALUES($1,$2)", [meeting.meeting.id, deck.id]);

      // Advisors (and outsiders) cannot delete; members can.
      expect((await req("DELETE", `/api/slides/${deck.id}`, prof.cookie)).statusCode).toBe(403);
      expect((await req("DELETE", `/api/slides/${deck.id}`, student.cookie)).statusCode).toBe(200);

      expect((await t.db.query("SELECT status FROM jobs WHERE id=$1", [job])).rows[0].status).toBe("cancelled");
      expect((await t.db.query("SELECT status FROM jobs WHERE id=$1", [otherJob])).rows[0].status).toBe("queued");
      expect((await t.db.query("SELECT artifacts FROM workflow_runs WHERE id=$1", [run])).rows[0].artifacts.map((a: any) => a.id)).toEqual([keep.id]);
      expect((await t.db.query("SELECT 1 FROM suggestions WHERE target_id=$1", [fileId])).rowCount).toBe(0);
      expect((await t.db.query("SELECT 1 FROM meeting_decks WHERE deck_id=$1", [deck.id])).rowCount).toBe(0);
      expect((await t.db.query("SELECT 1 FROM deck_sources WHERE id=$1", [fileId])).rowCount).toBe(0);
      const activity = (await t.db.query("SELECT kind,title,url,actor_id FROM study_activity WHERE study_id=$1 AND kind='deck_deleted'", [study.id])).rows;
      expect(activity).toEqual([{ kind: "deck_deleted", title: "Doomed deck", url: `/studies/${study.slug}?tab=decks`, actor_id: student.id }]);
      expect((await req("GET", `/api/slides/${keep.id}`, student.cookie)).statusCode).toBe(200);
    });
  });
});
