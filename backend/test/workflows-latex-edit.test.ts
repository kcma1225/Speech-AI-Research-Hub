/**
 * Part-scoped LaTeX edits end to end (playbooks/latex-edit.ts) with a scripted model and a fake LaTeX runner:
 * 1. 「把 Related Work 第二段刪掉」 with the project given (the assistant proposed lit_review): routed to an edit, no model
 *    writing, one suggestion whose single hunk removes that paragraph; every other byte of the project stays;
 * 2. 「第一節改短一點」: the section in main.tex (the root file) is rewritten from its own text only, its \section and
 *    \label kept; the suggestion covers only that range;
 * 3. 「把第九節刪掉」: a part that is not there → a question, nothing written;
 * 4. creation mode: 「幫我寫 Introduction」 for a section that lives in main.tex rewrites that block (no duplicate file).
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ChatResult } from "../src/ai/types.js";
import { runWorkflow } from "../src/workflows/engine.js";
import { approveWorkflow, createWorkflow } from "../src/workflows/service.js";
import { getRun, getSteps } from "../src/workflows/store.js";
import "../src/workflows/playbooks/index.js";
import type { ModelPort } from "../src/workflows/types.js";
import { insertTextFile } from "../src/lib/latex-projects/store.js";
import { checkRun } from "../src/workflows/invariants.js";
import { createTestContext, hasTestDb, hasTestS3, type TestContext } from "./helpers.js";
import { insertStudy } from "./study-fixtures.js";
import { setWorkflowAvailability } from "../src/routes/workflows.js";

process.env.PROVIDER_TOKEN_KEY ??= randomBytes(32).toString("base64");
const run = hasTestDb && hasTestS3 ? describe : describe.skip;

type Req = { messages: { role: string; content: unknown }[] };
const result = (text: string): ChatResult => ({ text, reasoning: "", toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 50 }, message: { role: "assistant", content: text } });
const textOf = (req: Req, role?: string) => req.messages.filter((m) => !role || m.role === role).map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
const allPass = (req: Req) => JSON.stringify({ results: [...textOf(req, "user").matchAll(/- \[([a-z0-9_]+)\]/g)].map((m) => ({ id: m[1], pass: true, evidence: "ok", reason: "ok" })) });

function mockModel() {
  const defaults = new Map<string, string | ((req: Req) => string)>();
  const log: { purpose: string; prompt: string }[] = [];
  const port: ModelPort = {
    async chat(_role, req, ctx) {
      log.push({ purpose: ctx.purpose, prompt: textOf(req as Req) });
      const reply = defaults.get(ctx.purpose) ?? defaults.get("*") ?? "{}";
      return result(typeof reply === "function" ? reply(req as Req) : reply);
    },
    available: async () => true,
    vision: async () => false,
  };
  return { port, log, set: (p: string, r: string | ((req: Req) => string)) => defaults.set(p, r), count: (p: string) => log.filter((l) => l.purpose === p).length, prompts: (p: string) => log.filter((l) => l.purpose === p).map((l) => l.prompt) };
}

const MAIN = "\\documentclass{article}\n\\begin{document}\n\\section{Introduction}\\label{sec:intro}\nWe study hotword biasing in streaming ASR.\n\nIt matters for rare names.\n\n\\input{sections/related}\n\\input{sections/method}\n\\bibliography{refs}\n\\end{document}\n";
const RELATED = "\\section{Related Work}\n\\label{sec:related}\n\nShallow fusion biases the decoder \\cite{a2020}.\n\nRNN-T biasing adds a context encoder \\cite{b2021}.\n\nTrie-based methods prune the search.\n";
const METHOD = "\\section{Method}\nOur method.\n\n\\begin{table}\\caption{Results}\\label{tab:r}\\end{table}\n";

run("LaTeX part edits (workflow)", () => {
  let t: TestContext;
  let alice: { id: string; cookie: string };
  let study: { id: string; slug: string };
  let m: ReturnType<typeof mockModel>;
  let stop = false;
  let worker: Promise<void>;
  const deps = () => ({ db: t.db, storage: t.storage, app: t.app, model: m.port, log: t.app.log, signal: new AbortController().signal, jobId: null, compileWaitMs: 20_000 });
  const asUser = async (id: string) => {
    const { toCurrentUser, CURRENT_USER_COLUMNS } = await import("../src/lib/auth.js");
    return toCurrentUser((await t.db.query(`SELECT ${CURRENT_USER_COLUMNS} FROM users u WHERE u.id=$1`, [id])).rows[0]);
  };
  async function newProject() {
    const id = (await t.db.query<{ id: string }>("INSERT INTO latex_projects(study_id,title,created_by,updated_by) VALUES($1,'熱詞論文',$2,$2) RETURNING id", [study.id, alice.id])).rows[0]!.id;
    const files: Record<string, string> = {};
    for (const [path, content, role] of [["main.tex", MAIN, "main"], ["sections/related.tex", RELATED, "section"], ["sections/method.tex", METHOD, "section"]] as const) files[path] = await insertTextFile(t.db, { projectId: id, path, content, role, actorId: alice.id });
    return { id, files };
  }
  const suggestionsOf = async (fileId: string) => (await t.db.query<{ hunks: { before: string; after: string }[] }>("SELECT hunks FROM suggestions WHERE target_type='latex_file' AND target_id=$1", [fileId])).rows;
  async function plan(request: string, inputs: Record<string, unknown>, playbook?: string) {
    const r = await createWorkflow(t.app, await asUser(alice.id), { request, playbook, inputs, context: { studyId: study.id } } as never);
    const out = await runWorkflow(deps(), r.id);
    return { id: r.id, status: out.status, run: (await getRun(t.db, r.id))! };
  }
  async function approveAndRun(id: string) {
    await approveWorkflow(t.app, await asUser(alice.id), id, {});
    const out = await runWorkflow(deps(), id);
    return { status: out.status, run: (await getRun(t.db, id))! };
  }

  beforeAll(async () => {
    t = await createTestContext();
    alice = await t.login("student", "alice-latex-edit");
    study = await insertStudy(t.db, alice.id, "熱詞研究");
    await t.db.query("INSERT INTO papers(title,created_by) VALUES('x',$1)", [alice.id]).catch(() => undefined);
    setWorkflowAvailability(async () => true);
    // Fake LaTeX runner: every compile succeeds.
    worker = (async () => {
      while (!stop) {
        const jobs = (await t.db.query<{ id: string; payload: { compileId: string } }>("SELECT id, payload FROM jobs WHERE kind='latex_compile' AND status='queued'")).rows;
        for (const j of jobs) {
          await t.db.query("UPDATE latex_compiles SET status='success', result=$2 WHERE id=$1", [j.payload.compileId, JSON.stringify({ errors: [], warnings: [] })]);
          await t.db.query("UPDATE jobs SET status='succeeded', finished_at=now() WHERE id=$1", [j.id]);
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    })();
  });
  afterAll(async () => {
    stop = true;
    await worker;
    await t?.close();
  });
  beforeEach(() => {
    m = mockModel();
    m.set("requirements", '{"requirements":[]}');
    m.set("verify", '{"verdict":"pass","issues":[]}');
    m.set("verify_final", allPass);
  });

  it("1. removes one paragraph with no model writing; one hunk; everything else byte for byte", async () => {
    const p = await newProject();
    const planned = await plan("把 Related Work 第二段刪掉", { project_id: p.id }, "lit_review");
    expect(planned.status, JSON.stringify(planned.run.question)).toBe("awaiting_plan_approval");
    const route = planned.run.state.route as { playbook: string; latex?: string };
    expect([planned.run.playbook, route.playbook, route.latex]).toEqual(["latex_section", "latex_section", "edit"]);
    expect(planned.run.plan!.writes!.map((w) => w.effect)).toEqual(["suggestion"]);
    const { status, run: r } = await approveAndRun(planned.id);
    expect(status, JSON.stringify(r.report?.issues)).toBe("done");
    expect(m.count("latex_edit") + m.count("latex_write") + m.count("latex_research")).toBe(0);
    expect((await getSteps(t.db, r.id)).map((s) => s.key)).toEqual(["assemble", "final"]);
    const sug = await suggestionsOf(p.files["sections/related.tex"]!);
    expect(sug).toHaveLength(1);
    expect(sug[0]!.hunks.map((h) => [h.before, h.after])).toEqual([["RNN-T biasing adds a context encoder \\cite{b2021}.\n\n", ""]]);
    expect(await suggestionsOf(p.files["main.tex"]!)).toHaveLength(0);
    expect(checkRun({ run: r } as never, ["latex.part_scope_kept", "route.latex_part_edit"])).toEqual([]);
  });

  it("2. rewrites the section in the root file from its own text; \\section and \\label kept", async () => {
    const p = await newProject();
    m.set("latex_edit", "\\subsection{Intro}\nWe study hotword biasing.\n");
    const planned = await plan("第一節改短一點", { project_id: p.id });
    expect(planned.status, JSON.stringify(planned.run.question)).toBe("awaiting_plan_approval");
    const { status, run: r } = await approveAndRun(planned.id);
    expect(status, JSON.stringify(r.report?.issues)).toBe("done");
    // The writer saw only that section's text.
    const prompt = m.prompts("latex_edit")[0]!;
    expect(prompt).toContain("It matters for rare names.");
    expect(prompt).not.toContain("Shallow fusion");
    const sug = await suggestionsOf(p.files["main.tex"]!);
    expect(sug).toHaveLength(1);
    expect(sug[0]!.hunks.map((h) => h.after).join("")).toContain("\\section{Introduction}\\label{sec:intro}\nWe study hotword biasing.\n");
    expect(sug[0]!.hunks.every((h) => !h.before.includes("\\input"))).toBe(true);
    expect(checkRun({ run: r } as never, ["latex.part_scope_kept"])).toEqual([]);
  });

  it("3. a part that is not there is a question; nothing is written", async () => {
    const p = await newProject();
    const planned = await plan("把第九節刪掉", { project_id: p.id });
    expect(planned.status).toBe("awaiting_input");
    expect(planned.run.question).toContain("找不到");
    expect(await suggestionsOf(p.files["sections/related.tex"]!)).toHaveLength(0);
  });

  it("4. creation mode: a section that lives in the root file is rewritten in place, not duplicated", async () => {
    const p = await newProject();
    m.set("latex_research", "研究重點：熱詞偏置在串流辨識的需求，引用 a2020 與 b2021 的做法與限制。".repeat(10));
    m.set("latex_outline", JSON.stringify({ section: "Introduction", subsections: [{ title: "Motivation", points: ["rare names"] }] }));
    m.set("latex_write", `\\subsection{Motivation}\n${"Hotword biasing helps rare names in streaming ASR \\cite{a2020}. ".repeat(8)}\n`);
    m.set("*", "研究重點：熱詞偏置在串流辨識的需求。".repeat(40));
    const planned = await plan("幫我寫 Introduction", { project_id: p.id });
    expect(planned.status, JSON.stringify(planned.run.question)).toBe("awaiting_plan_approval");
    expect(planned.run.plan!.writes!.map((w) => [w.effect, w.label])).toEqual([["suggestion", expect.stringContaining("main.tex")]]);
    expect(planned.run.state.target_file).toMatchObject({ path: "main.tex" });
  });

  it("5. a part of an existing research note starts no survey run (the assistant edits the note)", async () => {
    const before = Number((await t.db.query<{ n: string }>("SELECT count(*) AS n FROM workflow_runs")).rows[0]!.n);
    await expect(createWorkflow(t.app, await asUser(alice.id), { request: "把調研筆記裡 RNN-T 那節刪掉", playbook: "topic_research", context: { studyId: study.id } } as never)).rejects.toMatchObject({ status: 422, extra: { code: "note_edit" } });
    expect(Number((await t.db.query<{ n: string }>("SELECT count(*) AS n FROM workflow_runs")).rows[0]!.n)).toBe(before);
  });
});
