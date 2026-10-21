/**
 * `update_plan`: a visible checklist for multi-step requests (idea from openai/codex `update_plan`, Apache-2.0 —
 * reimplemented; see docs/research/harness-survey.md). The call only records the plan: it has no side effects, never
 * asks for consent and is not on MCP. The SPA renders the call's arguments as a checklist under the tool timeline; the
 * runtime reminds the model of unfinished steps after compaction and before it ends a turn (src/agent/guards.ts).
 */
import { z } from "zod";
import { registerAgentTool } from "./registry.js";

export const PLAN_STATUSES = ["pending", "in_progress", "completed"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];
export type PlanItem = { step: string; status: PlanStatus };
export type Plan = { explanation?: string; plan: PlanItem[] };

export const MAX_PLAN_STEPS = 12;

export const updatePlanInput = z
  .object({
    explanation: z.string().trim().max(300).optional().describe("Optional one-line reason for the change (e.g. why a step was added or dropped)"),
    plan: z
      .array(
        z.object({
          step: z.string().trim().min(1).max(160).describe("A short, verifiable step (5–12 words), in the user's language"),
          status: z.enum(PLAN_STATUSES).describe("pending | in_progress | completed"),
        }),
      )
      .min(1)
      .max(MAX_PLAN_STEPS)
      .describe("The whole plan, in order (every call replaces the previous plan)"),
  })
  .superRefine((v, c) => {
    if (v.plan.filter((p) => p.status === "in_progress").length > 1) c.addIssue({ code: "custom", path: ["plan"], message: "at most one step can be in_progress" });
  });

export const planCounts = (p: Plan) => ({ total: p.plan.length, done: p.plan.filter((s) => s.status === "completed").length });
export const unfinishedSteps = (p: Plan) => p.plan.filter((s) => s.status !== "completed");

/** Compact text form of a plan (reminders, compaction summaries). */
export function planText(p: Plan): string {
  const mark = { completed: "[x]", in_progress: "[~]", pending: "[ ]" } as const;
  return p.plan.map((s, i) => `${i + 1}. ${mark[s.status]} ${s.step}`).join("\n");
}

registerAgentTool({
  name: "update_plan",
  title: "更新工作計畫",
  titleEn: "Update plan",
  risk: "read",
  mcp: false,
  modes: ["chat"],
  description:
    "Show and update a short checklist for a multi-step request (it is rendered to the user as a live checklist). " +
    "Use it only when the work needs 3 or more distinct actions (e.g. read several sources, then draft, then create something), " +
    "not for a simple question or a single tool call. Each call sends the WHOLE plan: 2–8 short, concrete, verifiable steps " +
    "in the user's language; exactly one step in_progress while you work; mark a step completed as soon as it is done (you may " +
    "complete one and start the next in the same call); add, drop or reorder steps when the plan changes and say why in " +
    "`explanation`. Before your final answer every step must be completed (or removed). Do not repeat the plan in your reply.",
  input: updatePlanInput,
  summarize: (a) => {
    const { total, done } = planCounts(a as Plan);
    const cur = a.plan.find((s) => s.status === "in_progress");
    return cur ? `計畫 ${done}/${total}：${cur.step}` : `更新計畫（${done}/${total} 完成）`;
  },
  async execute(a) {
    const { total, done } = planCounts(a as Plan);
    return {
      data: { plan: a.plan, explanation: a.explanation ?? null, done, total },
      text:
        done === total
          ? `計畫已更新：${total} 個步驟全部完成。現在給出最後的回答（不要重複列出計畫）。`
          : `計畫已更新（${done}/${total} 完成）。繼續執行目前的步驟；不要在回覆中重複列出計畫。`,
    };
  },
});
