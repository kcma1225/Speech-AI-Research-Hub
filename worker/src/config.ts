import { z } from "zod";

const schema = z.object({
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  DATABASE_HOST: z.string().default("db"),
  DATABASE_PORT: z.coerce.number().int().default(5432),
  DATABASE_NAME: z.string().default("research_hub"),
  WORKER_DB_USER: z.string().default("hub_worker"),
  WORKER_DB_PASSWORD: z.string().min(1),
  S3_ENDPOINT: z.url().default("http://rustfs:9000"),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().min(3).default("hub"),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  /** Scratch space; must be writable (tmpfs in compose). */
  WORK_DIR: z.string().default("/tmp/jobs"),
  /** Pinned offline assets and browser installed by scripts/build-assets.py. */
  SLIDE_ASSETS_DIR: z.string().default("/opt/slide-assets"),
  CHROME_BIN: z.string().default("/opt/chrome/chrome-headless-shell"),
  PREPARE_PDF_SCRIPT: z.string().default("/app/scripts/prepare-pdf.py"),
  ANNOTATE_DIR: z.string().default("/app/assets/annotate"),
  HEALTH_PORT: z.coerce.number().int().default(8080),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}
