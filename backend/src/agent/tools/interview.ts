/**
 * Study-creation interview (conversation mode `interview`, /studies/new). The model asks one question at a time and
 * ends with `propose_study_plan`; the SPA shows the proposal as an editable form and creates the study through the
 * normal study API. The tool itself writes nothing.
 */
import { z } from "zod";
import { registerAgentTool } from "./registry.js";
import { dateArg } from "./util.js";

/** Some models double-escape newlines inside tool arguments ("## 問題\\n本研究…"); turn them back into real ones. */
export const unescapeNewlines = (v: unknown) => (typeof v === "string" && !v.includes("\n") && v.includes("\\n") ? v.replace(/(?:\\r)?\\n/g, "\n") : v);

export const studyPlanInput = z.object({
  title: z.string().trim().min(1).max(200),
  summary_format: z.enum(["prose", "bullets"]).describe("prose = paragraphs, bullets = bullet list"),
  summary_md: z.preprocess(unescapeNewlines, z.string().trim().min(1).max(8000)).describe("Study summary in Markdown: problem, motivation, method, data, expected results"),
  stages: z.array(z.object({ name: z.string().trim().min(1).max(60), description: z.preprocess(unescapeNewlines, z.string().max(400)).optional() })).min(1).max(12),
  milestones: z
    .array(z.object({ title: z.string().trim().min(1).max(200), due_on: dateArg.nullable().optional(), stage: z.string().max(60).optional().describe("Name of one of the stages") }))
    .max(20)
    .optional(),
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
  description: "Present the final study proposal to the user for review: title, summary, stages and 2–6 dated milestones derived from the timeline the user gave. Call it once you have the answers; the user edits it before anything is created.",
  input: studyPlanInput,
  summarize: (a) => `提出研究草案「${a.title}」`,
  async execute(a) {
    return { data: { plan: a, status: "shown_to_user" }, text: "草案已顯示給使用者檢視與修改；請簡短說明可以在畫面上的草案中調整後按「建立研究」。" };
  },
});
