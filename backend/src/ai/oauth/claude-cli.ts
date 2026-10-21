/**
 * "Claude Code CLI" adapter (EXPERIMENTAL): runs the unmodified `claude` binary in print mode with
 * a `claude setup-token` OAuth token (`CLAUDE_CODE_OAUTH_TOKEN`), maps our ChatRequest to its
 * stream-json input and parses its stream-json output into ChatEvents.
 * Runs in the ai-worker container (internet egress, `claude` installed). Text only: the CLI's
 * built-in tools are disabled and our JSON tools are not supported.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { AiError, type AiErrorCode } from "../errors.js";
import type { ChatEvent, ChatMessage, ChatRequest, ImageBlock, StopReason, TextBlock, Usage } from "../types.js";

export type ClaudeCliOptions = {
  /** `claude setup-token` value (sk-ant-oat…). Passed via env only, never argv. */
  oauthToken: string;
  /** Binary (default `claude`). */
  command?: string;
  /** Args placed before ours (tests: a fixture script run by node). */
  prefixArgs?: string[];
  extraArgs?: string[];
  maxBudgetUsd?: number;
  /** Overall timeout (default 10 min). */
  timeoutMs?: number;
  /** Parent for the per-run scratch HOME (default os.tmpdir()). */
  tmpDir?: string;
};

export type CliInvocation = { command: string; args: string[]; env: Record<string, string>; stdin: string };

const EFFORT: Record<string, string> = { none: "low", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };

function textOf(content: string | Array<{ type: string; [k: string]: any }>): string {
  if (typeof content === "string") return content;
  return content
    .map((b) => {
      if (b.type === "text") return b.text;
      if (b.type === "tool_result") return `[tool result${b.is_error ? " (error)" : ""}] ${typeof b.content === "string" ? b.content : textOf(b.content)}`;
      if (b.type === "tool_use") return `[tool call ${b.name}] ${JSON.stringify(b.input)}`;
      if (b.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function imageBlock(b: ImageBlock) {
  return b.source.kind === "base64"
    ? { type: "image", source: { type: "base64", media_type: b.source.mediaType, data: b.source.data } }
    : { type: "image", source: { type: "url", url: b.source.url } };
}

/** Builds the single stream-json user message: earlier turns flattened as a transcript, then the last user turn. */
export function cliUserMessage(messages: ChatMessage[]): { type: "user"; message: { role: "user"; content: unknown[] } } {
  const turns = messages.filter((m) => m.role !== "system");
  let lastUser = -1;
  for (let i = turns.length - 1; i >= 0; i--)
    if (turns[i]!.role === "user") {
      lastUser = i;
      break;
    }
  if (lastUser < 0) throw new AiError("bad_request", { vendorMessage: "claude-cli: no user message" });
  const content: unknown[] = [];
  if (lastUser > 0) {
    const lines = turns.slice(0, lastUser).map((m) => `<${m.role === "assistant" ? "assistant" : "user"}>\n${textOf(m.content as any)}\n</${m.role === "assistant" ? "assistant" : "user"}>`);
    content.push({ type: "text", text: `<conversation_history>\n${lines.join("\n")}\n</conversation_history>\n\nReply to the latest user message below, continuing the conversation above.` });
  }
  const last = turns[lastUser]!;
  if (typeof last.content === "string") content.push({ type: "text", text: last.content });
  else
    for (const b of last.content as Array<TextBlock | ImageBlock | { type: string }>) {
      if (b.type === "text") content.push({ type: "text", text: (b as TextBlock).text });
      else if (b.type === "image") content.push(imageBlock(b as ImageBlock));
      else content.push({ type: "text", text: textOf([b as any]) });
    }
  return { type: "user", message: { role: "user", content } };
}

export function buildClaudeCliInvocation(req: ChatRequest, opts: ClaudeCliOptions, home: string): CliInvocation {
  if (req.tools?.length && req.toolChoice !== "none")
    throw new AiError("unsupported", { vendorMessage: "claude-cli adapter does not support tool calling" });
  const system = req.messages
    .filter((m) => m.role === "system")
    .map((m) => textOf(m.content as any))
    .join("\n\n");
  const args = [
    ...(opts.prefixArgs ?? []),
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--input-format", "stream-json",
    "--tools", "",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--permission-mode", "dontAsk",
    "--model", req.model,
  ];
  if (system) args.push("--system-prompt", system);
  if (req.reasoning?.effort) args.push("--effort", EFFORT[req.reasoning.effort] ?? "medium");
  if (req.responseFormat?.type === "json_schema") args.push("--json-schema", JSON.stringify(req.responseFormat.schema));
  if (opts.maxBudgetUsd) args.push("--max-budget-usd", String(opts.maxBudgetUsd));
  args.push(...(opts.extraArgs ?? []));
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CLAUDE_CODE_OAUTH_TOKEN: opts.oauthToken,
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    LANG: "C.UTF-8",
  };
  return { command: opts.command ?? "claude", args, env, stdin: JSON.stringify(cliUserMessage(req.messages)) + "\n" };
}

// ---------------------------------------------------------------- output parsing

const STOP: Record<string, StopReason> = { end_turn: "end_turn", max_tokens: "max_tokens", stop_sequence: "stop_sequence", tool_use: "tool_use", refusal: "content_filter" };

/** Maps a CLI error text / assistant `error` field to an AiErrorCode. */
export function classifyCliError(text: string): AiErrorCode {
  const t = text.toLowerCase();
  if (/authentication|invalid api key|oauth|\/login|401|unauthori|token.*(expired|revoked)/.test(t)) return "auth_failed";
  if (/credit balance|billing|extra usage|out of (extra )?usage|spend limit|payment/.test(t)) return "quota_exhausted";
  if (/usage limit|limit reached|hit your limit|limit will reset/.test(t)) return "quota_exhausted";
  if (/rate.?limit|429|too many requests/.test(t)) return "rate_limited";
  if (/overloaded|529/.test(t)) return "overloaded";
  if (/prompt is too long|context (window|length)|too many tokens/.test(t)) return "context_too_long";
  if (/model.*(not found|not available|invalid)|unknown model/.test(t)) return "model_not_found";
  if (/budget/.test(t)) return "quota_exhausted";
  return "unavailable";
}

const redact = (s: string) => s.replace(/sk-ant-[a-z0-9]{2,4}\d*-[A-Za-z0-9_-]+/g, "sk-ant-***");

/**
 * Stateful stream-json parser: feed one stdout line at a time, get ChatEvents back.
 * Partial-message `stream_event`s produce deltas; full `assistant` messages are used only when no
 * partials were seen for them; `result` produces usage + done (or error).
 */
export function createClaudeStreamParser() {
  let streamedThisMessage = false;
  let anyText = false;
  let stop: StopReason = "end_turn";
  let model: string | undefined;
  let finished = false;
  const usage: Usage = {};
  return {
    get finished() {
      return finished;
    },
    push(line: string): ChatEvent[] {
      const s = line.trim();
      if (!s || finished) return [];
      let ev: any;
      try {
        ev = JSON.parse(s);
      } catch {
        return [];
      }
      const out: ChatEvent[] = [];
      switch (ev.type) {
        case "system":
          if (ev.subtype === "init" && ev.model) model = ev.model;
          break;
        case "stream_event": {
          const e = ev.event ?? {};
          if (ev.parent_tool_use_id) break;
          if (e.type === "message_start") {
            streamedThisMessage = false;
            model = e.message?.model ?? model;
          } else if (e.type === "content_block_delta") {
            if (e.delta?.type === "text_delta" && e.delta.text) {
              streamedThisMessage = true;
              anyText = true;
              out.push({ type: "text_delta", text: e.delta.text });
            } else if (e.delta?.type === "thinking_delta" && e.delta.thinking) {
              streamedThisMessage = true;
              out.push({ type: "reasoning_delta", text: e.delta.thinking });
            }
          } else if (e.type === "message_delta" && e.delta?.stop_reason) stop = STOP[e.delta.stop_reason] ?? "other";
          break;
        }
        case "assistant": {
          if (ev.parent_tool_use_id) break;
          const msg = ev.message ?? {};
          model = msg.model ?? model;
          if (ev.error) {
            finished = true;
            const text = textOf(msg.content ?? []) || String(ev.error);
            out.push({ type: "error", error: new AiError(classifyCliError(`${ev.error} ${text}`), { vendorCode: String(ev.error), vendorMessage: redact(text) }) });
            break;
          }
          if (!streamedThisMessage)
            for (const b of msg.content ?? []) {
              if (b.type === "text" && b.text) {
                anyText = true;
                out.push({ type: "text_delta", text: b.text });
              } else if (b.type === "thinking" && b.thinking) out.push({ type: "reasoning_delta", text: b.thinking });
            }
          if (msg.stop_reason) stop = STOP[msg.stop_reason] ?? stop;
          streamedThisMessage = false;
          break;
        }
        case "result": {
          finished = true;
          const u = ev.usage ?? {};
          usage.inputTokens = u.input_tokens;
          usage.outputTokens = u.output_tokens;
          usage.cacheReadTokens = u.cache_read_input_tokens;
          usage.cacheWriteTokens = u.cache_creation_input_tokens;
          if (ev.is_error || (ev.subtype && ev.subtype !== "success")) {
            const text = String(ev.result ?? ev.errors?.join?.("; ") ?? ev.subtype ?? "error");
            out.push({ type: "error", error: new AiError(classifyCliError(text), { vendorCode: ev.subtype, vendorMessage: redact(text), midStream: anyText }) });
            break;
          }
          if (!anyText) {
            const text = ev.structured_output != null ? JSON.stringify(ev.structured_output) : String(ev.result ?? "");
            if (text) out.push({ type: "text_delta", text });
          }
          out.push({ type: "usage", usage: { ...usage } });
          out.push({ type: "done", stopReason: stop, model });
          break;
        }
      }
      return out;
    },
  };
}

/** Parses a whole stream (async lines) into ChatEvents. */
export async function* parseClaudeStreamJson(lines: AsyncIterable<string>): AsyncGenerator<ChatEvent> {
  const p = createClaudeStreamParser();
  for await (const line of lines) {
    for (const ev of p.push(line)) yield ev;
    if (p.finished) return;
  }
  yield { type: "error", error: new AiError("unavailable", { vendorMessage: "claude-cli: stream ended without a result", midStream: true }) };
}

/** Runs the CLI for one chat request. Kills the process on abort/timeout. Never logs the token. */
export async function* runClaudeCli(req: ChatRequest, opts: ClaudeCliOptions): AsyncGenerator<ChatEvent> {
  const home = await mkdtemp(join(opts.tmpDir ?? tmpdir(), "claude-cli-"));
  let child: ChildProcessWithoutNullStreams | undefined;
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 600_000);
  const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
  const kill = () => child?.kill("SIGTERM");
  try {
    const inv = buildClaudeCliInvocation(req, opts, home);
    child = spawn(inv.command, inv.args, { cwd: home, env: inv.env, stdio: ["pipe", "pipe", "pipe"] });
    signal.addEventListener("abort", kill, { once: true });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
    const exited = new Promise<{ code: number | null; error?: Error }>((resolve) => {
      child!.once("error", (error) => resolve({ code: null, error }));
      child!.once("close", (code) => resolve({ code }));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(inv.stdin);
    const p = createClaudeStreamParser();
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    for await (const line of rl) {
      for (const ev of p.push(line)) yield ev;
      if (p.finished) break;
    }
    if (!p.finished) {
      const { code, error } = await exited;
      if (signal.aborted) {
        yield { type: "error", error: new AiError(timeout.aborted ? "timeout" : "cancelled", { midStream: true }) };
      } else if (error) {
        yield { type: "error", error: new AiError("unavailable", { vendorMessage: `claude-cli: cannot start (${(error as NodeJS.ErrnoException).code ?? error.message})` }) };
      } else {
        const text = redact(stderr.trim()) || `exit ${code}`;
        yield { type: "error", error: new AiError(classifyCliError(text), { vendorMessage: `claude-cli: ${text.slice(-500)}`, midStream: true }) };
      }
    }
  } finally {
    signal.removeEventListener("abort", kill);
    if (child && child.exitCode == null) child.kill("SIGTERM");
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  }
}
