/**
 * Agent tool registry: one definition feeds the agent loop (provider tool list), the consent UI (title, summary,
 * target chip) and the MCP server (`/api/mcp`). Modules add their own tools at import time:
 *
 *   import { z } from "zod";
 *   import { registerAgentTool } from "../agent/tools/registry.js";
 *   registerAgentTool({
 *     name: "get_meeting", title: "讀取會議", titleEn: "Read meeting", risk: "read",
 *     description: "Read a meeting: title, date, studies, participants and the analysis status.",
 *     input: z.object({ meeting_id: z.string().describe("Meeting id (uuid)") }),
 *     summarize: (a) => `讀取會議 ${a.meeting_id}`,
 *     async execute(a, ctx) { … return { data: {...}, untrusted: true }; },
 *   });
 *
 * Rules (docs/architecture.md "Agent"): `execute` runs with `ctx.user`'s permissions through the module's domain
 * helpers — never more than the user could do over HTTP. Risk is static per tool (split tools instead of a
 * `delete` flag). Writes that change existing content must produce suggestions. Content that the caller did not
 * write must be returned with `untrusted: true` (it taints the run).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../../db.js";
import type { CurrentUser } from "../../lib/auth.js";

export type AgentRisk = "read" | "write" | "destructive";
export type ConversationMode = "chat" | "interview";

export type AgentToolContext = {
  app: FastifyInstance;
  db: Db;
  user: CurrentUser;
  /** `mcp`: called by an external MCP client (suggestions only, never direct edits). */
  source: "agent" | "mcp";
  conversationId: string | null;
  runId: string | null;
  /** The call was auto-approved by autopilot: suggestion tools apply their change at once (versions tagged 自動駕駛). */
  autopilot: boolean;
  signal?: AbortSignal;
};

export type AgentToolLink = { label: string; url: string; kind?: "suggestion" | "note" | "task" | "study" | "paper" | "deck" | "meeting" | "memory" };

export type AgentToolResult = {
  /** Structured result: shown in the UI; sent to the model as JSON inside the data envelope unless `text` is set. */
  data: unknown;
  /** Text for the model instead of JSON(data) (still wrapped in the data envelope). */
  text?: string;
  /** The result contains content the caller did not author (other members, transcripts, papers, web): taints the run. */
  untrusted?: boolean;
  /** Provenance label shown on later consent cards (「王小明的筆記〈實驗紀錄〉」). */
  source?: string;
  /** Links the UI shows under the tool row (「在筆記中檢視建議」). */
  links?: AgentToolLink[];
  /** How 「復原」 reverts this call when it ran without a card (autopilot / grant); never sent to the model. */
  undo?: AgentUndo;
};

/**
 * Undo recipe stored with the tool call (`tool_calls.result.undo`). Each kind is refused when the object changed since
 * the call (`stamp` = `updated_at::text` + version / text at the time) or was not created by the caller.
 */
export type AgentUndo =
  | { kind: "task"; id: string; studyId: string; stamp: string }
  | { kind: "note"; id: string; stamp: string }
  | { kind: "text"; targetType: string; targetId: string; before: string; after: string };

/** What a call touches: authorization chip on the card and the scope of 「本對話都允許」. */
export type AgentTarget = { studyId: string | null; studySlug?: string; label: string; url?: string };

export interface AgentToolDef<I extends z.ZodType = z.ZodType> {
  /** `^[a-z][a-z0-9_]{1,63}$` (fits every vendor and MCP). */
  name: string;
  /** zh-TW title for cards and the timeline (「建立待辦」). */
  title: string;
  titleEn: string;
  /** For the model (English; keep stable for prompt caching). */
  description: string;
  input: I;
  risk: AgentRisk;
  /** Never auto-approved, never granted (memory). */
  alwaysAsk?: boolean;
  /** 「本對話都允許」 offered. Default: risk === "write" && !alwaysAsk. */
  grantable?: boolean;
  /** Sends data outside the hub (online search): asks once the run is tainted. */
  openWorld?: boolean;
  idempotent?: boolean;
  /** Produces a suggestion instead of editing (MCP may expose it). */
  suggests?: boolean;
  /** Exposed on /api/mcp. Default: read tools and suggestion tools (never destructive or alwaysAsk). */
  mcp?: boolean;
  /** Conversation modes that offer this tool. Default ["chat"]. */
  modes?: ConversationMode[];
  /** Resolve the target (study) — also used to authorize grants. Return null when there is none. */
  target?(args: z.infer<I>, ctx: AgentToolContext): Promise<AgentTarget | null>;
  /**
   * Runs before the policy decides (agent loop only): return a 繁中 message to fail the call without asking
   * (e.g. `remember` refuses text that only came from tool results in a tainted run).
   */
  precheck?(args: z.infer<I>, info: { tainted: boolean; userText: string; ctx: AgentToolContext }): Promise<string | null> | string | null;
  /** One zh-TW sentence for the card/timeline: 「在〈研究 A〉新增待辦「整理實驗數據」」. */
  summarize(args: z.infer<I>): string;
  execute(args: z.infer<I>, ctx: AgentToolContext): Promise<AgentToolResult>;
}

const NAME = /^[a-z][a-z0-9_]{1,63}$/;
const tools = new Map<string, AgentToolDef>();

/** Registers (or replaces, e.g. the search module's semantic `search`) a tool. Process-wide, any import order. */
export function registerAgentTool<I extends z.ZodType>(def: AgentToolDef<I>): void {
  if (!NAME.test(def.name)) throw new Error(`invalid agent tool name: ${def.name}`);
  if (!(def.input instanceof z.ZodObject)) throw new Error(`agent tool ${def.name}: input must be a z.object`);
  tools.set(def.name, def as unknown as AgentToolDef);
}

export const getAgentTool = (name: string): AgentToolDef | null => tools.get(name) ?? null;

export function listAgentTools(filter: { mode?: ConversationMode; mcp?: boolean } = {}): AgentToolDef[] {
  return [...tools.values()].filter((t) => (!filter.mode || (t.modes ?? ["chat"]).includes(filter.mode)) && (filter.mcp === undefined || isMcpTool(t) === filter.mcp));
}

export const isGrantable = (t: AgentToolDef) => !t.alwaysAsk && t.risk === "write" && (t.grantable ?? true);
export const isMcpTool = (t: AgentToolDef) => !t.alwaysAsk && t.risk !== "destructive" && (t.mcp ?? (t.risk === "read" || !!t.suggests));

/** Portable JSON Schema of the input (object at top level, no $schema/$ref, additionalProperties false). */
const schemas = new WeakMap<AgentToolDef, Record<string, unknown>>();
export function toolJsonSchema(def: AgentToolDef): Record<string, unknown> {
  const cached = schemas.get(def);
  if (cached) return cached;
  const schema = z.toJSONSchema(def.input, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete schema.$schema;
  schema.type = "object";
  schema.additionalProperties = false;
  schema.properties ??= {};
  schemas.set(def, schema);
  return schema;
}

/** MCP annotations derived from our risk class (always all four hints; MCP defaults are the unsafe ones). */
export function mcpAnnotations(def: AgentToolDef) {
  const readOnly = def.risk === "read";
  return {
    title: def.title,
    readOnlyHint: readOnly,
    destructiveHint: def.risk === "destructive",
    idempotentHint: readOnly ? true : (def.idempotent ?? false),
    openWorldHint: def.risk === "destructive" ? false : (def.openWorld ?? false),
  };
}

/** `tools/list` entry. */
export const mcpToolEntry = (def: AgentToolDef) => ({
  name: def.name,
  title: def.title,
  description: def.description,
  inputSchema: toolJsonSchema(def),
  annotations: mcpAnnotations(def),
});

/** Catalogue for the SPA (icons, labels, risk badges). */
export const toolCatalogue = () =>
  [...tools.values()].map((t) => ({ name: t.name, title: t.title, titleEn: t.titleEn, risk: t.risk, alwaysAsk: !!t.alwaysAsk, grantable: isGrantable(t), openWorld: !!t.openWorld, suggests: !!t.suggests }));
