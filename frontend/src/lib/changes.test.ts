import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("data-changed signal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("BroadcastChannel", undefined);
    vi.resetModules();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("coalesces a burst and only wakes listeners of the changed kinds", async () => {
    const { emitChanged, onChanged, kindsOfTool } = await import("./changes.ts");
    const papers = vi.fn();
    const notes = vi.fn();
    onChanged(["papers"], papers);
    onChanged(["notes"], notes);
    // The AI imports several papers in a row: one reload.
    for (let i = 0; i < 5; i++) emitChanged(kindsOfTool("import_paper"));
    vi.advanceTimersByTime(500);
    expect(papers).toHaveBeenCalledTimes(1);
    expect(notes).not.toHaveBeenCalled();
    expect(kindsOfTool("get_paper")).toEqual([]);
  });

  it("a finished background job announces what it wrote", async () => {
    const { onChanged } = await import("./changes.ts");
    const { announceFinished } = await import("./stores/jobs.svelte.ts");
    const papers = vi.fn();
    onChanged(["papers"], papers);
    const job = { id: "j1", kind: "ai_library_import", status: "running", stage: "", progress: 0, label: "", url: null, updatedAt: "" } as never;
    announceFinished([job], [job]);
    vi.advanceTimersByTime(500);
    expect(papers).not.toHaveBeenCalled();
    announceFinished([job], []);
    vi.advanceTimersByTime(500);
    expect(papers).toHaveBeenCalledTimes(1);
  });
});
