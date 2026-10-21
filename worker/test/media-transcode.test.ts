import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pino from "pino";
import { hasVideoStream, streamTypesArgs, transcodeArgs } from "../src/ffmpeg.js";
import { mediaTranscode } from "../src/handlers/media-transcode.js";
import type { HandlerContext } from "../src/handlers/context.js";
import type { MediaTranscodeResult } from "../src/types.js";

describe("transcode args (meetings)", () => {
  it("concatenates several inputs and maps only audio", () => {
    const args = transcodeArgs(["a.webm", "b.webm"], "out.m4a").join(" ");
    expect(args).toContain("-i a.webm -i b.webm");
    expect(args).toContain("concat=n=2:v=0:a=1[out]");
    expect(args).toContain("-map [out]");
    expect(transcodeArgs("in.mp4", "o.m4a").join(" ")).toContain("-map 0:a:0");
  });
  it("detects real video streams, not cover art", () => {
    expect(hasVideoStream("video,0\naudio,0\n")).toBe(true);
    expect(hasVideoStream("audio,0\nvideo,1\n")).toBe(false);
    expect(hasVideoStream("audio,0\n")).toBe(false);
    expect(streamTypesArgs("x").join(" ")).toContain("csv=p=0");
  });
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

/**
 * Runs the real handler with ffmpeg (skipped when ffmpeg is missing; run inside the worker image:
 * `docker run --rm -v "$PWD":/w -w /w <worker image> npx vitest run test/media-transcode.test.ts`).
 */
describe.skipIf(!hasFfmpeg)("media_transcode handler with ffmpeg", () => {
  let dir: string;
  const objects = new Map<string, string>();
  const deleted: string[] = [];
  const uploaded = new Map<string, string>();
  const ID = "11111111-1111-4111-8111-111111111111";
  const MEETING = "22222222-2222-4222-8222-222222222222";

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "mt-test-"));
    // 3 s test video (H.264 + AAC sine) and two 2 s WebM/Opus parts (like MediaRecorder output).
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=3", "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path.join(dir, "video.mp4")]);
    for (const [i, f] of [330, 550].entries()) {
      execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `sine=frequency=${f}:duration=2`, "-c:a", "libopus", "-b:a", "32k", path.join(dir, `part${i}.webm`)]);
    }
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function context(work: string): HandlerContext {
    const storage = {
      async download(key: string, file: string) {
        const src = objects.get(key);
        if (!src) throw new Error(`missing ${key}`);
        await copyFile(src, file);
      },
      async uploadFile(key: string, file: string) {
        const target = path.join(dir, `up-${uploaded.size}.m4a`);
        await copyFile(file, target);
        uploaded.set(key, target);
      },
      async delete(key: string) {
        deleted.push(key);
      },
    };
    return {
      jobId: "job", config: {} as HandlerContext["config"], storage: storage as unknown as HandlerContext["storage"], log: pino({ level: "silent" }),
      signal: new AbortController().signal, workDir: work, progress() {},
    };
  }

  const probeDuration = (file: string) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file]).toString());

  it("extracts the audio track of a video and keeps the video when asked", async () => {
    objects.set(`media/uploads/${ID}/source`, path.join(dir, "video.mp4"));
    const work = await mkdtemp(path.join(dir, "w1-"));
    const result = (await mediaTranscode({ itemId: ID, sourceKey: `media/uploads/${ID}/source`, outputKey: `media/items/${MEETING}/${ID}.m4a`, fileName: "v.mp4", keepSource: true }, context(work))) as MediaTranscodeResult;
    expect(result.hasVideo).toBe(true);
    expect(result.keptSource).toBe(true);
    expect(deleted).not.toContain(`media/uploads/${ID}/source`);
    const out = uploaded.get(`media/items/${MEETING}/${ID}.m4a`)!;
    expect((await stat(out)).size).toBeGreaterThan(1000);
    const streams = execFileSync("ffprobe", streamTypesArgs(out)).toString();
    expect(hasVideoStream(streams)).toBe(false);
    expect(probeDuration(out)).toBeGreaterThan(2.5);
    expect(result.peaks?.length).toBeGreaterThan(10);
  });

  it("concatenates recorder parts into one audio file and deletes the parts", async () => {
    const parts = [`media/uploads/${ID}/source`, `media/uploads/${ID}/part-1`];
    objects.set(parts[0]!, path.join(dir, "part0.webm"));
    objects.set(parts[1]!, path.join(dir, "part1.webm"));
    deleted.length = 0;
    const work = await mkdtemp(path.join(dir, "w2-"));
    const result = (await mediaTranscode({ itemId: ID, sourceKey: parts[0]!, extraSourceKeys: [parts[1]!], outputKey: `media/items/${MEETING}/${ID}.m4a`, fileName: "rec" }, context(work))) as MediaTranscodeResult;
    expect(result.hasVideo).toBe(false);
    expect(result.keptSource).toBe(false);
    expect(deleted).toEqual(parts);
    const out = uploaded.get(`media/items/${MEETING}/${ID}.m4a`)!;
    expect(probeDuration(out)).toBeGreaterThan(3.5);
    expect(result.durationSeconds).toBeGreaterThan(3.5);
  });

  it("rejects bad part keys", async () => {
    await expect(mediaTranscode({ itemId: ID, sourceKey: `media/uploads/${ID}/source`, extraSourceKeys: ["slides/x"], outputKey: `media/items/${MEETING}/${ID}.m4a`, fileName: "x" }, context(dir))).rejects.toThrow("工作內容不正確");
  });
});
