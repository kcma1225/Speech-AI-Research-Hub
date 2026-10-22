/**
 * Autopilot plan approval (docs/architecture.md "Workflows" → Safety). Autopilot means 完全自動: under autopilot every
 * plan is approved automatically — also when it overwrites existing content (a new version / revision is kept, so it
 * can be restored), publishes a deck version (old versions stay), imports into the library, and when the run is tainted
 * by reading papers, other members' notes or study content. Only two cases still wait for the user: the user asked for
 * a manual approval (「修改計畫」 on an auto-approved run), and a tainted run whose plan would send user data out
 * (`outbound`: prompt-injection exfiltration protection). No playbook deletes; a deletion would go through the deferred
 * deletion card of the assistant (never block the run).
 * Without autopilot: a stage of a goal whose roadmap the user approved runs unless it overwrites / publishes / deletes /
 * sends data out; everything else waits for the user. Pure; unit-tested.
 */
import type { PlannedWrite, WriteEffect } from "./types.js";

export const DRAFT_EFFECTS: ReadonlySet<WriteEffect> = new Set(["new", "draft_own", "suggestion"]);

export type AutoApprovalInput = {
  autopilot: boolean;
  /** The playbook may ever be auto-approved (every registered playbook may; kept for future ones that must not). */
  autoApprovable: boolean;
  writes: PlannedWrite[];
  tainted: boolean;
  /** The user asked to approve the next plan themselves (revised an auto-approved plan). */
  manual?: boolean;
  /**
   * A stage of a goal whose roadmap the user approved (goals/): approved like autopilot, and writes the roadmap listed
   * without a draft effect (a library import) are covered too; overwrite / publish / delete / outbound still wait.
   */
  goal?: boolean;
};

export type AutoApprovalDecision =
  | { auto: true; reason: "draft_only" | "goal" | "autopilot"; tainted: boolean; effects?: PlannedWrite[] }
  | { auto: false; reason: "not_autopilot" | "playbook" | "manual" | "write_effect"; blocking?: PlannedWrite[] };

/** Effects that always need the user's own approval, also inside an approved goal. */
export const USER_EFFECTS: ReadonlySet<WriteEffect> = new Set(["overwrite", "publish", "delete", "outbound"]);

export function autoApproval(p: AutoApprovalInput): AutoApprovalDecision {
  if (p.autopilot && p.autoApprovable && !p.manual) {
    // The only effect autopilot does not approve: sending data out after reading untrusted content.
    const blocking = p.tainted ? p.writes.filter((w) => w.effect === "outbound") : [];
    if (blocking.length) return { auto: false, reason: "write_effect", blocking };
    const effects = p.writes.filter((w) => !w.effect || !DRAFT_EFFECTS.has(w.effect));
    return effects.length ? { auto: true, reason: "autopilot", tainted: p.tainted, effects } : { auto: true, reason: "draft_only", tainted: p.tainted };
  }
  if (p.goal && !p.manual) {
    const blocking = p.writes.filter((w) => w.effect && USER_EFFECTS.has(w.effect));
    if (blocking.length) return { auto: false, reason: "write_effect", blocking };
    return { auto: true, reason: "goal", tainted: p.tainted };
  }
  if (!p.autopilot) return { auto: false, reason: "not_autopilot" };
  if (!p.autoApprovable) return { auto: false, reason: "playbook" };
  if (p.manual) return { auto: false, reason: "manual" };
  const blocking = p.writes.filter((w) => !w.effect || !DRAFT_EFFECTS.has(w.effect));
  if (blocking.length) return { auto: false, reason: "write_effect", blocking };
  return { auto: true, reason: "draft_only", tainted: p.tainted };
}

/** Timeline line for an auto-approved plan. */
export const AUTO_APPROVED_NOTE = "自動駕駛已自動核准計畫";

export function autoApprovalNote(d: AutoApprovalDecision, sources: string[] = []): string {
  if (d.auto && d.reason === "autopilot") {
    const labels = (d.effects ?? []).slice(0, 3).map((w) => `「${w.label}」`).join("、");
    return `${AUTO_APPROVED_NOTE}（完全自動）：計畫包含${labels}${(d.effects?.length ?? 0) > 3 ? "等" : ""}；覆蓋前的內容都留有版本，可以在版本紀錄還原。計畫仍可查看；需要調整時可以按「暫停」或「修改計畫」。`;
  }
  if (d.auto && d.reason === "goal") return "目標路線已經由你確認：這個階段的計畫自動開始（不會覆蓋、發布或刪除你的內容）。計畫仍可查看；需要調整時可以按「暫停」或「修改計畫」。";
  if (d.auto) {
    const read = d.tainted && sources.length ? `（讀過：${sources.slice(0, 3).join("、")}${sources.length > 3 ? "…" : ""}）` : "";
    return `${AUTO_APPROVED_NOTE}：只會寫入新的草稿或建議，不會覆蓋、發布或刪除你的內容${read}。計畫仍可查看；需要調整時可以按「暫停」或「修改計畫」。`;
  }
  if (d.reason === "write_effect") return `自動駕駛：這個計畫會${(d.blocking ?? []).map((w) => `「${w.label}」`).join("、")}，需要你確認後才開始。`;
  if (d.reason === "manual") return "自動駕駛：你修改了計畫，這次請你確認後再開始。";
  return "";
}
