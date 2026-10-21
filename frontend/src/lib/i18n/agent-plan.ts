// Assistant work plan (update_plan checklist) and loop-guard notices. Keys "agent.plan." / "agent.notice.stuck".
export const zh = {
  "agent.plan.title": "工作計畫",
  "agent.plan.progress": "{done}/{total} 完成",
  "agent.plan.status.pending": "尚未開始",
  "agent.plan.status.in_progress": "進行中",
  "agent.plan.status.completed": "已完成",
  "agent.notice.stuck": "AI 連續多次工具呼叫失敗，已先停止。",
} as const;

export const en: Record<keyof typeof zh, string> = {
  "agent.plan.title": "Plan",
  "agent.plan.progress": "{done}/{total} done",
  "agent.plan.status.pending": "not started",
  "agent.plan.status.in_progress": "in progress",
  "agent.plan.status.completed": "done",
  "agent.notice.stuck": "Stopped after several failed tool calls in a row.",
};
