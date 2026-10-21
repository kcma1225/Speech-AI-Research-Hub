import { describe, expect, it } from "vitest";
import { CloseGuard } from "./close-guard.svelte.ts";

function make(init: Partial<{ guard: boolean; dirty: boolean | undefined; busy: boolean }> = {}) {
  const cfg = { guard: true, dirty: undefined as boolean | undefined, busy: false, ...init };
  return { cfg, g: new CloseGuard(() => cfg) };
}
const fieldEvent = (target: unknown) => ({ target }) as unknown as Event;

describe("CloseGuard", () => {
  it("lets an untouched sheet close without a prompt", () => {
    const { g } = make();
    expect(g.request()).toBe(true);
    expect(g.confirming).toBe(false);
  });

  it("prompts after a user edit, and discard clears it", () => {
    const { g } = make();
    g.onFieldEvent(fieldEvent(null));
    expect(g.request()).toBe(false);
    expect(g.confirming).toBe(true);
    g.discard();
    expect(g.confirming).toBe(false);
    expect(g.request()).toBe(true);
  });

  it("reset on open starts clean", () => {
    const { g } = make();
    g.markDirty();
    g.request();
    g.reset();
    expect(g.confirming).toBe(false);
    expect(g.dirty).toBe(false);
  });

  it("an explicit dirty prop replaces auto-detection", () => {
    const { cfg, g } = make({ dirty: false });
    g.markDirty();
    expect(g.request()).toBe(true);
    cfg.dirty = true;
    expect(g.request()).toBe(false);
  });

  it("busy always guards, even with an explicit clean form", () => {
    const { g } = make({ dirty: false, busy: true });
    expect(g.request()).toBe(false);
  });

  it("guard={false} never prompts", () => {
    const { g } = make({ guard: false, busy: true });
    g.markDirty();
    expect(g.request()).toBe(true);
  });

  it("ignores fields marked data-guard-ignore", () => {
    const { g } = make();
    const el = (ignored: boolean) => ({ closest: (sel: string) => (ignored && sel.includes("[data-guard-ignore]") ? {} : null) });
    g.onFieldEvent(fieldEvent(el(true)));
    expect(g.dirty).toBe(false);
    g.onFieldEvent(fieldEvent(el(false)));
    expect(g.dirty).toBe(true);
  });
});
