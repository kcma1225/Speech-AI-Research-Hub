/**
 * Study-creation interview (conversation mode `interview`, /studies/new). The conversation starts with a seeded
 * `ask_user` card (「這個研究目前進行到哪個程度？」, `MATURITY_QUESTION`); the model then asks mode-specific question
 * cards (never schedules) and ends with `propose_study_plan`; the SPA shows the proposal as an editable form and creates
 * the study through the normal study API. The tool itself writes nothing.
 */
import { z } from "zod";
import { STUDY_MATURITIES } from "../../lib/studies/access.js";
import type { AskUserArgs } from "../ask.js";
import { registerAgentTool } from "./registry.js";
import { dateArg } from "./util.js";

/** The interview's first card (seeded by the runtime when an interview conversation is created; no model call). */
export const MATURITY_QUESTION: AskUserArgs = {
  intro: "先了解一下你目前的想法進行到哪裡，我會依照你的狀況調整接下來的問題。不確定也沒關係。",
  questions: [{
    id: "maturity",
    prompt: "這個研究目前進行到哪個程度？",
    type: "single_choice",
    required: false,
    allow_other: true,
    options: [
      { value: "exploring", label: "探索中", description: "只有感興趣的領域或大方向，問題還沒定義" },
      { value: "problem_defined", label: "有問題、方法未定", description: "知道想解決什麼問題，怎麼做還要研究和跟教授討論" },
      { value: "method_first", label: "有方法、找應用", description: "想用某個技術或模型，正在找適合的問題或場景" },
      { value: "continuation", label: "延續或復現", description: "延續學長姐或前人的研究，或從復現一篇論文開始" },
      { value: "assigned", label: "指派的題目或計畫", description: "教授或計畫指派，需求與交付已大致確定" },
      { value: "well_defined", label: "方向明確", description: "問題、方法、資料都大致確定" },
    ],
  }],
};
export const INTERVIEW_INTRO = "嗨！我會用幾張簡短的問題卡片，幫你把目前對這個研究的想法整理成草案。每一題都可以略過或選「還不確定」。";

/** Some models double-escape newlines inside tool arguments ("## 問題\\n本研究…"); turn them back into real ones. */
export const unescapeNewlines = (v: unknown) => (typeof v === "string" && !v.includes("\n") && v.includes("\\n") ? v.replace(/(?:\\r)?\\n/g, "\n") : v);

export const studyPlanInput = z.object({
  title: z.string().trim().min(1).max(200),
  maturity: z.enum(STUDY_MATURITIES).optional().describe("How far the student's thinking is (the answer to the first card)"),
  summary_format: z.enum(["prose", "bullets"]).describe("prose = paragraphs, bullets = bullet list"),
  summary_md: z.preprocess(unescapeNewlines, z.string().trim().min(1).max(8000)).describe("Markdown with sections ## 研究方向 / ## 動機 / ## 目前的想法 / ## 待釐清的問題 (+ ## 方法 / ## 資料 / ## 評估 when well_defined); unknowns written as 待探討"),
  open_questions: z.array(z.string().trim().min(1).max(200)).max(10).optional().describe("Open questions to clarify later (may become 「與教授討論：…」 tasks)"),
  first_steps: z.array(z.object({ title: z.string().trim().min(1).max(200) })).max(3).optional().describe("Up to 3 optional, undated first steps"),
  stages: z.array(z.object({ name: z.string().trim().min(1).max(60), description: z.preprocess(unescapeNewlines, z.string().max(400)).optional() })).min(1).max(12),
  milestones: z
    .array(z.object({ title: z.string().trim().min(1).max(200), due_on: dateArg.nullable().optional(), stage: z.string().max(60).optional().describe("Name of one of the stages") }))
    .max(20)
    .optional()
    .describe("Only when the user explicitly gave dates and asked for milestones; normally omit"),
  advisors: z.array(z.string().max(80)).max(5).optional().describe("Advisor names the user mentioned"),
});
export type StudyPlan = z.infer<typeof studyPlanInput>;

registerAgentTool({
  name: "propose_study_plan",
  title: "提出研究草案",
  titleEn: "Propose study plan",
  risk: "read",
  mcp: false,
  modes: ["interview"],
  description: "Present the study draft to the user for review: maturity, title, summary (confirmed vs open), open questions, stages and up to 3 optional undated first steps. Never invent dates or a schedule. Call it once you have the answers; the user edits it before anything is created.",
  input: studyPlanInput,
  summarize: (a) => `提出研究草案「${a.title}」`,
  async execute(a) {
    return { data: { plan: a, status: "shown_to_user" }, text: "草案已顯示給使用者檢視與修改；請簡短說明可以在畫面上的草案中調整後按「建立研究」。" };
  },
});
