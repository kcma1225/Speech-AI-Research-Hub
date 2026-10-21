import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("production"),
  PORT: z.coerce.number().int().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  APP_ORIGIN: z.url(),
  DATABASE_HOST: z.string().default("db"),
  DATABASE_PORT: z.coerce.number().int().default(5432),
  DATABASE_NAME: z.string().default("research_hub"),
  DATABASE_USER: z.string().default("research_hub"),
  POSTGRES_PASSWORD: z.string().min(1),
  /** Initial admin (bootstrap account). OWNER_NAME / OWNER_PASSWORD are accepted as legacy fallbacks (see loadConfig). */
  ADMIN_NAME: z.string().trim().min(1).max(80).default("admin"),
  ADMIN_PASSWORD: z.string().min(8, "ADMIN_PASSWORD (or legacy OWNER_PASSWORD) must be set, at least 8 characters"),
  AUTH_SECRET: z.string().min(32),
  /** AES-256-GCM key (32 bytes, base64) for AI provider secrets / OAuth tokens (ai/platform/crypto.ts). Empty = secrets can't be stored. */
  PROVIDER_TOKEN_KEY: z
    .string()
    .default("")
    .refine(v => v === "" || Buffer.from(v, "base64").length === 32, "must be 32 bytes, base64"),
  S3_ENDPOINT: z.url().default("http://rustfs:9000"),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().min(3).default("hub"),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  LATEX_URL: z.string().default(""),
  /** OIDC provider for Aldine (routes/oidc.ts); off unless both client id and secret are set. */
  LATEX_OIDC_CLIENT_ID: z.string().trim().max(200).default(""),
  LATEX_OIDC_CLIENT_SECRET: z.string().default("").refine(value => value === "" || value.length >= 32, "must be at least 32 characters"),
  /** Comma-separated exact redirect URIs; default `<LATEX_URL>/api/auth/oauth/oidc/callback`. */
  LATEX_OIDC_REDIRECT_URIS: z.string().default(""),
  VAPID_PUBLIC_KEY: z.string().default(""),
  VAPID_PRIVATE_KEY: z.string().default(""),
  VAPID_SUBJECT: z.string().default("mailto:admin@example.com"),
  WEBAUTHN_RP_ID: z.string().default("localhost"),
  WEBAUTHN_RP_NAME: z.string().default("Speech-AI Research Hub"),
  /** Max upload sizes in bytes. */
  MAX_MEDIA_BYTES: z.coerce.number().int().default(1024 * 1024 * 1024),
  MAX_SLIDE_ZIP_BYTES: z.coerce.number().int().default(200 * 1024 * 1024),
  MAX_REFERENCE_BYTES: z.coerce.number().int().default(50 * 1024 * 1024),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const blank = (value: string | undefined) => (value && value.trim() ? value : undefined);
  const parsed = schema.safeParse({
    ...env,
    ADMIN_NAME: blank(env.ADMIN_NAME) ?? blank(env.OWNER_NAME),
    ADMIN_PASSWORD: blank(env.ADMIN_PASSWORD) ?? blank(env.OWNER_PASSWORD) ?? "",
  });
  if (!parsed.success) {
    const issues = parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}

export const secureCookies = (config: Config) => config.APP_ORIGIN.startsWith("https://");
