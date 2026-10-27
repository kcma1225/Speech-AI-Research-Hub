// Postgres text / jsonb cannot hold U+0000 (production 研究內容講解: PDF text with NUL bytes made every read_paper result
// unstorable — 「工具執行時發生錯誤」 — and the assistant fetched a PDF the library already had).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pgSafe, transaction } from "../src/db.js";
import { createTestContext, hasTestDb, hasTestS3, type TestContext } from "./helpers.js";

describe("pgSafe", () => {
  it("drops NUL from strings and from JSON, leaves everything else", () => {
    expect(pgSafe("a\u0000b")).toBe("ab");
    expect(pgSafe("plain")).toBe("plain");
    expect(pgSafe({ t: "x\u0000y", n: [1, "\u0000"] })).toBe('{"t":"xy","n":[1,""]}');
    expect(pgSafe(["a\u0000", "b"])).toEqual(["a", "b"]);
    const d = new Date(0);
    expect(pgSafe(d)).toBe(d);
    const buf = Buffer.from([0, 1]);
    expect(pgSafe(buf)).toBe(buf);
    expect(pgSafe(null)).toBeNull();
    // A literal backslash-u0000 the user typed (escaped in JSON) is text, kept.
    expect(pgSafe(JSON.stringify({ s: "\\u0000" }))).toBe(JSON.stringify({ s: "\\u0000" }));
  });
});

(hasTestDb && hasTestS3 ? describe : describe.skip)("pg writes with NUL characters", () => {
  let t: TestContext;
  beforeAll(async () => { t = await createTestContext(); });
  afterAll(async () => { await t?.close(); });

  it("text and jsonb parameters with NUL are stored (pool and transaction clients)", async () => {
    const r = await t.db.query<{ a: string; b: { s: string } }>("SELECT $1::text AS a, $2::jsonb AS b", ["x\u0000y", { s: "p\u0000q" }]);
    expect(r.rows[0]).toEqual({ a: "xy", b: { s: "pq" } });
    const s = await t.db.query<{ b: { s: string } }>("SELECT $1::jsonb AS b", [JSON.stringify({ s: "p\u0000q" })]);
    expect(s.rows[0]!.b).toEqual({ s: "pq" });
    const inTx = await transaction(t.db, (c) => c.query<{ a: string }>({ text: "SELECT $1::text AS a", values: ["m\u0000n"] }));
    expect(inTx.rows[0]!.a).toBe("mn");
  });
});
