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
  /** Parallel compiles. Each one can use up to LATEX_MEMORY_MB. */
  LATEX_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  /** Per-project caches (`projects/<id>/src`) and nothing else; must be writable. */
  WORK_DIR: z.string().default("/tmp/latex"),
  /** How many per-project caches to keep (least recently used are deleted). */
  LATEX_CACHE_PROJECTS: z.coerce.number().int().min(1).max(500).default(16),
  LATEX_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(600).default(120),
  /** RLIMIT_AS for the TeX process tree. */
  LATEX_MEMORY_MB: z.coerce.number().int().min(256).max(16384).default(2048),
  /** RLIMIT_CPU (seconds of CPU per process). */
  LATEX_CPU_SECONDS: z.coerce.number().int().min(10).max(1200).default(150),
  /** RLIMIT_FSIZE: largest file a compile may write (stops runaway \write loops). */
  LATEX_FILE_SIZE_MB: z.coerce.number().int().min(1).max(4096).default(200),
  /** RLIMIT_NPROC (counts every process/thread of the runner's uid, so keep headroom). */
  LATEX_NPROC: z.coerce.number().int().min(16).max(4096).default(256),
  /** Snapshot limits checked before downloading. */
  LATEX_MAX_FILES: z.coerce.number().int().min(1).max(20000).default(2000),
  LATEX_MAX_PROJECT_MB: z.coerce.number().int().min(1).max(4096).default(300),
  /**
   * `bwrap`: every compile runs in a bubblewrap sandbox (needs the seccomp profile in seccomp.json).
   * `none`: no sandbox. Only for local development/tests; projects can read each other's caches.
   */
  LATEX_SANDBOX: z.enum(["bwrap", "none"]).default("bwrap"),
  /** Pre-extracted biber (PAR) cache baked into the image. */
  BIBER_PAR_DIR: z.string().default("/opt/par"),
  TEXLIVE_BIN: z.string().default("/usr/local/texlive/bin"),
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
