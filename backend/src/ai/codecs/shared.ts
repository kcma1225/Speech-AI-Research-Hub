/** Helpers shared by codecs: message flattening, tool-call accumulation, params whitelist, embeddings. */
import { AiError } from "../errors.js";
import type { ParamSpec } from "../providers/entry.js";
import { setPath } from "../providers/http.js";
import type {
  AssistantMessage,
  ChatEvent,
  ChatMessage,
  ChatRequest,
  CodecId,
  ImageBlock,
  ProviderState,
  ReasoningEffort,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
} from "../types.js";
import type { CodecContext } from "./codec.js";

export function blocksOf<T>(content: string | T[]): Array<T | TextBlock> {
  return typeof content === "string" ? (content ? [{ type: "text", text: content }] : []) : content;
}

export function textOf(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

export function systemText(messages: ChatMessage[]): string {
  return messages
    .filter((m) => m.role === "system")
    .map((m) => textOf(m.content))
    .filter(Boolean)
    .join("\n\n");
}

/** Text of a tool_result's content. */
export function toolResultText(b: ToolResultBlock): string {
  return typeof b.content === "string" ? b.content : textOf(b.content);
}

export function toolResultImages(b: ToolResultBlock): ImageBlock[] {
  return typeof b.content === "string" ? [] : (b.content.filter((c) => c.type === "image") as ImageBlock[]);
}

export function assistantParts(m: AssistantMessage) {
  const blocks = blocksOf(m.content);
  return {
    text: blocks.filter((b): b is TextBlock => b.type === "text").map((b) => b.text).join(""),
    toolUses: blocks.filter((b): b is ToolUseBlock => b.type === "tool_use"),
  };
}

/** providerState data if it belongs to this codec, else undefined. */
export function stateFor<T>(m: AssistantMessage, codec: CodecId): T | undefined {
  return m.providerState?.codec === codec ? (m.providerState.data as T) : undefined;
}

/** Maps tool_use ids → tool names across the history (Gemini/Ollama results need the name). */
export function toolNamesById(messages: ChatMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of messages) if (m.role === "assistant") for (const b of blocksOf(m.content)) if (b.type === "tool_use") map.set(b.id, b.name);
  return map;
}

export function imageDataUrl(img: ImageBlock): string {
  return img.source.kind === "base64" ? `data:${img.source.mediaType};base64,${img.source.data}` : img.source.url;
}

export function parseArgs(json: string): { input: unknown; invalid: boolean } {
  const t = json.trim();
  if (!t) return { input: {}, invalid: false };
  try {
    return { input: JSON.parse(t), invalid: false };
  } catch {
    return { input: null, invalid: true };
  }
}

let idCounter = 0;
export const genToolId = (prefix = "call") => `${prefix}_${Date.now().toString(36)}${(idCounter++).toString(36)}`;

/** Accumulates streamed tool calls keyed by a vendor index/id; emits unified events. */
export class ToolCalls {
  private calls = new Map<string | number, { index: number; id: string; name: string; args: string; started: boolean; ended: boolean }>();
  private next = 0;

  get count() {
    return this.next;
  }

  /** Record a fragment; returns events to emit. */
  push(key: string | number, frag: { id?: string; name?: string; args?: string }): ChatEvent[] {
    const out: ChatEvent[] = [];
    let c = this.calls.get(key);
    if (!c) {
      c = { index: this.next++, id: frag.id || "", name: frag.name || "", args: "", started: false, ended: false };
      this.calls.set(key, c);
    } else {
      if (frag.id && !c.id) c.id = frag.id;
      if (frag.name && !c.name) c.name = frag.name;
    }
    if (!c.started && c.name) {
      if (!c.id) c.id = genToolId();
      c.started = true;
      out.push({ type: "tool_call_start", index: c.index, id: c.id, name: c.name });
      if (c.args) out.push({ type: "tool_call_delta", index: c.index, argsDelta: c.args });
    }
    if (frag.args) {
      c.args += frag.args;
      if (c.started) out.push({ type: "tool_call_delta", index: c.index, argsDelta: frag.args });
    }
    return out;
  }

  /** Replace the full argument string (vendors that send a final `arguments` value). */
  setArgs(key: string | number, args: string) {
    const c = this.calls.get(key);
    if (c) c.args = args;
  }

  end(key: string | number): ChatEvent[] {
    const c = this.calls.get(key);
    if (!c || c.ended) return [];
    const out: ChatEvent[] = [];
    if (!c.started) {
      c.id ||= genToolId();
      c.name ||= "unknown";
      c.started = true;
      out.push({ type: "tool_call_start", index: c.index, id: c.id, name: c.name });
    }
    c.ended = true;
    const { input, invalid } = parseArgs(c.args);
    out.push({ type: "tool_call_end", index: c.index, id: c.id, name: c.name, input, argsJson: c.args, ...(invalid ? { invalidJson: true } : {}) });
    return out;
  }

  endAll(): ChatEvent[] {
    return [...this.calls.keys()].flatMap((k) => this.end(k));
  }
}

/** Emits a complete tool call (vendors that send whole calls) as start/delta/end. */
export function wholeToolCall(index: number, id: string, name: string, input: unknown): ChatEvent[] {
  const argsJson = typeof input === "string" ? input : JSON.stringify(input ?? {});
  const parsed = typeof input === "string" ? parseArgs(input) : { input: input ?? {}, invalid: false };
  return [
    { type: "tool_call_start", index, id, name },
    { type: "tool_call_delta", index, argsDelta: argsJson },
    { type: "tool_call_end", index, id, name, input: parsed.input, argsJson, ...(parsed.invalid ? { invalidJson: true } : {}) },
  ];
}

/**
 * Applies the provider's passthrough whitelist: caller params with keys in `specs` are set
 * (dotted path), and `sendDefault` defaults are filled in. Unknown keys are dropped.
 */
export function applyParams(body: Record<string, unknown>, specs: ParamSpec[], params: Record<string, unknown> | undefined): string[] {
  const dropped: string[] = [];
  const allowed = new Map(specs.map((s) => [s.key, s]));
  for (const s of specs) if (s.sendDefault && s.default !== undefined && !(params && s.key in params)) setPath(body, s.key, s.default);
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v === undefined) continue;
    if (!allowed.has(k)) {
      dropped.push(k);
      continue;
    }
    setPath(body, k, v);
  }
  return dropped;
}

/** Common tail of every chat body: fixed body, admin extraBody, whitelisted params, stripped fields. */
export function finishBody(ctx: CodecContext, body: Record<string, unknown>, req: ChatRequest) {
  for (const [k, v] of Object.entries(ctx.quirks.fixedBody ?? {})) body[k] = v;
  const extra = ctx.config.extraBody;
  if (extra && typeof extra === "object" && !Array.isArray(extra)) for (const [k, v] of Object.entries(extra)) setPath(body, k, v);
  applyParams(body, ctx.entry.params, req.params);
  for (const f of ctx.quirks.stripFields ?? []) delete body[f];
  return body;
}

export function ensureToolsSupported(ctx: CodecContext, req: ChatRequest) {
  if (req.tools?.length && !toolsEnabled(ctx)) {
    throw new AiError("unsupported", { vendorMessage: "tools not enabled for this provider", providerId: ctx.entry.id });
  }
}

export function toolsEnabled(ctx: CodecContext): boolean {
  if (typeof ctx.config.supportsTools === "boolean") return ctx.config.supportsTools;
  return ctx.entry.capabilities.tools;
}

export const EFFORT_ORDER: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Clamp an effort onto a vendor's allowed list (nearest, preferring higher). */
export function clampEffort(effort: ReasoningEffort, allowed: ReasoningEffort[]): ReasoningEffort {
  if (allowed.includes(effort)) return effort;
  const i = EFFORT_ORDER.indexOf(effort);
  for (let d = 1; d < EFFORT_ORDER.length; d++) {
    const up = EFFORT_ORDER[i + d];
    if (up && allowed.includes(up)) return up;
    const down = EFFORT_ORDER[i - d];
    if (down && allowed.includes(down)) return down;
  }
  return allowed[allowed.length - 1] ?? effort;
}

export function makeState(ctx: CodecContext, codec: CodecId, model: string, data: unknown): ProviderState | undefined {
  if (data == null) return undefined;
  if (typeof data === "object" && !Array.isArray(data) && Object.keys(data).length === 0) return undefined;
  return { codec, providerId: ctx.entry.id, model, data };
}

// ---------------------------------------------------------------- embeddings

export function l2normalize(v: number[]): number[] {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s);
  return n > 0 ? v.map((x) => x / n) : v;
}

/** Client-side query/document templates (`{text}` placeholder; `{task}` from config.taskInstruction). */
export function applyEmbedTemplate(ctx: CodecContext, inputs: string[], inputType: "query" | "document"): string[] {
  const tpl = inputType === "query" ? ctx.config.queryTemplate : ctx.config.documentTemplate;
  if (typeof tpl !== "string" || !tpl.includes("{text}")) return inputs;
  const task = String(ctx.config.taskInstruction ?? "Given a web search query, retrieve relevant passages that answer the query");
  return inputs.map((t) => tpl.replaceAll("{task}", task).replaceAll("{text}", t));
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += Math.max(1, size)) out.push(arr.slice(i, i + Math.max(1, size)));
  return out;
}

export function batchSize(ctx: CodecContext, fallback: number) {
  const n = Number(ctx.config.batchSize ?? ctx.quirks.embedBatchSize ?? fallback);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function finishVectors(ctx: CodecContext, vectors: number[][], model: string, inputTokens?: number) {
  const norm = ctx.config.normalize !== false;
  const out = norm ? vectors.map(l2normalize) : vectors;
  const dims = out[0]?.length ?? 0;
  if (out.some((v) => v.length !== dims)) throw new AiError("unavailable", { vendorMessage: "inconsistent embedding dimensions", providerId: ctx.entry.id });
  return { vectors: out, model, dims, usage: { inputTokens } };
}

export function decodeBase64Floats(s: string): number[] {
  const buf = Buffer.from(s, "base64");
  const f = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  return Array.from(f);
}

export function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
