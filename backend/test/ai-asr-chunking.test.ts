/** Pure chunk planning/merging, prompt chaining, chunked orchestration with resume, OpenCC. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asrErr } from "../src/ai/asr/err.js";
import {
  chainPrompt,
  convertScript,
  joinTokens,
  mergeChunks,
  normaliseSpeakers,
  parseSilencedetect,
  planChunks,
  segmentsFromWords,
  transcribe,
  type AsrAdapter,
  type AsrCheckpoint,
  type ChunkResult,
  type MediaTools,
} from "../src/ai/asr/index.js";

describe("silencedetect + planning", () => {
  it("parses ffmpeg stderr", () => {
    const stderr = [
      "[silencedetect @ 0x1] silence_start: 10.5",
      "[silencedetect @ 0x1] silence_end: 12.25 | silence_duration: 1.75",
      "size=N/A time=00:01:00.00",
      "[silencedetect @ 0x1] silence_start: 58",
    ].join("\n");
    expect(parseSilencedetect(stderr, 60)).toEqual([
      { start: 10.5, end: 12.25 },
      { start: 58, end: 60 },
    ]);
  });

  it("cuts at the longest silence inside the window, never exceeding max", () => {
    const silences = [
      { start: 500, end: 500.4 },
      { start: 1100, end: 1101 }, // 1 s, inside [900,1200]
      { start: 1150, end: 1153 }, // 3 s, longest → cut at 1151.5
      { start: 2300, end: 2302 },
    ];
    const plan = planChunks(3000, silences, { maxChunkSec: 1200 });
    expect(plan.map((p) => [p.start, p.end])).toEqual([
      [0, 1151.5],
      [1151.5, 2301],
      [2301, 3000],
    ]);
    for (const p of plan) {
      expect(p.end - p.start).toBeLessThanOrEqual(1200);
      expect([p.keepFrom, p.keepTo]).toEqual([p.start, p.end]);
    }
  });

  it("hard-cuts with a 2 s overlap when there is no silence", () => {
    const plan = planChunks(250, [], { maxChunkSec: 100 });
    expect(plan[0]).toEqual({ index: 0, start: 0, end: 99, keepFrom: 0, keepTo: 98 });
    expect(plan[1]).toEqual({ index: 1, start: 97, end: 197, keepFrom: 98, keepTo: 196 });
    expect(plan[2]).toEqual({ index: 2, start: 195, end: 250, keepFrom: 196, keepTo: 250 });
    for (const p of plan) expect(p.end - p.start).toBeLessThanOrEqual(100);
  });

  it("no plan split for short audio", () => {
    expect(planChunks(50, [], { maxChunkSec: 100 })).toEqual([{ index: 0, start: 0, end: 50, keepFrom: 0, keepTo: 50 }]);
  });
});

describe("merge", () => {
  it("offsets times, drops overlap duplicates, namespaces speakers per chunk", () => {
    const plan = planChunks(250, [], { maxChunkSec: 100 });
    const res = (texts: [number, number, string, string][]): ChunkResult => ({
      text: texts.map((t) => t[2]).join(""),
      segments: texts.map(([start, end, text, speaker]) => ({ start, end, text, speaker })),
      words: texts.map(([start, end, text, speaker]) => ({ start, end, text, speaker })),
    });
    const merged = mergeChunks(
      [
        { entry: plan[1]!, result: res([[0, 0.8, "重疊", "A"], [2, 5, "第二段", "A"], [50, 60, "B說", "B"]]) },
        { entry: plan[0]!, result: res([[0, 4, "第一段", "A"], [97.5, 98.9, "重疊", "A"]]) },
        { entry: plan[2]!, result: res([[3, 4, "第三段", "A"]]) },
      ],
      { speakerScope: "chunk" },
    );
    expect(merged.segments.map((s) => [s.start, s.text, s.speaker])).toEqual([
      [0, "第一段", "c0:A"],
      [97.5, "重疊", "c0:A"],
      [99, "第二段", "c1:A"],
      [147, "B說", "c1:B"],
      [198, "第三段", "c2:A"],
    ]);
    // chunk 1's copy of the seam word (abs 97–97.8) is before keepFrom 98 → dropped
    expect(merged.words.filter((w) => w.text === "重疊")).toHaveLength(1);
    expect(merged.warnings).toEqual(expect.arrayContaining(["chunked", "speaker_labels_per_chunk"]));
    expect(merged.text).toBe("第一段重疊第二段B說第三段");
    const speakers = normaliseSpeakers(merged.segments, merged.words);
    expect(speakers.map((s) => s.id)).toEqual(["S1", "S2", "S3", "S4"]);
  });

  it("global speaker scope keeps labels", () => {
    const plan = planChunks(190, [{ start: 99, end: 100 }], { maxChunkSec: 100 });
    const m = mergeChunks(
      plan.map((entry) => ({ entry, result: { text: "x", segments: [{ start: 1, end: 2, text: `t${entry.index}`, speaker: "Alice" }] } })),
      { speakerScope: "global" },
    );
    expect(m.segments.map((s) => s.speaker)).toEqual(["Alice", "Alice"]);
    expect(m.warnings).toEqual(["chunked"]);
  });

  it("prompt chaining keeps the base prompt plus the previous tail", () => {
    const prev = "第一句。".repeat(80);
    const p = chainPrompt("詞彙：BERT", prev)!;
    expect(p.startsWith("詞彙：BERT\n")).toBe(true);
    expect(p.length).toBeLessThanOrEqual(800);
    expect(p.length).toBeGreaterThan(150);
    expect(chainPrompt(undefined, undefined)).toBeUndefined();
  });

  it("segmentsFromWords splits on speaker, pause and punctuation; joinTokens spacing", () => {
    const segs = segmentsFromWords([
      { start: 0, end: 0.3, text: "我們", speaker: "0" },
      { start: 0.3, end: 0.6, text: "用", speaker: "0" },
      { start: 0.6, end: 1, text: "BERT", speaker: "0" },
      { start: 1, end: 1.4, text: "model.", speaker: "0" },
      { start: 1.5, end: 2, text: "好", speaker: "0" },
      { start: 3, end: 3.5, text: "對", speaker: "0" },
      { start: 3.5, end: 4, text: "嗯", speaker: "1" },
    ]);
    expect(segs.map((s) => [s.text, s.speaker])).toEqual([["我們用BERT model.", "0"], ["好", "0"], ["對", "0"], ["嗯", "1"]]);
    expect(joinTokens(["Hello", "world", ",", "你", "好"])).toBe("Hello world,你好");
  });
});

describe("chunked orchestration", () => {
  let dir: string;
  let src: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "asr-chunk-"));
    src = join(dir, "long.m4a");
    await writeFile(src, Buffer.alloc(1000));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  const tools = (log: string[]): MediaTools => ({
    probe: async () => ({ durationSec: 3000, sizeBytes: 1000 }),
    silences: async () => [{ start: 1150, end: 1153 }, { start: 2300, end: 2302 }],
    extract: async (_in, out, fmt, range) => {
      log.push(`${fmt}:${range?.start}-${range?.end}`);
      await writeFile(out, "x");
    },
  });
  const fakeAdapter = (calls: { prompt?: string; size: number }[], fail?: (n: number) => Error | undefined): AsrAdapter => ({
    kind: "fake",
    capabilities: () => ({ diarization: true, wordTimestamps: false, maxDurationSec: 1500, preferredChunkSec: 1200, async: false, streaming: false, prompt: true, keyterms: 0, formats: ["mp3"], traditionalNative: false }),
    async transcribe(_cfg, input) {
      calls.push({ prompt: input.prompt, size: input.part.durationSec ?? 0 });
      const err = fail?.(calls.length);
      if (err) throw err;
      return { text: `段落${calls.length}软件`, segments: [{ start: 1, end: 2, text: `段落${calls.length}软件`, speaker: "A" }], requestId: `r${calls.length}` };
    },
    async probe() {},
  });

  it("cuts at silences, chains prompts, offsets, converts script", async () => {
    const log: string[] = [];
    const calls: { prompt?: string; size: number }[] = [];
    const cps: AsrCheckpoint[] = [];
    const progress: number[] = [];
    const t = await transcribe(
      { kind: "fake", fields: {} },
      { audio: { path: src }, prompt: "會議", diarize: true, convertScript: "s2tw", onCheckpoint: (c) => void cps.push(c), onProgress: (p) => progress.push(p) },
      { tools: tools(log), adapter: fakeAdapter(calls) },
    );
    expect(log).toEqual(["mp3:0-1151.5", "mp3:1151.5-2301", "mp3:2301-3000"]);
    expect(calls[0]!.prompt).toBe("會議");
    expect(calls[1]!.prompt).toBe("會議\n段落1软件");
    expect(t.segments.map((s) => [s.start, s.text])).toEqual([[1, "段落1軟件"], [1152.5, "段落2軟件"], [2302, "段落3軟件"]]);
    expect(t.source.chunks.map((c) => c.offset)).toEqual([0, 1151.5, 2301]);
    expect(t.source.requestIds).toEqual(["r1", "r2", "r3"]);
    expect(t.warnings).toEqual(expect.arrayContaining(["chunked", "speaker_labels_per_chunk"]));
    expect(t.speakers.map((s) => s.label)).toEqual(["c0:A", "c1:A", "c2:A"]);
    expect(cps[0]!.plan).toHaveLength(3);
    expect(Object.keys(cps.at(-1)!.done)).toEqual(["0", "1", "2"]);
    expect(progress.at(-1)).toBe(1);
  });

  it("resumes from a checkpoint without redoing finished chunks", async () => {
    const calls: { prompt?: string; size: number }[] = [];
    let cp: AsrCheckpoint | undefined;
    const failing = fakeAdapter(calls, (n) => (n === 2 ? asrErr("bad_request", "boom") : undefined));
    await expect(
      transcribe({ kind: "fake", fields: {} }, { audio: { path: src }, onCheckpoint: (c) => void (cp = c) }, { tools: tools([]), adapter: failing }),
    ).rejects.toThrow(/bad_request/);
    expect(Object.keys(cp!.done)).toEqual(["0"]);
    const calls2: { prompt?: string; size: number }[] = [];
    const t = await transcribe({ kind: "fake", fields: {} }, { audio: { path: src }, resume: cp }, { tools: tools([]), adapter: fakeAdapter(calls2) });
    expect(calls2).toHaveLength(2);
    expect(calls2[0]!.prompt).toBe("段落1软件");
    expect(t.segments).toHaveLength(3);
  });

  it("re-plans smaller when the vendor says a chunk is too long", async () => {
    const calls: { prompt?: string; size: number }[] = [];
    const adapter = fakeAdapter(calls, (n) => (n === 1 ? asrErr("bad_request", "audio longer than 1500 seconds", { reason: "too_long" }) : undefined));
    const t = await transcribe({ kind: "fake", fields: {} }, { audio: { path: src } }, { tools: tools([]), adapter, retryBaseMs: 1 });
    expect(calls[0]!.size).toBe(1151.5);
    expect(calls[1]!.size).toBeLessThanOrEqual(576);
    expect(t.segments.length).toBeGreaterThan(3);
    expect(t.segments.at(-1)!.start).toBeGreaterThan(2800);
  });
});

describe("OpenCC", () => {
  it("s2tw vs s2twp vs none", () => {
    expect(convertScript("软件里的鼠标和内存", "s2tw")).toBe("軟件裡的鼠標和內存");
    expect(convertScript("软件里的鼠标和内存", "s2twp")).toBe("軟體裡的滑鼠和記憶體");
    expect(convertScript("软件", "none")).toBe("软件");
    expect(convertScript("我們用 Transformer 訓練", "s2twp")).toBe("我們用 Transformer 訓練");
  });
});
