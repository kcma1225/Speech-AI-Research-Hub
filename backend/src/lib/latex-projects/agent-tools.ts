/**
 * Agent tools of the LaTeX module (registered at import by routes/latex.ts): read projects/files/compile logs,
 * suggest edits to one file (suggestion), and start a compile (write).
 */
import { z } from "zod";
import { registerAgentTool, type AgentToolContext } from "../../agent/tools/registry.js";
import { clip, isUuid, readStudy, scrub, studyRef, uuidArg } from "../../agent/tools/util.js";
import { applySuggestionNow, createSuggestion } from "../suggestions/service.js";
import { badRequest, conflict, forbidden, notFound } from "../http.js";
import { loadStudyAccess } from "../studies/access.js";
import { compileView, findCompile, requestCompile } from "./service.js";
import { findFile, findFileByPath, findProject, isGeneratedBib, latexUrl, listFiles, liveText, sectionTitle } from "./store.js";

async function projectWithAccess(ctx: AgentToolContext, projectId: string) {
  if (!isUuid(projectId)) throw notFound("LaTeX 專案不存在。");
  const project = await findProject(ctx.db, projectId);
  if (!project) throw notFound("LaTeX 專案不存在。");
  return { project, access: await loadStudyAccess(ctx.db, project.study_id, ctx.user) };
}

async function fileOf(ctx: AgentToolContext, projectId: string, ref: { file_id?: string; path?: string }) {
  const file = ref.file_id && isUuid(ref.file_id) ? await findFile(ctx.db, projectId, ref.file_id) : ref.path ? await findFileByPath(ctx.db, projectId, ref.path) : null;
  if (!file) throw notFound("檔案不存在，請先用 latex_list_projects 查看檔案清單。");
  return file;
}

registerAgentTool({
  name: "latex_list_projects",
  title: "列出 LaTeX 專案",
  titleEn: "List LaTeX projects",
  risk: "read",
  description:
    "List a study's LaTeX projects (papers/theses). With project_id, also list that project's files (id, path, role main|section|bib|style|asset, section order and heading) and the latest compile status.",
  input: z.object({ study: studyRef.optional(), project_id: uuidArg("LaTeX project").optional() }),
  summarize: (a) => (a.project_id ? "讀取 LaTeX 專案的檔案清單" : `列出研究 ${a.study ?? ""} 的 LaTeX 專案`),
  async execute(a, ctx) {
    if (a.project_id) {
      const { project, access } = await projectWithAccess(ctx, a.project_id);
      const files = await listFiles(ctx.db, project.id);
      const latest = project.last_compile_id ? compileView(await findCompile(ctx.db, project.id, project.last_compile_id)) : null;
      return {
        data: {
          project: { id: project.id, title: scrub(project.title), kind: project.kind, compiler: project.compiler, root_file: project.root_file, bib_mode: project.bib_mode, can_edit: access.canEdit },
          files: files
            .sort((x, y) => (x.position ?? 9999) - (y.position ?? 9999) || x.path.localeCompare(y.path))
            .map((f) => ({ id: f.id, path: f.path, kind: f.kind, role: f.role, section_order: f.position, heading: f.kind === "text" && /\.tex$/.test(f.path) ? sectionTitle(f.content ?? "") : null, bytes: Number(f.bytes) })),
          latest_compile: latest ? { id: latest.id, status: latest.status, errors: latest.errors.length, warnings: latest.warning_count } : null,
        },
        untrusted: files.some((f) => f.updated_by && f.updated_by !== ctx.user.id),
        source: `LaTeX 專案〈${project.title}〉`,
        links: [{ label: project.title, url: latexUrl(access.study.slug, project.id) }],
      };
    }
    if (!a.study) throw badRequest("請提供 study 或 project_id。");
    const access = await readStudy(ctx, a.study);
    const rows = (await ctx.db.query<{ id: string; title: string; kind: string; compiler: string; updated_at: string; status: string | null }>(
      `SELECT p.id, p.title, p.kind, p.compiler, p.updated_at, c.status FROM latex_projects p LEFT JOIN latex_compiles c ON c.id=p.last_compile_id
        WHERE p.study_id=$1 ORDER BY p.updated_at DESC LIMIT 30`,
      [access.study.id],
    )).rows;
    return { data: { study: { id: access.study.id, slug: access.study.slug, title: access.study.title }, projects: rows.map((r) => ({ ...r, title: scrub(r.title) })) } };
  },
});

registerAgentTool({
  name: "latex_read_file",
  title: "讀取 LaTeX 檔案",
  titleEn: "Read LaTeX file",
  risk: "read",
  description: "Read a text file of a LaTeX project (live collaborative text), by file_id or path. Long files are paged with offset (characters); lines are numbered when line_numbers is true.",
  input: z.object({
    project_id: uuidArg("LaTeX project"),
    file_id: uuidArg("File").optional(),
    path: z.string().max(255).optional().describe("Project-relative path, e.g. sections/introduction.tex"),
    offset: z.number().int().min(0).optional(),
    line_numbers: z.boolean().optional(),
  }),
  summarize: (a) => `讀取 ${a.path ?? "LaTeX 檔案"}`,
  async execute(a, ctx) {
    const { project, access } = await projectWithAccess(ctx, a.project_id);
    const file = await fileOf(ctx, project.id, a);
    if (file.kind !== "text") throw badRequest("這是二進位檔（圖片、PDF…），無法讀取文字。");
    const text = await liveText(ctx.db, ctx.app.collab, file);
    const offset = a.offset ?? 0;
    const shown = a.line_numbers ? text.split("\n").map((l, i) => `${i + 1}: ${l}`).join("\n") : text;
    return {
      data: { file: { id: file.id, path: file.path, role: file.role }, length: shown.length, offset, text: clip(scrub(shown.slice(offset)), 11000), more: shown.length - offset > 11000 },
      untrusted: file.updated_by !== ctx.user.id,
      source: `LaTeX 檔案〈${project.title} · ${file.path}〉`,
      links: [{ label: file.path, url: latexUrl(access.study.slug, project.id, file.id) }],
    };
  },
});

registerAgentTool({
  name: "latex_get_compile_log",
  title: "讀取編譯結果",
  titleEn: "Read compile log",
  risk: "read",
  description: "Latest compile of a LaTeX project: status and the parsed errors/warnings (file, line, message, zh hint). Use it before proposing fixes with latex_suggest_edit.",
  input: z.object({ project_id: uuidArg("LaTeX project"), compile_id: uuidArg("Compile").optional() }),
  summarize: () => "讀取 LaTeX 編譯結果",
  async execute(a, ctx) {
    const { project } = await projectWithAccess(ctx, a.project_id);
    const id = a.compile_id ?? project.last_compile_id;
    const c = id ? compileView(await findCompile(ctx.db, project.id, id)) : null;
    if (!c) return { data: { compile: null, note: "這個專案還沒有編譯過。" } };
    const pick = (d: Record<string, unknown>) => ({ file: d.file, line: d.line, message: scrub(String(d.message ?? "")).slice(0, 400), hint_zh: d.hint_zh, context: d.context ? scrub(String(d.context)).slice(0, 300) : undefined });
    return {
      data: { compile: { id: c.id, status: c.status, error: c.error, created_at: c.created_at, errors: (c.errors as Record<string, unknown>[]).slice(0, 20).map(pick), warnings: (c.warnings as Record<string, unknown>[]).slice(0, 15).map(pick), warning_count: c.warning_count } },
      untrusted: true,
      source: `LaTeX 編譯記錄〈${project.title}〉`,
    };
  },
});

registerAgentTool({
  name: "latex_suggest_edit",
  title: "建議修改 LaTeX 檔案",
  titleEn: "Suggest LaTeX edit",
  risk: "write",
  suggests: true,
  description:
    "Propose changes to ONE text file of a LaTeX project (one section file per suggestion). Give `content` (the full new file text) or `edits` (exact `before` passages from the current text and their replacement). Creates a suggestion the user reviews in the LaTeX editor; nothing is changed directly.",
  input: z.object({
    project_id: uuidArg("LaTeX project"),
    file_id: uuidArg("File").optional(),
    path: z.string().max(255).optional(),
    content: z.string().max(300000).optional(),
    edits: z.array(z.object({ before: z.string().min(1).max(20000).describe("Exact current text (must appear once)"), after: z.string().max(20000) })).max(30).optional(),
    title: z.string().max(80).optional().describe("Short label, e.g. 修正 \\cite 錯誤"),
  }),
  summarize: (a) => `建議修改 ${a.path ?? "LaTeX 檔案"}${a.title ? `：${a.title}` : ""}${a.edits ? `（${a.edits.length} 處）` : ""}`,
  async target(a, ctx) {
    const { project, access } = await projectWithAccess(ctx, a.project_id);
    if (!access.canEdit) throw forbidden(`你不是〈${access.study.title}〉的成員，不能修改這份論文。`);
    const file = await fileOf(ctx, project.id, a);
    return { studyId: access.study.id, studySlug: access.study.slug, label: `${project.title} · ${file.path}`, url: latexUrl(access.study.slug, project.id, file.id) };
  },
  async execute(a, ctx) {
    const { project, access } = await projectWithAccess(ctx, a.project_id);
    if (!access.canEdit) throw forbidden(`你不是〈${access.study.title}〉的成員，不能修改這份論文。`);
    const file = await fileOf(ctx, project.id, a);
    if (file.kind !== "text") throw badRequest("只能修改文字檔。");
    if (isGeneratedBib({ ...project, path: file.path })) throw badRequest("這個 .bib 檔由文獻庫自動產生；請改用文獻庫工具新增文獻。");
    if (a.content === undefined && !a.edits?.length) throw badRequest("請提供 content 或 edits。");
    let hunks: { from: number; to: number; before: string; after: string }[] | undefined;
    if (a.content === undefined) {
      const text = await liveText(ctx.db, ctx.app.collab, file);
      hunks = a.edits!.map((e) => {
        const at = text.indexOf(e.before);
        if (at < 0) throw conflict(`檔案中找不到這段文字：「${clip(e.before, 40)}」，請先用 latex_read_file 讀取目前內容。`);
        if (text.indexOf(e.before, at + 1) >= 0) throw badRequest(`這段文字出現多次，請提供更長的段落：「${clip(e.before, 40)}」`);
        return { from: at, to: at + e.before.length, before: e.before, after: e.after };
      });
    }
    const input = {
      targetType: "latex_file", targetId: file.id, proposedText: a.content, hunks, title: a.title || "AI 建議",
      source: "ai" as const, actorId: ctx.user.id, conversationId: ctx.conversationId, user: ctx.user,
    };
    const deps = { db: ctx.db, collab: ctx.app.collab ?? null };
    const url = latexUrl(access.study.slug, project.id, file.id);
    if (ctx.autopilot && ctx.source === "agent") {
      const r = await applySuggestionNow(deps, { ...input, source: "autopilot" });
      return { data: { applied: r.applied, suggestion_id: r.suggestion.id, file: { id: file.id, path: file.path } }, links: [{ label: "已自動套用（可在建議紀錄查看）", url }] };
    }
    const s = await createSuggestion(deps, input);
    return { data: { suggestion_id: s.id, hunks: s.pending, status: "pending_review", file: { id: file.id, path: file.path } }, links: [{ label: "在論文編輯器檢視建議", url: `${url}&suggestion=${s.id}`, kind: "suggestion" }] };
  },
});

registerAgentTool({
  name: "latex_compile",
  title: "編譯 LaTeX",
  titleEn: "Compile LaTeX",
  risk: "write",
  description: "Start a compile of a LaTeX project (refs.bib is regenerated from the study library first when the project uses auto bibliography). Returns the compile id; read the result later with latex_get_compile_log.",
  input: z.object({ project_id: uuidArg("LaTeX project"), draft: z.boolean().optional().describe("One fast pass without BibTeX") }),
  summarize: (a) => `編譯 LaTeX 專案${a.draft ? "（草稿）" : ""}`,
  async target(a, ctx) {
    const { project, access } = await projectWithAccess(ctx, a.project_id);
    if (!access.canEdit) throw forbidden(`你不是〈${access.study.title}〉的成員，不能編譯這份論文。`);
    return { studyId: access.study.id, studySlug: access.study.slug, label: project.title, url: latexUrl(access.study.slug, project.id) };
  },
  async execute(a, ctx) {
    const { project, access } = await projectWithAccess(ctx, a.project_id);
    if (!access.canEdit) throw forbidden(`你不是〈${access.study.title}〉的成員，不能編譯這份論文。`);
    const compileId = await requestCompile({ db: ctx.db, storage: ctx.app.storage, collab: ctx.app.collab ?? null }, project, { actorId: ctx.user.id, draft: a.draft });
    return { data: { compile_id: compileId, status: "queued", note: "編譯約需 10–60 秒，之後用 latex_get_compile_log 讀取結果。" }, links: [{ label: project.title, url: latexUrl(access.study.slug, project.id) }] };
  },
});
