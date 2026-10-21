/**
 * End-to-end: the real latex-runner image claims `latex_compile` jobs from a scratch database and
 * compiles projects stored in RustFS, inside its bubblewrap sandbox.
 *
 *   LATEX_E2E_IMAGE=hub-latex-runner:dev \
 *   TEST_ADMIN_URL=postgres://postgres:pw@127.0.0.1:55440/postgres \
 *   TEST_S3_ENDPOINT=http://127.0.0.1:59040 TEST_S3_ACCESS_KEY=testkey TEST_S3_SECRET_KEY=testsecret123 \
 *   npx vitest run test/e2e.test.ts
 *
 * Creates database `latex_e2e`, role `latex_e2e_worker` and bucket `latex-e2e`; starts the container
 * with --network host (test only) and the same hardening as compose. Set LATEX_E2E_FIXTURES=<dir> to
 * also save every compile's .log/.blg there (parser fixtures).
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CreateBucketCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateTemplate, type LatexTemplateId } from "../../backend/src/lib/latex/templates.js";
import type { LatexCompilePayload, LatexCompileResult, LatexSnapshotManifest } from "../src/shared/contract.js";

const run = promisify(execFile);
const IMAGE = process.env.LATEX_E2E_IMAGE;
const ADMIN_URL = process.env.TEST_ADMIN_URL;
const S3_ENDPOINT = process.env.TEST_S3_ENDPOINT;
const enabled = !!(IMAGE && ADMIN_URL && S3_ENDPOINT);
const here = path.dirname(fileURLToPath(import.meta.url));
const BUCKET = "latex-e2e";
const DB = "latex_e2e";
const ROLE = "latex_e2e_worker";
const ROLE_PW = "e2e-" + randomUUID().slice(0, 8);
const CONTAINER = "latex-e2e-runner";
const FIXTURES = process.env.LATEX_E2E_FIXTURES;

let admin: pg.Client;
let db: pg.Client;
let s3: S3Client;

const JOBS_DDL = `
CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('media_transcode','slide_render','latex_compile')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  payload jsonb NOT NULL,
  result jsonb,
  error text,
  stage text NOT NULL DEFAULT 'queued',
  progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  run_after timestamptz NOT NULL DEFAULT now(),
  cancel_requested boolean NOT NULL DEFAULT false,
  locked_by text,
  heartbeat_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  finalized_at timestamptz
);`;

async function putProject(projectId: string, files: { path: string; content: string | Buffer }[]) {
  const manifest: LatexSnapshotManifest = { version: 1, files: [] };
  for (const file of files) {
    const body = typeof file.content === "string" ? Buffer.from(file.content) : file.content;
    const sha256 = createHash("sha256").update(body).digest("hex");
    const key = `latex/${projectId}/blobs/${sha256}`;
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body }));
    manifest.files.push({ path: file.path, key, size: body.length, sha256 });
  }
  const manifestKey = `latex/${projectId}/snapshots/${randomUUID()}.json`;
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: manifestKey, Body: JSON.stringify(manifest) }));
  return manifestKey;
}

async function readDir(dir: string, base = ""): Promise<{ path: string; content: Buffer }[]> {
  const out: { path: string; content: Buffer }[] = [];
  for (const entry of await readdir(path.join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await readDir(dir, rel)));
    else out.push({ path: rel, content: await readFile(path.join(dir, rel)) });
  }
  return out;
}

type Finished = { status: string; result: LatexCompileResult | null; error: string | null };

async function compile(
  projectId: string,
  files: { path: string; content: string | Buffer }[],
  options: Partial<Pick<LatexCompilePayload, "compiler" | "rootFile" | "draft" | "haltOnError">> & { name: string },
): Promise<Finished> {
  const manifestKey = await putProject(projectId, files);
  const compileId = randomUUID();
  const payload: LatexCompilePayload = {
    projectId,
    compileId,
    manifestKey,
    rootFile: options.rootFile ?? "main.tex",
    compiler: options.compiler ?? "pdflatex",
    outputPrefix: `latex/${projectId}/builds/${compileId}/`,
    draft: options.draft,
    haltOnError: options.haltOnError,
  };
  const inserted = await db.query<{ id: string }>("INSERT INTO jobs (kind, payload) VALUES ('latex_compile', $1) RETURNING id", [payload]);
  await db.query("SELECT pg_notify('jobs_new', 'latex_compile')");
  const jobId = inserted.rows[0]!.id;
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const row = (await db.query<Finished>("SELECT status, result, error FROM jobs WHERE id=$1", [jobId])).rows[0]!;
    if (["succeeded", "failed", "cancelled"].includes(row.status)) {
      if (FIXTURES && row.result) await saveFixtures(options.name, row.result);
      return row;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`job ${jobId} did not finish`);
}

async function getObject(key: string): Promise<Buffer> {
  const output = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return Buffer.from(await output.Body!.transformToByteArray());
}

async function saveFixtures(name: string, result: LatexCompileResult) {
  await mkdir(FIXTURES!, { recursive: true });
  if (result.logKey) await writeFile(path.join(FIXTURES!, `${name}.log`), await getObject(result.logKey));
  if (result.blgKey) await writeFile(path.join(FIXTURES!, `${name}.blg`), await getObject(result.blgKey));
}

describe.skipIf(!enabled)("latex-runner end to end", () => {
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [DB]);
    if (!exists.rowCount) await admin.query(`CREATE DATABASE ${DB}`);
    const role = await admin.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [ROLE]);
    await admin.query(`${role.rowCount ? "ALTER" : "CREATE"} ROLE ${ROLE} LOGIN PASSWORD '${ROLE_PW}'`);
    const url = new URL(ADMIN_URL!);
    url.pathname = `/${DB}`;
    db = new pg.Client({ connectionString: url.toString() });
    await db.connect();
    await db.query(JOBS_DDL);
    await db.query("DELETE FROM jobs");
    await db.query(`GRANT SELECT, UPDATE ON jobs TO ${ROLE}`);

    s3 = new S3Client({
      endpoint: S3_ENDPOINT,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: process.env.TEST_S3_ACCESS_KEY ?? "testkey", secretAccessKey: process.env.TEST_S3_SECRET_KEY ?? "testsecret123" },
    });
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET })).catch(() => {});

    await run("docker", ["rm", "-f", CONTAINER]).catch(() => {});
    const s3Url = new URL(S3_ENDPOINT!);
    await run("docker", [
      "run", "-d", "--name", CONTAINER, "--network", "host",
      "--read-only", "--tmpfs", "/tmp:size=1g,mode=1777",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--security-opt", `seccomp=${path.resolve(here, "../seccomp.json")}`,
      "--pids-limit", "512", "--memory", "3g",
      "-e", `DATABASE_HOST=${url.hostname}`, "-e", `DATABASE_PORT=${url.port}`, "-e", `DATABASE_NAME=${DB}`,
      "-e", `WORKER_DB_USER=${ROLE}`, "-e", `WORKER_DB_PASSWORD=${ROLE_PW}`,
      "-e", `S3_ENDPOINT=${s3Url.origin}`, "-e", `S3_BUCKET=${BUCKET}`,
      "-e", `S3_ACCESS_KEY=${process.env.TEST_S3_ACCESS_KEY ?? "testkey"}`, "-e", `S3_SECRET_KEY=${process.env.TEST_S3_SECRET_KEY ?? "testsecret123"}`,
      "-e", "HEALTH_PORT=18931", "-e", "LATEX_TIMEOUT_SECONDS=25", "-e", "LOG_LEVEL=debug",
      // LATEX_E2E_DIST=dist runs a locally built runner (npm run build) in the image without rebuilding it.
      ...(process.env.LATEX_E2E_DIST ? ["-v", `${path.resolve(here, "..", process.env.LATEX_E2E_DIST)}:/app/dist:ro`] : []),
      IMAGE!,
    ]);
  }, 120_000);

  afterAll(async () => {
    if (process.env.LATEX_E2E_KEEP !== "1") await run("docker", ["rm", "-f", CONTAINER]).catch(() => {});
    else console.log((await run("docker", ["logs", CONTAINER]).catch(error => ({ stdout: String(error) }))).stdout);
    await db?.end();
    await admin?.end();
  });

  async function compileTemplate(id: LatexTemplateId) {
    const zh = id === "zh-thesis" || id === "article-zh";
    const project = generateTemplate(id, zh ? { title: "端對端測試", author: "測試者" } : { title: "End-to-end test", author: "Tester" });
    const projectId = randomUUID();
    const finished = await compile(projectId, project.files, { compiler: project.compiler, name: `template-${id}` });
    return { finished, project, projectId };
  }

  it.each<LatexTemplateId>(["zh-thesis", "ieee-conference", "article-zh", "article-en"])("compiles the %s template to PDF + SyncTeX", async id => {
    const { finished } = await compileTemplate(id);
    expect(finished.error).toBeNull();
    expect(finished.status).toBe("succeeded");
    const result = finished.result!;
    expect(result.errors).toEqual([]);
    expect(result.status).toBe("success");
    const pdf = await getObject(result.pdfKey!);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const synctex = await getObject(result.synctexKey!);
    expect(synctex[0]).toBe(0x1f); // gzip
    expect(result.blgKey).not.toBeNull();
    const blg = (await getObject(result.blgKey!)).toString();
    expect(blg).toMatch(id === "zh-thesis" || id === "article-zh" ? /This is Biber/ : /This is BibTeX/);
    // Citations and references resolved on the final pass.
    const log = (await getObject(result.logKey!)).toString();
    expect(log).not.toMatch(/Citation .* undefined|There were undefined references/);
    if (id === "zh-thesis") {
      expect(log).toMatch(/NotoSerifCJK/i);
      expect(result.warnings.filter(warning => /Missing character/.test(warning.message))).toEqual([]);
    }
  }, 240_000);

  it("reports parsed errors with file:line and zh hints for a broken project", async () => {
    const files = await readDir(path.join(here, "projects/errors-mixed"));
    const finished = await compile(randomUUID(), files, { name: "errors-mixed" });
    expect(finished.status).toBe("succeeded");
    const result = finished.result!;
    expect(result.status).toBe("partial"); // -f still produces a PDF
    const undefinedCs = result.errors.find(error => error.code === "undefined-control-sequence")!;
    expect(undefinedCs).toMatchObject({ file: "sections/broken.tex", line: 2, token: "\\foo" });
    expect(undefinedCs.hint_zh).toMatch(/指令/);
    expect(result.errors.some(error => error.code === "missing-dollar" && error.file === "sections/broken.tex")).toBe(true);
    expect(result.errors.some(error => error.code === "environment-undefined" && error.line === 6)).toBe(true);
    expect(result.warnings.some(warning => warning.code === "undefined-reference")).toBe(true);
    expect(result.warnings.some(warning => warning.code === "undefined-citation")).toBe(true);
    expect(result.badBoxCount).toBeGreaterThan(0);
    // No absolute container paths leak into what the editor shows.
    expect(JSON.stringify(result)).not.toMatch(/\/work\/|\/tmp\/latex|\/usr\/local\/texlive/);
  }, 240_000);

  it("fails cleanly on a missing package", async () => {
    const files = await readDir(path.join(here, "projects/missing-package"));
    const result = (await compile(randomUUID(), files, { name: "missing-package" })).result!;
    expect(result.status).toBe("failure");
    expect(result.pdfKey).toBeNull();
    expect(result.errors[0]).toMatchObject({ code: "file-not-found", file: "main.tex" });
    expect(result.errors[0]!.line).toBeGreaterThanOrEqual(2);
  }, 240_000);

  it("parses BibTeX and biber problems", async () => {
    const bibtex = (await compile(randomUUID(), await readDir(path.join(here, "projects/bibtex-errors")), { name: "bibtex-errors" })).result!;
    expect(bibtex.errors.some(error => error.source === "bibtex" && error.file === "refs.bib" && error.code === "bib-syntax")).toBe(true);
    expect(bibtex.warnings.some(warning => warning.source === "bibtex" && /absent2021/.test(warning.message))).toBe(true);
    const biber = (await compile(randomUUID(), await readDir(path.join(here, "projects/biber-errors")), { name: "biber-errors" })).result!;
    expect(biber.errors.some(error => error.source === "biber" && error.file === "refs.bib")).toBe(true);
    // biber 2.21 no longer warns about missing entries; LaTeX does.
    expect(biber.warnings.some(warning => /absent2021/.test(warning.message))).toBe(true);
  }, 240_000);

  it("explains Chinese under pdfLaTeX and missing CJK glyphs under XeLaTeX", async () => {
    const zh = (await compile(randomUUID(), await readDir(path.join(here, "projects/zh-pdflatex")), { name: "zh-pdflatex" })).result!;
    expect(zh.errors.some(error => error.code === "unicode-not-setup")).toBe(true);
    const glyph = (await compile(randomUUID(), await readDir(path.join(here, "projects/missing-glyph")), { compiler: "xelatex", name: "missing-glyph" })).result!;
    expect(glyph.status).toBe("success");
    expect(glyph.warnings.some(warning => warning.code === "missing-glyph")).toBe(true);
  }, 240_000);

  it("compiles with LuaLaTeX (luatexja + Noto CJK)", async () => {
    const result = (await compile(randomUUID(), await readDir(path.join(here, "projects/lualatex")), { compiler: "lualatex", name: "lualatex" })).result!;
    expect(result.errors).toEqual([]);
    expect(result.pdfKey).not.toBeNull();
  }, 240_000);

  it("isolates projects: no /etc, /proc, /app or other projects; no writes outside the project", async () => {
    const other = randomUUID();
    const secret = await compile(other, [{ path: "main.tex", content: "\\documentclass{article}\\begin{document}TOPSECRET\\end{document}" }, { path: "secret.tex", content: "TOPSECRET" }], { name: "isolation-other" });
    expect(secret.result!.status).toBe("success");
    const source = (await readFile(path.join(here, "projects/isolation/main.tex"), "utf8")).replaceAll("OTHER", other);
    const result = (await compile(randomUUID(), [{ path: "main.tex", content: source }], { name: "isolation" })).result!;
    const log = (await getObject(result.logKey!)).toString();
    expect(log).not.toMatch(/LEAK:/);
    expect(log.match(/OK: /g)?.length).toBe(5);
    expect(log).not.toMatch(/root:x:0:0|TOPSECRET/);
    expect(result.errors.some(error => error.code === "file-not-found" && /passwd/.test(error.message))).toBe(true);
    // Writing outside the project (absolute path, parent dir) is refused by openout_any = p.
    const write = "\\documentclass{article}\\begin{document}\\newwrite\\f\\immediate\\openout\\f=/tmp/escape.txt\\immediate\\write\\f{x}\\end{document}";
    const written = (await compile(randomUUID(), [{ path: "main.tex", content: write }], { name: "write-escape" })).result!;
    expect(written.errors.some(error => error.code === "cannot-write")).toBe(true);
  }, 240_000);

  it("rejects unsafe paths and keys from other projects as input errors", async () => {
    const traversal = await compile(randomUUID(), [{ path: "../escape.tex", content: "x" }], { name: "unsafe" });
    expect(traversal.status).toBe("failed");
    expect(traversal.error).toMatch(/不安全的檔案路徑/);
    const projectId = randomUUID();
    const manifestKey = `latex/${projectId}/snapshots/foreign.json`;
    const foreign: LatexSnapshotManifest = { version: 1, files: [{ path: "main.tex", key: `latex/${randomUUID()}/blobs/x` }] };
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: manifestKey, Body: JSON.stringify(foreign) }));
    const payload: LatexCompilePayload = { projectId, compileId: randomUUID(), manifestKey, rootFile: "main.tex", compiler: "pdflatex", outputPrefix: `latex/${projectId}/builds/x/` };
    const id = (await db.query<{ id: string }>("INSERT INTO jobs (kind, payload) VALUES ('latex_compile', $1) RETURNING id", [payload])).rows[0]!.id;
    let row: Finished | undefined;
    for (let i = 0; i < 60; i++) {
      row = (await db.query<Finished>("SELECT status, result, error FROM jobs WHERE id=$1", [id])).rows[0]!;
      if (row.status === "failed") break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    expect(row!.status).toBe("failed");
    expect(row!.error).toMatch(/不屬於此專案/);
  }, 240_000);

  it("recovers from a corrupt .aux by recompiling from a clean output directory", async () => {
    // LaTeX heals most stale aux files on its next pass; a fatal error while reading the .aux does not.
    const projectId = randomUUID();
    const first = "\\documentclass{article}\\begin{document}\\makeatletter\\immediate\\write\\@auxout{\\string\\input{ghost-file}}\\makeatother Hi\\end{document}\n";
    const second = "\\documentclass{article}\\begin{document}Hi\\end{document}\n";
    await compile(projectId, [{ path: "main.tex", content: first }], { name: "stale-1" });
    const result = (await compile(projectId, [{ path: "main.tex", content: second }], { name: "stale-2" })).result!;
    expect(result.retriedAfterStaleAux).toBe(true);
    expect(result.status).toBe("success");
  }, 240_000);

  it("kills a compile that runs past the timeout", async () => {
    const result = (await compile(randomUUID(), [{ path: "main.tex", content: "\\documentclass{article}\\begin{document}\\loop\\iftrue\\repeat\\end{document}" }], { name: "timeout" })).result!;
    expect(result.status).toBe("timeout");
    expect(result.errors[0]!.code).toBe("timeout");
    expect(result.durationMs).toBeLessThan(60_000);
  }, 240_000);
});
