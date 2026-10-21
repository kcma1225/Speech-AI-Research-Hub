import { describe, expect, it } from "vitest";
import { findFocusTarget, focusFromUrl, focusKey, parseFocus, runFromUrl, waitForFocus, withoutFocus } from "./focus.ts";

const U = "11111111-2222-3333-4444-555555555555";

/** A tiny fake of `querySelector` over a map of selector → element. */
function fakeRoot(map: Record<string, unknown>) {
  return { querySelector: (s: string) => map[s] ?? null };
}

describe("focus deep links", () => {
  it("parses workflow / toolcall targets and rejects anything else", () => {
    expect(parseFocus(`workflow:${U}`)).toEqual({ type: "workflow", id: U });
    expect(parseFocus(`toolcall:${U}`)).toEqual({ type: "toolcall", id: U });
    expect(parseFocus("message:abc")).toBeNull();
    expect(parseFocus("workflow:")).toBeNull();
    expect(parseFocus('workflow:a"],[x')).toBeNull();
    expect(parseFocus(null)).toBeNull();
    expect(focusKey({ type: "toolcall", id: "x1" })).toBe("toolcall:x1");
  });

  it("reads ?focus= first, then the ?workflow= alias, and strips both", () => {
    expect(focusFromUrl(new URL(`https://h/assistant/c?focus=toolcall:${U}&workflow=zz`))).toEqual({ type: "toolcall", id: U });
    expect(focusFromUrl(new URL(`https://h/assistant/c?workflow=${U}`))).toEqual({ type: "workflow", id: U });
    expect(focusFromUrl(new URL("https://h/assistant/c"))).toBeNull();
    const clean = withoutFocus(new URL(`https://h/assistant/c?focus=workflow:${U}&workflow=${U}&x=1`));
    expect(clean.search).toBe("?x=1");
  });

  it("reads the run of /assistant/workflows from ?run= or ?id=", () => {
    expect(runFromUrl(new URL(`https://h/assistant/workflows?run=${U}`))).toBe(U);
    expect(runFromUrl(new URL(`https://h/assistant/workflows?id=${U}`))).toBe(U);
    expect(runFromUrl(new URL("https://h/assistant/workflows"))).toBeNull();
  });

  it("finds the card, narrowed to its [data-focus-target] part", () => {
    const inner = { name: "plan editor" };
    const card = { name: "card", querySelector: (s: string) => (s === "[data-focus-target]" ? inner : null) };
    const plain = { name: "ask card", querySelector: () => null };
    const root = fakeRoot({ [`[data-focus-key="workflow:${U}"]`]: card, [`[data-focus-key="toolcall:${U}"]`]: plain });
    expect(findFocusTarget(root, { type: "workflow", id: U })).toBe(inner);
    expect(findFocusTarget(root, { type: "toolcall", id: U })).toBe(plain);
    expect(findFocusTarget(root, { type: "toolcall", id: "other" })).toBeNull();
  });

  it("waits for a card that renders later, and gives up after the timeout", async () => {
    const map: Record<string, unknown> = {};
    const root = fakeRoot(map);
    let ticks = 0;
    const sleep = async () => {
      ticks++;
      if (ticks === 3) map[`[data-focus-key="workflow:${U}"]`] = { querySelector: () => null, id: "late" };
    };
    let got: unknown = null;
    expect(await waitForFocus(root, { type: "workflow", id: U }, { sleep, intervalMs: 10, timeoutMs: 1000, found: (el) => (got = el) })).toBe(true);
    expect(got).toMatchObject({ id: "late" });

    let calls = 0;
    expect(await waitForFocus(fakeRoot({}), { type: "toolcall", id: U }, { sleep: async () => void calls++, intervalMs: 10, timeoutMs: 50, found: () => {} })).toBe(false);
    expect(calls).toBe(6);
    // A cancelled wait stops without calling `found`.
    expect(await waitForFocus(root, { type: "workflow", id: U }, { cancelled: () => true, found: () => { throw new Error("no"); } })).toBe(false);
  });
});
