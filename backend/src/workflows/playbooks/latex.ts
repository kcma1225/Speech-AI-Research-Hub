/**
 * 論文章節撰寫: a LaTeX section from the study's notes and papers, with citations that resolve to the study library.
 * research → subsection outline (planning) → writers per subsection (parallel) → assemble + **verification compile**
 * (a throw-away compile of the project with the new section \input-ed; the project's own compile history and preview
 * are left as they were) → final verification → commit: a NEW section file plus a suggestion on the root file that adds
 * its \input — or, when the section already exists, a suggestion on that file. Nothing is overwritten directly.
 */
import { randomUUID } from "node:crypto";
import { transaction } from "../../db.js";
import { enqueueJob } from "../../jobs/queue.js";
import { LATEX_JOB_KIND, type LatexCompilePayload } from "../../lib/latex/contract.js";
import { addInput } from "../../lib/latex/inputs.js";
import { sectionPath } from "../../lib/latex/templates.js";
import { runnerManifest, snapshotProject } from "../../lib/latex-projects/service.js";
import { findProject, insertTextFile, latexKeys, latexUrl, listFiles, liveText, sectionTitle, sha256Hex } from "../../lib/latex-projects/store.js";
import { createSuggestion } from "../../lib/suggestions/service.js";
import { requireEditor, WorkflowInputError } from "../engine.js";
import { dataBlock } from "../llm.js";
import { addArtifact, getSteps } from "../store.js";
import type { WorkflowEnv } from "../env.js";
import type { CheckSpec, Criterion, StepOutput, StepRow, StepSpec } from "../types.js";
import { clipText, planningStep, resolveStudy, systemFor, taskPrompt, whichStudyQuestion } from "./common.js";
import { registerWorkflowPlaybook, type PlanResult, type WorkflowPlaybook } from "./registry.js";

type Fix = { previous: StepOutput; issues: string[] } | null;
type LatexOutline = { section: string; subsections: { title: string; points?: string[] }[] };
const isLatexOutline = (v: unknown): v is LatexOutline => !!v && typeof v === "object" && typeof (v as LatexOutline).section === "string" && Array.isArray((v as LatexOutline).subsections) && (v as LatexOutline).subsections.length > 0;

const slugOf = (t: string) => t.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || `section-${Date.now().toString(36)}`;

/** Checks: LaTeX \subsection titles present (mirrors sections_present for Markdown). */
function latexChecks(keys: string[], subsections: string[]): CheckSpec[] {
  return [
    { id: "citations", params: { keys, min: 1 } },
    { id: "not_truncated" },
    { id: "no_placeholder" },
    { id: "min_length", params: { chars: 300 } },
    ...(subsections.length ? [{ id: "sections_present", params: { sections: subsections } }] : []),
  ];
}

/** `\subsection{X}` → `### X` so the Markdown heading check applies to LaTeX too. */
export const latexHeadings = (tex: string) => tex.replace(/^\s*\\(?:sub)*section\*?\{([^}]*)\}.*$/gm, "### $1");

async function studyKeys(env: WorkflowEnv, studyId: string) {
  return (await env.db.query<{ cite_key: string }>("SELECT cite_key FROM study_papers WHERE study_id=$1", [studyId])).rows.map((r) => r.cite_key);
}

/**
 * Compiles the project with `extra` files and the root file's content replaced by `root` (in a manifest only), without
 * touching the project's compile history: the row is removed afterwards and the preview PDF pointer restored.
 */
export async function verificationCompile(env: WorkflowEnv, projectId: string, extra: { path: string; content: string }[], root: string): Promise<{ status: string; errors: string[] }> {
  const project = await findProject(env.db, projectId);
  if (!project) throw new WorkflowInputError("LaTeX 專案不存在。");
  const deps = { db: env.db, storage: env.storage, collab: null };
  const entries = await snapshotProject(deps, project.id);
  const put = async (path: string, content: string) => {
    const data = Buffer.from(content, "utf8");
    const sha = sha256Hex(data);
    const key = latexKeys.blob(project.id, sha);
    await env.storage.put(key, data, "text/plain; charset=utf-8");
    return { path, key, size: data.length, sha256: sha, fileId: "", kind: "text" as const, role: "section" as const, contentType: "text/x-tex" };
  };
  const rootEntry = await put(project.root_file, root);
  const list = [...entries.filter((e) => e.path !== project.root_file && !extra.some((x) => x.path === e.path)), rootEntry, ...(await Promise.all(extra.map((x) => put(x.path, x.content))))];
  const compileId = randomUUID();
  const manifestKey = latexKeys.manifest(project.id, compileId);
  await env.storage.put(manifestKey, JSON.stringify(runnerManifest(list as never)), "application/json");
  const outputPrefix = latexKeys.build(project.id, compileId);
  const payload: LatexCompilePayload = { projectId: project.id, compileId, manifestKey, rootFile: project.root_file, compiler: project.compiler, outputPrefix };
  const before = (await env.db.query<{ last_pdf_compile_id: string | null }>("SELECT last_pdf_compile_id FROM latex_projects WHERE id=$1", [project.id])).rows[0]?.last_pdf_compile_id ?? null;
  await transaction(env.db, async (client) => {
    await client.query(
      `INSERT INTO latex_compiles(id,project_id,compiler,root_file,draft,manifest_key,output_prefix,file_map,triggered_by) VALUES($1,$2,$3,$4,false,$5,$6,'{}',$7)`,
      [compileId, project.id, project.compiler, project.root_file, manifestKey, outputPrefix, env.user.id],
    );
    const jobId = await enqueueJob(client, LATEX_JOB_KIND, payload, null, 1);
    await client.query("UPDATE latex_compiles SET job_id=$2 WHERE id=$1", [compileId, jobId]);
  });
  await env.note("以新章節做一次驗證編譯（不會改動專案的編譯紀錄）。");
  const deadline = Date.now() + (env.deps.compileWaitMs ?? 180_000);
  let row: { status: string; result: { errors?: { message?: string; file?: string; line?: number }[] } | null; error: string | null } | undefined;
  while (Date.now() < deadline) {
    row = (await env.db.query<typeof row & object>("SELECT status,result,error FROM latex_compiles WHERE id=$1", [compileId])).rows[0];
    if (row && !["queued", "running"].includes(row.status)) break;
    if (env.signal.aborted) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  // Leave no trace in the project's history: restore the preview pointer, drop the row and its outputs.
  await env.db.query("UPDATE latex_projects SET last_pdf_compile_id=$2 WHERE id=$1 AND last_pdf_compile_id=$3", [project.id, before, compileId]);
  await env.db.query("DELETE FROM latex_compiles WHERE id=$1 AND status NOT IN ('queued','running')", [compileId]);
  void env.storage.deletePrefix(outputPrefix).catch(() => undefined);
  void env.storage.delete(manifestKey).catch(() => undefined);
  if (!row || ["queued", "running"].includes(row.status)) return { status: "timeout", errors: ["驗證編譯逾時（LaTeX 編譯服務可能忙碌或沒有啟動）。"] };
  const errors = (row.result?.errors ?? []).slice(0, 8).map((e) => `${e.file ? `${e.file}${e.line ? `:${e.line}` : ""} ` : ""}${String(e.message ?? "").slice(0, 200)}`);
  if (row.status !== "success" && row.status !== "partial" && !errors.length) errors.push(row.error?.slice(-300) ?? row.status);
  return { status: row.status, errors };
}

async function plan(env: WorkflowEnv): Promise<PlanResult> {
  const access = await resolveStudy(env);
  if (!access) return { kind: "question", question: await whichStudyQuestion(env, "這段論文內容") };
  if (!access.canEdit) return { kind: "question", question: `你不是〈${access.study.title}〉的成員，不能修改這份論文。` };
  const projects = (await env.db.query<{ id: string; title: string }>("SELECT id,title FROM latex_projects WHERE study_id=$1 ORDER BY updated_at DESC", [access.study.id])).rows;
  const projectId = (env.run.inputs.project_id as string | undefined) ?? (projects.length === 1 ? projects[0]!.id : undefined);
  const project = projectId ? await findProject(env.db, projectId) : null;
  if (!project || project.study_id !== access.study.id) return { kind: "question", question: projects.length ? `要寫進哪一份 LaTeX 專案？${projects.map((p) => `〈${p.title}〉`).join("、")}——請在補充指示寫出專案名稱。` : `〈${access.study.title}〉還沒有 LaTeX 專案，請先在「論文」分頁建立。` };
  const keys = await studyKeys(env, access.study.id);
  const files = await listFiles(env.db, project.id);
  const existing = files.filter((f) => f.kind === "text" && /\.tex$/.test(f.path) && f.path !== project.root_file).map((f) => ({ id: f.id, path: f.path, heading: sectionTitle(f.content ?? "") }));
  await env.setState({ project_id: project.id, keys, project_title: project.title });

  const research = await planningStep(env, {
    key: "research", role: "researcher", title: "讀筆記與文獻",
    instructions: "讀研究的筆記、文獻（read_paper）與論文現有章節，整理要寫的內容與可引用的文獻（附 cite key）。",
    expected: "內容重點與可用引用",
    verify: { checks: [{ id: "min_length", params: { chars: 500 } }], judge: false },
  }, async (fix) => {
    const user = [
      `要撰寫的論文章節：${env.run.request}`,
      `LaTeX 專案〈${project.title}〉現有章節：${existing.map((e) => `${e.path}${e.heading ? `（${e.heading}）` : ""}`).join("、") || "（沒有）"}；project_id ${project.id}。`,
      `研究的文獻 cite key：${keys.join("、") || "（文獻庫是空的）"}。get_study_bibtex 可查看每個 key 對應的論文。`,
      "請用 list_notes / get_note 讀相關筆記，用 read_paper 讀要引用的論文重點，需要時 latex_read_file 看相鄰章節的寫法。輸出：要寫的內容重點（含數字與出處）、建議引用的 cite key 與對應論點。",
      env.guidanceText(),
      fix ? `上一版的問題：${fix.issues.join("；")}` : "",
    ].filter(Boolean).join("\n\n");
    const r = await env.researcher({ id: "plan-research", key: "research" }, { system: systemFor("researcher"), user, tools: ["list_notes", "get_note", "list_papers", "get_paper", "read_paper", "get_study_bibtex", "latex_list_projects", "latex_read_file", "get_study"], maxToolSteps: 70, purpose: "latex_research" });
    return { summary: `讀了 ${r.toolCalls} 次，整理 ${r.text.length} 字`, text: r.text };
  });
  const brief = research.output.text ?? "";
  await env.setState({ brief: brief.slice(0, 30_000) });

  const outline = await planningStep(env, { key: "outline", role: "planner", title: "規劃章節結構", instructions: "規劃這一節的小節（\\subsection）與每小節重點。", depends_on: ["research"], expected: "小節大綱", verify: { checks: [{ id: "min_length", params: { chars: 20 } }], judge: false } }, async (fix) => {
    const user = [
      `要撰寫的章節：${env.run.request}`,
      env.guidanceText(),
      dataBlock("research", brief.slice(0, 20_000)),
      fix ? `上一版的問題：${fix.issues.join("；")}` : "",
      '規劃 2–6 個小節。只輸出 JSON：{"section":"章節標題","subsections":[{"title":"小節標題","points":["重點（可附 cite key）"]}]}',
    ].filter(Boolean).join("\n\n");
    const { value } = await env.callJson<LatexOutline>({ purpose: "latex_outline", role: "planner", messages: [{ role: "system", content: systemFor("planner") }, { role: "user", content: user }], maxTokens: 4000 }, isLatexOutline);
    return value ? { summary: `${value.subsections.length} 個小節`, text: value.subsections.map((s) => `### ${s.title}\n${(s.points ?? []).map((p) => `- ${p}`).join("\n")}`).join("\n\n"), data: value } : { summary: "大綱不是有效的 JSON", text: "" };
  }, 1);
  const lo = outline.output.data as LatexOutline | undefined;
  if (!lo) throw new WorkflowInputError("無法規劃章節結構，請換個方式描述要寫的章節。");
  const subsections = lo.subsections.slice(0, 6).map((s) => ({ title: s.title.slice(0, 120), points: (s.points ?? []).slice(0, 6) }));
  const target = existing.find((e) => e.heading && (e.heading.toLowerCase().includes(lo.section.toLowerCase()) || lo.section.toLowerCase().includes(e.heading.toLowerCase())));
  const newPath = sectionPathSafe(lo.section);
  await env.setState({ section: lo.section, subsections, target_file: target ?? null, new_path: newPath });

  const writes: StepSpec[] = subsections.map((s, i) => ({
    key: `write_${i + 1}`, role: "writer", title: `撰寫小節「${clipText(s.title, 40)}」`,
    instructions: `寫 \\subsection{${s.title}} 的 LaTeX 內文，重點：${s.points.join("；") || "依研究資料"}。引用用 \\cite{key}（只能用研究文獻庫的 key）。`,
    depends_on: ["outline"], inputs: { index: i }, expected: "一個 \\subsection 的 LaTeX 內文",
    verify: { checks: latexChecks(keys, [s.title]), judge: true },
  }));
  const titles = subsections.map((s) => s.title);
  const steps: StepSpec[] = [
    research.spec, outline.spec, ...writes,
    { key: "assemble", role: "integrator", kind: "integrate", title: "整合並驗證編譯", instructions: "整合各小節成一個章節檔，加入主檔後做驗證編譯；有錯誤時依錯誤修正。", depends_on: writes.map((w) => w.key), expected: "可以編譯的章節", verify: { checks: [{ id: "compile_ok" }, { id: "citations", params: { keys, min: 1 } }, { id: "not_truncated" }], judge: false } },
    { key: "final", role: "verifier", kind: "final", title: "最終驗收", instructions: "依目標逐條驗收。", depends_on: ["assemble"], expected: "每一條驗收標準都通過" },
  ];
  const criteria: Omit<Criterion, "status">[] = [
    { id: "compile", kind: "check", text: "加入論文後可以成功編譯（沒有 LaTeX 錯誤）", check: { id: "compile_ok" } },
    { id: "cites", kind: "check", text: "所有 \\cite 都對應到研究文獻庫的 cite key", check: { id: "citations", params: { keys, min: 1 } } },
    { id: "structure", kind: "check", text: `包含規劃的 ${titles.length} 個小節`, check: { id: "sections_present", params: { sections: titles } } },
    { id: "complete", kind: "check", text: "沒有佔位文字或未關閉的環境", check: { id: "not_truncated" } },
    { id: "grounded", kind: "judge", text: "論述來自研究的筆記與文獻，引用對應正確的論點，沒有捏造結果" },
  ];
  return {
    kind: "plan",
    title: `論文章節：${clipText(lo.section, 60)}`,
    studyId: access.study.id,
    objective: `為〈${project.title}〉撰寫「${lo.section}」一節（${titles.length} 個小節），引用研究文獻庫，並確認加入後能編譯。`,
    criteria,
    plan: {
      summary: `讀筆記與文獻後規劃 ${titles.length} 個小節，由撰寫者平行撰寫，每節檢查引用；整合後做一次驗證編譯（不改動專案），通過後${target ? `以建議的方式修改 ${target.path}` : `新增章節檔 ${newPath}，並以建議的方式在主檔加入 \\input`}。`,
      outline: subsections.map((s, i) => ({ n: i + 1, title: s.title, points: s.points })),
      writes: target
        ? [{ kind: "latex_file", label: `對 ${target.path} 的修改建議（你在編輯器逐段接受）`, effect: "suggestion" as const }]
        : [{ kind: "latex_file", label: `新章節檔 ${newPath}`, effect: "new" as const }, { kind: "latex_file", label: "主檔加入 \\input 的建議", effect: "suggestion" as const }],
    },
    steps,
  };
}

function sectionPathSafe(title: string) {
  try {
    return sectionPath(slugOf(title));
  } catch {
    return `sections/${slugOf(title)}.tex`;
  }
}

function assembleTex(env: WorkflowEnv, parts: string[]) {
  const section = env.state<string>("section") ?? "Section";
  return `\\section{${section}}\n\\label{sec:${slugOf(section)}}\n\n${parts.map((p) => p.trim()).join("\n\n")}\n`;
}

async function execute(env: WorkflowEnv, step: StepRow, fix: Fix): Promise<StepOutput> {
  const keys = env.state<string[]>("keys") ?? [];
  if (step.key.startsWith("write_")) {
    const subs = env.state<{ title: string; points: string[] }[]>("subsections") ?? [];
    const s = subs[Number(step.inputs.index ?? 0)];
    const user = taskPrompt(env, step, {
      context: { research: (env.state<string>("brief") ?? "").slice(0, 16_000), all_subsections: subs.map((x, i) => `${i + 1}. ${x.title}`).join("\n"), cite_keys: keys.join(", ") },
      format: `只輸出這一小節的 LaTeX：第一行是 \\subsection{${s?.title ?? ""}}，接著內文（段落、必要時 itemize/equation）。不要 \\documentclass、不要 \\section、不要 Markdown、不要 \`\`\`。`,
    }, fix);
    const res = await env.call({ purpose: "latex_write", role: "writer", messages: [{ role: "system", content: systemFor("writer", "你寫學術論文的 LaTeX 內文（中文論文用繁體中文，英文論文用英文，依研究現有章節的語言）。") }, { role: "user", content: user }], maxTokens: 7000 }, step.id);
    const tex = res.text.replace(/^```(?:latex|tex)?\n|\n```$/g, "").trim();
    return { summary: `${tex.length} 字${res.stopReason === "max_tokens" ? "（輸出被截斷）" : ""}`, text: tex };
  }
  if (step.key === "assemble") {
    const steps = await getSteps(env.db, env.run.id);
    let content = assembleTex(env, steps.filter((s) => s.key.startsWith("write_") && s.output?.text).sort((a, b) => Number(a.key.slice(6)) - Number(b.key.slice(6))).map((s) => s.output!.text!));
    const prev = env.state<{ content: string; errors: string[] }>("compiled");
    if (fix && prev?.errors.length) {
      await env.activity(step.key, "integrator", "依編譯錯誤修正");
      const res = await env.call({ purpose: "latex_fix", role: "integrator", aiRole: "writing", messages: [{ role: "system", content: systemFor("integrator", "修正 LaTeX 語法錯誤，內容不變。只輸出完整的章節 LaTeX。") }, { role: "user", content: `編譯錯誤：\n${prev.errors.join("\n")}\n\n${dataBlock("section", prev.content)}` }], maxTokens: 9000 }, step.id);
      const fixed = res.text.replace(/^```(?:latex|tex)?\n|\n```$/g, "").trim();
      if (fixed.includes("\\section")) content = `${fixed}\n`;
    }
    const projectId = env.state<string>("project_id")!;
    const project = await findProject(env.db, projectId);
    if (!project) throw new WorkflowInputError("LaTeX 專案不存在。");
    const rootFile = (await listFiles(env.db, project.id)).find((f) => f.path === project.root_file);
    const rootText = rootFile ? await liveText(env.db, null, rootFile) : "";
    const target = env.state<{ id: string; path: string } | null>("target_file");
    const path = target?.path ?? env.state<string>("new_path")!;
    const root = target ? rootText : addInput(rootText, path);
    const compile = await verificationCompile(env, project.id, [{ path, content }], root);
    await env.setState({ compiled: { content, errors: compile.errors }, tex: content });
    return { summary: `整合 ${content.length} 字；驗證編譯：${compile.status}${compile.errors.length ? `（${compile.errors.length} 個錯誤）` : ""}`, text: content, data: { compile, headings: latexHeadings(content) } };
  }
  return step.output ?? { summary: "（已完成）", text: env.state<string>("brief") ?? "" };
}

async function commit(env: WorkflowEnv, outcome: "done" | "partial") {
  const content = env.state<string>("tex");
  if (!content || env.state<string>("committed")) return content ? null : "章節沒有寫入（流程在整合前就停止了）。";
  if (!env.run.study_id) return null;
  const access = await requireEditor(env, env.run.study_id);
  const project = await findProject(env.db, env.state<string>("project_id")!);
  if (!project) return "LaTeX 專案已不存在，沒有寫入。";
  const deps = { db: env.db, collab: null };
  const target = env.state<{ id: string; path: string } | null>("target_file");
  const title = outcome === "done" ? "Agent：撰寫章節" : "Agent：撰寫章節（未完全通過驗收）";
  if (target) {
    const s = await createSuggestion(deps, { targetType: "latex_file", targetId: target.id, proposedText: content, title, source: "ai", actorId: env.user.id, conversationId: env.run.conversation_id, user: env.user });
    await env.setState({ committed: true });
    await addArtifact(env.db, env.run.id, { kind: "latex_file", id: target.id, url: `${latexUrl(access.study.slug, project.id, target.id)}&suggestion=${s.id}`, title: `${target.path} 的修改建議`, role: "suggestion" });
    return `已在 ${target.path} 建立修改建議，請在 LaTeX 編輯器逐段接受。`;
  }
  const path = env.state<string>("new_path")!;
  const fileId = await transaction(env.db, async (client) => {
    await client.query("SELECT 1 FROM latex_projects WHERE id=$1 FOR UPDATE", [project.id]);
    const taken = (await client.query("SELECT 1 FROM latex_files WHERE project_id=$1 AND path=$2", [project.id, path])).rowCount;
    const finalPath = taken ? path.replace(/\.tex$/, `-${Date.now().toString(36)}.tex`) : path;
    await env.setState({ new_path: finalPath });
    return insertTextFile(client, { projectId: project.id, path: finalPath, content, role: "section", actorId: env.user.id });
  });
  const finalPath = env.state<string>("new_path")!;
  const rootFile = (await listFiles(env.db, project.id)).find((f) => f.path === project.root_file);
  let line = `已新增章節檔 ${finalPath}`;
  if (rootFile) {
    const rootText = await liveText(env.db, null, rootFile);
    const next = addInput(rootText, finalPath);
    if (next !== rootText) {
      const s = await createSuggestion(deps, { targetType: "latex_file", targetId: rootFile.id, proposedText: next, title: `加入 ${finalPath}`, source: "ai", actorId: env.user.id, conversationId: env.run.conversation_id, user: env.user });
      await addArtifact(env.db, env.run.id, { kind: "latex_file", id: rootFile.id, url: `${latexUrl(access.study.slug, project.id, rootFile.id)}&suggestion=${s.id}`, title: `${project.root_file}：加入 \\input 的建議`, role: "suggestion" });
      line += `，並在 ${project.root_file} 建立加入 \\input 的建議（接受後才會出現在論文中）`;
    }
  }
  await env.setState({ committed: true });
  await addArtifact(env.db, env.run.id, { kind: "latex_file", id: fileId, url: latexUrl(access.study.slug, project.id, fileId), title: finalPath, role: "draft" });
  return `${line}。`;
}

const latexSection: WorkflowPlaybook = {
  id: "latex_section",
  title: "論文章節撰寫",
  titleEn: "Thesis section",
  description: "從筆記與文獻撰寫 LaTeX 章節：平行撰寫小節、檢查引用、驗證編譯，成果以新檔案與建議呈現",
  descriptionEn: "Write a LaTeX section from notes and papers: subsections in parallel, citation checks, verification compile; delivered as a new file and suggestions",
  // Only a new section file + suggestions (autopilot.ts): auto-approvable under autopilot.
  autoApprovable: true,
  detect: (req, inputs) => (inputs.project_id ? 0.85 : /latex|章節|論文.*(撰寫|寫)|thesis|related work 章|introduction|方法章|\\section/i.test(req) && !/簡報|投影片/.test(req) ? 0.7 : 0),
  plan,
  execute,
  async finalText(env) {
    const st = env.state<{ content: string; errors: string[] }>("compiled");
    const steps = await getSteps(env.db, env.run.id);
    const data = steps.find((s) => s.key === "assemble")?.output?.data ?? null;
    return { text: latexHeadings(st?.content ?? ""), data };
  },
  async repair(env, failing) {
    const out: { key: string; issues: string[] }[] = [];
    const subs = env.state<{ title: string }[]>("subsections") ?? [];
    for (const c of failing) {
      if (c.id === "compile") out.push({ key: "assemble", issues: [c.reason ?? "編譯失敗"] });
      else if (c.id === "structure") subs.forEach((s, i) => out.push({ key: `write_${i + 1}`, issues: [`請確認小節「${s.title}」完整：${c.reason ?? ""}`] }));
      else subs.slice(0, 4).forEach((_, i) => out.push({ key: `write_${i + 1}`, issues: [`${c.text}：${c.reason ?? ""}`] }));
    }
    return out;
  },
  commit,
};

registerWorkflowPlaybook(latexSection);
export { latexSection };
