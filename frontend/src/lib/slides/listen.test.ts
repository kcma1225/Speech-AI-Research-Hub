import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A speech recognition that behaves like the browsers: `results` accumulate for the whole session. */
class FakeRec {
  static last: FakeRec | null = null;
  static starts = 0;
  static refuseRestart = false;
  lang = "";
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  onstart: (() => void) | null = null;
  said: { text: string; final: boolean }[] = [];
  constructor() {
    FakeRec.last = this;
  }
  start() {
    FakeRec.starts++;
    if (FakeRec.refuseRestart && FakeRec.starts > 1) return void setTimeout(() => (this.onerror?.({ error: "not-allowed" }), this.onend?.()), 0);
    setTimeout(() => this.onstart?.(), 0);
  }
  stop() {
    setTimeout(() => this.onend?.(), 0);
  }
  abort() {
    setTimeout(() => this.onend?.(), 0);
  }
  /** Interim words of the current result, or a final one (iOS: rarely final). */
  hear(text: string, final = true) {
    const open = this.said.at(-1);
    if (open && !open.final) open.text = text;
    else this.said.push({ text, final });
    if (open && !open.final) open.final = final;
    const results = this.said.map((r) => Object.assign([{ transcript: r.text }], { isFinal: r.final }));
    this.onresult?.({ resultIndex: 0, results });
  }
}

describe("Listener (browser speech recognition)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeRec.starts = 0;
    FakeRec.refuseRestart = false;
    (globalThis as { window?: unknown }).window = { webkitSpeechRecognition: FakeRec };
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as { window?: unknown }).window;
  });
  const make = async () => {
    const { Listener } = await import("./listen.svelte.ts");
    const heard: string[] = [];
    const l = new Listener((t) => heard.push(t));
    l.start();
    await vi.advanceTimersByTimeAsync(1);
    return { l, heard };
  };

  it("commits each utterance after a silence, only the new words, without restarting the recognition", async () => {
    const { l, heard } = await make();
    expect(l.listening).toBe(true);
    FakeRec.last!.hear("好接下來看實驗", false);
    expect(l.interim).toBe("好接下來看實驗");
    FakeRec.last!.hear("好接下來看實驗結果", true);
    await vi.advanceTimersByTimeAsync(1400);
    FakeRec.last!.hear("你為什麼選第九層", true);
    await vi.advanceTimersByTimeAsync(1400);
    expect(heard).toEqual(["好接下來看實驗結果", "你為什麼選第九層"]);
    expect(FakeRec.starts).toBe(1);
  });

  it("restarts when the browser ends it (Android), and flush() hands over what is being said", async () => {
    const { l, heard } = await make();
    FakeRec.last!.hear("第一句", true);
    // Ended a while after it started (Android after a silence): restarts at once.
    await vi.advanceTimersByTimeAsync(3000);
    FakeRec.last!.onend?.();
    await vi.advanceTimersByTimeAsync(100);
    expect(heard).toEqual(["第一句"]);
    expect(FakeRec.starts).toBe(2);
    FakeRec.last!.hear("老師的問題還沒講完", false);
    expect(l.flush()).toBe("老師的問題還沒講完");
    expect(heard.at(-1)).toBe("老師的問題還沒講完");
    l.stop();
    expect(l.listening).toBe(false);
  });

  it("a restart the browser refuses (iOS without a tap) asks for a tap, not for a permission", async () => {
    FakeRec.refuseRestart = true;
    const { l } = await make();
    await vi.advanceTimersByTimeAsync(3000);
    FakeRec.last!.onend?.();
    await vi.advanceTimersByTimeAsync(500);
    expect(l.error).toBe("other");
    expect(l.listening).toBe(false);
  });

  it("reports a browser without speech recognition", async () => {
    (globalThis as { window?: unknown }).window = {};
    const { Listener } = await import("./listen.svelte.ts");
    const l = new Listener(() => {});
    l.start();
    expect(l.error).toBe("unsupported");
  });
});
