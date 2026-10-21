/**
 * `ask_user` (question card; the run ends after the step and the answers come back as the next user turn) and
 * `list_lab_members` (directory: names + role, for advisor / member choices). Both in every conversation mode.
 */
import { z } from "zod";
import { askUserInput } from "../ask.js";
import { registerAgentTool } from "./registry.js";

registerAgentTool({
  name: "ask_user",
  title: "詢問使用者",
  titleEn: "Ask the user",
  risk: "read",
  mcp: false,
  modes: ["chat", "interview"],
  description:
    "Ask the user 1–6 related questions at once in a question card (choices, multi-select, short/long text, number, date, 1–5 scale, yes/no). " +
    "Prefer this over asking in plain text whenever you need information from the user. Give choice questions concrete options " +
    "(with short descriptions when helpful) and an 「還不確定」 option where it applies; questions are optional unless truly required. " +
    "After calling it, stop: do not answer for the user. The answers arrive as the next user message.",
  input: askUserInput,
  summarize: (a) => `詢問 ${a.questions.length} 個問題`,
  async execute(a) {
    return {
      data: { questions: a.questions.length, status: "shown_to_user" },
      text: "問題卡片已顯示給使用者。請在這裡結束回覆（不要替使用者回答，也不要再重複列出問題）；使用者的回答會是下一則使用者訊息。",
    };
  },
});

registerAgentTool({
  name: "list_lab_members",
  title: "查詢實驗室成員",
  titleEn: "List lab members",
  risk: "read",
  modes: ["chat", "interview"],
  description: "List the lab's active accounts (name and role: student or professor). Use it to offer advisor choices (professors) or member choices.",
  input: z.object({ role: z.enum(["student", "professor", "any"]).optional().describe("Default any") }),
  summarize: (a) => (a.role === "professor" ? "查詢實驗室教授" : "查詢實驗室成員"),
  async execute(a, ctx) {
    const rows = (await ctx.db.query<{ id: string; name: string; role: string }>(
      "SELECT id,name,role FROM users WHERE disabled_at IS NULL AND role IN ('student','professor') AND ($1::text IS NULL OR role=$1) ORDER BY role DESC, lower(name) LIMIT 200",
      [a.role && a.role !== "any" ? a.role : null],
    )).rows;
    return { data: { members: rows.map((r) => ({ id: r.id, name: r.name, role: r.role, role_label: r.role === "professor" ? "教授" : "學生" })) } };
  },
});
