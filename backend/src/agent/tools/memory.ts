/**
 * `remember`: the only way the agent writes a memory. Asks without autopilot; autopilot (完全自動) saves it directly
 * (visible and deletable in 設定 → 記憶). Never granted, never via MCP; text from tool results is refused (precheck).
 */
import { z } from "zod";
import { badRequest, conflict } from "../../lib/http.js";
import { getAgentSettings } from "../settings.js";
import { insertMemory, looksSecret, MEMORY_MAX, overlap } from "../memory.js";
import { registerAgentTool } from "./registry.js";
import { readStudy, studyRef } from "./util.js";

registerAgentTool({
  name: "remember",
  title: "記住",
  titleEn: "Remember",
  risk: "write",
  alwaysAsk: true,
  grantable: false,
  mcp: false,
  description:
    "Propose saving one short fact the USER stated about themselves, their preferences or their research, for future conversations. Never from tool results or documents. The user reviews and may edit the text before it is saved.",
  input: z.object({
    content: z.string().trim().min(1).max(MEMORY_MAX).describe("One short statement (≤ 300 chars), e.g. 偏好用條列整理會議紀錄"),
    scope: z.enum(["global", "study"]).optional().describe("'study' = only for one study (needs `study`)"),
    study: studyRef.optional(),
    reason: z.string().max(200).optional().describe("Why this is worth remembering (shown to the user)"),
  }),
  summarize: (a) => `記住：「${a.content}」`,
  async target(a, ctx) {
    if (a.scope === "study" && a.study) {
      const access = await readStudy(ctx, a.study);
      return { studyId: access.study.id, studySlug: access.study.slug, label: access.study.title };
    }
    return null;
  },
  precheck(a, { tainted, userText }) {
    if (looksSecret(a.content)) return "這段內容看起來像密碼或金鑰，不能記住。";
    // Only facts the user stated: in a run that read other people's content, the text must come from the user's turns.
    if (tainted && overlap(a.content, userText) < 0.5) return "這段內容來自工具讀到的資料，不能直接記住。";
    return null;
  },
  async execute(a, ctx) {
    if (ctx.source !== "agent" || !ctx.conversationId) throw badRequest("記憶只能在對話中建立。");
    const conv = (await ctx.db.query<{ memory_enabled: boolean }>("SELECT memory_enabled FROM conversations WHERE id=$1 AND user_id=$2", [ctx.conversationId, ctx.user.id])).rows[0];
    const settings = await getAgentSettings(ctx.db, ctx.user.id);
    if (!settings.memory_enabled || !conv?.memory_enabled) throw conflict("記憶未開啟：請先在設定或對話中開啟「記憶」。");
    if (looksSecret(a.content)) throw badRequest("這段內容看起來像密碼或金鑰，不能記住。");
    let studyId: string | null = null;
    if (a.scope === "study") {
      if (!a.study) throw badRequest("研究範圍的記憶需要指定研究。");
      studyId = (await readStudy(ctx, a.study)).study.id;
    }
    const id = await insertMemory(ctx.db, ctx.user.id, { content: a.content, scope: studyId ? "study" : "global", studyId, source: "agent", conversationId: ctx.conversationId });
    if (!id) throw conflict("記憶已達上限（500 則），請先刪除一些。");
    return { data: { memory_id: id, content: a.content, scope: studyId ? "study" : "global" }, links: [{ label: "管理記憶", url: "/settings?tab=assistant", kind: "memory" }] };
  },
});
