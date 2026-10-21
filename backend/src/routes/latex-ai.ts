/**
 * AI actions of the LaTeX editor (role `writing`): 「AI 改寫段落」, 「AI 依筆記草擬本節」 and 「解釋/修正編譯錯誤」.
 * Each one ends as a suggestion on one section file (`latex_file`), never a direct write.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { aiFor, toHttpError } from "../ai/platform/index.js";
import type { ChatMessage } from "../ai/types.js";
import { badRequest, conflict, HttpError, notFound, parse } from "../lib/http.js";
import type { LatexDiagnostic } from "../lib/latex/contract.js";
import { createSuggestion } from "../lib/suggestions/service.js";
import { cleanLatex, draftContext, keepTrailingNewlines, draftMessages, fixMessages, parseFixReply, rewriteMessages, type RewriteMode } from "../lib/latex-projects/ai.js";
import { findCompile } from "../lib/latex-projects/service.js";
import { findFile, findFileByPath, isGeneratedBib, liveText, sectionTitle } from "../lib/latex-projects/store.js";
import { editableProject } from "./latex-shared.js";

const fileParams = z.object({ id: z.uuid(), fileId: z.uuid() });
const compileParams = z.object({ id: z.uuid(), compileId: z.uuid() });
const instruction = z.string().trim().max(1000).optional();
const rewriteInput = z.object({
  from: z.number().int().min(0),
  to: z.number().int().min(0),
  before: z.string().min(1).max(30_000),
  mode: z.enum(["rewrite", "polish", "shorten", "expand", "translate_en", "translate_zh"]).default("rewrite"),
  instruction,
});
const draftInput = z.object({ instruction });
const fixInput = z.object({ index: z.number().int().min(0).max(299), severity: z.enum(["error", "warning"]).default("error") });

/** 503 `llm_unavailable` (the UI shows 維護中 via AiGate) unless role `writing` is usable. */
async function requireWriting(app: FastifyInstance) {
  const status = (await aiFor(app).status()).roles.writing;
  if (!status || (status.state !== "ok" && status.state !== "degraded")) {
    throw new HttpError(503, "AI 寫作功能維護中，請稍後再試。", { code: "llm_unavailable", hint: status?.message_zh || "請管理員到「模型設定」綁定 writing 功能。" });
  }
}

/**
 * Reasoning models may spend the whole budget thinking (even at low effort) and return no text: retry once with
 * thinking off and twice the budget.
 */
async function chat(app: FastifyInstance, messages: ChatMessage[], maxTokens: number, userId: string) {
  try {
    const r = await aiFor(app).chat("writing", { messages, maxTokens, temperature: 0.3, reasoning: { effort: "low" } }, { userId });
    if (r.text.trim() || r.stopReason !== "max_tokens") return r.text;
    const again = await aiFor(app).chat("writing", { messages, maxTokens: Math.min(16_000, maxTokens * 2), temperature: 0.3, reasoning: { enabled: false, effort: "none" } }, { userId });
    return again.text;
  } catch (e) {
    throw toHttpError(e);
  }
}

export default async function latexAi(app: FastifyInstance) {
  const textFile = async (projectId: string, fileId: string) => {
    const file = await findFile(app.db, projectId, fileId);
    if (!file || file.kind !== "text") throw notFound("檔案不存在。");
    return file;
  };

  app.post("/latex/:id/files/:fileId/ai/rewrite", async (request, reply) => {
    const { id, fileId } = parse(fileParams, request.params);
    const input = parse(rewriteInput, request.body, "請先選取要處理的文字。");
    const { user, project } = await editableProject(request, id);
    const file = await textFile(id, fileId);
    if (isGeneratedBib({ ...project, path: file.path })) throw badRequest("這個檔案由文獻庫自動產生。");
    if (input.to <= input.from) throw badRequest("請先選取要處理的文字。");
    const text = await liveText(app.db, app.collab, file);
    if (text.slice(input.from, input.to) !== input.before) throw conflict("內容已經變更，請重新選取後再試。");
    await requireWriting(app);
    const context = `${text.slice(Math.max(0, input.from - 1500), input.from)}【選取段落】${text.slice(input.to, input.to + 1500)}`;
    let out = cleanLatex(await chat(app, rewriteMessages({ selection: input.before, mode: input.mode as RewriteMode, instruction: input.instruction, path: file.path, context }), Math.min(12_000, 4000 + Math.ceil(input.before.length * 1.5)), user.id));
    if (!out.trim()) throw new HttpError(502, "AI 沒有回覆內容，請再試一次。", { code: "empty_reply" });
    out = keepTrailingNewlines(input.before, out);
    const suggestion = await createSuggestion({ db: app.db, collab: app.collab }, {
      targetType: "latex_file", targetId: file.id, hunks: [{ from: input.from, to: input.to, before: input.before, after: out }],
      title: input.instruction ? `AI：${input.instruction.slice(0, 60)}` : "AI 改寫段落", source: "ai", actorId: user.id, user,
    });
    return reply.code(201).send({ suggestion });
  });

  app.post("/latex/:id/files/:fileId/ai/draft", async (request, reply) => {
    const { id, fileId } = parse(fileParams, request.params);
    const input = parse(draftInput, request.body ?? {});
    const { user, project } = await editableProject(request, id);
    const file = await textFile(id, fileId);
    if (!/\.tex$/i.test(file.path) || file.path === project.root_file) throw badRequest("只能草擬章節檔。");
    await requireWriting(app);
    const current = await liveText(app.db, app.collab, file);
    const ctx = await draftContext(app.db, project.study_id);
    const out = cleanLatex(await chat(app, draftMessages({ ...ctx, sectionTitle: sectionTitle(current), path: file.path, current, instruction: input.instruction }), 8000, user.id));
    if (!out.trim()) throw new HttpError(502, "AI 沒有回覆內容，請再試一次。", { code: "empty_reply" });
    const suggestion = await createSuggestion({ db: app.db, collab: app.collab }, {
      targetType: "latex_file", targetId: file.id, proposedText: out.endsWith("\n") ? out : `${out}\n`, title: "AI 依筆記草擬", source: "ai", actorId: user.id, user,
    });
    return reply.code(201).send({ suggestion });
  });

  app.post("/latex/:id/compiles/:compileId/ai/fix", async (request, reply) => {
    const { id, compileId } = parse(compileParams, request.params);
    const input = parse(fixInput, request.body);
    const { user } = await editableProject(request, id);
    const compile = await findCompile(app.db, id, compileId);
    if (!compile) throw notFound("找不到這次編譯。");
    const result = (compile.result ?? {}) as { errors?: LatexDiagnostic[]; warnings?: LatexDiagnostic[] };
    const diagnostic = (input.severity === "error" ? result.errors : result.warnings)?.[input.index];
    if (!diagnostic) throw notFound("找不到這個錯誤。");
    await requireWriting(app);
    // The offending file: from the snapshot's path → id map (renames since then), else by path.
    const fileId = diagnostic.file ? compile.file_map?.[diagnostic.file] : undefined;
    const file = (fileId ? await findFile(app.db, id, fileId) : null) ?? (diagnostic.file ? await findFileByPath(app.db, id, diagnostic.file) : null);
    if (!file || file.kind !== "text" || !diagnostic.line || diagnostic.generated) {
      // Nothing to patch (TeX tree file, generated file, unknown line): explanation only.
      const text = await chat(app, fixMessages({ diagnostic, path: diagnostic.file ?? "（未知檔案）", window: "（無法取得對應的原始碼）", firstLine: 0, lastLine: 0 }), 2500, user.id);
      return reply.send({ explanation: parseFixReply(text).explanation, suggestion: null, file_id: null, line: diagnostic.line });
    }
    const text = await liveText(app.db, app.collab, file);
    const lines = text.split("\n");
    const at = Math.min(Math.max(diagnostic.line, 1), lines.length);
    const first = Math.max(1, at - 4);
    const last = Math.min(lines.length, at + 4);
    const window = lines.slice(first - 1, last).join("\n");
    const reply_text = await chat(app, fixMessages({ diagnostic, path: file.path, window, firstLine: first, lastLine: last }), 4000, user.id);
    const parsed = parseFixReply(reply_text);
    const explanation = parsed.explanation;
    const code = parsed.code === null ? null : keepTrailingNewlines(window, parsed.code);
    let suggestion = null;
    if (code !== null && code !== window) {
      const from = lines.slice(0, first - 1).join("\n").length + (first > 1 ? 1 : 0);
      const to = from + window.length;
      suggestion = await createSuggestion({ db: app.db, collab: app.collab }, {
        targetType: "latex_file", targetId: file.id, hunks: [{ from, to, before: window, after: code }],
        title: `修正編譯錯誤：${(diagnostic.title_zh ?? diagnostic.message).slice(0, 50)}`, source: "ai", actorId: user.id, user,
      }).catch((e: unknown) => {
        if (e instanceof HttpError && e.status === 400) return null; // the fix changes nothing
        throw e;
      });
    }
    return reply.send({ explanation: explanation || "（AI 沒有提供說明）", suggestion, file_id: file.id, line: at });
  });
}
