/**
 * Autopilot plan approval (docs/architecture.md "Workflows" → Safety). The taint rule exists to stop exfiltration and
 * destructive / overwriting writes, not to block drafting from the user's own library: under autopilot a plan is
 * approved automatically when **every planned write is draft-only** (`new` object, `draft_own` revision of an object the
 * run created / an untouched template, `suggestion`) — also when the run is tainted by reading papers, other members'
 * notes or study content. It still waits for the user when any write overwrites existing content, publishes, deletes or
 * sends user data out (`overwrite` / `publish` / `delete` / `outbound`, or a write without a declared effect), when the
 * playbook is not auto-approvable, or when the user asked for a manual approval (「修改計畫」 on an auto-approved run).
 * Pure; unit-tested.
 */
import type { PlannedWrite, WriteEffect } from "./types.js";

export const DRAFT_EFFECTS: ReadonlySet<WriteEffect> = new Set(["new", "draft_own", "suggestion"]);

export type AutoApprovalInput = {
  autopilot: boolean;
  /** The playbook may ever be auto-approved (it only writes drafts / suggestions). */
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
  | { auto: true; reason: "draft_only" | "goal"; tainted: boolean }
  | { auto: false; reason: "not_autopilot" | "playbook" | "manual" | "write_effect"; blocking?: PlannedWrite[] };

/** Effects that always need the user's own approval, also inside an approved goal. */
export const USER_EFFECTS: ReadonlySet<WriteEffect> = new Set(["overwrite", "publish", "delete", "outbound"]);

export function autoApproval(p: AutoApprovalInput): AutoApprovalDecision {
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
  if (d.auto && d.reason === "goal") return "目標路線已經由你確認：這個階段的計畫自動開始（不會覆蓋、發布或刪除你的內容）。計畫仍可查看；需要調整時可以按「暫停」或「修改計畫」。";
  if (d.auto) {
    const read = d.tainted && sources.length ? `（讀過：${sources.slice(0, 3).join("、")}${sources.length > 3 ? "…" : ""}）` : "";
    return `${AUTO_APPROVED_NOTE}：只會寫入新的草稿或建議，不會覆蓋、發布或刪除你的內容${read}。計畫仍可查看；需要調整時可以按「暫停」或「修改計畫」。`;
  }
  if (d.reason === "write_effect") return `自動駕駛：這個計畫會${(d.blocking ?? []).map((w) => `「${w.label}」`).join("、")}，需要你確認後才開始。`;
  if (d.reason === "manual") return "自動駕駛：你修改了計畫，這次請你確認後再開始。";
  return "";
}
