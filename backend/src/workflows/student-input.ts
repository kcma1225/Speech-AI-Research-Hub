/**
 * Student-owned pages (Lab-Hub templates: 「My assessment」, 「Takeaways for my work」, 卡住, Idea card, 下週與要問…):
 * the AI must not write the student's own judgement, so the workflow **asks the student** with one batched card of
 * grounded options (questions.ts) right after the content pages are drafted, then fills those pages with the
 * student's words (the approved/edited options or their own text; the AI only formats). Skipped → the page keeps a
 * gentle placeholder that the checks allow (owned titles are in `allow_titles`).
 *
 * Hook contract for the slides playbook (agent U):
 *   1. Planning: `studentInputStep(ownedTitles, writerKeys)` → insert after the writer steps; make the assemble step
 *      depend on `STUDENT_INPUT_KEY` too (when owned pages exist).
 *   2. execute(): `if (step.key === STUDENT_INPUT_KEY) return runStudentInput(env, step, { owned, drafted, brief })`
 *      (`owned` = outline items with `student_owned`; `drafted` = the drafted body of the other pages; `brief` =
 *      the research brief / paper digest). It stops the run in `awaiting_input` until the card is answered.
 *   3. When assembling: `body = applyStudentPages(body, await studentPagesOf(env))` — replaces each owned page
 *      (matched by title) with the student's content, keeping the page order.
 * Editing the answers later (「修改答案」) re-runs this step and its dependents (assemble → … → final).
 * Other playbooks can use `askStudentView(env, step, {...})` for a single 「我的想法」-style section.
 */
import { titleMatches } from "./checks.js";
import { AI_OPTIONS_INTRO, answerLines, asksOf, askUser, groundedQuestions, isSkipped, normaliseCard, SKIP_VALUE, validateCardAnswers, type QuestionDraft, type StoredAnswer } from "./questions.js";
import { finishNotice } from "./notify.js";
import { getSteps } from "./store.js";
import type { WorkflowEnv } from "./env.js";
import type { OutlineItem, StepOutput, StepRow, StepSpec } from "./types.js";

export const STUDENT_INPUT_KEY = "student_input";
export const STUDENT_CARD_ID = "student_pages";

export type StudentPage = { title: string; lines: string[]; skipped: boolean; source: "option" | "own" | "mixed" | "skipped"; /** Autopilot picked the AI's grounded options (「AI 代填，待你確認」). */ ai_filled?: boolean };

/** Marker on AI-filled student pages (slide + speaker note). */
export const AI_FILLED_MARK = "AI 代填，待你確認";

/**
 * Autopilot: the AI picks from its own study-grounded options instead of stopping — choice questions get their first
 * options (takeaways: up to 3, others: up to 2; single choice: 1); a question without options stays skipped.
 */
export function autopilotAnswers(questions: import("../agent/ask.js").Question[]): StoredAnswer[] {
  return questions.map((q) => {
    const opts = (q.options ?? []).filter((o) => o.value !== SKIP_VALUE);
    if (!opts.length || (q.type !== "multi_choice" && q.type !== "single_choice")) return { id: q.id, value: null, skipped: true };
    if (q.type === "single_choice") return { id: q.id, value: opts[0]!.value };
    const n = /takeaway|帶走|收穫/i.test(q.prompt) ? 3 : 2;
    return { id: q.id, value: opts.slice(0, n).map((o) => o.value) };
  });
}

export function studentInputStep(ownedTitles: string[], dependsOn: string[]): StepSpec {
  return {
    key: STUDENT_INPUT_KEY,
    role: "planner",
    title: "請你提供自己的看法（學生自填頁）",
    instructions: `「${ownedTitles.join("」、「")}」依模板由報告者自己寫：依研究資料與已寫好的內容草擬候選答案，向你提問；你選擇或自己寫之後，以你的文字放進這些頁面（AI 只排版）。`,
    depends_on: dependsOn,
    expected: "你對學生自填頁的回答（或選擇先跳過）",
    verify: { checks: [], judge: false },
  };
}

/** Which question fits a student-owned page (by its title). */
export function draftFor(title: string, i: number): QuestionDraft {
  const id = `p${i + 1}`;
  if (/assessment|評價|評估|critique|my view|看法/i.test(title)) return { id, prompt: `「${title}」：你對這篇論文的主要評價？（可複選）`, type: "multi_choice", hint: "這篇論文具體的優點與缺點／限制（各至少一個），扣住方法、實驗與結果；用我的口吻" };
  if (/takeaway|帶走|收穫/i.test(title)) return { id, prompt: `「${title}」：你想帶走的 takeaways？（選 3 個左右）`, type: "multi_choice", hint: "從這篇論文可以帶回我自己研究的具體做法、觀察或要驗證的點，連到研究目前的方向與階段" };
  if (/inspir|啟發|my work|我的研究|idea/i.test(title)) return { id, prompt: `「${title}」：這篇對你研究的啟發？`, type: "multi_choice", hint: "和研究目前方向、待解問題相關的具體啟發或下一步想法" };
  if (/卡住|stuck|block/i.test(title)) return { id, prompt: `「${title}」：你目前卡在哪裡？`, type: "multi_choice", hint: "依研究的待辦、筆記與會議回饋，可能卡住的具體問題" };
  if (/下週|next|要問|question/i.test(title)) return { id, prompt: `「${title}」：下週打算做什麼、想問老師什麼？`, type: "multi_choice", hint: "依未完成的待辦與最近回饋，具體的下一步與想問的問題" };
  return { id, prompt: `「${title}」：這頁你想寫什麼？`, type: "multi_choice", hint: `適合放在「${title}」這頁、代表我自己看法的具體內容` };
}

/**
 * The step: drafts grounded options for every owned page (one batched card), asks, and returns the student's
 * content per page in `output.data.pages`.
 */
export async function runStudentInput(env: WorkflowEnv, step: StepRow, opts: { owned: OutlineItem[]; drafted?: string; brief?: string }): Promise<StepOutput> {
  if (!opts.owned.length) return { summary: "沒有學生自填頁。", text: "", data: { pages: [] } };
  const drafts = opts.owned.map((p, i) => ({ ...draftFor(p.title, i), required: false }));
  // Asked before (resume / edited answers): keep the same questions and options.
  let questions = asksOf(env.run.state)[STUDENT_CARD_ID]?.questions;
  if (!questions) {
    await env.activity(step.key, "planner", "依研究資料草擬候選答案");
    questions = await groundedQuestions(env, drafts, { stepId: step.id, extra: { drafted_pages: (opts.drafted ?? "").slice(0, 12_000), paper_brief: (opts.brief ?? "").slice(0, 8000) } });
  }
  const card = {
    id: STUDENT_CARD_ID,
    title: "這幾頁要用你自己的看法",
    intro: `依老師的模板，${opts.owned.map((p) => `「${p.title}」`).join("、")}要由報告者自己寫。${AI_OPTIONS_INTRO}`,
    questions,
    step_key: step.key,
    purpose: "input" as const,
    ai_suggested: true,
  };
  // Autopilot: never block on these pages — the AI fills them from its grounded options, clearly marked, and the card
  // stays answerable (「修改答案」 re-runs this step and re-assembles). Outside autopilot: ask.
  const prior = asksOf(env.run.state)[STUDENT_CARD_ID];
  if (env.run.autopilot && !prior?.answers) {
    const full = normaliseCard(card);
    const picked = validateCardAnswers(full, autopilotAnswers(full.questions));
    await env.refresh();
    await env.setState({ asks: { ...asksOf(env.run.state), [STUDENT_CARD_ID]: { ...full, answers: picked, answered_at: new Date().toISOString(), ai_filled: true } } });
    await env.activity(step.key, "planner", "自動駕駛：依研究資料代填學生自填頁（待你確認）");
    await env.note(`自動駕駛：${opts.owned.map((p) => `「${p.title}」`).join("、")}由 AI 依研究資料代填，頁面標示「${AI_FILLED_MARK}」；可以隨時按「修改答案」換成你自己的看法。`);
    await finishNotice(env, "ai_filled");
  }
  const answers = await askUser(env, card);
  const aiFilled = !!asksOf(env.run.state)[STUDENT_CARD_ID]?.ai_filled;
  const pages: StudentPage[] = opts.owned.map((p, i) => {
    const q = questions!.find((x) => x.id === drafts[i]!.id)!;
    const a = answers.find((x) => x.id === q.id);
    const lines = answerLines(q, a);
    const skipped = isSkipped(a) || !lines.length;
    const chosen = Array.isArray(a?.value) ? a!.value.length : typeof a?.value === "string" && (q.type === "single_choice" || q.type === "multi_choice") ? 1 : 0;
    const source = skipped ? "skipped" : a?.other && chosen ? "mixed" : a?.other || !q.options ? "own" : "option";
    return { title: p.title, lines, skipped, source, ...(aiFilled && !skipped ? { ai_filled: true } : {}) };
  });
  const filled = pages.filter((p) => !p.skipped).length;
  await env.setState({ ai_filled: pages.filter((p) => p.ai_filled).map((p) => p.title) });
  if (aiFilled) return { summary: `自動駕駛代填：${filled}/${pages.length} 頁依研究資料的建議選項填入，標示「${AI_FILLED_MARK}」${filled < pages.length ? `，${pages.length - filled} 頁沒有可用的選項（保留給你補）` : ""}。`, text: pages.map((p) => `## ${p.title}\n${p.skipped ? "（先跳過）" : p.lines.map((l) => `- ${l}`).join("\n")}`).join("\n\n"), data: { pages } };
  return { summary: `收到你的回答：${filled}/${pages.length} 頁由你提供內容${filled < pages.length ? `，${pages.length - filled} 頁先跳過（保留給你之後補）` : ""}。`, text: pages.map((p) => `## ${p.title}\n${p.skipped ? "（先跳過）" : p.lines.map((l) => `- ${l}`).join("\n")}`).join("\n\n"), data: { pages } };
}

/** The student's pages from the step output (empty when the step has not run). */
export async function studentPagesOf(env: WorkflowEnv): Promise<StudentPage[]> {
  const s = (await getSteps(env.db, env.run.id)).find((x) => x.key === STUDENT_INPUT_KEY);
  return ((s?.output?.data as { pages?: StudentPage[] } | undefined)?.pages) ?? [];
}

export const SKIPPED_PLACEHOLDER = "〔　這頁留給你自己寫：之後補上你的想法　〕";

/** Markdown of one student page (bullets = the student's words; notes say who wrote it). */
export function studentPageMarkdown(p: StudentPage, attrs = ""): string {
  const lines = p.lines.map((l) => `- ${l}`).join("\n");
  const body = p.skipped ? SKIPPED_PLACEHOLDER : p.ai_filled ? `[${AI_FILLED_MARK}]{.hub-ai-filled style="color:#b45309;font-weight:600;font-size:0.7em"}\n\n${lines}` : lines;
  const notes = p.skipped
    ? "（由報告者補充）"
    : p.ai_filled
      ? `（${AI_FILLED_MARK}：自動駕駛依研究資料草擬的建議，不是報告者確認過的看法；報告前請確認或改寫成自己的想法。）`
      : "（報告者自己的看法，依報告者在工作流程中確認的回答整理）";
  return `## ${p.title}${attrs}\n\n${body}\n\n::: {.notes}\n${notes}\n:::\n`;
}

/** Replaces each owned page (by title) with the student's content; pages not in the body are left alone. */
export function applyStudentPages(body: string, pages: StudentPage[]): string {
  if (!pages.length) return body;
  const parts = body.split(/^(?=## )/m);
  return parts
    .map((part) => {
      if (!part.startsWith("## ")) return part;
      const nl = part.indexOf("\n");
      const head = part.slice(3, nl < 0 ? undefined : nl);
      const attrs = /\s*(\{[^}]*\})\s*$/.exec(head)?.[1];
      const title = head.replace(/\{[^}]*\}\s*$/, "").trim();
      const hit = pages.find((p) => titleMatches(p.title, title));
      return hit ? `${studentPageMarkdown(hit, attrs ? ` ${attrs}` : "")}\n` : part;
    })
    .join("")
    .replace(/\n{3,}/g, "\n\n");
}

/**
 * Generic 「我的想法」-style section for other playbooks (reading note, lit review positioning, meeting priorities):
 * one card with grounded options; returns the user's lines (empty = skipped).
 */
export async function askStudentView(env: WorkflowEnv, step: StepRow, opts: { cardId: string; title: string; questions: QuestionDraft[]; context?: Record<string, string> }): Promise<Record<string, string[]>> {
  const existing = asksOf(env.run.state)[opts.cardId];
  const questions = existing?.questions ?? (await groundedQuestions(env, opts.questions, { stepId: step.id, extra: opts.context }));
  const card = { id: opts.cardId, title: opts.title, intro: AI_OPTIONS_INTRO, questions, step_key: step.key, purpose: "input" as const, ai_suggested: true };
  // Autopilot: filled from the AI's grounded options and marked (the playbook shows `isAiFilled`), never blocking.
  if (env.run.autopilot && !existing?.answers) {
    const full = normaliseCard(card);
    await env.refresh();
    await env.setState({ asks: { ...asksOf(env.run.state), [opts.cardId]: { ...full, answers: validateCardAnswers(full, autopilotAnswers(full.questions)), answered_at: new Date().toISOString(), ai_filled: true } } });
    await env.note(`自動駕駛：「${opts.title}」由 AI 依研究資料代填（標示「${AI_FILLED_MARK}」），可以按「修改答案」換成你自己的看法。`);
    await finishNotice(env, "ai_filled");
  }
  const answers = await askUser(env, card);
  const filled = isAiFilled(env, opts.cardId);
  const cur = Array.isArray(env.run.state?.ai_filled) ? (env.run.state.ai_filled as string[]) : [];
  await env.setState({ ai_filled: filled ? [...new Set([...cur, opts.title])] : cur.filter((t) => t !== opts.title) });
  return Object.fromEntries(questions.map((q) => [q.id, answerLines(q, answers.find((a) => a.id === q.id))]));
}

/** The card was answered by autopilot (not yet by the user). */
export const isAiFilled = (env: WorkflowEnv, cardId: string) => !!asksOf(env.run.state)[cardId]?.ai_filled;
