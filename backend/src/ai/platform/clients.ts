/** Turns provider rows into library clients (decrypting secrets, wiring subscription tokens). */
import type { Db } from "../../db.js";
import type { AsrProviderConfig } from "../asr/index.js";
import { AiError } from "../errors.js";
import { createClient, type AiClient } from "../providers/index.js";
import { getTokens, type TokenStoreOptions } from "./oauth-store.js";
import { providerSecrets, type ProviderRecord } from "./store.js";
import { isSubscriptionKind, subscriptionFetch } from "./subscriptions.js";

export type ClientFactoryOptions = { fetch?: typeof fetch; tokens?: TokenStoreOptions };

const cache = new Map<string, { stamp: number; client: AiClient }>();

/** Cached per provider row version (`updated_at`), so config edits take effect immediately. */
export function llmClient(db: Db, p: ProviderRecord, opts: ClientFactoryOptions = {}): AiClient {
  const stamp = new Date(p.updated_at).getTime();
  const hit = cache.get(p.id);
  if (hit && hit.stamp === stamp && !opts.fetch) return hit.client;
  const client = buildLlmClient(db, p, opts);
  if (!opts.fetch) cache.set(p.id, { stamp, client });
  return client;
}

export function buildLlmClient(db: Db, p: ProviderRecord, opts: ClientFactoryOptions = {}): AiClient {
  if (p.family !== "llm") throw new AiError("unsupported", { vendorMessage: `provider ${p.id} is not an LLM account` });
  const secrets = providerSecrets(p);
  const config = { ...p.config, ...(p.base_url ? { baseUrl: p.base_url } : {}) };
  if (isSubscriptionKind(p.kind) && p.kind !== "claude-cli") {
    const tokens = () => getTokens(db, p.id, opts.tokens);
    return createClient(p.kind, config, secrets, {
      fetch: subscriptionFetch(p.kind, tokens, opts.fetch),
      oauthTokenProvider: async () => (await tokens()).accessToken,
    });
  }
  return createClient(p.kind, config, secrets, { fetch: opts.fetch });
}

/** ASR config for a member: account form (config + secrets) overlaid with the member's params. */
export function asrConfig(p: ProviderRecord, model: string, params: Record<string, unknown>, fetchImpl?: typeof fetch): AsrProviderConfig {
  if (p.family !== "asr") throw new AiError("unsupported", { vendorMessage: `provider ${p.id} is not an ASR account` });
  const fields = { ...p.config, ...providerSecrets(p), ...params };
  return {
    kind: p.kind,
    baseUrl: p.base_url ?? (typeof p.config.base_url === "string" ? p.config.base_url : undefined),
    fields,
    model,
    timeoutMs: typeof params.timeout_ms === "number" ? params.timeout_ms : undefined,
    pollIntervalMs: typeof params.poll_interval_ms === "number" ? params.poll_interval_ms : undefined,
    fetch: fetchImpl,
  };
}

export function forgetClients(providerId?: string) {
  if (providerId) cache.delete(providerId);
  else cache.clear();
}
