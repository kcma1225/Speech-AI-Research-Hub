/**
 * `ai_slides_generate` (ai-worker): drafts a Lab-Hub Quarto deck (progress report or paper report) into the deck's
 * source tree, then checks it with a quick preview render and, if that fails, asks the model once to fix it.
 * Stages (jobs.stage): context → generating → (continuing)* → writing → validating → (fixing → validating) →
 * (visual_check) → (publishing) → done.
 *
 * Truncation guard: a reply that stops early (stop reason max_tokens / content filter, or far fewer `## ` pages than the
 * user's plan — seen with the ChatGPT subscription, which returned 1 of 11 pages and ended normally) is continued up to
 * MAX_CONTINUE_ROUNDS times; a draft that is still short is written but marked `partial`, and one with at most a
 * single page (of ≥ 3 planned) fails without touching the source. A complete, rendering draft of a deck with no
 * version yet is published as v1 automatically so the deck page plays it right away.
 */
import { transaction, type Db } from "../../db.js";
import { AiJobInputError, type AiJobContext } from "../../ai-worker/registry.js";
import { extractPdfText } from "../../lib/library/pdf.js";
import type { Storage } from "../../lib/storage.js";
import { loadConfig } from "../../config.js";
import type { StopReason } from "../../ai/types.js";
import {
  appendSlides, cleanBody, continueMessages, countSlides, draftMessages, draftQmd, dropLastSlide, expectedPages, fixMessages, paperContext, progressContext, type DeckMode,
} from "../../lib/slides/ai-context.js";
import { publishTree } from "../../lib/slides/publish.js";
import { notifyFromJob } from "../meetings/notify.js";
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
export type SlidesGenerateResult = {
  revision: number;
  previewId: string | null;
  valid: boolean | null;
  fixed: boolean;
  pages: number;
  /** Pages the user's plan asked for (explicit count / numbered structure / format default). */
  expectedPages?: number;
  /** Continuation requests sent after an early stop. */
  continued?: number;
  /** The draft has fewer pages than planned (or still ended on the token limit); `warning` says so in 繁中. */
  partial?: boolean;
  warning?: string;
  /** Version number published automatically (first version of a deck without versions). */
  publishedVersion?: number;
  /** Fixes applied by the visual self-check (vision models only). */
  visualFixes?: number;
};

/** Generous: reasoning models spend thousands of tokens thinking before the deck (the cheap test model cannot turn it off). */
const MAX_TOKENS: Record<DeckMode, number> = { progress: 12_000, paper_report: 16_000 };
/** Rough size of reasoning + reply, for the progress bar. */
const EXPECTED_CHARS: Record<DeckMode, number> = { progress: 7000, paper_report: 12_000 };
export const PREVIEW_WAIT_MS = 240_000;
export const MAX_CONTINUE_ROUNDS = 3;

type Deck = { id: string; study_id: string; kind: DeckMode; title: string; paper_id: string | null; metadata: Record<string, unknown> };
type Completion = { text: string; stop: StopReason | undefined };
type Messages = { role: "system" | "user" | "assistant"; content: string }[];

/** Fewest pages that count as complete: 80 % of the plan. */
const enoughPages = (expected: number) => Math.max(1, Math.ceil(expected * 0.8));
const cutOff = (stop: StopReason | undefined) => stop === "max_tokens" || stop === "content_filter" || stop === "other";

async function pdfText(pdf: Buffer) {
  const result = await extractPdfText(new Uint8Array(pdf), { maxPages: 12 });
  return result.pages.join("\n");
}

/** Streams one completion, reporting progress between `from` and `to` percent; returns the text and stop reason. */
async function complete(ctx: AiJobContext<SlidesGeneratePayload>, messages: Messages, mode: DeckMode, stage: string, from: number, to: number): Promise<Completion> {
  let text = "";
  let stop: StopReason | undefined;
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
    } else if (event.type === "done") stop = event.stopReason;
    else if (event.type === "error") throw event.error;
  }
  return { text, stop };
}

/**
 * The draft body with the truncation guard: continues a reply that stopped early (token limit, filter, or too few
 * pages for the plan) up to MAX_CONTINUE_ROUNDS times, appending only new slides.
 */
async function draftBody(ctx: AiJobContext<SlidesGeneratePayload>, mode: DeckMode, messages: Messages, expected: number) {
  let { text: reply, stop } = await complete(ctx, messages, mode, "generating", 10, 70);
  let first = cleanBody(reply);
  let fixed = false;
  if (!first) {
    // One more try when the reply had no slides at all.
    ({ text: reply, stop } = await complete(ctx, fixMessages(mode, reply, "輸出中沒有任何以「## 」開頭的投影片。"), mode, "fixing", 70, 72));
    first = cleanBody(reply);
    fixed = true;
    if (!first) throw new AiJobInputError("AI 產生的內容不是投影片，請再試一次。");
  }
  let body: string = first;
  let continued = 0;
  while (continued < MAX_CONTINUE_ROUNDS && (countSlides(body) < enoughPages(expected) || cutOff(stop)) && countSlides(body) < expected + 2) {
    continued++;
    const before = countSlides(body);
    await ctx.progress("continuing", 70 + (continued - 1) * 3);
    ctx.log.info({ jobId: ctx.job.id, pages: before, expected, stop, round: continued }, "slides draft stopped early; continuing");
    // A reply cut by the limit may end mid-slide: drop that slide and let the continuation rewrite it.
    const base: string = cutOff(stop) ? dropLastSlide(body) : body;
    const next = await complete(ctx, continueMessages(messages as ReturnType<typeof draftMessages>, base, expected), mode, "continuing", 70 + (continued - 1) * 3, 70 + continued * 3);
    const more = cleanBody(next.text);
    const merged: string = more ? appendSlides(base, more) : base;
    stop = next.stop;
    if (countSlides(merged) < before) break; // nothing usable came back: keep what we had
    body = merged;
    if (countSlides(merged) === before && !cutOff(stop)) break; // no new pages: stop asking
  }
  return { body, fixed, continued, stop };
}

/** In-app notification (+ Web Push when enabled) about a finished or failed draft, linking to the deck page. */
export async function notifyDraft(db: Db, payload: SlidesGeneratePayload, outcome: { ok: true; title: string; body: string } | { ok: false; error: string }) {
  const deck = (await db.query<{ title: string; slug: string }>("SELECT d.title,s.slug FROM decks d JOIN studies s ON s.id=d.study_id WHERE d.id=$1", [payload.deckId])).rows[0];
  if (!deck || !payload.userId) return;
  const url = `/studies/${encodeURIComponent(deck.slug)}/decks/${payload.deckId}`;
  await notifyFromJob(
    db,
    [payload.userId],
    outcome.ok
      ? { kind: "slide", title: outcome.title, body: `${deck.title}：${outcome.body}`, url }
      : { kind: "slide", title: "AI 簡報草稿失敗", body: `${deck.title}：${outcome.error}`, url },
    "slideRendered",
  );
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

export async function runSlidesGenerate(
  ctx: AiJobContext<SlidesGeneratePayload>,
  deps: { storage: Storage; waitMs?: number; extractText?: (pdf: Buffer) => Promise<string>; autoPublish?: boolean; maxZipBytes?: number; notify?: typeof notifyDraft },
): Promise<SlidesGenerateResult> {
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
  const expected = expectedPages(mode, job.payload.instructions);
  const messages = draftMessages(mode, data, job.payload.instructions);
  const drafted = await draftBody(ctx, mode, messages, expected);
  let body = drafted.body;
  let fixed = drafted.fixed;
  const pagesDrafted = countSlides(body);
  if (pagesDrafted <= 1 && expected >= 3) {
    // Nothing worth keeping: fail clearly and leave the source as it was.
    throw new AiJobInputError(`AI 只產生了 ${pagesDrafted} / ${expected} 頁就停止了，草稿沒有寫入。請再試一次；若一直如此，請管理員為「slides」換一個模型。`);
  }
  const partial = pagesDrafted < enoughPages(expected) || cutOff(drafted.stop);
  const warning = partial
    ? cutOff(drafted.stop) && pagesDrafted >= enoughPages(expected)
      ? `AI 的回覆被截斷（${drafted.stop === "content_filter" ? "內容過濾" : "長度上限"}），最後一頁可能不完整，請檢查後再發布。`
      : `AI 只完成了 ${pagesDrafted} / ${expected} 頁，其餘頁面請在編輯器補上，或重新產生草稿。`
    : undefined;
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
    const repaired = cleanBody((await complete(ctx, fixMessages(mode, body, error), mode, "fixing", 90, 95)).text);
    // A "fix" that loses pages (a truncated reply) is worse than the render error: keep the full draft then.
    if (repaired && countSlides(repaired) >= countSlides(body)) {
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
    // Optional: visualSelfFix never throws (a provider that refuses images only means no visual fixes).
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
  const pages = countSlides(body);

  // A complete draft that renders becomes v1 of a deck that has no version yet: the deck page then plays it.
  let publishedVersion: number | undefined;
  if (deps.autoPublish !== false && error === null && !partial) {
    await ctx.progress("publishing", 98);
    try {
      const published = await publishTree(db, deps.storage, deck.id, userId, { maxZipBytes: deps.maxZipBytes ?? maxZipBytes(), firstOnly: { expectRevision: revision } });
      if (published) publishedVersion = published.version;
    } catch (err) {
      ctx.log.warn({ jobId: job.id, reason: err instanceof Error ? err.message : String(err) }, "slides draft auto-publish skipped");
    }
  }

  const notify = deps.notify ?? notifyDraft;
  await notify(db, job.payload, {
    ok: true,
    title: partial ? "AI 簡報草稿只完成一部分" : "AI 簡報草稿完成",
    body: partial ? warning! : publishedVersion ? `${pages} 頁，已發布為第 ${publishedVersion} 版。` : `${pages} 頁，尚未發布（到簡報頁預覽後按「發布」）。`,
  }).catch(err => ctx.log.warn({ jobId: job.id, reason: err instanceof Error ? err.message : String(err) }, "slides draft notification failed"));

  return {
    revision,
    previewId: preview.preview.id,
    valid: error === undefined ? null : error === null,
    fixed,
    pages,
    expectedPages: expected,
    ...(drafted.continued ? { continued: drafted.continued } : {}),
    ...(partial ? { partial: true, warning } : {}),
    ...(publishedVersion ? { publishedVersion } : {}),
    ...(visualFixes ? { visualFixes } : {}),
  };
}

function maxZipBytes() {
  try {
    return loadConfig().MAX_SLIDE_ZIP_BYTES;
  } catch {
    return 200 * 1024 * 1024;
  }
}
