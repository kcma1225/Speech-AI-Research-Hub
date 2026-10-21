import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LivePoller, sameJson } from "./live-poll.ts";

class FakeDoc extends EventTarget {
  hidden = false;
}

describe("LivePoller", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("ticks on the interval while active and visible, and stops", async () => {
    const tick = vi.fn(async () => {});
    const doc = new FakeDoc();
    let active = true;
    const p = new LivePoller(tick, { interval: 1000, active: () => active, doc: doc as unknown as Document });
    const stop = p.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(tick).toHaveBeenCalledTimes(3);
    active = false;
    await vi.advanceTimersByTimeAsync(2000);
    expect(tick).toHaveBeenCalledTimes(3);
    active = true;
    doc.hidden = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(tick).toHaveBeenCalledTimes(3);
    // Coming back to the page refreshes at once.
    doc.hidden = false;
    doc.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(4);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(tick).toHaveBeenCalledTimes(4);
    expect(p.running).toBe(false);
  });

  it("never overlaps: kicks during a running tick coalesce into one more", async () => {
    let release!: () => void;
    const tick = vi.fn(() => new Promise<void>(r => (release = r)));
    const p = new LivePoller(tick, { interval: 60_000, doc: null });
    void p.kick();
    void p.kick();
    void p.kick();
    expect(tick).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(2);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it("swallows tick errors so the next tick still runs", async () => {
    const tick = vi.fn(async () => {
      throw new Error("offline");
    });
    const p = new LivePoller(tick, { interval: 1000, doc: null });
    p.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(tick).toHaveBeenCalledTimes(2);
    p.stop();
  });
});

describe("sameJson", () => {
  it("compares payloads structurally", () => {
    expect(sameJson({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(sameJson({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameJson(null, [])).toBe(false);
  });
});
