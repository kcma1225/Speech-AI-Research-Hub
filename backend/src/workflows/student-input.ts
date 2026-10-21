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
import { AI_OPTIONS_INTRO, answerLines, asksOf, askUser, groundedQuestions, isSkipped, type QuestionDraft } from "./questions.js";
import { getSteps } from "./store.js";
import type { WorkflowEnv } from "./env.js";
import type { OutlineItem, StepOutput, StepRow, StepSpec } from "./types.js";

export const STUDENT_INPUT_KEY = "student_input";
export const STUDENT_CARD_ID = "student_pages";

export type StudentPage = { title: string; lines: string[]; skipped: boolean; source: "option" | "own" | "mixed" | "skipped" };

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
  const answers = await askUser(env, {
    id: STUDENT_CARD_ID,
    title: "這幾頁要用你自己的看法",
    intro: `依老師的模板，${opts.owned.map((p) => `「${p.title}」`).join("、")}要由報告者自己寫。${AI_OPTIONS_INTRO}`,
    questions,
    step_key: step.key,
    purpose: "input",
    ai_suggested: true,
  });
  const pages: StudentPage[] = opts.owned.map((p, i) => {
    const q = questions!.find((x) => x.id === drafts[i]!.id)!;
    const a = answers.find((x) => x.id === q.id);
    const lines = answerLines(q, a);
    const skipped = isSkipped(a) || !lines.length;
    const chosen = Array.isArray(a?.value) ? a!.value.length : typeof a?.value === "string" && (q.type === "single_choice" || q.type === "multi_choice") ? 1 : 0;
    const source = skipped ? "skipped" : a?.other && chosen ? "mixed" : a?.other || !q.options ? "own" : "option";
    return { title: p.title, lines, skipped, source };
  });
  const filled = pages.filter((p) => !p.skipped).length;
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
  const body = p.skipped ? SKIPPED_PLACEHOLDER : p.lines.map((l) => `- ${l}`).join("\n");
  const notes = p.skipped ? "（由報告者補充）" : "（報告者自己的看法，依報告者在工作流程中確認的回答整理）";
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
  const answers = await askUser(env, { id: opts.cardId, title: opts.title, intro: AI_OPTIONS_INTRO, questions, step_key: step.key, purpose: "input", ai_suggested: true });
  return Object.fromEntries(questions.map((q) => [q.id, answerLines(q, answers.find((a) => a.id === q.id))]));
}
