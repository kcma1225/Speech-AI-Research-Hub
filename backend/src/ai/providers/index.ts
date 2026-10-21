/** Public entry point of the AI providers library. */
export * from "../types.js";
export * from "../errors.js";
export type {
  AuthSpec,
  AuthType,
  Bilingual,
  Capabilities,
  FieldType,
  FormField,
  ParamSpec,
  ProviderEntry,
  PublicProviderEntry,
  Quirks,
  ReasoningStyle,
} from "./entry.js";
export { aggregateChat, createClient, type AiClient, type ClientOptions } from "./client.js";
export {
  applyDefaults,
  getProvider,
  listProviders,
  publicProviders,
  registerProvider,
  secretKeys,
  toPublic,
  validateAccount,
  type ValidationIssue,
} from "./registry.js";
export { registerAuthStrategy, clearTokenCache, type AuthProvider, type AuthOptions, type SignableRequest } from "./auth.js";
export { CODECS, getCodec, type Codec, type CodecContext } from "../codecs/index.js";
