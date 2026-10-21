/** Minimal AWS Signature V4 (header auth) for Transcribe JSON calls and S3 PUT/DELETE. */
import { createHash, createHmac } from "node:crypto";

export type AwsCreds = { accessKeyId: string; secretAccessKey: string; sessionToken?: string };

const sha256 = (d: string | Buffer) => createHash("sha256").update(d).digest("hex");
const hmac = (k: Buffer | string, d: string) => createHmac("sha256", k).update(d).digest();
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function amzDate(d: Date): string {
  return d.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

/**
 * Returns headers to add (authorization, x-amz-date, x-amz-content-sha256, x-amz-security-token).
 * `payloadHash` defaults to sha256(body); pass "UNSIGNED-PAYLOAD" for streamed S3 uploads.
 */
export function signV4(opts: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  payloadHash?: string;
  service: string;
  region: string;
  creds: AwsCreds;
  now?: Date;
}): Record<string, string> {
  const u = new URL(opts.url);
  const date = amzDate(opts.now ?? new Date());
  const day = date.slice(0, 8);
  const payloadHash = opts.payloadHash ?? sha256(opts.body ?? "");
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.headers)) headers[k.toLowerCase()] = String(v).trim().replace(/\s+/g, " ");
  headers.host = u.host;
  headers["x-amz-date"] = date;
  if (opts.service === "s3") headers["x-amz-content-sha256"] = payloadHash;
  if (opts.creds.sessionToken) headers["x-amz-security-token"] = opts.creds.sessionToken;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const path = u.pathname.split("/").map((seg) => enc(decodeURIComponent(seg))).join("/") || "/";
  const query = [...u.searchParams.entries()]
    .map(([k, v]) => [enc(k), enc(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonical = [opts.method.toUpperCase(), path, query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${day}/${opts.region}/${opts.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", date, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${opts.creds.secretAccessKey}`, day), opts.region), opts.service), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  const out: Record<string, string> = {
    "x-amz-date": date,
    authorization: `AWS4-HMAC-SHA256 Credential=${opts.creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
  if (opts.service === "s3") out["x-amz-content-sha256"] = payloadHash;
  if (opts.creds.sessionToken) out["x-amz-security-token"] = opts.creds.sessionToken;
  return out;
}
