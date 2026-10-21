import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, migrationsDir } from "../src/migrate.js";
import { uniqueUsername, usernameSlug } from "../src/lib/users/username.js";
import { createTestContext, hasTestDb, ORIGIN, OWNER_PASSWORD, type TestContext } from "./helpers.js";

describe("username derivation", () => {
  it("slugs Han names via pinyin and Latin names via accent folding", () => {
    expect(usernameSlug("林雅婷")).toBe("linyating");
    expect(usernameSlug("王教授")).toBe("wangjiaoshou");
    expect(usernameSlug("QA 教授甲")).toBe("qa-jiaoshoujia");
    expect(usernameSlug("Owner")).toBe("owner");
    expect(usernameSlug("José Núñez")).toBe("jose-nunez");
    expect(usernameSlug("a..b__c")).toBe("a.b_c");
    expect(usernameSlug("--Bob--")).toBe("bob");
    expect(usernameSlug("!!!")).toBe("");
    expect(usernameSlug("😀")).toBe("");
    const long = usernameSlug("x".repeat(50));
    expect(long).toHaveLength(32);
  });

  it("makes names unique with numeric suffixes and falls back to user<N>", () => {
    const taken = new Set(["linyating", "bo1"]);
    expect(uniqueUsername("linyating", taken, 1)).toBe("linyating2");
    expect(uniqueUsername("linyating", taken, 1)).toBe("linyating3");
    expect(uniqueUsername("bo", taken, 1)).toBe("bo2");
    expect(uniqueUsername("", taken, 7)).toBe("user7");
    expect(uniqueUsername("y".repeat(32), taken, 1)).toBe("y".repeat(32));
    expect(uniqueUsername("y".repeat(32), taken, 1)).toBe(`${"y".repeat(31)}2`);
  });
});

/** 0103_usernames.sql + its data step on data shaped like staging before it (name = login id and display name). */
describe.skipIf(!hasTestDb)("migration 0103 (usernames)", () => {
  const name = `t_${randomBytes(6).toString("hex")}`;
  let pool: pg.Pool;
  let before: string;
  const log = { info: () => {} };
  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.pathname = `/${name}`;
    pool = new pg.Pool({ connectionString: url.toString() });
    before = await mkdtemp(path.join(tmpdir(), "mig-"));
    for (const file of await readdir(migrationsDir)) if (file < "0103") await copyFile(path.join(migrationsDir, file), path.join(before, file));
  });
  afterAll(async () => {
    await pool?.end();
    await rm(before, { recursive: true, force: true });
    const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  });

  it("keeps the real name, derives unique usernames (CJK, collisions, fallbacks) and enforces them", async () => {
    await migrate(pool as never, log, before);
    let at = 0;
    const user = async (n: string, role = "student", isOwner = false) =>
      (await pool.query<{ id: string }>(
        "INSERT INTO users(name,password_hash,role,is_admin,is_owner,created_at) VALUES($1,'x',$2,$3,$4,$5) RETURNING id",
        [n, role, role === "admin", isOwner, new Date(Date.UTC(2026, 0, 1, 0, at++)).toISOString()],
      )).rows[0]!.id;
    const ids = {
      admin: await user("admin", "admin", true),
      lin: await user("林雅婷"),
      linAscii: await user("LinYaTing"), // same slug as 林雅婷 → suffix
      chen: await user("陳柏宇"),
      prof: await user("王教授", "professor"),
      qa: await user("QA 教授甲", "professor"),
      bo: await user("Bo"), // too short → bo1
      emoji: await user("😀"), // nothing left → user<N>
    };
    await migrate(pool as never, log);

    const rows = (await pool.query<{ id: string; username: string; real_name: string; name: string }>("SELECT id,username,real_name,name FROM users")).rows;
    const byId = Object.fromEntries(rows.map(r => [r.id, r]));
    expect(byId[ids.admin]).toMatchObject({ username: "admin", real_name: "系統管理員", name: "系統管理員" });
    expect(byId[ids.lin]).toMatchObject({ username: "linyating", real_name: "林雅婷", name: "林雅婷" });
    expect(byId[ids.linAscii]).toMatchObject({ username: "linyating2", real_name: "LinYaTing" });
    expect(byId[ids.chen]!.username).toMatch(/^chenb[oa]iyu$/);
    expect(byId[ids.prof]!.username).toBe("wangjiaoshou");
    expect(byId[ids.qa]!.username).toBe("qa-jiaoshoujia");
    expect(byId[ids.bo]!.username).toBe("bo1");
    expect(byId[ids.emoji]!.username).toBe("user8");

    // `name` is a read-only mirror of real_name; usernames are required, well-formed and unique case-insensitively.
    await pool.query("UPDATE users SET real_name='林雅婷（改）' WHERE id=$1", [ids.lin]);
    expect((await pool.query("SELECT name FROM users WHERE id=$1", [ids.lin])).rows[0].name).toBe("林雅婷（改）");
    await expect(pool.query("UPDATE users SET name='x' WHERE id=$1", [ids.lin])).rejects.toThrow();
    await expect(pool.query("INSERT INTO users(real_name,password_hash,role) VALUES('沒有帳號','x','student')")).rejects.toThrow(/null/);
    await expect(pool.query("INSERT INTO users(username,real_name,password_hash,role) VALUES('LinYaTing','重複','x','student')")).rejects.toThrow();
    await expect(pool.query("INSERT INTO users(username,real_name,password_hash,role) VALUES('linyating','重複','x','student')")).rejects.toThrow(/unique/);
    // Real names may repeat now.
    await pool.query("INSERT INTO users(username,real_name,password_hash,role) VALUES('lin.second','林雅婷（改）','x','student')");
  });
});

describe.skipIf(!hasTestDb)("usernames and real names", () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestContext();
  });
  afterAll(async () => {
    await t?.close();
  });
  const headers = (cookie?: string) => ({ origin: ORIGIN, ...(cookie ? { cookie } : {}) });
  const inject = (method: "GET" | "POST" | "PATCH", url: string, cookie?: string, payload?: object) =>
    t.app.inject({ method, url, headers: headers(cookie), ...(payload ? { payload } : {}) });
  const invite = async () => {
    const owner = await t.ownerCookie();
    return (await inject("POST", "/api/invitations", owner.cookie, { role: "student", expiresIn: "1d", maxUses: null })).json().token as string;
  };
  const join = (token: string, body: object) =>
    inject("POST", "/api/join", undefined, { token, password: "joiner-password", passwordConfirm: "joiner-password", ...body });

  it("join needs a real name and a well-formed, unused username (zh messages)", async () => {
    const token = await invite();
    const bad = async (body: object, message: string | RegExp) => {
      const r = await join(token, body);
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toMatch(message);
    };
    await bad({ username: "ya-ting" }, /真實姓名|邀請或帳號資料/);
    await bad({ username: "ya-ting", realName: "   " }, "真實姓名需為 1–40 個字元。");
    await bad({ username: "ya-ting", realName: "字".repeat(41) }, "真實姓名需為 1–40 個字元。");
    for (const username of ["ab", "-yating", "雅婷", "ya ting", "a".repeat(33)]) await bad({ username, realName: "林雅婷" }, /使用者名稱需為 3–32 個字元/);
    await bad({ username: "ya-ting", realName: "林雅婷", passwordConfirm: "different-1" }, /邀請或帳號資料/);

    const ok = await join(token, { username: "Ya-Ting", realName: " 林雅婷 " });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().account).toMatchObject({ name: "林雅婷", username: "ya-ting" });
    const dup = await join(token, { username: "YA-TING", realName: "另一位林雅婷" });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe("這個使用者名稱已被使用。");
    // Same real name with another username is fine.
    expect((await join(token, { username: "yating2", realName: "林雅婷" })).statusCode).toBe(201);
  });

  it("checks username availability only for holders of a valid invitation", async () => {
    const token = await invite();
    await join(token, { username: "taken.name", realName: "已有人" });
    const check = (u: string, tk = token) => inject("GET", `/api/join/username-available?u=${encodeURIComponent(u)}&token=${encodeURIComponent(tk)}`);
    expect((await check("Taken.Name")).json()).toMatchObject({ username: "taken.name", valid: true, available: false, error: "這個使用者名稱已被使用。" });
    expect((await check("free.name")).json()).toEqual({ username: "free.name", valid: true, available: true });
    expect((await check("x")).json()).toMatchObject({ valid: false, available: false });
    expect((await check("free.name", "z".repeat(40))).statusCode).toBe(410);
    expect((await inject("GET", "/api/join/username-available?u=free.name")).statusCode).toBe(400);
  });

  it("logs in by username case-insensitively, never by real name", async () => {
    const token = await invite();
    await join(token, { username: "chen.boyu", realName: "陳柏宇" });
    const login = (body: object) => inject("POST", "/api/auth/login", undefined, { password: "joiner-password", ...body });
    const r = await login({ username: "Chen.BoYu" });
    expect(r.statusCode).toBe(200);
    expect(r.json().account).toMatchObject({ name: "陳柏宇", username: "chen.boyu" });
    expect((await login({ username: "陳柏宇" })).statusCode).toBe(401);
  });

  it("shows the real name wherever the person appears and lists both in the directory", async () => {
    const alice = await t.login("student", "alice.w");
    await t.db.query("UPDATE users SET real_name='王愛麗' WHERE id=$1", [alice.id]);
    const study = (await inject("POST", "/api/studies", alice.cookie, { title: "名稱測試" })).json();
    expect(study.members.map((m: { name: string }) => m.name)).toEqual(["王愛麗"]);
    const directory = (await inject("GET", "/api/users/directory", alice.cookie)).json().users as { id: string; name: string; username: string }[];
    expect(directory.find(u => u.id === alice.id)).toMatchObject({ name: "王愛麗", username: "alice.w" });
    expect((await inject("GET", "/api/auth/me", alice.cookie)).json().user).toMatchObject({ name: "王愛麗", username: "alice.w" });
  });

  it("lets admins change real names and usernames (unique), including the initial admin's", async () => {
    const owner = await t.ownerCookie();
    const bob = await t.login("student", "bob.old");
    await t.login("student", "carol");
    const patch = (id: string, body: object, cookie = owner.cookie) => inject("PATCH", `/api/users/${id}`, cookie, body);
    const r = await patch(bob.id, { username: "Bob.New", realName: "鮑伯" });
    expect(r.statusCode).toBe(200);
    expect(r.json().user).toMatchObject({ username: "bob.new", name: "鮑伯" });
    const taken = await patch(bob.id, { username: "CAROL" });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error).toBe("這個使用者名稱已被使用。");
    expect((await patch(bob.id, { username: "no" })).json().error).toMatch(/使用者名稱需為/);
    // The old username no longer signs in; the new one does.
    const login = (username: string) => inject("POST", "/api/auth/login", undefined, { username, password: OWNER_PASSWORD });
    expect((await login("bob.old")).statusCode).toBe(401);
    expect((await login("bob.new")).statusCode).toBe(200);
    // Names of the initial admin (and one's own) are editable; its role/disabled state still is not.
    expect((await patch(owner.id, { realName: "實驗室管理員" })).json().user).toMatchObject({ name: "實驗室管理員", username: "owner" });
    expect((await patch(owner.id, { disabled: true })).statusCode).toBe(400);
    // Students cannot use the admin endpoint.
    expect((await patch(bob.id, { realName: "x" }, bob.cookie)).statusCode).toBe(403);
    const list = (await inject("GET", "/api/users", owner.cookie)).json().users as { id: string; username: string; name: string }[];
    expect(list.find(u => u.id === bob.id)).toMatchObject({ username: "bob.new", name: "鮑伯" });
  });
});
