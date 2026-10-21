import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, migrationsDir } from "../src/migrate.js";
import { composeZhName, formalZhAddress, formatPersonName, personNamesSchema, splitLegacyName } from "../src/lib/users/person-name.js";
import { createTestContext, hasTestDb, ORIGIN, type TestContext } from "./helpers.js";

describe("person name helpers", () => {
  it("splits legacy names: single and compound surnames, pinyin English, Latin names", () => {
    expect(splitLegacyName("林雅婷")).toEqual({ zh_family: "林", zh_given: "雅婷", en_family: "Lin", en_given: "Ya-Ting" });
    expect(splitLegacyName("歐陽娜娜")).toEqual({ zh_family: "歐陽", zh_given: "娜娜", en_family: "Ouyang", en_given: "Na-Na" });
    expect(splitLegacyName("諸葛亮")).toMatchObject({ zh_family: "諸葛", zh_given: "亮", en_family: "Zhuge", en_given: "Liang" });
    expect(splitLegacyName("張簡志明")).toMatchObject({ zh_family: "張簡", zh_given: "志明" });
    // A two-character name never loses its given name to a compound-surname match.
    expect(splitLegacyName("司馬")).toMatchObject({ zh_family: "司", zh_given: "馬" });
    expect(splitLegacyName("呂秀蓮")).toMatchObject({ en_family: "Lyu", en_given: "Xiu-Lian" });
    expect(splitLegacyName("Alice Wang")).toEqual({ zh_family: "Wang", zh_given: "Alice", en_family: "Wang", en_given: "Alice" });
    expect(splitLegacyName("José María Núñez")).toEqual({ zh_family: "Núñez", zh_given: "José María", en_family: "Núñez", en_given: "José María" });
    expect(splitLegacyName("Bob")).toEqual({ zh_family: "Bob", zh_given: "", en_family: "Bob", en_given: null });
    expect(splitLegacyName("student-1a2b")).toMatchObject({ zh_family: "student-1a2b", en_family: null });
    // Long names never produce English parts over the 40-character column limit; mixed names lose nothing.
    expect(splitLegacyName("林" + "雅婷".repeat(10)).en_given).toBeNull();
    expect(splitLegacyName("QA 教授甲")).toMatchObject({ zh_family: "教授甲", zh_given: "QA" });
    expect(splitLegacyName("周 子晴")).toMatchObject({ zh_family: "周", zh_given: "子晴", en_family: "Zhou", en_given: "Zi-Qing" });
  });

  it("composes the Chinese full name and formats per locale and style", () => {
    expect(composeZhName("林", "雅婷")).toBe("林雅婷");
    expect(composeZhName("Smith", "Anna")).toBe("Anna Smith");
    const lin = { name: "林雅婷", zh_family: "林", zh_given: "雅婷", en_family: "Lin", en_given: "Ya-Ting", title: "dr" as const };
    expect(formatPersonName(lin, "zh-TW")).toBe("林雅婷");
    expect(formatPersonName(lin, "zh-TW", "formal")).toBe("林雅婷");
    expect(formalZhAddress(lin)).toBe("林博士");
    expect(formatPersonName(lin, "en")).toBe("Ya-Ting Lin");
    expect(formatPersonName(lin, "en", "formal")).toBe("Dr. Ya-Ting Lin");
    expect(formatPersonName({ ...lin, en_given: null, title: "prof" }, "en", "formal")).toBe("Prof. Lin");
    expect(formatPersonName({ ...lin, title: "mx" }, "zh-TW", "formal")).toBe("林雅婷");
    expect(formalZhAddress({ ...lin, title: "mx" })).toBe("林雅婷");
    // Missing structured parts fall back to `name`.
    expect(formatPersonName({ name: "舊名字" }, "en")).toBe("舊名字");
    expect(formatPersonName({ name: "舊名字" }, "zh-TW")).toBe("舊名字");
  });

  it("validates input: zh parts 1–20 letters, English letters only, optional given name and title", () => {
    const ok = { zhFamily: "林", zhGiven: "雅婷", enFamily: "Lin" };
    expect(personNamesSchema.parse(ok)).toEqual({ zh_family: "林", zh_given: "雅婷", en_family: "Lin", en_given: null, title: null });
    expect(personNamesSchema.parse({ ...ok, enGiven: " Ya-Ting ", title: "ms" })).toMatchObject({ en_given: "Ya-Ting", title: "ms" });
    expect(personNamesSchema.parse({ ...ok, enGiven: "", title: "" })).toMatchObject({ en_given: null, title: null });
    for (const bad of [{ zhFamily: "" }, { zhGiven: "a1" }, { zhGiven: "字".repeat(21) }, { enFamily: "林" }, { enFamily: "-Lin" }, { enGiven: "Ya2" }, { title: "sir" }]) {
      expect(personNamesSchema.safeParse({ ...ok, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

/** 0112_person_names.sql + its data step on users shaped like staging before it. */
describe.skipIf(!hasTestDb)("migration 0112 (person names)", () => {
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
    for (const file of await readdir(migrationsDir)) if (file < "0112") await copyFile(path.join(migrationsDir, file), path.join(before, file));
  });
  afterAll(async () => {
    await pool?.end();
    await rm(before, { recursive: true, force: true });
    const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  });

  it("splits every real name, keeps real_name, confirms only the initial admin", async () => {
    await migrate(pool as never, log, before);
    const user = async (username: string, realName: string, role = "student", isOwner = false) =>
      (await pool.query<{ id: string }>(
        "INSERT INTO users(username,real_name,password_hash,role,is_admin,is_owner) VALUES($1,$2,'x',$3,$4,$5) RETURNING id",
        [username, realName, role, role === "admin", isOwner],
      )).rows[0]!.id;
    const ids = {
      admin: await user("admin", "系統管理員", "admin", true),
      lin: await user("linyating", "林雅婷"),
      ouyang: await user("ouyang", "歐陽娜娜"),
      prof: await user("wangjiaoshou", "王教授", "professor"),
      alice: await user("alice", "Alice Wang"),
      long: await user("longname", "林" + "雅婷".repeat(10)),
      mixed: await user("qa.student", "QA 學生甲"),
      odd: await user("odd", "student-1a2b"),
    };
    await migrate(pool as never, log);
    const rows = (await pool.query("SELECT id,real_name,name,name_en,zh_family,zh_given,en_family,en_given,title,(names_confirmed_at IS NOT NULL) AS confirmed FROM users")).rows;
    const by = Object.fromEntries(rows.map(r => [r.id, r]));
    expect(by[ids.admin]).toMatchObject({ real_name: "系統管理員", zh_family: "系統", zh_given: "管理員", en_family: "Admin", en_given: null, name_en: "Admin", confirmed: true });
    expect(by[ids.lin]).toMatchObject({ real_name: "林雅婷", name: "林雅婷", zh_family: "林", zh_given: "雅婷", en_family: "Lin", en_given: "Ya-Ting", name_en: "Ya-Ting Lin", title: null, confirmed: false });
    expect(by[ids.ouyang]).toMatchObject({ zh_family: "歐陽", zh_given: "娜娜", name_en: "Na-Na Ouyang" });
    expect(by[ids.prof]).toMatchObject({ zh_family: "王", zh_given: "教授", en_family: "Wang", en_given: "Jiao-Shou" });
    expect(by[ids.alice]).toMatchObject({ real_name: "Alice Wang", zh_family: "Wang", zh_given: "Alice", name_en: "Alice Wang" });
    expect(by[ids.long]).toMatchObject({ zh_family: "林", en_family: "Lin", en_given: null });
    expect(by[ids.mixed]).toMatchObject({ real_name: "QA 學生甲", zh_family: "學生甲", zh_given: "QA" });
    expect(by[ids.odd]).toMatchObject({ real_name: "student-1a2b", en_family: null, name_en: null, confirmed: false });
    await expect(pool.query("UPDATE users SET title='sir' WHERE id=$1", [ids.lin])).rejects.toThrow();
    await expect(pool.query("UPDATE users SET name_en='x' WHERE id=$1", [ids.lin])).rejects.toThrow();
  });
});

describe.skipIf(!hasTestDb)("person names in the API", () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestContext();
  });
  afterAll(async () => {
    await t?.close();
  });
  const inject = (method: "GET" | "POST" | "PATCH", url: string, cookie?: string, payload?: object) =>
    t.app.inject({ method, url, headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) }, ...(payload ? { payload } : {}) });

  it("the initial admin gets 系統 / 管理員 / Admin and counts as confirmed", async () => {
    const owner = await t.ownerCookie();
    expect((await inject("GET", "/api/auth/me", owner.cookie)).json().user).toMatchObject({
      name: "系統管理員",
      names_confirmed: true,
      person: { zh_family: "系統", zh_given: "管理員", en_family: "Admin", en_given: null, title: null },
    });
  });

  it("join stores both names and the title; directory and admin list carry person + name_en", async () => {
    const owner = await t.ownerCookie();
    const token = (await inject("POST", "/api/invitations", owner.cookie, { role: "professor", expiresIn: "1d", maxUses: 1 })).json().token as string;
    const joined = await inject("POST", "/api/join", undefined, {
      token,
      username: "ouyang.prof",
      names: { zhFamily: "歐陽", zhGiven: "娜娜", enFamily: "Ouyang", enGiven: "Nana", title: "prof" },
      password: "joiner-password",
      passwordConfirm: "joiner-password",
    });
    expect(joined.statusCode).toBe(201);
    expect(joined.json().account).toMatchObject({ name: "歐陽娜娜", name_en: "Nana Ouyang" });
    const cookie = joined.headers["set-cookie"]!.toString().split(";")[0]!;
    expect((await inject("GET", "/api/auth/me", cookie)).json().user).toMatchObject({ names_confirmed: true, person: { title: "prof" } });
    const student = await t.login("student");
    const directory = (await inject("GET", "/api/users/directory", student.cookie)).json().users as { id: string }[];
    expect(directory.find(u => u.id === joined.json().account.id)).toMatchObject({
      name: "歐陽娜娜",
      name_en: "Nana Ouyang",
      username: "ouyang.prof",
      person: { zh_family: "歐陽", zh_given: "娜娜", en_family: "Ouyang", en_given: "Nana", title: "prof" },
    });
    const list = (await inject("GET", "/api/users", owner.cookie)).json().users as { id: string }[];
    expect(list.find(u => u.id === joined.json().account.id)).toMatchObject({ name_en: "Nana Ouyang", names_confirmed: true, person: { title: "prof" } });
    // Join without the English family name is refused.
    const token2 = (await inject("POST", "/api/invitations", owner.cookie, { role: "student", expiresIn: "1d", maxUses: 1 })).json().token as string;
    const missing = await inject("POST", "/api/join", undefined, {
      token: token2,
      username: "no.english",
      names: { zhFamily: "林", zhGiven: "雅婷" },
      password: "joiner-password",
    });
    expect(missing.statusCode).toBe(400);
  });

  it("an admin edit changes the names without confirming them for the account holder", async () => {
    const owner = await t.ownerCookie();
    const bob = await t.login("student", "bob.names");
    const r = await inject("PATCH", `/api/users/${bob.id}`, owner.cookie, { names: { zhFamily: "鮑", zhGiven: "伯", enFamily: "Bao", enGiven: "Bob", title: "mr" } });
    expect(r.json().user).toMatchObject({ name: "鮑伯", name_en: "Bob Bao", names_confirmed: false, person: { title: "mr" } });
    expect((await inject("GET", "/api/auth/me", bob.cookie)).json().user).toMatchObject({ name: "鮑伯", names_confirmed: false });
  });
});
