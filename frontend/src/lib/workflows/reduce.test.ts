import { describe, expect, it } from "vitest";
import { applyEvent, budgetUsage, cleanOutline, emptyState, moveItem, outlineChanged, parseAgentCommand } from "./reduce.ts";
import type { Step, Workflow } from "./types.ts";

const wf = { id: "w", artifacts: [], budget: { max_steps: 10, max_calls: 20, max_tokens: 1000, max_minutes: 10, max_fix_rounds: 2, concurrency: 3 }, usage: { steps: 1, calls: 5, tokens_in: 400, tokens_out: 100, active_ms: 60_000, fix_rounds: 0 }, criteria: [] } as unknown as Workflow;
const step = (key: string, position: number, status: Step["status"] = "pending") => ({ id: key, key, position, status }) as unknown as Step;

describe("workflow reducer", () => {
  it("upserts steps in position order and clears activity when a step settles", () => {
    let s = applyEvent(emptyState(), "workflow", { workflow: wf });
    s = applyEvent(s, "step", { step: step("b", 2, "running") });
    s = applyEvent(s, "step", { step: step("a", 1) });
    expect(s.steps.map((x) => x.key)).toEqual(["a", "b"]);
    s = applyEvent(s, "activity", { step_key: "b", role: "writer", text: "寫第 3 頁" }, 5);
    expect(s.activity.b?.text).toBe("寫第 3 頁");
    s = applyEvent(s, "step", { step: step("b", 2, "passed") });
    expect(s.activity.b).toBeUndefined();
    expect(s.steps).toHaveLength(2);
  });
  it("applies verdicts, artifacts (deduplicated) and caps the log", () => {
    let s = applyEvent(emptyState(), "workflow", { workflow: wf });
    s = applyEvent(s, "step", { step: step("a", 1, "verifying") });
    s = applyEvent(s, "verdict", { step_key: "a", round: 0, verdict: { verdict: "revise", issues: [{ severity: "high", text: "缺第 3 頁" }], checks: [] } });
    expect(s.steps[0]!.verdict?.verdict).toBe("revise");
    const art = { kind: "deck", id: "d", url: "/x", title: "D", role: "draft" };
    s = applyEvent(s, "artifact", { artifact: art });
    s = applyEvent(s, "artifact", { artifact: { ...art, revision: 3 } });
    expect(s.workflow!.artifacts).toEqual([{ ...art, revision: 3 }]);
    for (let i = 0; i < 80; i++) s = applyEvent(s, "log", { level: "info", text: `l${i}` });
    expect(s.log).toHaveLength(60);
    expect(s.log.at(-1)!.text).toBe("l79");
    expect(applyEvent(s, "unknown", {})).toBe(s);
  });
  it("computes budget usage", () => {
    expect(budgetUsage(wf)).toEqual({ calls: 25, tokens: 50, time: 10, steps: 10, max: 50 });
  });
  it("edits outlines", () => {
    expect(moveItem([1, 2, 3], 0, 2)).toEqual([2, 3, 1]);
    expect(moveItem([1, 2, 3], 0, -1)).toEqual([1, 2, 3]);
    expect(cleanOutline([{ title: " A ", points: [" x ", ""] }, { title: " ", points: [] }])).toEqual([{ title: "A", points: ["x"] }]);
    expect(outlineChanged([{ title: "A", points: ["x"] }], [{ title: "A", points: ["x"] }])).toBe(false);
    expect(outlineChanged([{ title: "A", points: ["x"] }], [{ title: "A", points: ["y"] }])).toBe(true);
  });
  it("parses /agent", () => {
    expect(parseAgentCommand("/agent 做一份 11 頁簡報")).toBe("做一份 11 頁簡報");
    expect(parseAgentCommand("/agent")).toBe("");
    expect(parseAgentCommand("/agents x")).toBeNull();
    expect(parseAgentCommand("hello")).toBeNull();
  });
});
