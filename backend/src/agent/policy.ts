/**
 * Approval policy (pure; unit-tested). Autopilot means 完全自動: nothing asks any more, except deletions, which are
 * deferred (the call returns at once and becomes a pending card the user decides later; the run never waits for it).
 *   Autopilot on (chat conversations):
 *     1. destructive tools → `defer` (a card outside the step; approve executes later, deny does nothing);
 *     2. open-world tools after the run read untrusted content → `skip` with a tool error (prompt-injection
 *        exfiltration protection: content the user did not write must not trigger outbound calls carrying data, and
 *        the agent continues without that call instead of asking);
 *     3. reads run;
 *     4. writes (also memory, overwrites, tainted runs, `requireCard` tools) run until the safety cap, then `pause`
 *        (the run stops after the step with a notice, no card).
 *   Autopilot off: memory and destructive always ask, open-world asks once tainted, reads run, writes run under a
 *   「本對話都允許」 grant, otherwise ask.
 */
import type { AgentRisk } from "./tools/registry.js";

export type ApprovalReason = "write" | "destructive" | "memory" | "tainted" | "outbound" | "autopilot_limit";

export type PolicyInput = {
  risk: AgentRisk;
  alwaysAsk?: boolean;
  openWorld?: boolean;
  /** The tool asks for a card for these arguments (`requireCard`); autopilot overrides it. */
  requireCard?: boolean;
  /** Current conversation autopilot (read at decision time, so turning it off applies at once). */
  autopilot: boolean;
  tainted: boolean;
  /** A conversation grant covers this tool + scope. */
  granted: boolean;
  autopilotWrites: number;
  autopilotWriteLimit: number;
};

export type PolicyDecision =
  | { run: true; via: "autopilot" | "conversation_grant" | null }
  | { run: false; reason: ApprovalReason }
  /** Autopilot deletion: recorded as a deferred card; the tool result says it waits for the user. */
  | { run: false; defer: true }
  /** Autopilot outbound call after taint: not run, not asked; the tool result explains why. */
  | { run: false; skip: "outbound" }
  /** Autopilot safety cap reached: not run; the run pauses after this step with a notice. */
  | { run: false; pause: "autopilot_limit" };

export function decide(p: PolicyInput): PolicyDecision {
  if (p.autopilot) {
    if (p.risk === "destructive") return { run: false, defer: true };
    if (p.openWorld && p.tainted) return { run: false, skip: "outbound" };
    if (p.risk === "read") return { run: true, via: null };
    if (p.autopilotWrites >= p.autopilotWriteLimit) return { run: false, pause: "autopilot_limit" };
    return { run: true, via: "autopilot" };
  }
  if (p.alwaysAsk) return { run: false, reason: "memory" };
  if (p.risk === "destructive") return { run: false, reason: "destructive" };
  if (p.openWorld && p.tainted) return { run: false, reason: "outbound" };
  if (p.requireCard) return { run: false, reason: "write" };
  if (p.risk === "read") return { run: true, via: null };
  if (p.granted) return { run: true, via: "conversation_grant" };
  return { run: false, reason: "write" };
}

/** Tool result of a deferred deletion (what the model sees; the run continues). */
export const DEFERRED_TEXT = "已排入待確認的刪除（不影響其他工作）：使用者之後在卡片上確認才會真的刪除，拒絕就不會刪除。不要再呼叫相同的刪除，也不要等待；繼續其他工作，最後一句話提到有刪除等待確認即可。";
/** Tool error of an outbound call skipped under autopilot after the run read untrusted content. */
export const OUTBOUND_SKIPPED_TEXT = "自動駕駛：這一輪讀過不是使用者寫的內容（文獻、其他人的筆記或網路資料），為了避免外洩，不會再送出對外查詢。這個呼叫已略過；請用已經有的資料繼續，或在最後請使用者自己開新的查詢。";
/** Notice when the autopilot safety cap pauses a run. */
export const autopilotLimitNotice = (n: number) => `自動駕駛這一輪已自動執行 ${n} 個寫入，先暫停（安全上限）。要繼續的話請按「繼續」。`;

/** Grant scope of a call: its target study, or `*` for tools without one. */
export const grantScope = (target: { studyId: string | null } | null | undefined) => target?.studyId ?? "*";
