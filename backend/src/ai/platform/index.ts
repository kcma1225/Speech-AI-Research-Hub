/**
 * Public API of the AI platform for other modules. See docs/architecture.md "AI platform".
 *
 *   import { ai } from "../ai/platform/index.js";
 *   const r = await ai.chat("writing", { messages, maxTokens: 800 }, { userId });
 *   for await (const ev of ai.chatStream("assistant", { messages, tools }, { userId, signal })) …
 *   const { vectors, spaceId } = await ai.embed(["查詢"], "query");
 *   const t = await ai.transcribe({ audio: { path } }, { jobId, resume, onCheckpoint, glossary });
 *   const s = await ai.status();   // role → { state, message_zh }
 *
 * Inside Fastify handlers use `aiFor(request.server)` (same instance).
 */
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { Db } from "../../db.js";
import { AiPlatform, type PlatformOptions } from "./platform.js";

export { AiPlatform } from "./platform.js";
export type { AiCallContext, MemberCheckpoint, PlatformOptions, PublicRoleStatus, PublicStatus, RoleChatRequest, RouteInfo, TranscribeContext } from "./platform.js";
export { PlatformError, isPlatformError, isLlmUnavailable, llmUnavailable, toHttpError, type PlatformErrorCode } from "./errors.js";
export { AI_ROLES, ROLE_CAPABILITY, ROLE_LABEL_ZH, isAiRole, type AiRole, type ChatRole, type RoleState, type RouteCapability } from "./roles.js";
export type { RoleStatus } from "./health.js";

let current: AiPlatform | undefined;
const byPool = new WeakMap<Db, AiPlatform>();

/** Creates (or returns) the process-wide platform. The backend calls this from routes/ai-status.ts; ai-worker from main.ts. */
export function initAiPlatform(db: Db, log: FastifyBaseLogger | Pick<FastifyBaseLogger, "warn" | "info" | "error">, opts: PlatformOptions = {}): AiPlatform {
  let p = byPool.get(db);
  if (!p) {
    p = new AiPlatform(db, log, opts);
    byPool.set(db, p);
  }
  current = p;
  return p;
}

/** The platform bound to this app's database pool. */
export const aiFor = (app: Pick<FastifyInstance, "db" | "log">) => initAiPlatform(app.db, app.log);

function need(): AiPlatform {
  if (!current) throw new Error("AI platform not initialised (initAiPlatform)");
  return current;
}

/** Module-level façade bound to the process-wide platform. */
export const ai = {
  chat: (...a: Parameters<AiPlatform["chat"]>) => need().chat(...a),
  chatStream: (...a: Parameters<AiPlatform["chatStream"]>) => need().chatStream(...a),
  embed: (...a: Parameters<AiPlatform["embed"]>) => need().embed(...a),
  embedForIndex: (...a: Parameters<AiPlatform["embedForIndex"]>) => need().embedForIndex(...a),
  embeddingState: () => need().embeddingState(),
  transcribe: (...a: Parameters<AiPlatform["transcribe"]>) => need().transcribe(...a),
  liveTranscribe: (...a: Parameters<AiPlatform["liveTranscribe"]>) => need().liveTranscribe(...a),
  status: () => need().status(),
  onStatus: (...a: Parameters<AiPlatform["onStatus"]>) => need().onStatus(...a),
  get platform() {
    return need();
  },
};
