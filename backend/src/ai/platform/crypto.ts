/**
 * AES-256-GCM for provider secrets and OAuth tokens. Key: env PROVIDER_TOKEN_KEY (32 bytes, base64), never
 * AUTH_SECRET. The AAD binds a ciphertext to its row and purpose (`<provider id>:secrets`), so a blob copied to
 * another row does not decrypt. Layout: version(1) | iv(12) | tag(16) | ciphertext.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { PlatformError } from "./errors.js";

const VERSION = 1;
let cachedKey: { raw: string; key: Buffer } | undefined;

export function providerKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.PROVIDER_TOKEN_KEY ?? "";
  if (cachedKey?.raw === raw) return cachedKey.key;
  const key = Buffer.from(raw, "base64");
  if (!raw || key.length !== 32) throw new PlatformError("secrets_key_missing");
  cachedKey = { raw, key };
  return key;
}

export const hasProviderKey = () => {
  try {
    providerKey();
    return true;
  } catch {
    return false;
  }
};

export function encryptJson(value: unknown, aad: string, key = providerKey()): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ct]);
}

export function decryptJson<T = unknown>(blob: Buffer, aad: string, key = providerKey()): T {
  if (blob.length < 29 || blob[0] !== VERSION) throw new PlatformError("secrets_corrupt");
  const decipher = createDecipheriv("aes-256-gcm", key, blob.subarray(1, 13));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(blob.subarray(13, 29));
  try {
    return JSON.parse(Buffer.concat([decipher.update(blob.subarray(29)), decipher.final()]).toString("utf8")) as T;
  } catch {
    throw new PlatformError("secrets_corrupt");
  }
}

export const secretsAad = (providerId: string) => `${providerId}:secrets`;
export const oauthAad = (providerId: string) => `${providerId}:oauth`;
export const sessionAad = (sessionId: string) => `${sessionId}:oauth_session`;
