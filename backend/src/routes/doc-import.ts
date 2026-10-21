import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { aiFor, toHttpError } from "../ai/platform/index.js";
import type { ChatMessage } from "../ai/types.js";
import { requireUser } from "../lib/auth.js";
import { DOC_IMPORT_ACCEPT, DOC_IMPORT_FORMATS, DOC_IMPORT_MAX_BYTES, importDocument, type ImportedDocument } from "../lib/doc-import/index.js";
import { badRequest, HttpError, parse } from "../lib/http.js";
import { loadStudyAccess, requireStudyEditor } from "../lib/studies/access.js";
import { createSuggestion } from "../lib/suggestions/service.js";
import "../lib/suggestions/study-summary.js";
import mdImages from "./md-images.js";

/**
 * Document import (研究簡述「從檔案匯入」, note editor 「匯入文件」): the upload is checked by extension and by
 * content (Google Magika, `lib/doc-import`), converted to Markdown, and optionally condensed by AI (role
 * `writing`). Existing studies get a `study_summary` suggestion; everything else only returns the Markdown.
 * Also registers the Markdown image routes (`md-images.ts`).
 */
const fields = z.object({
  mode: z.enum(["markdown", "condense"]).default("markdown"),
  purpose: z.enum(["study_summary", "note"]).default("study_summary"),
  /** Ignored (old clients); the model picks the structure. */
  style: z.string().max(20).optional(),
  placement: z.enum(["append", "replace"]).default("append"),
  study_id: z.uuid().optional(),
});
type Fields = z.infer<typeof fields>;
const studyParams = z.object({ id: z.string().min(1).max(80) });

/** Input sent to the model (the rest of a long document is dropped, with a note in the prompt). */
const AI_INPUT_CHARS = 24_000;
/** Longest Markdown accepted into a summary suggestion (studies.summary_md allows 100 000). */
const SUMMARY_MAX = 100_000;

/** Reads the multipart body: fields + the single file (buffered; ≤ 30 MB). */
async function readUpload(request: FastifyRequest): Promise<{ fields: Fields; file: { name: string; bytes: Buffer } }> {
  if (!request.isMultipart()) throw badRequest("請選擇要匯入的檔案。");
  const raw: Record<string, string> = {};
  let file: { name: string; bytes: Buffer } | null = null;
  for await (const part of request.parts({ limits: { fileSize: DOC_IMPORT_MAX_BYTES, files: 1 } })) {
    if (part.type === "field") {
      if (typeof part.value === "string") raw[part.fieldname] = part.value;
      continue;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of part.file) chunks.push(chunk as Buffer);
    if (part.file.truncated) throw new HttpError(413, "檔案超過 30 MB。", { code: "too_large" });
    file = { name: (part.filename || "document").slice(0, 255), bytes: Buffer.concat(chunks) };
  }
  if (!file) throw badRequest("請選擇要匯入的檔案。");
  return { fields: parse(fields, raw), file };
}

const unfence = (text: string) => {
  const t = text.trim();
  const m = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i.exec(t);
  return (m ? m[1]! : t).trim();
};

function condensePrompt(purpose: Fields["purpose"], doc: ImportedDocument, markdown: string, context: { title?: string; current?: string }): ChatMessage[] {
  const clipped = markdown.length > AI_INPUT_CHARS;
  const body = clipped ? markdown.slice(0, AI_INPUT_CHARS) : markdown;
  const system =
    purpose === "study_summary"
      ? [
          "你是研究所實驗室的研究助理。把使用者提供的文件整理成「研究簡述」，用繁體中文（台灣用語）與 Markdown 輸出。",
          "結構：用 `## 研究問題`、`## 方法`、`## 資料與實驗`、`## 預期成果與進度` 等小標分組（文件沒有的部分就省略）；每組依內容選擇自然的寫法——條列適合並列的事實（資料集、指標、步驟），敘述性的脈絡（動機、方法的思路）用 1–2 段簡潔文字。",
          "只根據文件內容，不要編造數字、結果或引用；專有名詞、模型與資料集名稱保留原文。",
          "直接輸出簡述本身，不要前言、不要結語、不要用 ``` 包起來。",
        ].join("\n")
      : [
          "你是研究所實驗室的研究助理。把使用者提供的文件整理成一份研究筆記，用繁體中文（台灣用語）與 Markdown 輸出。",
          "結構：`## 重點摘要`（3–6 條）、`## 內容整理`（依文件章節的精簡條列）、`## 值得追問`（2–4 個問題）。",
          "只根據文件內容，不要編造；專有名詞保留原文。直接輸出筆記，不要前言、不要用 ``` 包起來。",
        ].join("\n");
  const parts = [
    context.title ? `研究：${context.title}` : "",
    context.current ? `目前的研究簡述（請整合進新的版本，保留仍正確的內容）：\n<目前簡述>\n${context.current.slice(0, 6000)}\n</目前簡述>` : "",
    `文件：${doc.filename}${doc.title ? `（標題：${doc.title}）` : ""}${clipped ? `（文件很長，以下只有前 ${AI_INPUT_CHARS} 字）` : ""}`,
    `<文件>\n${body}\n</文件>`,
  ].filter(Boolean);
  return [
    { role: "system", content: system },
    { role: "user", content: parts.join("\n\n") },
  ];
}

async function condense(app: FastifyInstance, userId: string, messages: ChatMessage[]): Promise<string> {
  const ai = aiFor(app);
  let text: string;
  try {
    const r = await ai.chat("writing", { messages, maxTokens: 3000, temperature: 0.3, reasoning: { effort: "low" } }, { userId });
    text = r.text;
    // Reasoning models can spend the whole budget thinking: retry once without thinking and a larger budget.
    if (!text.trim() && r.stopReason === "max_tokens") text = (await ai.chat("writing", { messages, maxTokens: 6000, temperature: 0.3, reasoning: { enabled: false, effort: "none" } }, { userId })).text;
  } catch (e) {
    throw toHttpError(e);
  }
  const out = unfence(text);
  if (!out) throw new HttpError(502, "AI 沒有回覆內容，請再試一次。", { code: "empty_reply" });
  return out;
}

export default async function docImport(app: FastifyInstance) {
  await app.register(mdImages);

  app.get("/doc-import/formats", async (request) => {
    await requireUser(request);
    return { formats: DOC_IMPORT_FORMATS.map((f) => ({ format: f.format, extensions: f.extensions })), accept: DOC_IMPORT_ACCEPT, maxBytes: DOC_IMPORT_MAX_BYTES };
  });

  /** Converts (and optionally condenses) a document; nothing is stored. With `study_id` the caller must be a study editor. */
  app.post("/doc-import", async (request) => {
    const user = await requireUser(request);
    const { fields: input, file } = await readUpload(request);
    let title: string | undefined;
    if (input.study_id) {
      const access = await loadStudyAccess(app.db, input.study_id, user);
      if (!access.canEdit) throw new HttpError(403, "只有研究成員可以匯入文件。");
      title = access.study.title;
    }
    const doc = await importDocument(file.bytes, file.name);
    const markdown = input.mode === "condense" ? await condense(app, user.id, condensePrompt(input.purpose, doc, doc.markdown, { title })) : doc.markdown;
    request.log.info({ format: doc.format, detected: doc.detected.label, chars: doc.chars, mode: input.mode }, "doc import");
    return { markdown, document: publicDoc(doc) };
  });

  /** 研究簡述「從檔案匯入」 for an existing study → pending `study_summary` suggestion (201). */
  app.post("/studies/:id/summary/import", async (request, reply) => {
    const { id } = parse(studyParams, request.params);
    const { user, access } = await requireStudyEditor(request, id);
    const { fields: input, file } = await readUpload(request);
    const doc = await importDocument(file.bytes, file.name);
    const current = access.study.summary_md ?? "";
    const body =
      input.mode === "condense"
        ? await condense(app, user.id, condensePrompt("study_summary", doc, doc.markdown, { title: access.study.title, current: input.placement === "replace" ? current : undefined }))
        : doc.markdown;
    const prefix = input.placement === "replace" || !current.trim() ? "" : `${current.replace(/\s+$/, "")}\n\n`;
    const room = SUMMARY_MAX - prefix.length - 1;
    if (room < 200) throw new HttpError(413, "研究簡述已經太長，無法再加入這份文件。");
    const finalText = `${prefix}${body.slice(0, room).replace(/\s+$/, "")}\n`;
    const suggestion = await createSuggestion(
      { db: app.db },
      {
        targetType: "study_summary",
        targetId: access.study.id,
        proposedText: finalText,
        title: `${input.mode === "condense" ? "AI 摘要文件" : "從檔案匯入"}：${doc.filename}`.slice(0, 200),
        source: input.mode === "condense" ? "ai" : "user",
        actorId: user.id,
        user,
      },
    );
    request.log.info({ format: doc.format, detected: doc.detected.label, chars: doc.chars, mode: input.mode, study: access.study.id }, "summary import");
    return reply.code(201).send({ suggestion, document: publicDoc(doc) });
  });
}

const publicDoc = (doc: ImportedDocument) => ({
  filename: doc.filename,
  format: doc.format,
  detected: doc.detected,
  title: doc.title,
  chars: doc.chars,
  truncated: doc.truncated,
  ...(doc.pages !== undefined ? { pages: doc.pages } : {}),
  warnings: doc.warnings,
});
