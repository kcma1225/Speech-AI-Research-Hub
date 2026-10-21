/** Claude Code CLI adapter: invocation mapping, stream-json parsing (fixture), process runner with a fake binary. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildClaudeCliInvocation, classifyCliError, cliUserMessage, createClaudeStreamParser, parseClaudeStreamJson, runClaudeCli } from "../src/ai/oauth/index.js";
import type { ChatEvent, ChatRequest } from "../src/ai/types.js";

const FIXTURE = [
  { type: "system", subtype: "init", session_id: "s1", model: "claude-sonnet-x", tools: [], cwd: "/tmp/x" },
  { type: "stream_event", event: { type: "message_start", message: { id: "m1", model: "claude-sonnet-x", usage: { input_tokens: 12 } } }, session_id: "s1" },
  { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } },
  { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "想一下" } } },
  { type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } } },
  { type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "你好，" } } },
  { type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "世界" } } },
  { type: "stream_event", event: { type: "content_block_stop", index: 1 } },
  { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } } },
  { type: "assistant", message: { id: "m1", model: "claude-sonnet-x", role: "assistant", content: [{ type: "thinking", thinking: "想一下" }, { type: "text", text: "你好，世界" }], stop_reason: null }, session_id: "s1" },
  { type: "stream_event", event: { type: "message_stop" } },
  { type: "result", subtype: "success", is_error: false, duration_ms: 1200, num_turns: 1, result: "你好，世界", session_id: "s1", total_cost_usd: 0.001, usage: { input_tokens: 12, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } },
].map((l) => JSON.stringify(l));

const req: ChatRequest = {
  model: "sonnet",
  messages: [
    { role: "system", content: "你是實驗室助理。" },
    { role: "user", content: "第一題" },
    { role: "assistant", content: "第一答" },
    { role: "user", content: [{ type: "text", text: "看圖" }, { type: "image", source: { kind: "base64", mediaType: "image/png", data: "iVBOR" } }] },
  ],
  reasoning: { effort: "high" },
};

describe("Claude CLI stream-json parser", () => {
  it("partial messages → deltas once, result → usage + done", async () => {
    async function* lines() {
      yield* ["not json", "", ...FIXTURE];
    }
    const out: ChatEvent[] = [];
    for await (const e of parseClaudeStreamJson(lines())) out.push(e);
    expect(out).toEqual([
      { type: "reasoning_delta", text: "想一下" },
      { type: "text_delta", text: "你好，" },
      { type: "text_delta", text: "世界" },
      { type: "usage", usage: { inputTokens: 12, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 0 } },
      { type: "done", stopReason: "end_turn", model: "claude-sonnet-x" },
    ]);
  });

  it("without partials uses the full assistant message", () => {
    const p = createClaudeStreamParser();
    const evs = [FIXTURE[0]!, FIXTURE[9]!, FIXTURE[11]!].flatMap((l) => p.push(l));
    expect(evs.filter((e) => e.type === "text_delta")).toEqual([{ type: "text_delta", text: "你好，世界" }]);
  });

  it("errors: result is_error and assistant.error map to AiError codes", () => {
    const p = createClaudeStreamParser();
    const [e] = p.push(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Invalid API key · Please run /login sk-ant-oat01-SECRETSECRET" }));
    expect(e!.type).toBe("error");
    const err = (e as Extract<ChatEvent, { type: "error" }>).error;
    expect(err.code).toBe("auth_failed");
    expect(err.vendorMessage).not.toContain("SECRETSECRET");
    const p2 = createClaudeStreamParser();
    const [e2] = p2.push(JSON.stringify({ type: "assistant", error: "rate_limit", message: { content: [{ type: "text", text: "API Error: 429 rate limited" }] } }));
    expect((e2 as any).error.code).toBe("rate_limited");
    expect(classifyCliError("Claude AI usage limit reached|1760000000")).toBe("quota_exhausted");
    expect(classifyCliError("API Error: 529 Overloaded")).toBe("overloaded");
    expect(classifyCliError("Prompt is too long")).toBe("context_too_long");
  });

  it("stream without result → unavailable", async () => {
    async function* lines() {
      yield FIXTURE[0]!;
    }
    const out: ChatEvent[] = [];
    for await (const e of parseClaudeStreamJson(lines())) out.push(e);
    expect(out.at(-1)).toMatchObject({ type: "error" });
  });
});

describe("Claude CLI invocation", () => {
  it("maps model/system/effort, disables tools, passes the token via env only, flattens history", () => {
    const inv = buildClaudeCliInvocation(req, { oauthToken: "sk-ant-oat01-tok" }, "/tmp/home");
    expect(inv.command).toBe("claude");
    expect(inv.args).toEqual(expect.arrayContaining(["-p", "--output-format", "stream-json", "--input-format", "--include-partial-messages", "--no-session-persistence"]));
    const at = (flag: string) => inv.args[inv.args.indexOf(flag) + 1];
    expect(at("--model")).toBe("sonnet");
    expect(at("--system-prompt")).toBe("你是實驗室助理。");
    expect(at("--effort")).toBe("high");
    expect(at("--tools")).toBe("");
    expect(inv.args.join(" ")).not.toContain("sk-ant");
    expect(inv.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-tok", HOME: "/tmp/home", CLAUDE_CONFIG_DIR: "/tmp/home/.claude" });
    expect(inv.env.ANTHROPIC_API_KEY).toBeUndefined();
    const msg = JSON.parse(inv.stdin);
    expect(msg.type).toBe("user");
    expect(msg.message.content[0].text).toContain("<user>\n第一題\n</user>\n<assistant>\n第一答\n</assistant>");
    expect(msg.message.content.slice(1)).toEqual([{ type: "text", text: "看圖" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } }]);
    expect(cliUserMessage([{ role: "user", content: "only" }]).message.content).toEqual([{ type: "text", text: "only" }]);
  });

  it("refuses tool calling", () => {
    expect(() => buildClaudeCliInvocation({ ...req, tools: [{ name: "x", inputSchema: {} }] }, { oauthToken: "t" }, "/h")).toThrow(/tool/);
  });
});

describe("runClaudeCli with a fake binary", () => {
  let dir: string;
  let script: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "fake-claude-"));
    script = join(dir, "fake-claude.mjs");
    await writeFile(
      script,
      `let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN !== "sk-ant-oat01-good") {
    console.error("Invalid API key · Please run /login");
    process.exit(1);
  }
  if (args.includes("--hang")) return setTimeout(() => {}, 60000);
  const msg = JSON.parse(input.trim());
  const echo = msg.message.content.map((b) => b.text).join("|");
  const lines = ${JSON.stringify(FIXTURE)}.map((l) => l.replace("世界", echo + "|" + args[args.indexOf("--model") + 1] + "|" + (process.cwd() === process.env.HOME)));
  for (const l of lines) process.stdout.write(l + "\\n");
});
`,
    );
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  const collect = async (gen: AsyncGenerator<ChatEvent>) => {
    const out: ChatEvent[] = [];
    for await (const e of gen) out.push(e);
    return out;
  };

  it("streams text from the process", async () => {
    const out = await collect(runClaudeCli({ model: "opus", messages: [{ role: "user", content: "hi" }] }, { oauthToken: "sk-ant-oat01-good", command: process.execPath, prefixArgs: [script] }));
    const text = out.filter((e) => e.type === "text_delta").map((e) => (e as any).text).join("");
    expect(text).toBe("你好，hi|opus|true");
    expect(out.at(-1)).toMatchObject({ type: "done", stopReason: "end_turn" });
  });

  it("non-zero exit → classified error from stderr", async () => {
    const out = await collect(runClaudeCli({ model: "opus", messages: [{ role: "user", content: "hi" }] }, { oauthToken: "sk-ant-oat01-bad", command: process.execPath, prefixArgs: [script] }));
    expect(out).toHaveLength(1);
    expect((out[0] as any).error.code).toBe("auth_failed");
  });

  it("abort kills the process → cancelled", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const out = await collect(
      runClaudeCli({ model: "opus", messages: [{ role: "user", content: "hi" }], signal: ac.signal }, { oauthToken: "sk-ant-oat01-good", command: process.execPath, prefixArgs: [script], extraArgs: ["--hang"] }),
    );
    expect((out.at(-1) as any).error.code).toBe("cancelled");
  });

  it("missing binary → unavailable", async () => {
    const out = await collect(runClaudeCli({ model: "x", messages: [{ role: "user", content: "hi" }] }, { oauthToken: "t", command: join(dir, "nope") }));
    expect((out[0] as any).error.code).toBe("unavailable");
  });
});
