import { mkdtemp, readdir, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, migrationsDir } from "../src/migrate.js";
import { hasTestDb } from "./helpers.js";

/** 0100_admin_role.sql on data shaped like v3 staging before it (Owner = student + is_admin, owning studies). */
describe.skipIf(!hasTestDb)("migration 0100 (admin role)", () => {
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
    for (const file of await readdir(migrationsDir)) if (file < "0100") await copyFile(path.join(migrationsDir, file), path.join(before, file));
  });
  afterAll(async () => {
    await pool?.end();
    await rm(before, { recursive: true, force: true });
    const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  });

  it("turns the Owner into the initial admin, hands over its studies and keeps every invariant", async () => {
    await migrate(pool as never, log, before);
    const user = async (n: string, role: string, isAdmin = false, isOwner = false) =>
      (await pool.query<{ id: string }>("INSERT INTO users(name,password_hash,role,is_admin,is_owner) VALUES($1,'x',$2,$3,$4) RETURNING id", [n, role, isAdmin, isOwner])).rows[0]!.id;
    const owner = await user("Owner", "student", true, true);
    const bob = await user("Bob", "student");
    const carol = await user("Carol", "student");
    const prof = await user("Prof", "professor", true); // a professor with the old admin flag
    const study = async (slug: string) => (await pool.query<{ id: string }>("INSERT INTO studies(slug,title) VALUES($1,$1) RETURNING id", [slug])).rows[0]!.id;
    const member = (s: string, u: string, role: string, at: string) => pool.query("INSERT INTO study_members(study_id,user_id,role,added_at) VALUES($1,$2,$3,$4)", [s, u, role, at]);
    const shared = await study("shared");
    await member(shared, owner, "owner", "2026-01-01");
    await member(shared, prof, "advisor", "2026-01-02");
    await member(shared, carol, "member", "2026-01-04");
    await member(shared, bob, "member", "2026-01-03"); // earliest member → heir
    const lonely = await study("lonely");
    await member(lonely, owner, "owner", "2026-01-01");
    const others = await study("others");
    await member(others, carol, "owner", "2026-01-01");
    await member(others, owner, "member", "2026-01-02");
    await pool.query("INSERT INTO tasks(study_id,title,assignee_id) VALUES($1,'t',$2)", [shared, owner]);
    await pool.query("INSERT INTO invitations(token_hash,role,is_admin,created_by) VALUES('h1','professor',true,$1)", [owner]);

    await migrate(pool as never, log); // applies 0100 (and anything after it)

    const users = (await pool.query("SELECT name,role,is_admin,is_owner FROM users ORDER BY lower(name)")).rows;
    expect(users).toEqual([
      { name: "admin", role: "admin", is_admin: true, is_owner: true },
      { name: "Bob", role: "student", is_admin: false, is_owner: false },
      { name: "Carol", role: "student", is_admin: false, is_owner: false },
      { name: "Prof", role: "professor", is_admin: false, is_owner: false },
    ]);
    const members = async (s: string) => (await pool.query("SELECT u.name,m.role FROM study_members m JOIN users u ON u.id=m.user_id WHERE study_id=$1 ORDER BY lower(u.name)", [s])).rows;
    expect(await members(shared)).toEqual([{ name: "Bob", role: "owner" }, { name: "Carol", role: "member" }, { name: "Prof", role: "advisor" }]);
    expect(await members(lonely)).toEqual([{ name: "admin", role: "owner" }]); // nobody to hand it to
    expect(await members(others)).toEqual([{ name: "Carol", role: "owner" }]);
    expect((await pool.query("SELECT assignee_id FROM tasks")).rows[0].assignee_id).toBeNull();
    expect((await pool.query("SELECT is_admin FROM invitations")).rows[0].is_admin).toBe(false);
    // The new constraints hold.
    await expect(pool.query("UPDATE users SET is_admin=true WHERE name='Bob'")).rejects.toThrow();
    await expect(pool.query("UPDATE users SET disabled_at=now() WHERE is_owner")).rejects.toThrow();
  });
});
