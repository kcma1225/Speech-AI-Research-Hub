/**
 * Approval policy (pure; unit-tested). Evaluation order is "always ask" first, then grants, then autopilot — an
 * allow can never carve an exception out of a hard rule:
 *   1. memory writes (`alwaysAsk`) and destructive tools always ask (every mode);
 *   2. open-world tools ask once the run is tainted (the outbound query must be seen by the user);
 *   3. reads run;
 *   4. writes run when 「本對話都允許」 covers this tool + target study;
 *   5. writes run under autopilot unless the run is tainted or the autopilot write cap is reached;
 *   6. otherwise ask.
 */
import type { AgentRisk } from "./tools/registry.js";

export type ApprovalReason = "write" | "destructive" | "memory" | "tainted" | "outbound" | "autopilot_limit";

export type PolicyInput = {
  risk: AgentRisk;
  alwaysAsk?: boolean;
  openWorld?: boolean;
  /** Current conversation autopilot (read at decision time, so turning it off applies at once). */
  autopilot: boolean;
  tainted: boolean;
  /** A conversation grant covers this tool + scope. */
  granted: boolean;
  autopilotWrites: number;
  autopilotWriteLimit: number;
};

export type PolicyDecision = { run: true; via: "autopilot" | "conversation_grant" | null } | { run: false; reason: ApprovalReason };

export function decide(p: PolicyInput): PolicyDecision {
  if (p.alwaysAsk) return { run: false, reason: "memory" };
  if (p.risk === "destructive") return { run: false, reason: "destructive" };
  if (p.openWorld && p.tainted) return { run: false, reason: "outbound" };
  if (p.risk === "read") return { run: true, via: null };
  if (p.granted) return { run: true, via: "conversation_grant" };
  if (p.autopilot) {
    if (p.tainted) return { run: false, reason: "tainted" };
    if (p.autopilotWrites >= p.autopilotWriteLimit) return { run: false, reason: "autopilot_limit" };
    return { run: true, via: "autopilot" };
  }
  return { run: false, reason: "write" };
}

/** Grant scope of a call: its target study, or `*` for tools without one. */
export const grantScope = (target: { studyId: string | null } | null | undefined) => target?.studyId ?? "*";
