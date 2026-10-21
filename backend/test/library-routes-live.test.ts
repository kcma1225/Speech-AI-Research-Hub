import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, hasTestDb, ORIGIN, type TestContext } from "./helpers.js";
import { userSession } from "./slides-fixtures.js";
import { addStudyMember, insertStudy } from "./study-fixtures.js";

/**
 * One real AI call through the library routes (role `analysis`), cheapest model only:
 *   TEST_LLM_BASE_URL=… TEST_LLM_API_KEY=… npx vitest run test/library-routes-live.test.ts
 */
process.env.PROVIDER_TOKEN_KEY ??= randomBytes(32).toString("base64");
const live = hasTestDb && process.env.TEST_LLM_BASE_URL && process.env.TEST_LLM_API_KEY;

describe.skipIf(!live)("library AI (live, cheapest model)", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => ctx?.close());

  it("summarizes a paper and relates it to a study", async () => {
    const admin = await userSession(ctx.db, "admin");
    const student = await userSession(ctx.db, "student");
    const study = await insertStudy(ctx.db, admin.id, "台語 ASR");
    await addStudyMember(ctx.db, study.id, student.id);
    await ctx.db.query("UPDATE studies SET summary_md='用自監督預訓練模型改善低資源台語語音辨識。' WHERE id=$1", [study.id]);
    const send = (who: { cookie: string }, url: string, payload: object = {}, method: "POST" | "PUT" = "POST") =>
      ctx.app.inject({ method, url, headers: { origin: ORIGIN, cookie: who.cookie }, payload });
    const prov = (await send(admin, "/api/admin/ai/providers", { family: "llm", kind: "openai-compatible", name: "test", config: { baseUrl: process.env.TEST_LLM_BASE_URL }, secrets: { apiKey: process.env.TEST_LLM_API_KEY } })).json().provider.id;
    const route = (await send(admin, "/api/admin/ai/routes", { name: "a", capability: "chat", strategy: "single", members: [{ provider_id: prov, model: "glm/glm-5.3-flash" }] })).json().route.id;
    expect((await send(admin, "/api/admin/ai/roles/analysis", { route_id: route }, "PUT")).statusCode).toBe(200);
    const add = await send(student, "/api/library/papers", {
      study: study.id,
      record: { type: "article", title: "wav2vec 2.0: A Framework for Self-Supervised Learning of Speech Representations", authors: [{ family: "Baevski", given: "Alexei" }], year: 2020,
        abstract: "We show for the first time that learning powerful representations from speech audio alone followed by fine-tuning on transcribed speech can outperform the best semi-supervised methods while being conceptually simpler." },
    });
    const paperId = add.json().paper.id;
    const s = await send(student, `/api/library/papers/${paperId}/ai/summary`);
    expect(s.statusCode, s.body).toBe(200);
    expect(s.json().markdown.length).toBeGreaterThan(20);
    expect(s.json().markdown).not.toContain("[DONE]");
    const r = await send(student, `/api/studies/${study.slug}/papers/${paperId}/ai/relevance`);
    expect(r.statusCode, r.body).toBe(200);
    console.log(s.json().markdown, "\n---\n", r.json().markdown);
  }, 120_000);
});
