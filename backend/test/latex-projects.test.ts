import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, hasTestDb, hasTestS3, ORIGIN, type TestContext } from "./helpers.js";
import { addStudyMember, insertStudy } from "./study-fixtures.js";
import { listInputs } from "../src/lib/latex/inputs.js";
import { latexDocName } from "../src/lib/latex-projects/store.js";
import { parseDocName } from "../src/collab/registry.js";
import type { LatexCompileResult, LatexSnapshotManifest } from "../src/lib/latex/contract.js";
import { getAgentTool } from "../src/agent/tools/registry.js";
import { CURRENT_USER_COLUMNS, toCurrentUser } from "../src/lib/auth.js";

type Session = { id: string; cookie: string };

describe.skipIf(!hasTestDb || !hasTestS3)("LaTeX projects (routes)", () => {
  let t: TestContext;
  let alice: Session; // study owner
  let bob: Session; // member
  let carol: Session; // other student (non-member)
  let prof: Session; // advisor
  let study: { id: string; slug: string };
  let projectId: string;

  const send = (who: Session, method: string, url: string, payload?: unknown) =>
    t.app.inject({ method: method as "GET", url, headers: { cookie: who.cookie, origin: ORIGIN }, ...(payload === undefined ? {} : { payload: payload as object }) });
  const json = (r: { body: string }) => JSON.parse(r.body);
  const detail = async (who: Session = alice) => json(await send(who, "GET", `/api/latex/${projectId}`));
  const fileText = async (fileId: string) => (await send(alice, "GET", `/api/latex/${projectId}/files/${fileId}/raw`)).body;
  const mainText = async () => {
    const d = await detail();
    return fileText(d.root_file_id);
  };

  beforeAll(async () => {
    t = await createTestContext();
    alice = await t.login("student", "林雅婷");
    bob = await t.login("student", "陳柏宇");
    carol = await t.login("student", "張三");
    prof = await t.login("professor", "王教授");
    study = await insertStudy(t.db, alice.id, "語音情緒辨識");
    await addStudyMember(t.db, study.id, bob.id);
    await addStudyMember(t.db, study.id, prof.id, "advisor");
  }, 60_000);
  afterAll(async () => {
    await t?.close();
  });

  it("creates a 中文碩士論文 project from the template (members only)", async () => {
    expect((await send(carol, "POST", `/api/studies/${study.slug}/latex`, { title: "x", template: "zh-thesis" })).statusCode).toBe(403);
    expect((await send(prof, "POST", `/api/studies/${study.slug}/latex`, { title: "x", template: "zh-thesis" })).statusCode).toBe(403);
    const r = await send(alice, "POST", `/api/studies/${study.slug}/latex`, { title: "語音情緒辨識之研究", kind: "thesis", template: "zh-thesis" });
    expect(r.statusCode).toBe(201);
    projectId = json(r).project.id;
    expect(json(r).project).toMatchObject({ compiler: "xelatex", bib_mode: "auto", root_file: "main.tex", template: "zh-thesis" });
    const d = await detail(carol); // everyone reads
    expect(d.permissions.edit).toBe(false);
    expect(d.sections.map((s: { path: string }) => s.path)).toEqual([
      "sections/abstract-zh.tex", "sections/abstract-en.tex", "sections/introduction.tex", "sections/related-work.tex", "sections/method.tex", "sections/experiments.tex", "sections/conclusion.tex",
    ]);
    expect(d.sections[2].title).toBe("緒論");
    expect(d.files.find((f: { path: string }) => f.path === "refs.bib")).toMatchObject({ role: "bib", generated: true });
    expect(await mainText()).toContain("林雅婷");
    expect(await mainText()).toContain("王教授");
    const list = json(await send(prof, "GET", `/api/studies/${study.slug}/latex`));
    expect(list.projects).toHaveLength(1);
    expect(list.templates.map((x: { id: string }) => x.id)).toContain("ieee-conference");
  });

  it("adds a section after another one and inserts its \\input into main.tex", async () => {
    const d = await detail();
    const intro = d.sections.find((s: { path: string }) => s.path === "sections/introduction.tex");
    expect((await send(carol, "POST", `/api/latex/${projectId}/sections`, { title: "背景", name: "background" })).statusCode).toBe(403);
    const r = await send(bob, "POST", `/api/latex/${projectId}/sections`, { title: "背景知識", name: "background", after: intro.file_id });
    expect(r.statusCode).toBe(201);
    const body = json(r);
    expect(body.file).toMatchObject({ path: "sections/background.tex", role: "section", title: "背景知識" });
    expect(body.sections.map((s: { path: string }) => s.path).indexOf("sections/background.tex")).toBe(3);
    const main = await mainText();
    expect(main).toMatch(/\\input\{sections\/introduction\}\n\\input\{sections\/background\}\n/);
    expect(await fileText(body.file.id)).toBe("\\chapter{背景知識}\\label{chap:background}\n\n");
    // Same name again → 409; bad name → 400.
    expect((await send(bob, "POST", `/api/latex/${projectId}/sections`, { title: "x", name: "background" })).statusCode).toBe(409);
    expect((await send(bob, "POST", `/api/latex/${projectId}/sections`, { title: "x", name: "../evil" })).statusCode).toBe(400);
    // Without a name: section-1.
    const auto = json(await send(bob, "POST", `/api/latex/${projectId}/sections`, { title: "附錄 A" }));
    expect(auto.file.path).toBe("sections/section-1.tex");
    expect(listInputs(await mainText()).map((e) => e.path).at(-1)).toBe("sections/section-1.tex");
  });

  it("reorders sections robustly in a user-edited main.tex and keeps other lines in place", async () => {
    const d = await detail();
    const root = d.root_file_id;
    // A user adds comments, a \clearpage and a disabled input between the managed lines.
    const edited = (await fileText(root)).replace("\\input{sections/method}", "% 方法章節\n  \\input{sections/method} % 主要貢獻\n\\clearpage").replace("\\input{sections/conclusion}", "% \\input{sections/conclusion}");
    await t.app.collab.edit(latexDocName(projectId, root), alice.id, (_doc, ytext) => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, edited);
    });
    const sections = (await detail()).sections as { file_id: string; path: string; disabled: boolean }[];
    expect(sections.find((s) => s.path === "sections/conclusion.tex")!.disabled).toBe(true);
    const ids = sections.map((s) => s.file_id);
    const methodIdx = sections.findIndex((s) => s.path === "sections/method.tex");
    const order = [ids[methodIdx]!, ...ids.filter((_, i) => i !== methodIdx)];
    const r = await send(bob, "PUT", `/api/latex/${projectId}/sections/order`, { order });
    expect(r.statusCode).toBe(200);
    expect(json(r).sections[0].path).toBe("sections/method.tex");
    const main = await mainText();
    expect(main).toContain("% 方法章節");
    expect(main).toContain("\\clearpage");
    expect(main).toContain("% \\input{sections/conclusion}");
    expect(main).toMatch(/\\end\{titlepage\}\n\n  \\input\{sections\/method\} % 主要貢獻/); // indentation/comment moved with the line
    const inputs = listInputs(main).map((e) => e.path);
    expect(inputs[0]).toBe("sections/method.tex");
    expect(inputs).toHaveLength(sections.length);
    // Unknown ids → 400.
    expect((await send(bob, "PUT", `/api/latex/${projectId}/sections/order`, { order: ["00000000-0000-4000-8000-000000000000"] })).statusCode).toBe(400);
  });

  it("renames and retitles a section, and deletes it with its \\input", async () => {
    const d = await detail();
    const bg = d.sections.find((s: { path: string }) => s.path === "sections/background.tex");
    const r = await send(alice, "PATCH", `/api/latex/${projectId}/sections/${bg.file_id}`, { title: "相關背景", name: "bg" });
    expect(r.statusCode).toBe(200);
    expect(json(r).sections.find((s: { file_id: string }) => s.file_id === bg.file_id)).toMatchObject({ path: "sections/bg.tex" });
    expect(await mainText()).toContain("\\input{sections/bg}");
    expect(await fileText(bg.file_id)).toContain("\\chapter{相關背景}\\label{chap:background}");
    // The root file cannot be deleted.
    expect((await send(alice, "DELETE", `/api/latex/${projectId}/files/${d.root_file_id}`)).statusCode).toBe(400);
    expect((await send(alice, "DELETE", `/api/latex/${projectId}/files/${bg.file_id}`)).statusCode).toBe(200);
    expect(await mainText()).not.toContain("sections/bg");
    expect((await detail()).files.some((f: { id: string }) => f.id === bg.file_id)).toBe(false);
  });

  it("creates text files, uploads binaries content-addressed, rejects unsafe paths", async () => {
    expect((await send(alice, "POST", `/api/latex/${projectId}/files`, { path: "../x.tex" })).statusCode).toBe(400);
    expect((await send(alice, "POST", `/api/latex/${projectId}/files`, { path: ".out/x.tex" })).statusCode).toBe(400);
    expect((await send(alice, "POST", `/api/latex/${projectId}/files`, { path: "-x.tex" })).statusCode).toBe(400);
    const r = await send(alice, "POST", `/api/latex/${projectId}/files`, { path: "macros.sty", content: "\\newcommand{\\hub}{Hub}\n" });
    expect(r.statusCode).toBe(201);
    expect(json(r).file).toMatchObject({ role: "style", kind: "text" });
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5f0000000049454e44ae426082", "hex");
    const boundary = "----hubtest";
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="dot.png"\r\nContent-Type: image/png\r\n\r\n`),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const up = await t.app.inject({ method: "POST", url: `/api/latex/${projectId}/files`, headers: { cookie: alice.cookie, origin: ORIGIN, "content-type": `multipart/form-data; boundary=${boundary}` }, payload: body });
    expect(up.statusCode).toBe(201);
    const file = json(up).file;
    expect(file).toMatchObject({ path: "figures/dot.png", kind: "binary", role: "asset", bytes: png.length });
    const row = (await t.db.query("SELECT s3_key FROM latex_files WHERE id=$1", [file.id])).rows[0];
    expect(row.s3_key).toMatch(new RegExp(`^latex/${projectId}/blobs/[0-9a-f]{64}$`));
    const raw = await send(carol, "GET", `/api/latex/${projectId}/files/${file.id}/raw`);
    expect(raw.statusCode).toBe(200);
    expect(raw.headers["content-security-policy"]).toContain("sandbox");
    expect(Buffer.from(raw.rawPayload).equals(png)).toBe(true);
    // QA: executables/web pages are refused; a non-UTF-8 text file is refused instead of becoming an uneditable blob.
    const upload = (name: string, data: Buffer) =>
      t.app.inject({
        method: "POST", url: `/api/latex/${projectId}/files`, headers: { cookie: alice.cookie, origin: ORIGIN, "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), data, Buffer.from(`\r\n--${boundary}--\r\n`)]),
      });
    expect((await upload("page.html", Buffer.from("<script>alert(1)</script>"))).statusCode).toBe(400);
    expect((await upload("tool.exe", Buffer.from("MZ"))).statusCode).toBe(400);
    const big5 = await upload("big5.tex", Buffer.from([0xa4, 0xa4, 0xa4, 0xe5, 0x0a]));
    expect(big5.statusCode).toBe(400);
    expect(json(big5).error).toContain("UTF-8");
  });

  it("collab access: members edit, others and the generated refs.bib are read-only", async () => {
    const d = await detail();
    const parsed = (fileId: string) => parseDocName(latexDocName(projectId, fileId))!;
    const intro = d.sections.find((s: { path: string }) => s.path === "sections/introduction.tex").file_id;
    const bib = d.files.find((f: { path: string }) => f.path === "refs.bib").id;
    const user = async (s: Session) => (await t.db.query("SELECT id,name,role,is_admin,is_owner FROM users WHERE id=$1", [s.id])).rows[0];
    expect(await parsed(intro).ns.authorize(t.db, await user(bob), parsed(intro).rest)).toEqual({ readOnly: false });
    expect(await parsed(intro).ns.authorize(t.db, await user(carol), parsed(intro).rest)).toEqual({ readOnly: true });
    expect(await parsed(intro).ns.authorize(t.db, await user(prof), parsed(intro).rest)).toEqual({ readOnly: true });
    expect(await parsed(bib).ns.authorize(t.db, await user(alice), parsed(bib).rest)).toEqual({ readOnly: true });
    expect(await parsed(intro).ns.authorize(t.db, await user(alice), `${projectId}:00000000-0000-4000-8000-000000000000`)).toBeNull();
  });

  let compileId: string;
  it("compile: regenerates refs.bib from the library, snapshots blobs, writes the manifest, enqueues latex_compile", async () => {
    const paper = (await t.db.query(
      `INSERT INTO papers(record,type,title,title_norm,authors_text,year,bibtex,added_by) VALUES($1,'paper-conference',$2,$3,'Chen, Bo',2024,$4,$5) RETURNING id`,
      [JSON.stringify({ type: "paper-conference", title: "語音情緒辨識綜述" }), "語音情緒辨識綜述", "語音情緒辨識綜述", "@inproceedings{orig, title={語音情緒辨識綜述}, author={Chen, Bo}, year={2024}}", alice.id],
    )).rows[0].id;
    await t.db.query("INSERT INTO study_papers(study_id,paper_id,cite_key,added_by) VALUES($1,$2,'chen2024ser',$3)", [study.id, paper, alice.id]);
    expect((await send(carol, "POST", `/api/latex/${projectId}/compile`, {})).statusCode).toBe(403);
    const first = await send(alice, "POST", `/api/latex/${projectId}/compile`, {});
    expect(first.statusCode).toBe(202);
    const r = await send(bob, "POST", `/api/latex/${projectId}/compile`, {});
    expect(r.statusCode).toBe(202);
    compileId = json(r).compile.id;
    expect(json(r).compile).toMatchObject({ status: "queued", stage: "排隊中", pdf_url: null });
    // The first (still queued) compile was superseded.
    const old = json(await send(alice, "GET", `/api/latex/${projectId}/compiles/${json(first).compile.id}`)).compile;
    expect(old).toMatchObject({ status: "cancelled", error: "已由較新的編譯取代。" });
    const d = await detail();
    const bibText = await fileText(d.files.find((f: { path: string }) => f.path === "refs.bib").id);
    expect(bibText).toContain("@inproceedings{chen2024ser,");
    expect(bibText).toContain("研究文獻庫自動產生");
    const job = (await t.db.query("SELECT j.kind, j.payload, j.created_by, j.max_attempts FROM jobs j JOIN latex_compiles c ON c.job_id=j.id WHERE c.id=$1", [compileId])).rows[0];
    expect(job).toMatchObject({ kind: "latex_compile", created_by: null, max_attempts: 2 });
    expect(job.payload).toMatchObject({ projectId, compileId, rootFile: "main.tex", compiler: "xelatex", outputPrefix: `latex/${projectId}/builds/${compileId}/`, manifestKey: `latex/${projectId}/manifests/${compileId}.json` });
    const manifest = JSON.parse((await t.storage.getBuffer(job.payload.manifestKey))!.toString()) as LatexSnapshotManifest;
    expect(manifest.version).toBe(1);
    expect(manifest.files.map((f) => f.path)).toEqual(expect.arrayContaining(["main.tex", "refs.bib", "sections/introduction.tex", "figures/dot.png", "macros.sty"]));
    for (const f of manifest.files) expect(f.key.startsWith(`latex/${projectId}/blobs/`)).toBe(true);
    const main = manifest.files.find((f) => f.path === "main.tex")!;
    expect((await t.storage.getBuffer(main.key))!.toString()).toBe(await mainText());
  });

  it("finalizer applies a fake runner result: PDF (Range), log, parsed errors", async () => {
    const prefix = `latex/${projectId}/builds/${compileId}/`;
    await t.storage.put(`${prefix}output.pdf`, Buffer.from("%PDF-1.5\nfake pdf body\n%%EOF\n"), "application/pdf");
    await t.storage.put(`${prefix}output.log`, "This is XeTeX\n", "text/plain");
    const result: LatexCompileResult = {
      status: "partial", pdfKey: `${prefix}output.pdf`, synctexKey: null, logKey: `${prefix}output.log`, blgKey: null, stdoutKey: null, durationMs: 4200, pdfBytes: 30, compiler: "xelatex",
      errors: [{ severity: "error", source: "latex", file: "sections/introduction.tex", line: 4, message: "Undefined control sequence.", token: "\\foo", code: "undefined-control-sequence", title_zh: "未定義的指令", hint_zh: "檢查拼字" }],
      warnings: [], warningCount: 0, badBoxCount: 0,
    };
    // A hostile key outside the prefix is ignored.
    await t.db.query("UPDATE jobs SET status='succeeded', result=$2, finished_at=now(), started_at=now() WHERE id=(SELECT job_id FROM latex_compiles WHERE id=$1)", [compileId, JSON.stringify({ ...result, blgKey: "slides/other/secret" })]);
    await t.finalizer.drain();
    const c = json(await send(carol, "GET", `/api/latex/${projectId}/compiles/${compileId}`)).compile;
    expect(c).toMatchObject({ status: "partial", progress: 100, pdf_url: `/api/latex/${projectId}/compiles/${compileId}/pdf`, log_url: expect.any(String), duration_ms: 4200 });
    expect(c.errors[0]).toMatchObject({ file: "sections/introduction.tex", line: 4, hint_zh: "檢查拼字" });
    expect(c.file_map["sections/introduction.tex"]).toBeTruthy();
    expect((await t.db.query("SELECT blg_key FROM latex_compiles WHERE id=$1", [compileId])).rows[0].blg_key).toBeNull();
    const d = await detail();
    expect(d.pdf_compile.id).toBe(compileId);
    const range = await t.app.inject({ method: "GET", url: c.pdf_url, headers: { cookie: carol.cookie, range: "bytes=0-4" } });
    expect(range.statusCode).toBe(206);
    expect(range.body).toBe("%PDF-");
    expect(range.headers["content-type"]).toBe("application/pdf");
    expect((await send(carol, "GET", c.log_url)).body).toContain("XeTeX");
    // The manifest is deleted after finalizing.
    expect(await t.storage.getBuffer(`latex/${projectId}/manifests/${compileId}.json`)).toBeNull();
    const card = json(await send(alice, "GET", `/api/studies/${study.slug}/latex`)).projects[0];
    expect(card).toMatchObject({ last_compile_status: "partial", pdf_url: c.pdf_url });
  });

  it("a failed job (bad input) marks the compile failed and keeps the previous PDF", async () => {
    const r = json(await send(alice, "POST", `/api/latex/${projectId}/compile`, { draft: true })).compile;
    await t.db.query("UPDATE jobs SET status='failed', error='不安全的檔案路徑', finished_at=now() WHERE id=(SELECT job_id FROM latex_compiles WHERE id=$1)", [r.id]);
    await t.finalizer.drain();
    const c = json(await send(alice, "GET", `/api/latex/${projectId}/compiles/${r.id}`)).compile;
    expect(c).toMatchObject({ status: "failed", error: "不安全的檔案路徑", draft: true, pdf_url: null });
    const d = await detail();
    expect(d.latest_compile.id).toBe(r.id);
    expect(d.pdf_compile.id).toBe(compileId);
  });

  it("suggestions target latex_file: members accept, non-members cannot", async () => {
    const d = await detail();
    const intro = d.sections.find((s: { path: string }) => s.path === "sections/introduction.tex").file_id;
    const before = await fileText(intro);
    const proposed = before.replace("\\section{論文架構}", "\\section{論文架構與貢獻}");
    expect((await send(carol, "POST", "/api/suggestions", { target_type: "latex_file", target_id: intro, proposed_text: proposed })).statusCode).toBe(403);
    const s = await send(bob, "POST", "/api/suggestions", { target_type: "latex_file", target_id: intro, proposed_text: proposed });
    expect(s.statusCode).toBe(201);
    const sug = json(s).suggestion;
    expect(sug.url ?? "").toContain(`/latex/${projectId}`);
    expect((await send(alice, "POST", `/api/suggestions/${sug.id}/accept-all`)).statusCode).toBe(200);
    expect(await fileText(intro)).toContain("論文架構與貢獻");
    const row = (await t.db.query("SELECT content FROM latex_files WHERE id=$1", [intro])).rows[0];
    expect(row.content).toContain("論文架構與貢獻");
  });

  it("versions: save, edit, restore (text through the live document, deleted files come back)", async () => {
    const v = await send(alice, "POST", `/api/latex/${projectId}/versions`, { label: "初稿" });
    expect(v.statusCode).toBe(201);
    const d = await detail();
    const concl = d.sections.find((s: { path: string }) => s.path === "sections/conclusion.tex").file_id;
    const sty = d.files.find((f: { path: string }) => f.path === "macros.sty").id;
    await t.app.collab.edit(latexDocName(projectId, concl), alice.id, (_doc, ytext) => ytext.insert(0, "% 修改過\n"));
    await send(alice, "DELETE", `/api/latex/${projectId}/files/${sty}`);
    const r = await send(alice, "POST", `/api/latex/${projectId}/versions/${json(v).version.id}/restore`);
    expect(r.statusCode).toBe(200);
    expect(await fileText(concl)).not.toContain("% 修改過");
    expect(json(r).files.some((f: { path: string }) => f.path === "macros.sty")).toBe(true);
    const versions = json(await send(carol, "GET", `/api/latex/${projectId}/versions`)).versions;
    expect(versions.map((x: { kind: string }) => x.kind)).toEqual(["restore", "backup", "manual"]);
    expect(versions[0].label).toBe("還原至〈初稿〉");
    expect((await send(carol, "POST", `/api/latex/${projectId}/versions`, {})).statusCode).toBe(403);
  });

  it("ZIP export → import round trip (root and compiler detected, files kept as-is)", async () => {
    const zip = await send(carol, "GET", `/api/latex/${projectId}/export.zip`);
    expect(zip.statusCode).toBe(200);
    expect(zip.headers["content-type"]).toBe("application/zip");
    const boundary = "----hubzip";
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\n匯入測試\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="thesis.zip"\r\nContent-Type: application/zip\r\n\r\n`),
      Buffer.from(zip.rawPayload),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const r = await t.app.inject({ method: "POST", url: `/api/studies/${study.slug}/latex/import`, headers: { cookie: bob.cookie, origin: ORIGIN, "content-type": `multipart/form-data; boundary=${boundary}` }, payload: body });
    expect(r.statusCode).toBe(201);
    const imported = json(r);
    expect(imported.project).toMatchObject({ title: "匯入測試", root_file: "main.tex", compiler: "xelatex", bib_mode: "manual", template: "import" });
    const di = json(await send(bob, "GET", `/api/latex/${imported.project.id}`));
    expect(di.files.find((f: { path: string }) => f.path === "figures/dot.png")).toMatchObject({ kind: "binary" });
    expect(di.sections.length).toBe((await detail()).sections.length);
    expect(di.files.find((f: { path: string }) => f.path === "refs.bib").generated).toBe(false);
  });

  it("symbols for autocompletion: labels across files and cite keys from the library", async () => {
    const s = json(await send(carol, "GET", `/api/latex/${projectId}/symbols`));
    expect(s.labels.map((l: { key: string }) => l.key)).toEqual(expect.arrayContaining(["chap:introduction", "eq:loss", "tab:results"]));
    expect(s.citations.find((c: { key: string }) => c.key === "chen2024ser")).toMatchObject({ source: "library", title: "語音情緒辨識綜述" });
  });

  it("agent tools: list, read, suggest (members only), compile, log", async () => {
    const userOf = async (sess: Session) => toCurrentUser((await t.db.query(`SELECT ${CURRENT_USER_COLUMNS} FROM users u WHERE u.id=$1`, [sess.id])).rows[0]);
    const ctx = async (sess: Session) => ({ app: t.app, db: t.db, user: await userOf(sess), source: "agent" as const, conversationId: null, runId: null, autopilot: false });
    const run = (name: string, args: Record<string, unknown>, c: Awaited<ReturnType<typeof ctx>>) => getAgentTool(name)!.execute(getAgentTool(name)!.input.parse(args), c);
    const list = (await run("latex_list_projects", { study: study.slug }, await ctx(carol))).data as { projects: { id: string }[] };
    expect(list.projects.map((p) => p.id)).toContain(projectId);
    const files = (await run("latex_list_projects", { project_id: projectId }, await ctx(carol))).data as { files: { id: string; path: string; role: string }[] };
    const intro = files.files.find((f) => f.path === "sections/introduction.tex")!;
    expect(intro.role).toBe("section");
    const read = await run("latex_read_file", { project_id: projectId, path: "sections/introduction.tex", line_numbers: true }, await ctx(carol));
    expect((read.data as { text: string }).text).toMatch(/^1: \\chapter\{緒論\}/);
    // Non-members cannot suggest; members get a pending suggestion.
    await expect(getAgentTool("latex_suggest_edit")!.target!({ project_id: projectId, file_id: intro.id, content: "x" }, await ctx(carol))).rejects.toMatchObject({ status: 403 });
    const sug = await run("latex_suggest_edit", { project_id: projectId, file_id: intro.id, edits: [{ before: "研究背景與動機", after: "研究背景" }], title: "精簡標題" }, await ctx(bob));
    expect((sug.data as { status: string }).status).toBe("pending_review");
    const bib = files.files.find((f) => f.path === "refs.bib")!;
    await expect(run("latex_suggest_edit", { project_id: projectId, file_id: bib.id, content: "x" }, await ctx(bob))).rejects.toMatchObject({ status: 400 });
    const comp = await run("latex_compile", { project_id: projectId, draft: true }, await ctx(bob));
    expect((comp.data as { status: string }).status).toBe("queued");
    const logView = (await run("latex_get_compile_log", { project_id: projectId }, await ctx(carol))).data as { compile: { status: string } };
    expect(logView.compile.status).toBe("queued");
  });

  it("project settings: bib mode manual makes refs.bib editable; delete removes everything", async () => {
    expect((await send(carol, "PATCH", `/api/latex/${projectId}`, { bib_mode: "manual" })).statusCode).toBe(403);
    const r = await send(alice, "PATCH", `/api/latex/${projectId}`, { bib_mode: "manual", compiler: "lualatex", title: "新標題" });
    expect(json(r).project).toMatchObject({ bib_mode: "manual", compiler: "lualatex", title: "新標題" });
    expect((await detail()).files.find((f: { path: string }) => f.path === "refs.bib").generated).toBe(false);
    expect((await send(alice, "PATCH", `/api/latex/${projectId}`, { root_file: "refs.bib" })).statusCode).toBe(400);
    const docs = (await t.db.query("SELECT count(*)::int AS n FROM yjs_docs WHERE name LIKE $1", [`latex:${projectId}:%`])).rows[0].n;
    expect(docs).toBeGreaterThan(5);
    expect((await send(alice, "DELETE", `/api/latex/${projectId}`)).statusCode).toBe(200);
    expect((await send(alice, "GET", `/api/latex/${projectId}`)).statusCode).toBe(404);
    expect((await t.db.query("SELECT count(*)::int AS n FROM yjs_docs WHERE name LIKE $1", [`latex:${projectId}:%`])).rows[0].n).toBe(0);
  });
});
