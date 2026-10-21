import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createTestContext, hasTestDb, ORIGIN, OWNER_PASSWORD, type TestContext } from "./helpers.js";

const headers = (cookie?: string) => ({ origin: ORIGIN, ...(cookie ? { cookie } : {}) });
const sessionCookie = (response: { cookies: { name: string; value: string }[] }) => {
  const cookie = response.cookies.find(c => c.name === "hub_session");
  return cookie ? `hub_session=${cookie.value}` : undefined;
};

describe.skipIf(!hasTestDb)("identity", () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestContext();
  });
  afterAll(async () => {
    await t?.close();
  });

  const inject = (method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT", url: string, cookie?: string, payload?: object) =>
    t.app.inject({ method, url, headers: headers(cookie), ...(payload ? { payload } : {}) });

  describe("csrf", () => {
    it("rejects writes without a matching Origin", async () => {
      const { id } = await t.ownerCookie();
      const missing = await t.app.inject({ method: "POST", url: "/api/auth/login", payload: { userId: id, password: OWNER_PASSWORD } });
      expect(missing.statusCode).toBe(403);
      const foreign = await t.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: "http://evil.test" }, payload: { userId: id, password: OWNER_PASSWORD } });
      expect(foreign.statusCode).toBe(403);
    });
  });

  describe("login", () => {
    it("logs in by id and by username (case-insensitive), and /auth/me reflects the session", async () => {
      const { id } = await t.ownerCookie();
      const byId = await inject("POST", "/api/auth/login", undefined, { userId: id, password: OWNER_PASSWORD });
      expect(byId.statusCode).toBe(200);
      expect(byId.json().account).toEqual({ id, name: "系統管理員", username: "owner" });
      const cookie = sessionCookie(byId)!;
      const me = await inject("GET", "/api/auth/me", cookie);
      expect(me.json().user).toMatchObject({ id, name: "系統管理員", username: "owner", role: "admin", is_admin: true, is_owner: true });
      const byUsername = await inject("POST", "/api/auth/login", undefined, { username: " OWNER ", password: OWNER_PASSWORD });
      expect(byUsername.statusCode).toBe(200);
      // `name` is a legacy alias of `username`; the real name is not a login id.
      expect((await inject("POST", "/api/auth/login", undefined, { name: "owner", password: OWNER_PASSWORD })).statusCode).toBe(200);
      expect((await inject("POST", "/api/auth/login", undefined, { username: "系統管理員", password: OWNER_PASSWORD })).statusCode).toBe(401);
    });

    it("rejects wrong passwords and disabled users", async () => {
      const { id } = await t.ownerCookie();
      expect((await inject("POST", "/api/auth/login", undefined, { userId: id, password: "wrong" })).statusCode).toBe(401);
      const member = await t.login("student");
      await t.db.query("UPDATE users SET disabled_at=now() WHERE id=$1", [member.id]);
      expect((await inject("POST", "/api/auth/login", undefined, { userId: member.id, password: OWNER_PASSWORD })).statusCode).toBe(401);
      expect((await inject("GET", "/api/auth/me", member.cookie)).json().user).toBeNull();
    });

    it("returns 403 for two_factor accounts", async () => {
      const member = await t.login("student");
      await t.db.query("UPDATE users SET auth_mode='two_factor' WHERE id=$1", [member.id]);
      const response = await inject("POST", "/api/auth/login", undefined, { userId: member.id, password: OWNER_PASSWORD });
      expect(response.statusCode).toBe(403);
    });

    it("rejects malformed input", async () => {
      expect((await inject("POST", "/api/auth/login", undefined, { password: "x" })).statusCode).toBe(400);
    });

    it("returns names for account hints", async () => {
      const member = await t.login("student", "hint-user");
      const response = await inject("GET", `/api/auth/accounts?ids=${member.id}`);
      expect(response.json().accounts).toEqual([{ id: member.id, name: "hint-user", username: "hint-user" }]);
      expect((await inject("GET", "/api/auth/accounts?ids=not-a-uuid")).statusCode).toBe(400);
    });
  });

  describe("logout and sessions", () => {
    it("logout invalidates the session", async () => {
      const member = await t.login("student");
      expect((await inject("POST", "/api/auth/logout", member.cookie)).statusCode).toBe(200);
      expect((await inject("GET", "/api/auth/me", member.cookie)).json().user).toBeNull();
      expect((await inject("GET", "/api/notifications", member.cookie)).statusCode).toBe(401);
    });

    it("lists and revokes own sessions", async () => {
      const member = await t.login("student");
      const second = sessionCookie(await inject("POST", "/api/auth/login", undefined, { userId: member.id, password: OWNER_PASSWORD }))!;
      const list = (await inject("GET", "/api/auth/sessions", member.cookie)).json().sessions as { id: string; current: boolean }[];
      expect(list).toHaveLength(2);
      const other = list.find(s => !s.current)!;
      expect((await inject("DELETE", `/api/auth/sessions/${other.id}`, member.cookie)).statusCode).toBe(200);
      expect((await inject("GET", "/api/auth/me", second)).json().user).toBeNull();
      const otherUser = await t.login("student");
      const mine = list.find(s => s.current)!;
      expect((await inject("DELETE", `/api/auth/sessions/${mine.id}`, otherUser.cookie)).statusCode).toBe(404);
    });
  });

  describe("profile", () => {
    it("changes the real name and theme, never the username", async () => {
      const member = await t.login("student", "before-rename");
      const response = await inject("PATCH", "/api/auth/profile", member.cookie, { realName: "  林 雅婷  ", theme: "dark", username: "hijack" });
      expect(response.statusCode).toBe(200);
      expect(response.json().user).toMatchObject({ name: "林 雅婷", username: "before-rename", theme: "dark" });
      // Legacy `name` field still sets the real name.
      expect((await inject("PATCH", "/api/auth/profile", member.cookie, { name: "Renamed" })).json().user).toMatchObject({ name: "Renamed", username: "before-rename" });
    });

    it("password change needs the current password and revokes other sessions", async () => {
      const member = await t.login("student");
      const other = sessionCookie(await inject("POST", "/api/auth/login", undefined, { userId: member.id, password: OWNER_PASSWORD }))!;
      expect((await inject("PATCH", "/api/auth/profile", member.cookie, { newPassword: "new-password-1" })).statusCode).toBe(400);
      expect((await inject("PATCH", "/api/auth/profile", member.cookie, { currentPassword: "wrong", newPassword: "new-password-1" })).statusCode).toBe(403);
      expect((await inject("PATCH", "/api/auth/profile", member.cookie, { currentPassword: OWNER_PASSWORD, newPassword: "new-password-1" })).statusCode).toBe(200);
      expect((await inject("GET", "/api/auth/me", member.cookie)).json().user).not.toBeNull();
      expect((await inject("GET", "/api/auth/me", other)).json().user).toBeNull();
      expect((await inject("POST", "/api/auth/login", undefined, { userId: member.id, password: "new-password-1" })).statusCode).toBe(200);
    });

    it("password change rejects passwords shorter than 8 characters (zh message)", async () => {
      const member = await t.login("student");
      for (const newPassword of ["short7!", "   abc     "]) {
        const r = await inject("PATCH", "/api/auth/profile", member.cookie, { currentPassword: OWNER_PASSWORD, newPassword });
        expect(r.statusCode).toBe(400);
        expect(r.json().error).toBe("密碼至少需要 8 個字元。");
      }
      expect((await inject("POST", "/api/auth/login", undefined, { userId: member.id, password: OWNER_PASSWORD })).statusCode).toBe(200);
    });

    it("allows repeated real names but validates their length (zh message)", async () => {
      await t.login("student", "same-real-name");
      const member = await t.login("student");
      expect((await inject("PATCH", "/api/auth/profile", member.cookie, { realName: "same-real-name" })).statusCode).toBe(200);
      for (const realName of ["   ", "字".repeat(41)]) {
        const r = await inject("PATCH", "/api/auth/profile", member.cookie, { realName });
        expect(r.statusCode).toBe(400);
        expect(r.json().error).toBe("真實姓名需為 1–40 個字元。");
      }
    });
  });

  describe("invitations and join", () => {
    const create = async (cookie: string, body: object) => inject("POST", "/api/invitations", cookie, body);
    const join = (token: string, username: string, realName = `真實 ${username}`) =>
      inject("POST", "/api/join", undefined, { token, username, realName, password: "joiner-password", passwordConfirm: "joiner-password" });

    it("is admin-only", async () => {
      const student = await t.login("student");
      const professor = await t.login("professor");
      expect((await create(student.cookie, { role: "student", expiresIn: "1d", maxUses: 1 })).statusCode).toBe(403);
      expect((await inject("GET", "/api/invitations", professor.cookie)).statusCode).toBe(403);
      const admin = await t.login("admin");
      expect((await create(admin.cookie, { role: "student", expiresIn: "1d", maxUses: 1 })).statusCode).toBe(201);
      expect((await inject("GET", "/api/invitations", admin.cookie)).statusCode).toBe(200);
    });

    it("creates admin accounts only through the admin role (never a student or professor with admin rights)", async () => {
      const owner = await t.ownerCookie();
      expect((await create(owner.cookie, { role: "professor", isAdmin: true, expiresIn: "1d", maxUses: 1 })).statusCode).toBe(400);
      const created = (await create(owner.cookie, { role: "admin", expiresIn: "1d", maxUses: 1 })).json();
      expect(created.invitation).toMatchObject({ role: "admin", is_admin: true });
      expect((await inject("GET", `/api/join/${created.token}`)).json()).toMatchObject({ role: "admin", isAdmin: true });
      const joined = await join(created.token, "second-admin");
      const cookie = sessionCookie(joined)!;
      expect((await inject("GET", "/api/auth/me", cookie)).json().user).toMatchObject({ role: "admin", is_admin: true, is_owner: false });
      // The new admin manages the system but is refused in the research workspace.
      expect((await inject("GET", "/api/users", cookie)).statusCode).toBe(200);
      expect((await inject("GET", "/api/studies", cookie)).statusCode).toBe(403);
      const student = (await create(owner.cookie, { role: "student", isAdmin: false, expiresIn: "1d", maxUses: 1 })).json();
      expect(student.invitation).toMatchObject({ role: "student", is_admin: false });
    });

    it("creates, validates and consumes a single-use invitation", async () => {
      const owner = await t.ownerCookie();
      const created = await create(owner.cookie, { role: "professor", expiresIn: "1d", maxUses: 1 });
      expect(created.statusCode).toBe(201);
      const { token, url, invitation } = created.json();
      expect(url).toBe(`${ORIGIN}/join/${encodeURIComponent(token)}`);
      expect(invitation.state).toBe("active");
      expect((await inject("GET", `/api/join/${token}`)).json().role).toBe("professor");

      const first = await join(token, "prof-a");
      expect(first.statusCode).toBe(201);
      const cookie = sessionCookie(first)!;
      expect((await inject("GET", "/api/auth/me", cookie)).json().user).toMatchObject({ name: "真實 prof-a", username: "prof-a", role: "professor" });

      expect((await join(token, "prof-b")).statusCode).toBe(410);
      expect((await inject("GET", `/api/join/${token}`)).statusCode).toBe(404);
      const list = (await inject("GET", "/api/invitations", owner.cookie)).json().invitations as { id: string; state: string; uses: unknown[] }[];
      const row = list.find(i => i.id === invitation.id)!;
      expect(row.state).toBe("exhausted");
      expect(row.uses).toHaveLength(1);
    });

    it("join rejects passwords shorter than 8 characters (zh message) without using the invitation", async () => {
      const owner = await t.ownerCookie();
      const { token, invitation } = (await create(owner.cookie, { role: "student", expiresIn: "1d", maxUses: 1 })).json();
      const r = await inject("POST", "/api/join", undefined, { token, username: "short-pass", realName: "短密碼", password: "1234567" });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe("密碼至少需要 8 個字元。");
      const list = (await inject("GET", "/api/invitations", owner.cookie)).json().invitations as { id: string; state: string }[];
      expect(list.find(i => i.id === invitation.id)!.state).toBe("active");
      expect((await join(token, "long-pass")).statusCode).toBe(201);
    });

    it("a used-up invitation stays 'exhausted' after it would have expired", async () => {
      const owner = await t.ownerCookie();
      const { token, invitation } = (await create(owner.cookie, { role: "student", expiresIn: "5m", maxUses: 1 })).json();
      expect((await join(token, "used-then-expired")).statusCode).toBe(201);
      await t.db.query("UPDATE invitations SET expires_at=now()-interval '1 minute' WHERE id=$1", [invitation.id]);
      const list = (await inject("GET", "/api/invitations", owner.cookie)).json().invitations as { id: string; state: string }[];
      expect(list.find(i => i.id === invitation.id)!.state).toBe("exhausted");
    });

    it("allows unlimited invitations to be used repeatedly", async () => {
      const owner = await t.ownerCookie();
      const { token } = (await create(owner.cookie, { role: "student", expiresIn: "never", maxUses: null })).json();
      expect((await join(token, "multi-1")).statusCode).toBe(201);
      expect((await join(token, "multi-2")).statusCode).toBe(201);
      expect((await join(token, "multi-1")).statusCode).toBe(409);
    });

    it("rejects expired and revoked invitations", async () => {
      const owner = await t.ownerCookie();
      const expired = (await create(owner.cookie, { role: "student", expiresIn: "5m", maxUses: null })).json();
      await t.db.query("UPDATE invitations SET expires_at=now()-interval '1 minute' WHERE id=$1", [expired.invitation.id]);
      expect((await join(expired.token, "late-user")).statusCode).toBe(410);

      const revoked = (await create(owner.cookie, { role: "student", expiresIn: "1h", maxUses: null })).json();
      expect((await inject("DELETE", `/api/invitations/${revoked.invitation.id}`, owner.cookie)).statusCode).toBe(200);
      expect((await join(revoked.token, "revoked-user")).statusCode).toBe(410);
      const states = (await inject("GET", "/api/invitations", owner.cookie)).json().invitations as { id: string; state: string }[];
      expect(states.find(i => i.id === expired.invitation.id)!.state).toBe("expired");
      expect(states.find(i => i.id === revoked.invitation.id)!.state).toBe("revoked");
    });

    it("consumes a single-use invitation only once under concurrency", async () => {
      const owner = await t.ownerCookie();
      const { token } = (await create(owner.cookie, { role: "student", expiresIn: "1h", maxUses: 1 })).json();
      const results = await Promise.all(Array.from({ length: 5 }, (_, i) => join(token, `race-${i}`)));
      expect(results.filter(r => r.statusCode === 201)).toHaveLength(1);
      expect(results.filter(r => r.statusCode === 410)).toHaveLength(4);
    });

    it("rejects invalid settings", async () => {
      const owner = await t.ownerCookie();
      expect((await create(owner.cookie, { role: "owner", expiresIn: "1d", maxUses: 1 })).statusCode).toBe(400);
      expect((await create(owner.cookie, { role: "admin", isAdmin: false, expiresIn: "1d", maxUses: 1 })).statusCode).toBe(400);
      expect((await create(owner.cookie, { role: "student", expiresIn: "9d", maxUses: 1 })).statusCode).toBe(400);
      expect((await create(owner.cookie, { role: "student", expiresIn: "1d", maxUses: 2 })).statusCode).toBe(400);
    });
  });

  describe("admin accounts are system-only", () => {
    it("refuses admin sessions on research-workspace routes and allows the system ones", async () => {
      const admin = await t.ownerCookie();
      const workspace: [string, string][] = [
        ["GET", "/api/dashboard"], ["GET", "/api/studies"], ["POST", "/api/studies"], ["GET", "/api/tasks"],
        ["GET", "/api/meetings"], ["GET", "/api/library/papers"], ["GET", "/api/search?q=x"], ["GET", "/api/agent/conversations"],
        ["GET", "/api/memories"], ["GET", "/api/slides"], ["GET", "/api/suggestions/00000000-0000-0000-0000-000000000000"],
        ["GET", "/api/latex/projects"], ["GET", "/api/studies/x/notes"],
      ];
      for (const [method, url] of workspace) {
        const response = await inject(method as "GET", url, admin.cookie, method === "POST" ? { title: "x" } : undefined);
        expect(response.statusCode, `${method} ${url}`).toBe(403);
        expect(response.json(), url).toMatchObject({ error: "管理員帳號只能管理系統設定與使用者。" });
      }
      for (const url of ["/api/auth/me", "/api/users", "/api/invitations", "/api/admin/ai/providers", "/api/ai/status", "/api/library/settings", "/api/note-templates", "/api/notifications", "/api/config"]) {
        expect((await inject("GET", url, admin.cookie)).statusCode, url).toBe(200);
      }
      // Other accounts are unaffected.
      const student = await t.login("student");
      expect((await inject("GET", "/api/studies", student.cookie)).statusCode).toBe(200);
      expect((await inject("GET", "/api/admin/ai/providers", student.cookie)).statusCode).toBe(403);
    });
  });

  describe("users", () => {
    it("is admin-only, except the directory", async () => {
      const professor = await t.login("professor");
      const member = await t.login("student", "dir-student");
      expect((await inject("GET", "/api/users", professor.cookie)).statusCode).toBe(403);
      expect((await inject("PATCH", `/api/users/${member.id}`, professor.cookie, { is_admin: true })).statusCode).toBe(403);
      const directory = await inject("GET", "/api/users/directory", professor.cookie);
      expect(directory.statusCode).toBe(200);
      const entry = (directory.json().users as { id: string }[]).find(u => u.id === member.id);
      expect(entry).toEqual({ id: member.id, name: "dir-student", username: "dir-student", role: "student" });
      expect((await inject("GET", "/api/users/directory")).statusCode).toBe(401);
    });

    it("changes student/professor roles, never grants admin, and never touches the initial admin", async () => {
      const owner = await t.ownerCookie();
      const member = await t.login("student");
      const changed = await inject("PATCH", `/api/users/${member.id}`, owner.cookie, { role: "professor" });
      expect(changed.statusCode).toBe(200);
      expect(changed.json().user).toMatchObject({ role: "professor", is_admin: false, is_owner: false });
      expect((await inject("PATCH", `/api/users/${member.id}`, owner.cookie, { is_admin: true })).statusCode).toBe(400);
      expect((await inject("PATCH", `/api/users/${member.id}`, owner.cookie, { role: "admin" })).statusCode).toBe(400);
      // Another admin may manage accounts too (and be disabled), but not the initial admin.
      const admin = await t.login("admin");
      expect((await inject("PATCH", `/api/users/${member.id}`, admin.cookie, { role: "student" })).json().user.role).toBe("student");
      expect((await inject("PATCH", `/api/users/${admin.id}`, owner.cookie, { role: "student" })).statusCode).toBe(400);
      expect((await inject("PATCH", `/api/users/${owner.id}`, admin.cookie, { disabled: true })).statusCode).toBe(404);
      const other = await t.login("admin");
      expect((await inject("PATCH", `/api/users/${other.id}`, owner.cookie, { disabled: true })).json().user.disabled).toBe(true);
      // Admins never appear in the member/participant directory.
      const directory = (await inject("GET", "/api/users/directory", member.cookie)).json().users as { id: string; role: string }[];
      expect(directory.some(u => u.role === "admin")).toBe(false);
      expect(directory.some(u => u.id === member.id)).toBe(true);
      expect((await inject("PATCH", `/api/users/${owner.id}`, owner.cookie, { role: "professor" })).statusCode).toBe(400);
      expect((await inject("PATCH", `/api/users/${owner.id}`, owner.cookie, { disabled: true })).statusCode).toBe(400);
      expect((await inject("PATCH", `/api/users/${member.id}`, owner.cookie, { role: "owner" })).statusCode).toBe(400);
      const users = (await inject("GET", "/api/users", owner.cookie)).json().users as { is_owner: boolean }[];
      expect(users[0]!.is_owner).toBe(true);
    });

    it("disabling a user revokes their sessions; re-enabling allows login", async () => {
      const owner = await t.ownerCookie();
      const member = await t.login("student");
      expect((await inject("PATCH", `/api/users/${member.id}`, owner.cookie, { disabled: true })).statusCode).toBe(200);
      const sessions = await t.db.query("SELECT 1 FROM sessions WHERE user_id=$1", [member.id]);
      expect(sessions.rowCount).toBe(0);
      expect((await inject("GET", "/api/auth/me", member.cookie)).json().user).toBeNull();
      expect((await inject("PATCH", `/api/users/${member.id}`, owner.cookie, { disabled: false })).statusCode).toBe(200);
      expect((await inject("POST", "/api/auth/login", undefined, { userId: member.id, password: OWNER_PASSWORD })).statusCode).toBe(200);
    });
  });

  describe("notifications", () => {
    it("lists, counts unread, marks read and deletes", async () => {
      const member = await t.login("student");
      const other = await t.login("student");
      await t.app.notifier.notify([member.id, other.id], { kind: "system", title: "a", body: "b", url: "/" }, { pref: null });
      await t.app.notifier.notify([member.id], { kind: "media", title: "c", body: "d", url: "/items/x" }, { pref: "mediaTranscoded" });

      const list = (await inject("GET", "/api/notifications", member.cookie)).json().notifications as { id: string }[];
      expect(list).toHaveLength(2);
      expect((await inject("GET", "/api/notifications/unread", member.cookie)).json().count).toBe(2);

      expect((await inject("POST", "/api/notifications/read", member.cookie, { ids: [list[0]!.id] })).json().updated).toBe(1);
      expect((await inject("GET", "/api/notifications/unread", member.cookie)).json().count).toBe(1);
      await inject("POST", "/api/notifications/read", member.cookie, {});
      expect((await inject("GET", "/api/notifications/unread", member.cookie)).json().count).toBe(0);
      expect((await inject("GET", "/api/notifications/unread", other.cookie)).json().count).toBe(1);

      expect((await inject("DELETE", "/api/notifications", other.cookie, { id: list[0]!.id })).json().removed).toBe(0);
      expect((await inject("DELETE", "/api/notifications", member.cookie, { id: list[0]!.id })).json().removed).toBe(1);
      expect((await inject("DELETE", "/api/notifications", member.cookie, {})).json().removed).toBe(1);
      expect((await inject("GET", "/api/notifications", member.cookie)).json().notifications).toHaveLength(0);
    });

    it("requires a session", async () => {
      expect((await inject("GET", "/api/notifications/unread")).statusCode).toBe(401);
    });
  });

  describe("push", () => {
    it("manages subscriptions", async () => {
      const member = await t.login("student");
      expect((await inject("GET", "/api/push", member.cookie)).json()).toEqual({ enabled: false, publicKey: null, subscribed: false });
      const subscription = { endpoint: "https://push.example.com/abc", keys: { p256dh: "key", auth: "auth" } };
      expect((await inject("POST", "/api/push", member.cookie, { subscription: { ...subscription, endpoint: "http://insecure" } })).statusCode).toBe(400);
      expect((await inject("POST", "/api/push", member.cookie, { subscription })).statusCode).toBe(201);
      expect((await inject("GET", "/api/push", member.cookie)).json().subscribed).toBe(true);
      expect((await inject("POST", "/api/push/test", member.cookie)).statusCode).toBe(409); // VAPID not configured
      expect((await inject("DELETE", "/api/push", member.cookie, { endpoint: subscription.endpoint })).statusCode).toBe(200);
      expect((await inject("GET", "/api/push", member.cookie)).json().subscribed).toBe(false);
    });
  });
});

describe("initial admin configuration", () => {
  const base = { APP_ORIGIN: "http://hub.test", POSTGRES_PASSWORD: "x", AUTH_SECRET: "test-secret-test-secret-test-secret-1234", S3_ACCESS_KEY: "a", S3_SECRET_KEY: "b" };
  it("defaults the name to admin and reads ADMIN_PASSWORD", () => {
    const config = loadConfig({ ...base, ADMIN_PASSWORD: "admin-pass-1" });
    expect(config.ADMIN_NAME).toBe("admin");
    expect(config.ADMIN_PASSWORD).toBe("admin-pass-1");
  });
  it("falls back to the legacy OWNER_NAME / OWNER_PASSWORD", () => {
    const config = loadConfig({ ...base, OWNER_NAME: "Boss", OWNER_PASSWORD: "owner-pass-1" });
    expect(config).toMatchObject({ ADMIN_NAME: "Boss", ADMIN_PASSWORD: "owner-pass-1" });
    expect(loadConfig({ ...base, ADMIN_PASSWORD: "new-pass-12", OWNER_PASSWORD: "old-pass-12" }).ADMIN_PASSWORD).toBe("new-pass-12");
    expect(() => loadConfig({ ...base })).toThrow(/ADMIN_PASSWORD/);
  });
});
