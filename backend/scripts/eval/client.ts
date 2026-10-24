/**
 * Eval harness plumbing: the hub API as one user (cookie session, retries across staging redeploys), read-only SQL on
 * the staging database through `docker exec` (ai_call_log, workflow steps / events), and which build is deployed.
 * Never points at production: the URL and the compose project are refused.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);

export const HUB = (process.env.HUB_URL ?? "http://127.0.0.1:18090").replace(/\/+$/, "");
/** Staging compose project (containers `<project>-db-1`, `<project>-ai-worker-1`, `<project>-backend-1`). */
export const PROJECT = process.env.EVAL_COMPOSE_PROJECT ?? "hubv3";
if (/speech-ai-hub\.gugulu\.tw/.test(HUB) || PROJECT === "hub") throw new Error("Refusing to run the eval against production.");

export class HttpFail extends Error {
  constructor(readonly status: number, readonly data: Record<string, unknown>, message: string) {
    super(message);
  }
}

export class Hub {
  private cookie = "";
  private readonly origin = new URL(HUB).origin;
  constructor(readonly username: string, private readonly password: string) {}

  async login() {
    await this.api("POST", "/auth/login", { username: this.username, password: this.password });
  }

  /** Raw text of a GET (file contents). */
  async text(path: string): Promise<string> {
    const res = await fetch(`${HUB}/api${path}`, { headers: { origin: this.origin, cookie: this.cookie } });
    if (!res.ok) throw new HttpFail(res.status, {}, `GET ${path} → ${res.status}`);
    return res.text();
  }

  /** JSON API call; connection errors and 502/503/504 (a redeploy) are retried for ~5 minutes. */
  async api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    for (let i = 0; ; i++) {
      let res: Response;
      try {
        res = await fetch(`${HUB}/api${path}`, { method, headers: { origin: this.origin, cookie: this.cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
      } catch (e) {
        if (i >= 30) throw e;
        await sleep(10_000);
        continue;
      }
      if ([502, 503, 504].includes(res.status) && i < 30 && !path.startsWith("/auth")) {
        await sleep(10_000);
        continue;
      }
      const set = res.headers.get("set-cookie");
      if (set) this.cookie = set.split(";")[0]!;
      const text = await res.text();
      let data: any = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { error: text.slice(0, 200) };
      }
      if (res.status === 401 && path !== "/auth/login" && i < 2) {
        await this.login();
        continue;
      }
      if (!res.ok) throw new HttpFail(res.status, data, `${method} ${path} → ${res.status} ${data.code ?? ""} ${data.error ?? ""}`);
      return data as T;
    }
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Read-only SQL on the staging database (rows as JSON objects). Only literal UUIDs are interpolated by callers. */
export async function sql<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const wrapped = `SELECT coalesce(json_agg(t), '[]'::json) FROM (${query}) t`;
  const { stdout } = await run("docker", ["exec", `${PROJECT}-db-1`, "psql", "-U", process.env.EVAL_DB_USER ?? "research_hub", "-d", process.env.EVAL_DB_NAME ?? "research_hub", "-Atc", wrapped], { maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(stdout.trim() || "[]") as T[];
}

export const isUuid = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f-]{36}$/i.test(s);

export type Build = { image: string; created: string; git: string };

/** The deployed ai-worker image (the one that executes workflows) + the local git HEAD, for attributing results. */
export async function deployedBuild(): Promise<Build> {
  let image = "?";
  let created = "?";
  try {
    const { stdout } = await run("docker", ["inspect", `${PROJECT}-ai-worker-1`, "--format", "{{.Image}} {{.Created}}"]);
    const [img, cr] = stdout.trim().split(" ");
    image = (img ?? "?").replace(/^sha256:/, "").slice(0, 12);
    created = cr ?? "?";
  } catch {
    // docker not reachable: leave unknown
  }
  let git = "?";
  try {
    const src = fileURLToPath(new URL("../../src", import.meta.url));
    const head = (await run("git", ["-C", src, "rev-parse", "--short", "HEAD"])).stdout.trim();
    const dirty = (await run("git", ["-C", src, "status", "--porcelain", "--", "."])).stdout.trim();
    git = dirty ? `${head}+dirty` : head;
  } catch {
    // not a checkout
  }
  return { image, created, git };
}
