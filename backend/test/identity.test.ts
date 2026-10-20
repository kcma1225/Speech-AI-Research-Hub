import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
    it("logs in by id and by name, and /auth/me reflects the session", async () => {
      const { id } = await t.ownerCookie();
      const byId = await inject("POST", "/api/auth/login", undefined, { userId: id, password: OWNER_PASSWORD });
      expect(byId.statusCode).toBe(200);
      expect(byId.json().account).toEqual({ id, name: "Owner" });
      const cookie = sessionCookie(byId)!;
      const me = await inject("GET", "/api/auth/me", cookie);
      expect(me.json().user).toMatchObject({ id, role: "owner" });
      const byName = await inject("POST", "/api/auth/login", undefined, { name: "owner", password: OWNER_PASSWORD });
      expect(byName.statusCode).toBe(200);
    });

    it("rejects wrong passwords and disabled users", async () => {
      const { id } = await t.ownerCookie();
      expect((await inject("POST", "/api/auth/login", undefined, { userId: id, password: "wrong" })).statusCode).toBe(401);
      const member = await t.login("member");
      await t.db.query("UPDATE users SET disabled_at=now() WHERE id=$1", [member.id]);
      expect((await inject("POST", "/api/auth/login", undefined, { userId: member.id, password: OWNER_PASSWORD })).statusCode).toBe(401);
      expect((await inject("GET", "/api/auth/me", member.cookie)).json().user).toBeNull();
    });

    it("returns 403 for two_factor accounts", async () => {
      const member = await t.login("member");
      await t.db.query("UPDATE users SET auth_mode='two_factor' WHERE id=$1", [member.id]);
      const response = await inject("POST", "/api/auth/login", undefined, { userId: member.id, password: OWNER_PASSWORD });
      expect(response.statusCode).toBe(403);
    });

    it("rejects malformed input", async () => {
      expect((await inject("POST", "/api/auth/login", undefined, { password: "x" })).statusCode).toBe(400);
    });

    it("returns names for account hints", async () => {
      const member = await t.login("member", "hint-user");
      const response = await inject("GET", `/api/auth/accounts?ids=${member.id}`);
      expect(response.json().accounts).toEqual([{ id: member.id, name: "hint-user" }]);
      expect((await inject("GET", "/api/auth/accounts?ids=not-a-uuid")).statusCode).toBe(400);
    });
  });

  describe("logout and sessions", () => {
    it("logout invalidates the session", async () => {
      const member = await t.login("member");
      expect((await inject("POST", "/api/auth/logout", member.cookie)).statusCode).toBe(200);
      expect((await inject("GET", "/api/auth/me", member.cookie)).json().user).toBeNull();
      expect((await inject("GET", "/api/notifications", member.cookie)).statusCode).toBe(401);
    });

    it("lists and revokes own sessions", async () => {
      const member = await t.login("member");
      const second = sessionCookie(await inject("POST", "/api/auth/login", undefined, { userId: member.id, password: OWNER_PASSWORD }))!;
      const list = (await inject("GET", "/api/auth/sessions", member.cookie)).json().sessions as { id: string; current: boolean }[];
      expect(list).toHaveLength(2);
      const other = list.find(s => !s.current)!;
      expect((await inject("DELETE", `/api/auth/sessions/${other.id}`, member.cookie)).statusCode).toBe(200);
      expect((await inject("GET", "/api/auth/me", second)).json().user).toBeNull();
      const otherUser = await t.login("member");
      const mine = list.find(s => s.current)!;
      expect((await inject("DELETE", `/api/auth/sessions/${mine.id}`, otherUser.cookie)).statusCode).toBe(404);
    });
  });

  describe("profile", () => {
    it("changes name and theme", async () => {
      const member = await t.login("member");
      const response = await inject("PATCH", "/api/auth/profile", member.cookie, { name: "renamed-user", theme: "dark" });
      expect(response.statusCode).toBe(200);
      expect(response.json().user).toMatchObject({ name: "renamed-user", theme: "dark" });
    });

    it("password change needs the current password and revokes other sessions", async () => {
      const member = await t.login("member");
      const other = sessionCookie(await inject("POST", "/api/auth/login", undefined, { userId: member.id, password: OWNER_PASSWORD }))!;
      expect((await inject("PATCH", "/api/auth/profile", member.cookie, { newPassword: "new-password-1" })).statusCode).toBe(400);
      expect((await inject("PATCH", "/api/auth/profile", member.cookie, { currentPassword: "wrong", newPassword: "new-password-1" })).statusCode).toBe(403);
      expect((await inject("PATCH", "/api/auth/profile", member.cookie, { currentPassword: OWNER_PASSWORD, newPassword: "new-password-1" })).statusCode).toBe(200);
      expect((await inject("GET", "/api/auth/me", member.cookie)).json().user).not.toBeNull();
      expect((await inject("GET", "/api/auth/me", other)).json().user).toBeNull();
      expect((await inject("POST", "/api/auth/login", undefined, { userId: member.id, password: "new-password-1" })).statusCode).toBe(200);
    });

    it("rejects duplicate names", async () => {
      await t.login("member", "taken-name");
      const member = await t.login("member");
      expect((await inject("PATCH", "/api/auth/profile", member.cookie, { name: "Taken-Name" })).statusCode).toBe(409);
    });
  });

  describe("invitations and join", () => {
    const create = async (cookie: string, body: object) => inject("POST", "/api/invitations", cookie, body);
    const join = (token: string, name: string) => inject("POST", "/api/join", undefined, { token, name, password: "joiner-password" });

    it("is owner-only", async () => {
      const admin = await t.login("admin");
      expect((await create(admin.cookie, { role: "member", expiresIn: "1d", maxUses: 1 })).statusCode).toBe(403);
      expect((await inject("GET", "/api/invitations", admin.cookie)).statusCode).toBe(403);
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
      expect((await inject("GET", "/api/auth/me", cookie)).json().user).toMatchObject({ name: "prof-a", role: "professor" });

      expect((await join(token, "prof-b")).statusCode).toBe(410);
      expect((await inject("GET", `/api/join/${token}`)).statusCode).toBe(404);
      const list = (await inject("GET", "/api/invitations", owner.cookie)).json().invitations as { id: string; state: string; uses: unknown[] }[];
      const row = list.find(i => i.id === invitation.id)!;
      expect(row.state).toBe("exhausted");
      expect(row.uses).toHaveLength(1);
    });

    it("allows unlimited invitations to be used repeatedly", async () => {
      const owner = await t.ownerCookie();
      const { token } = (await create(owner.cookie, { role: "member", expiresIn: "never", maxUses: null })).json();
      expect((await join(token, "multi-1")).statusCode).toBe(201);
      expect((await join(token, "multi-2")).statusCode).toBe(201);
      expect((await join(token, "multi-1")).statusCode).toBe(409);
    });

    it("rejects expired and revoked invitations", async () => {
      const owner = await t.ownerCookie();
      const expired = (await create(owner.cookie, { role: "member", expiresIn: "5m", maxUses: null })).json();
      await t.db.query("UPDATE invitations SET expires_at=now()-interval '1 minute' WHERE id=$1", [expired.invitation.id]);
      expect((await join(expired.token, "late-user")).statusCode).toBe(410);

      const revoked = (await create(owner.cookie, { role: "member", expiresIn: "1h", maxUses: null })).json();
      expect((await inject("DELETE", `/api/invitations/${revoked.invitation.id}`, owner.cookie)).statusCode).toBe(200);
      expect((await join(revoked.token, "revoked-user")).statusCode).toBe(410);
      const states = (await inject("GET", "/api/invitations", owner.cookie)).json().invitations as { id: string; state: string }[];
      expect(states.find(i => i.id === expired.invitation.id)!.state).toBe("expired");
      expect(states.find(i => i.id === revoked.invitation.id)!.state).toBe("revoked");
    });

    it("consumes a single-use invitation only once under concurrency", async () => {
      const owner = await t.ownerCookie();
      const { token } = (await create(owner.cookie, { role: "member", expiresIn: "1h", maxUses: 1 })).json();
      const results = await Promise.all(Array.from({ length: 5 }, (_, i) => join(token, `race-${i}`)));
      expect(results.filter(r => r.statusCode === 201)).toHaveLength(1);
      expect(results.filter(r => r.statusCode === 410)).toHaveLength(4);
    });

    it("rejects invalid settings", async () => {
      const owner = await t.ownerCookie();
      expect((await create(owner.cookie, { role: "owner", expiresIn: "1d", maxUses: 1 })).statusCode).toBe(400);
      expect((await create(owner.cookie, { role: "member", expiresIn: "9d", maxUses: 1 })).statusCode).toBe(400);
      expect((await create(owner.cookie, { role: "member", expiresIn: "1d", maxUses: 2 })).statusCode).toBe(400);
    });
  });

  describe("users", () => {
    it("is owner-only", async () => {
      const admin = await t.login("admin");
      const member = await t.login("member");
      expect((await inject("GET", "/api/users", admin.cookie)).statusCode).toBe(403);
      expect((await inject("PATCH", `/api/users/${member.id}`, admin.cookie, { role: "admin" })).statusCode).toBe(403);
    });

    it("changes roles but never touches the owner", async () => {
      const owner = await t.ownerCookie();
      const member = await t.login("member");
      const changed = await inject("PATCH", `/api/users/${member.id}`, owner.cookie, { role: "admin" });
      expect(changed.statusCode).toBe(200);
      expect(changed.json().user.role).toBe("admin");
      expect((await inject("PATCH", `/api/users/${owner.id}`, owner.cookie, { role: "member" })).statusCode).toBe(400);
      expect((await inject("PATCH", `/api/users/${owner.id}`, owner.cookie, { disabled: true })).statusCode).toBe(400);
      expect((await inject("PATCH", `/api/users/${member.id}`, owner.cookie, { role: "owner" })).statusCode).toBe(400);
      const users = (await inject("GET", "/api/users", owner.cookie)).json().users as { role: string }[];
      expect(users[0]!.role).toBe("owner");
    });

    it("disabling a user revokes their sessions; re-enabling allows login", async () => {
      const owner = await t.ownerCookie();
      const member = await t.login("member");
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
      const member = await t.login("member");
      const other = await t.login("member");
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
      const member = await t.login("member");
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
