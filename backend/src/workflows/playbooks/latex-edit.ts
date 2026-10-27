/**
 * Part-scoped edits of an existing LaTeX project (`latex_section` with `route.latex = "edit"`; docs/architecture.md
 * "Workflows" → LaTeX part edits). 「把 Related Work 第二段刪掉」「Table 2 拿掉」「第三節改短」: the parts the user's words
 * name are resolved from the project's real structure (lib/latex/structure.ts: every .tex file in \input order, the root
 * included, numbered as the PDF shows them); only those ranges change and everything else stays byte for byte:
 * - a removal needs no model call (no length / citation checks);
 * - a rewrite gives the writer the current text of that part only; a section keeps its command (\chapter stays
 *   \chapter), its star and its \label, and every \label inside it;
 * - the write guard (`spliceFiles`) builds each changed file from the original + splices and checks the kept segments,
 *   recorded in `state.latex_edit_result` for the invariant `latex.part_scope_kept`;
 * - the commit is a suggestion per changed file whose hunks cover only those ranges (nothing applied directly).
 * Words naming nothing / the whole paper, a part that is not there or one that matches several parts → a question.
 */
import { createHash } from "node:crypto";
import { listInputs } from "../../lib/latex/inputs.js";
import { stripPreamble } from "../../lib/latex/section-scope.js";
import { applySplices, blockLabel, keepHeading, keepsSegments, keptSegments, projectStructure, REMOVE_RE, resolveParts, type Block, type PartResolution, type PartTarget, type SourceFile, type Splice } from "../../lib/latex/structure.js";
import { findProject, latexUrl, listFiles, liveText } from "../../lib/latex-projects/store.js";
import { createSuggestion } from "../../lib/suggestions/service.js";
import { HttpError } from "../../lib/http.js";
import { requireEditor, WorkflowInputError } from "../engine.js";
import { dataBlock } from "../llm.js";
import { addArtifact, getSteps } from "../store.js";
import type { WorkflowEnv } from "../env.js";
import type { Criterion, StepOutput, StepRow, StepSpec } from "../types.js";
import { clipText, requirePick, systemFor, taskPrompt } from "./common.js";
import type { PlanResult } from "./registry.js";

type Project = NonNullable<Awaited<ReturnType<typeof findProject>>>;
type EditFile = SourceFile & { id: string };

/** One planned change: a range of one file (removal: `after` fixed now; rewrite: the writer's text at assemble). */
export type PlannedRange = { path: string; file_id: string; start: number; end: number; before: string; after?: string };
export type PlannedTarget = {
  key: string; kind: PartTarget["kind"]; action: PartTarget["action"]; ref: string; clause: string;
  /** A rewritten heading block: keep its command / label (and its title unless the words rename it). */
  heading: boolean; retitle: boolean;
  ranges: PlannedRange[];
};
export type LatexEditState = { project_id: string; targets: PlannedTarget[]; shas: Record<string, string> };
/** What the write guard checked (invariant `latex.part_scope_kept`). */
export type LatexEditResult = { files: { path: string; file_id: string; kept: string[]; removed: string[]; next: string; splices: (Splice & { before: string })[] }[]; issues: string[] };

const sha = (t: string) => createHash("sha256").update(t).digest("hex").slice(0, 16);
const RETITLE_RE = /標題|題目|節名|章名|改名|重新命名|\btitle\b|\brename\b/i;
const CITE_SWAP_RE = /(?:換成|改成|改為|替換成|replace (?:it )?with|→)\s*\\?(?:cite\{)?([A-Za-z][\w:.\-]{2,})/i;

/** Live text of every .tex file and the structure (the last successful compile's .aux numbers when stored). */
export async function loadProjectSource(env: WorkflowEnv, project: Project): Promise<{ files: EditFile[]; structure: ReturnType<typeof projectStructure> }> {
  const rows = (await listFiles(env.db, project.id)).filter((f) => f.kind === "text" && /\.tex$/.test(f.path));
  const files = await Promise.all(rows.map(async (f) => ({ id: f.id, path: f.path, text: await liveText(env.db, null, f) })));
  const prefix = (await env.db.query<{ output_prefix: string }>("SELECT output_prefix FROM latex_compiles WHERE project_id=$1 AND status='success' ORDER BY created_at DESC LIMIT 1", [project.id]).catch(() => ({ rows: [] as { output_prefix: string }[] }))).rows[0]?.output_prefix;
  const aux = prefix ? (await env.storage.getBuffer(`${prefix}output.aux`).catch(() => null))?.toString("utf8") ?? null : null;
  return { files, structure: projectStructure(files, project.root_file, aux) };
}

/**
 * The user's words → parts: all their words first; when those do not resolve and the newest turn (a clarifying answer:
 * 「我是說第三節」) does, the newest turn with the earlier turns' removal verb. Ambiguous refs picked on a card are applied.
 */
export function resolveWords(words: string[], s: ReturnType<typeof projectStructure>, files: SourceFile[], chosen: Map<string, number>): PartResolution {
  const all = resolveParts(words.join("\n"), s, files, chosen);
  if (all.kind === "parts" || words.length < 2) return all;
  const last = words.at(-1)!;
  const newest = resolveParts(last, s, files, chosen);
  if (newest.kind !== "parts") return all;
  const earlier = words.slice(0, -1).join("\n");
  if (!REMOVE_RE.test(last) && REMOVE_RE.test(earlier)) for (const t of newest.targets) t.action = "remove";
  for (const t of newest.targets) t.clause = `${earlier}\n${t.clause}`;
  return newest;
}

/** The text a removal takes out: a paragraph with the blank lines after it; a whole input-ed file → its \input line. */
function removalSplices(t: PartTarget, files: Map<string, EditFile>, root: string): PlannedRange[] {
  const out: PlannedRange[] = [];
  for (const r of t.ranges) {
    const f = files.get(r.path)!;
    let { start, end } = r;
    if (t.kind === "paragraph") end += /^\s*/.exec(f.text.slice(end))![0].length;
    // A block that is all of a section file: the root's \input of it goes (the file itself stays, unused).
    const whole = t.kind === "block" && r.path !== root && !f.text.slice(0, start).trim() && !f.text.slice(end).trim();
    const rootFile = files.get(root);
    if (whole && rootFile) {
      const entry = listInputs(rootFile.text).find((e) => e.path === r.path && !e.disabled);
      if (entry) {
        const lines = rootFile.text.split("\n");
        const s = lines.slice(0, entry.line).reduce((n, l) => n + l.length + 1, 0);
        const e = Math.min(rootFile.text.length, s + lines[entry.line]!.length + 1);
        out.push({ path: root, file_id: rootFile.id, start: s, end: e, before: rootFile.text.slice(s, e), after: "" });
        continue;
      }
    }
    out.push({ path: r.path, file_id: f.id, start, end, before: f.text.slice(start, end), after: r.after ?? "" });
  }
  return out;
}

const askKey = (ref: string) => `latex_part_${sha(ref).slice(0, 8)}`;

/** Plans a part-scoped edit of `project` (called by latex_section's plan when the route is `latex: "edit"`). */
export async function planLatexEdit(env: WorkflowEnv, studyId: string, project: Project): Promise<PlanResult> {
  const { files, structure } = await loadProjectSource(env, project);
  const byPath = new Map(files.map((f) => [f.path, f] as const));
  const words = (env.brief()?.user_words ?? [env.run.request]).filter((w) => w.trim());
  const chosen = new Map<string, number>(Object.entries(env.state<Record<string, number>>("latex_part_choices") ?? {}));
  let res = resolveWords(words, structure, files, chosen);
  // A ref matching several parts: one card per ref (the parts as options), then resolve again with the choice.
  for (let i = 0; i < 4 && res.kind === "ask" && res.candidates.length > 1 && res.ref; i++) {
    const ref = res.ref;
    const picked = await requirePick(env, askKey(ref), res.candidates.map((b) => ({ id: String(b.index), title: blockLabel(b), description: `${b.path}` })), {
      title: `「${clipText(ref, 30)}」是哪一個？`, prompt: `論文裡有好幾個地方符合「${clipText(ref, 30)}」，要改的是哪一個？`, none: `還是不知道「${clipText(ref, 30)}」是哪一個。請在補充指示寫出節號或標題`,
    });
    if ("question" in picked) return { kind: "question", question: picked.question };
    chosen.set(ref, Number(picked.id));
    await env.setState({ latex_part_choices: Object.fromEntries(chosen) });
    res = resolveWords(words, structure, files, chosen);
  }
  if (res.kind === "ask") return { kind: "question", question: res.question };
  if (res.kind === "none") {
    const top = structure.blocks.filter((b) => b.kind === "heading" && (b.level === "chapter" || (b.level === "section" && !structure.chapters))).slice(0, 12).map(blockLabel);
    return { kind: "question", question: `要改〈${project.title}〉的哪一部分？${res.why}；這個流程一次只改你指出的章節、段落、表、圖或引用，其他內容不動。${top.length ? `目前的章節：${top.join("、")}。` : ""}請說出節號、標題或「表 2」「圖 3」這樣的名稱。` };
  }
  const targets: PlannedTarget[] = res.targets.map((t, i) => {
    const key = `edit_${i + 1}`;
    const heading = t.kind === "block" && t.block?.kind === "heading";
    if (t.kind === "citation" && t.action === "rewrite") {
      const swap = CITE_SWAP_RE.exec(t.clause)?.[1];
      if (swap) return { key, kind: t.kind, action: "rewrite" as const, ref: t.ref, clause: t.clause, heading: false, retitle: false, ranges: t.ranges.map((r) => { const f = byPath.get(r.path)!; const before = f.text.slice(r.start, r.end); const old = t.ref.replace(/^引用 /, ""); return { path: r.path, file_id: f.id, start: r.start, end: r.end, before, after: before.replace(/\{([^{}]*)\}$/, (_m, ks: string) => `{${ks.split(",").map((k) => (k.trim() === old ? swap : k)).join(",")}}`) }; }) };
    }
    if (t.action === "remove") return { key, kind: t.kind, action: "remove" as const, ref: t.ref, clause: t.clause, heading, retitle: false, ranges: removalSplices(t, byPath, project.root_file) };
    return { key, kind: t.kind, action: "rewrite" as const, ref: t.ref, clause: t.clause, heading, retitle: heading && RETITLE_RE.test(t.clause), ranges: t.ranges.map((r) => ({ path: r.path, file_id: byPath.get(r.path)!.id, start: r.start, end: r.end, before: byPath.get(r.path)!.text.slice(r.start, r.end) })) };
  });
  const bad = targets.find((t) => t.kind === "citation" && t.action === "rewrite" && t.ranges.some((r) => r.after === undefined));
  if (bad) return { kind: "question", question: `「${bad.ref}」要改成什麼？請說出要換成的 cite key（例如「換成 lee2021」），或說要拿掉它。` };
  const touched = [...new Set(targets.flatMap((t) => t.ranges.map((r) => r.path)))];
  const state: LatexEditState = { project_id: project.id, targets, shas: Object.fromEntries(touched.map((p) => [p, sha(byPath.get(p)!.text)])) };
  await env.setState({ project_id: project.id, project_title: project.title, latex_edit: state, latex_edit_result: null, tex: null, committed: null });
  const rewrites = targets.filter((t) => t.action === "rewrite" && t.ranges.some((r) => r.after === undefined));
  const removals = targets.filter((t) => t.action === "remove");
  const writes: StepSpec[] = rewrites.map((t) => ({
    key: t.key, role: "writer", title: `改寫「${clipText(t.ref, 40)}」`,
    instructions: `只改寫「${t.ref}」：照使用者的話修改這一部分，沒有被要求改的句子、指令、\\label、\\cite 逐字保留。`,
    inputs: { target: t.key }, expected: "這一部分改寫後完整的 LaTeX",
    verify: { checks: [{ id: "not_truncated" }, { id: "no_placeholder" }], judge: false },
  }));
  const steps: StepSpec[] = [
    ...writes,
    { key: "assemble", role: "integrator", kind: "integrate", title: removals.length && !rewrites.length ? "刪除指定部分並驗證編譯" : "套用修改並驗證編譯", instructions: "只把指定的範圍換成新內容，其他內容一字不動；做一次驗證編譯（不改動專案的編譯紀錄）。", depends_on: writes.map((w) => w.key), expected: "可以編譯、只改了指定部分的論文", verify: { checks: [{ id: "compile_ok" }, { id: "latex_scope_kept" }], judge: false } },
    { key: "final", role: "verifier", kind: "final", title: "最終驗收", instructions: "依目標逐條驗收。", depends_on: ["assemble"], expected: "每一條驗收標準都通過" },
  ];
  const criteria: Omit<Criterion, "status">[] = [
    { id: "scope", kind: "check", text: "只改了你指出的部分：其他內容一字不差，要刪的部分真的刪掉了", check: { id: "latex_scope_kept" } },
    { id: "compile", kind: "check", text: "修改後可以成功編譯（沒有 LaTeX 錯誤）", check: { id: "compile_ok" } },
    ...(rewrites.length ? [{ id: "asked", kind: "judge" as const, text: "改寫的部分照你的話修改，沒有改動不相關的句子或捏造內容" }] : []),
  ];
  const list = targets.map((t) => `${t.action === "remove" ? "刪除" : "改寫"}「${t.ref}」`).join("、");
  const files_ = touched.map((p) => byPath.get(p)!);
  return {
    kind: "plan",
    title: `修改論文：${clipText(list, 60)}`,
    studyId,
    objective: `在〈${project.title}〉${list}；其他內容一字不動，修改後仍能編譯。`,
    criteria,
    plan: {
      summary: `${list}。${removals.length ? "刪除不需要撰寫；" : ""}${rewrites.length ? "撰寫者只拿到要改的那一部分；" : ""}其他章節、段落、標籤與引用一字不動，做一次驗證編譯（不改動專案），通過後在${touched.join("、")}建立只涵蓋這些範圍的修改建議。`,
      outline: targets.map((t, i) => ({ n: i + 1, title: `${t.action === "remove" ? "刪除" : "改寫"}「${t.ref}」`, points: t.ranges.map((r) => `${r.path}：${clipText(r.before.replace(/\s+/g, " ").trim(), 80)}`) })),
      writes: files_.map((f) => ({ kind: "latex_file", label: `對 ${f.path} 的修改建議（只涵蓋指定的部分，你在編輯器逐段接受）`, effect: "suggestion" as const })),
    },
    steps,
  };
}

/** The writer of one rewrite: the part's current text only, the user's words, the study's cite keys. */
export async function executeLatexEdit(env: WorkflowEnv, step: StepRow, fix: { previous: StepOutput; issues: string[] } | null): Promise<StepOutput> {
  const st = env.state<LatexEditState>("latex_edit")!;
  const t = st.targets.find((x) => x.key === step.key);
  if (!t) return { summary: "（沒有這個修改）", text: "" };
  const keys = env.state<string[]>("keys") ?? [];
  const r = t.ranges[0]!;
  const words = (env.brief()?.user_words ?? [env.run.request]).join("\n");
  const user = taskPrompt(env, step, {
    context: { user_words: words, current_text: r.before, cite_keys: keys.join(", ") },
    format: [
      `只輸出「${t.ref}」改寫後的完整 LaTeX（取代 current_text），不要 \\documentclass、\\begin{document}、Markdown 或 \`\`\`。`,
      t.heading ? `第一行保留原本的標題指令${t.retitle ? "（可以照使用者的話改標題文字，但指令層級與 \\label 不變）" : "與標題、\\label，一字不改"}；裡面的小節指令與 \\label 都保留。` : "",
      "使用者沒有要求改的句子、數字、\\cite、\\ref、\\label 逐字保留；只做使用者要求的修改。引用只能用 cite_keys 裡的 key。",
    ].filter(Boolean).join("\n"),
  }, fix);
  const res = await env.call({ purpose: "latex_edit", role: "writer", aiRole: "writing", messages: [{ role: "system", content: systemFor("writer", "你修改學術論文 LaTeX 的一個指定部分，只改被要求的地方，其餘逐字保留，語言與原文相同。") }, { role: "user", content: user }], maxTokens: Math.min(16_000, 2000 + Math.ceil(r.before.length * 1.5)) }, step.id);
  const text = stripPreamble(res.text.replace(/^```(?:latex|tex)?\n|\n```\s*$/g, "").trim(), { keepAbstract: true }).text;
  return { summary: `改寫「${clipText(t.ref, 30)}」：${r.before.length} → ${text.length} 字`, text };
}

/** Labels defined in a text (a rewrite keeps every \label its part had). */
const labels = (t: string) => [...t.matchAll(/\\label\{([^}]+)\}/g)].map((m) => m[1]!);
const trailingWs = (t: string) => /\s*$/.exec(t)![0];

/**
 * The write guard: each touched file = its text at planning + the planned splices; the kept segments must be in the
 * result byte for byte (and the files must not have changed since planning — else the ranges would point elsewhere).
 */
export function spliceFiles(files: { path: string; file_id: string; text: string }[], targets: PlannedTarget[], rewritten: Record<string, string>): LatexEditResult {
  const issues: string[] = [];
  const out: LatexEditResult["files"] = [];
  for (const f of files) {
    const splices: (Splice & { before: string })[] = [];
    const removed: string[] = [];
    for (const t of targets) for (const r of t.ranges.filter((x) => x.path === f.path)) {
      if (f.text.slice(r.start, r.end) !== r.before) {
        issues.push(`${f.path} 在規劃後被修改過，「${t.ref}」的位置對不上；請重新規劃。`);
        continue;
      }
      let after = r.after;
      if (after === undefined) {
        const w = rewritten[t.key];
        if (w === undefined || !w.trim()) {
          issues.push(`「${t.ref}」沒有改寫的內容。`);
          continue;
        }
        after = t.heading ? keepHeading(r.before, w, { retitle: t.retitle }) : w.trim();
        after = `${after.replace(/\s*$/, "")}${trailingWs(r.before)}`;
        const lost = labels(r.before).filter((l) => !labels(after!).includes(l));
        if (lost.length) issues.push(`「${t.ref}」改寫後少了標籤 ${lost.map((l) => `\\label{${l}}`).join("、")}（其他地方的 \\ref 會失效）；請保留。`);
      } else if (t.action === "remove") removed.push(r.before);
      splices.push({ start: r.start, end: r.end, after, before: r.before });
    }
    if (!splices.length) continue;
    const next = applySplices(f.text, splices);
    const kept = keptSegments(f.text, splices);
    if (!keepsSegments(next, kept)) issues.push(`${f.path}：指定範圍以外的內容被改動了。`);
    out.push({ path: f.path, file_id: f.file_id, kept, removed, next, splices });
  }
  return { files: out, issues };
}

/** The assemble step: splices + guard + verification compile (a throw-away compile with the changed files). */
export async function assembleLatexEdit(env: WorkflowEnv, verificationCompile: (env: WorkflowEnv, projectId: string, extra: { path: string; content: string }[], root: string) => Promise<{ status: string; errors: string[] }>): Promise<StepOutput> {
  const st = env.state<LatexEditState>("latex_edit")!;
  const project = await findProject(env.db, st.project_id);
  if (!project) throw new WorkflowInputError("LaTeX 專案不存在。");
  const steps = await getSteps(env.db, env.run.id);
  const rewritten = Object.fromEntries(steps.filter((s) => s.key.startsWith("edit_") && s.output?.text).map((s) => [s.key, s.output!.text!]));
  const rows = (await listFiles(env.db, project.id)).filter((f) => Object.keys(st.shas).includes(f.path));
  const files = await Promise.all(rows.map(async (f) => ({ path: f.path, file_id: f.id, text: await liveText(env.db, null, f) })));
  const result = spliceFiles(files, st.targets, rewritten);
  const root = result.files.find((f) => f.path === project.root_file)?.next ?? (await (async () => {
    const rf = (await listFiles(env.db, project.id)).find((f) => f.path === project.root_file);
    return rf ? liveText(env.db, null, rf) : "";
  })());
  const compile = result.issues.some((i) => i.includes("被修改過")) ? { status: "skipped", errors: result.issues } : await verificationCompile(env, project.id, result.files.filter((f) => f.path !== project.root_file).map((f) => ({ path: f.path, content: f.next })), root);
  const scope = { ok: !result.issues.length, issues: result.issues };
  await env.setState({ latex_edit_result: result, tex: result.files.map((f) => f.splices.map((s) => s.after).join("\n\n")).join("\n\n") || "（刪除）" });
  const changed = st.targets.map((t) => `${t.action === "remove" ? "刪除" : "改寫"}「${t.ref}」`).join("、");
  return { summary: `${changed}；驗證編譯：${compile.status}${compile.errors.length ? `（${compile.errors.length} 個錯誤）` : ""}${scope.ok ? "" : `；${scope.issues[0]}`}`, text: env.state<string>("tex") ?? "", data: { compile, scope } };
}

/** The final verification input. */
export async function finalLatexEdit(env: WorkflowEnv): Promise<{ text: string; data: unknown }> {
  const steps = await getSteps(env.db, env.run.id);
  return { text: env.state<string>("tex") ?? "", data: steps.find((s) => s.key === "assemble")?.output?.data ?? null };
}

/** One suggestion per changed file, its hunks = only the planned ranges (re-located when the file moved meanwhile). */
export async function commitLatexEdit(env: WorkflowEnv, outcome: "done" | "partial"): Promise<string | null> {
  const result = env.state<LatexEditResult | null>("latex_edit_result");
  if (env.state<boolean>("committed")) return null;
  if (!result?.files.length) return "沒有寫入（流程在套用修改前就停止了）。";
  if (result.issues.length) return `沒有建立修改建議：${result.issues[0]}`;
  if (!env.run.study_id) return null;
  const access = await requireEditor(env, env.run.study_id);
  const st = env.state<LatexEditState>("latex_edit")!;
  const project = await findProject(env.db, st.project_id);
  if (!project) return "LaTeX 專案已不存在，沒有寫入。";
  const deps = { db: env.db, collab: null };
  const title = outcome === "done" ? "Agent：修改論文" : "Agent：修改論文（未完全通過驗收）";
  const lines: string[] = [];
  for (const f of result.files) {
    const row = (await listFiles(env.db, project.id)).find((x) => x.id === f.file_id);
    if (!row) continue;
    const now = await liveText(env.db, null, row);
    // The planned ranges against the file as it is now: same place, else the same text found exactly once.
    const hunks = f.splices.map((s) => {
      if (now.slice(s.start, s.end) === s.before) return { from: s.start, to: s.end, before: s.before, after: s.after };
      const at = now.indexOf(s.before);
      return at >= 0 && now.indexOf(s.before, at + 1) < 0 ? { from: at, to: at + s.before.length, before: s.before, after: s.after } : null;
    });
    if (hunks.some((h) => !h)) {
      lines.push(`${f.path} 在這段期間被修改過，沒有建立建議`);
      continue;
    }
    try {
      const s = await createSuggestion(deps, { targetType: "latex_file", targetId: f.file_id, hunks: hunks as { from: number; to: number; before: string; after: string }[], title, source: "ai", actorId: env.user.id, conversationId: env.run.conversation_id, user: env.user });
      await addArtifact(env.db, env.run.id, { kind: "latex_file", id: f.file_id, url: `${latexUrl(access.study.slug, project.id, f.file_id)}&suggestion=${s.id}`, title: `${f.path} 的修改建議`, role: "suggestion" });
      lines.push(`已在 ${f.path} 建立修改建議（${hunks.length} 處）`);
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      lines.push(`${f.path}：${e.message}`);
    }
  }
  await env.setState({ committed: true });
  return `${lines.join("；")}。請在 LaTeX 編輯器逐段接受；其他內容沒有變動。`;
}

export const _test = { removalSplices };
export type { Block };
