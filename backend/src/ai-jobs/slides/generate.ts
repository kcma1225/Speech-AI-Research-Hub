/**
 * `ai_slides_generate` (ai-worker): drafts a Lab-Hub Quarto deck (progress report or paper report) into the deck's
 * source tree, then checks it with a quick preview render and, if that fails, asks the model once to fix it.
 * Stages (jobs.stage): context → generating → writing → validating → (fixing → validating) → done.
 */
import { transaction, type Db } from "../../db.js";
import { AiJobInputError, type AiJobContext } from "../../ai-worker/registry.js";
import { extractPdfText } from "../../lib/library/pdf.js";
import type { Storage } from "../../lib/storage.js";
import { cleanBody, draftMessages, draftQmd, fixMessages, paperContext, progressContext, type DeckMode } from "../../lib/slides/ai-context.js";
import { enqueuePreview } from "../../lib/slides/preview.js";
import { createTree, loadTree, saveText } from "../../lib/slides/sources.js";
import { progressTitle, taipeiToday } from "../../lib/slides/templates.js";
import { visualSelfFix } from "../../lib/vision/slides.js";

export const SLIDES_GENERATE_JOB = "ai_slides_generate";

export type SlidesGeneratePayload = {
  deckId: string;
  userId: string;
  mode: DeckMode;
  instructions?: string;
  /** Label for the jobs tray (`/jobs/active` shows `payload.fileName`). */
  fileName?: string;
};
export type SlidesGenerateResult = { revision: number; previewId: string | null; valid: boolean | null; fixed: boolean; pages: number; /** Fixes applied by the visual self-check (vision models only). */ visualFixes?: number };

/** Generous: reasoning models spend thousands of tokens thinking before the deck (the cheap test model cannot turn it off). */
const MAX_TOKENS: Record<DeckMode, number> = { progress: 12_000, paper_report: 16_000 };
/** Rough size of reasoning + reply, for the progress bar. */
const EXPECTED_CHARS: Record<DeckMode, number> = { progress: 7000, paper_report: 12_000 };
export const PREVIEW_WAIT_MS = 240_000;

type Deck = { id: string; study_id: string; kind: DeckMode; title: string; paper_id: string | null; metadata: Record<string, unknown> };

async function pdfText(pdf: Buffer) {
  const result = await extractPdfText(new Uint8Array(pdf), { maxPages: 12 });
  return result.pages.join("\n");
}

/** Streams one completion, reporting progress between `from` and `to` percent. */
async function complete(ctx: AiJobContext<SlidesGeneratePayload>, messages: ReturnType<typeof draftMessages>, mode: DeckMode, stage: string, from: number, to: number) {
  let text = "";
  let produced = 0;
  let last = Date.now();
  for await (const event of ctx.ai.chatStream("slides", { messages, maxTokens: MAX_TOKENS[mode], reasoning: { effort: "low" } }, { userId: ctx.job.payload.userId, jobId: ctx.job.id, signal: ctx.signal })) {
    if (event.type === "text_delta" || event.type === "reasoning_delta") {
      if (event.type === "text_delta") text += event.text;
      produced += event.text.length;
      if (Date.now() - last > 1500) {
        last = Date.now();
        await ctx.progress(stage, from + Math.min(to - from - 1, (produced / EXPECTED_CHARS[mode]) * (to - from)));
      }
    } else if (event.type === "error") throw event.error;
  }
  return text;
}

/** Writes `qmd` as the tree's entry file (creating the tree when missing) and returns the new revision. */
async function writeDraft(db: Db, deckId: string, userId: string, qmd: string) {
  return transaction(db, async client => {
    await client.query("SELECT 1 FROM decks WHERE id=$1 FOR UPDATE", [deckId]);
    let tree = await loadTree(client, deckId, true);
    if (!tree) {
      await createTree(client, deckId, userId, "ai", []);
      tree = (await loadTree(client, deckId, true))!;
    }
    const saved = await saveText(client, deckId, tree.entry, qmd, userId);
    return saved.revision;
  });
}

/** Waits for a preview job to finish; returns its error (null = rendered) or undefined when it did not finish in time. */
async function waitForPreview(db: Db, jobId: string | null, signal: AbortSignal, timeoutMs = PREVIEW_WAIT_MS): Promise<string | null | undefined> {
  if (!jobId) return null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error("aborted");
    const job = (await db.query<{ status: string; error: string | null }>("SELECT status,error FROM jobs WHERE id=$1", [jobId])).rows[0];
    if (!job) return undefined;
    if (job.status === "succeeded") return null;
    if (job.status === "failed") return job.error ?? "編譯失敗";
    if (job.status === "cancelled") return undefined;
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  return undefined;
}

export async function runSlidesGenerate(ctx: AiJobContext<SlidesGeneratePayload>, deps: { storage: Storage; waitMs?: number; extractText?: (pdf: Buffer) => Promise<string> }): Promise<SlidesGenerateResult> {
  const { db, job } = ctx;
  const { deckId, userId } = job.payload ?? ({} as SlidesGeneratePayload);
  if (!deckId || !userId) throw new AiJobInputError("工作內容不正確。");
  const deck = (await db.query<Deck>("SELECT id,study_id,kind,title,paper_id,metadata FROM decks WHERE id=$1", [deckId])).rows[0];
  if (!deck) throw new AiJobInputError("簡報不存在。");
  // AI acts with the caller's permissions: they must still be able to edit the deck's study.
  const member = await db.query<{ name: string }>(
    "SELECT u.name FROM study_members m JOIN users u ON u.id=m.user_id WHERE m.study_id=$1 AND m.user_id=$2 AND m.role IN ('owner','member') AND u.disabled_at IS NULL",
    [deck.study_id, userId],
  );
  if (!member.rowCount) throw new AiJobInputError("只有研究成員可以產生簡報。");
  const author = member.rows[0]!.name;
  const mode: DeckMode = job.payload.mode === "paper_report" || job.payload.mode === "progress" ? job.payload.mode : deck.kind;

  await ctx.progress("context", 5);
  const study = (await db.query<{ title: string }>("SELECT title FROM studies WHERE id=$1", [deck.study_id])).rows[0]!;
  const date = taipeiToday();
  let data: string;
  let title = deck.title;
  let subtitle: string | undefined;
  if (mode === "progress") {
    data = await progressContext(db, deck.id, deck.study_id);
    if (!title.trim()) title = progressTitle(study.title, date);
  } else {
    const paper = await paperContext(db, deps.storage, deck, deps.extractText ?? pdfText);
    data = paper.data;
    title = paper.title ?? deck.title;
    subtitle = paper.subtitle;
    if (!data.trim()) throw new AiJobInputError("請先填寫要報告的論文（標題、摘要或上傳論文 PDF 作為參考資料）。");
  }

  await ctx.progress("generating", 10);
  let reply = await complete(ctx, draftMessages(mode, data, job.payload.instructions), mode, "generating", 10, 75);
  let body = cleanBody(reply);
  let fixed = false;
  if (!body) {
    // One more try when the reply had no slides at all.
    reply = await complete(ctx, fixMessages(mode, reply, "輸出中沒有任何以「## 」開頭的投影片。"), mode, "fixing", 75, 80);
    body = cleanBody(reply);
    fixed = true;
    if (!body) throw new AiJobInputError("AI 產生的內容不是投影片，請再試一次。");
  }
  const header = { title, author, date, ...(subtitle ? { subtitle } : {}) };

  await ctx.progress("writing", 80);
  let revision = await writeDraft(db, deck.id, userId, draftQmd(header, body));
  await db.query("UPDATE deck_source_trees SET origin='ai' WHERE deck_id=$1", [deck.id]);

  await ctx.progress("validating", 85);
  // With a vision model the check also captures screenshots for one visual self-check (lib/vision/slides.ts).
  let vision = false;
  try {
    vision = Boolean((await ctx.ai.capabilities?.("slides"))?.vision);
  } catch {
    vision = false;
  }
  let preview = await enqueuePreview(db, deps.storage, deck.id, userId, { shots: vision });
  let error = await waitForPreview(db, preview.preview.job_id, ctx.signal, deps.waitMs);
  if (typeof error === "string" && !fixed) {
    await ctx.progress("fixing", 90);
    const repaired = cleanBody(await complete(ctx, fixMessages(mode, body, error), mode, "fixing", 90, 95));
    if (repaired) {
      body = repaired;
      fixed = true;
      revision = await writeDraft(db, deck.id, userId, draftQmd(header, body));
      await ctx.progress("validating", 95);
      preview = await enqueuePreview(db, deps.storage, deck.id, userId, { shots: vision });
      error = await waitForPreview(db, preview.preview.job_id, ctx.signal, deps.waitMs);
    }
  }
  let visualFixes: number | undefined;
  if (vision && error === null) {
    await ctx.progress("visual_check", 96);
    const patched = await visualSelfFix(ctx.ai, db, deps.storage, { id: deck.id, kind: mode, title }, preview.preview.id, { userId, signal: ctx.signal, log: ctx.log });
    if (patched) {
      const before = draftQmd(header, body);
      const nextRevision = await writeDraft(db, deck.id, userId, patched.text);
      const checked = await enqueuePreview(db, deps.storage, deck.id, userId);
      const checkError = await waitForPreview(db, checked.preview.job_id, ctx.signal, deps.waitMs);
      if (checkError === null) {
        revision = nextRevision;
        preview = checked;
        body = patched.text;
        visualFixes = patched.applied;
      } else revision = await writeDraft(db, deck.id, userId, before); // the fix broke the render: keep the checked draft
    }
  }
  return {
    revision,
    previewId: preview.preview.id,
    valid: error === undefined ? null : error === null,
    fixed,
    pages: (body.match(/^## /gm) ?? []).length,
    ...(visualFixes ? { visualFixes } : {}),
  };
}

