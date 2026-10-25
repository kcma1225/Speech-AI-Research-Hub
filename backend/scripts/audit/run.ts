/**
 * Production invariant auditor (docs/research/agent-invariants.md). READ-ONLY: runs the deterministic invariants of
 * src/workflows/invariants.ts over recent workflow runs and their conversations and writes a report grouped by
 * invariant (markdown + JSON) with run ids and the evidence each rule extracted. No model calls on the data, no writes
 * (the connection is opened with default_transaction_read_only and every query is a SELECT inside BEGIN READ ONLY).
 *
 *   cd backend
 *   npx tsx scripts/audit/run.ts --db postgres://user:pw@host:5432/db [--since 7d | --since 2026-10-21] [--until …]
 *                                [--runs id,id] [--conversations id,id] [--user username] [--limit 500]
 *                                [--only inv,inv] [--out <dir>]
 *   --db may also come from AUDIT_DB_URL. `--staging` builds the staging URL (compose project hubv3: the db container's
 *   address + POSTGRES_PASSWORD from ../.env.staging) — it never reads `.env`.
 *   Output: <out>/audit.json + audit.md (default scripts/audit/reports/<time>/, gitignored).
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { INVARIANTS, SEVERITY_RANK, checkConversation, checkRun, type Finding } from "../../src/workflows/invariants.js";
import { loadBundles, loadRuns, openReadOnly } from "./load.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const argv = process.argv.slice(2);
const opt = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const list = (v: string | undefined) => (v ? v.split(",").map((x) => x.trim()).filter(Boolean) : undefined);

/** `7d` / `12h` / an ISO date → ISO timestamp. */
export function sinceOf(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const m = /^(\d+)([dh])$/.exec(v);
  if (m) return new Date(Date.now() - Number(m[1]) * (m[2] === "d" ? 86_400_000 : 3_600_000)).toISOString();
  return new Date(v).toISOString();
}

/** The staging database URL (hubv3 db container address on its docker network + POSTGRES_PASSWORD from .env.staging). */
export async function stagingDbUrl(project = "hubv3"): Promise<string> {
  if (project === "hub") throw new Error("--staging refuses the production compose project");
  const run = promisify(execFile);
  const { stdout } = await run("docker", ["inspect", `${project}-db-1`, "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}"]);
  const ip = stdout.trim().split(/\s+/)[0];
  const env = await readFile(resolve(HERE, "../../../.env.staging"), "utf8");
  const pw = /^POSTGRES_PASSWORD=(.*)$/m.exec(env)?.[1]?.trim().replace(/^["']|["']$/g, "");
  if (!ip || !pw) throw new Error("staging db address / password not found");
  return `postgres://research_hub:${encodeURIComponent(pw)}@${ip}:5432/research_hub`;
}

export type AuditReport = {
  generated_at: string; db: string; window: Record<string, unknown>; runs_checked: number; conversations_checked: number;
  by_status: Record<string, number>;
  invariants: { id: string; category: string; severity: string; title: string; findings: number; runs: string[] }[];
  findings: Finding[];
};

export function auditMarkdown(r: AuditReport): string {
  const out: string[] = [];
  out.push(`# Invariant audit ${r.generated_at.slice(0, 16)}Z`, "");
  out.push(`- DB: \`${r.db}\` (read-only)  ·  window: ${JSON.stringify(r.window)}`);
  out.push(`- Runs checked: ${r.runs_checked} (${Object.entries(r.by_status).map(([k, v]) => `${k} ${v}`).join(", ")})  ·  conversations: ${r.conversations_checked}`);
  const failing = r.invariants.filter((i) => i.findings > 0);
  out.push(`- Findings: ${r.findings.length} across ${failing.length}/${r.invariants.length} invariants; runs with ≥ 1 critical/high finding: ${new Set(r.findings.filter((f) => SEVERITY_RANK[f.severity] <= 1).map((f) => f.run_id ?? f.conversation_id)).size}`, "");
  out.push("| Invariant | Severity | Findings | Runs / conversations |", "|---|---|---|---|");
  for (const i of [...r.invariants].sort((a, b) => b.findings - a.findings || SEVERITY_RANK[a.severity as keyof typeof SEVERITY_RANK] - SEVERITY_RANK[b.severity as keyof typeof SEVERITY_RANK]))
    out.push(`| \`${i.id}\` ${i.title} | ${i.severity} | ${i.findings} | ${i.runs.slice(0, 6).map((x) => x.slice(0, 8)).join(" ")}${i.runs.length > 6 ? ` +${i.runs.length - 6}` : ""} |`);
  for (const i of failing) {
    out.push("", `## \`${i.id}\` — ${i.title} (${i.severity}, ${i.findings})`, "");
    for (const f of r.findings.filter((x) => x.invariant === i.id).slice(0, 25)) {
      out.push(`- **${(f.run_id ?? f.conversation_id ?? "").slice(0, 8)}** [${f.severity}] ${f.message}`);
      const ev = JSON.stringify(f.evidence);
      out.push(`  <details><summary>evidence</summary>\n\n  \`\`\`json\n  ${ev.length > 1500 ? `${ev.slice(0, 1500)}…` : ev}\n  \`\`\`\n  </details>`);
    }
    const n = r.findings.filter((x) => x.invariant === i.id).length;
    if (n > 25) out.push(`- … ${n - 25} more in audit.json`);
  }
  return out.join("\n");
}

export async function audit(url: string, w: Parameters<typeof loadRuns>[1], only?: string[]): Promise<AuditReport> {
  const db = await openReadOnly(url);
  try {
    const runs = await loadRuns(db, w);
    const { bundles, conversations } = await loadBundles(db, runs);
    const findings = [...bundles.flatMap((b) => checkRun(b, only)), ...conversations.flatMap((c) => checkConversation(c, only))];
    findings.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.invariant.localeCompare(b.invariant));
    const by_status: Record<string, number> = {};
    for (const r of runs) by_status[r.status] = (by_status[r.status] ?? 0) + 1;
    return {
      generated_at: new Date().toISOString(), db: db.label, window: { ...w, ...(only ? { only } : {}) }, runs_checked: runs.length, conversations_checked: conversations.length, by_status,
      invariants: INVARIANTS.filter((i) => !only || only.includes(i.id)).map((i) => {
        const fs = findings.filter((f) => f.invariant === i.id);
        return { id: i.id, category: i.category, severity: i.severity, title: i.title, findings: fs.length, runs: [...new Set(fs.map((f) => f.run_id ?? f.conversation_id ?? ""))] };
      }),
      findings,
    };
  } finally {
    await db.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const url = argv.includes("--staging") ? await stagingDbUrl(opt("project") ?? "hubv3") : (opt("db") ?? process.env.AUDIT_DB_URL);
  if (!url) {
    console.error("usage: npx tsx scripts/audit/run.ts --db <postgres url> | --staging  [--since 7d] [--runs …] [--out dir]");
    process.exit(2);
  }
  const w = { since: sinceOf(opt("since") ?? (list(opt("runs")) || list(opt("conversations")) ? undefined : "7d")), until: sinceOf(opt("until")), runIds: list(opt("runs")), conversationIds: list(opt("conversations")), user: opt("user"), limit: Number(opt("limit") ?? 500) };
  const report = await audit(url, w, list(opt("only")));
  const out = resolve(opt("out") ?? join(HERE, "reports", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)));
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "audit.json"), JSON.stringify(report, null, 2));
  await writeFile(join(out, "audit.md"), auditMarkdown(report));
  console.log(`${report.runs_checked} runs, ${report.conversations_checked} conversations → ${report.findings.length} findings\n→ ${join(out, "audit.md")}`);
  for (const i of report.invariants.filter((x) => x.findings)) console.log(`  ${String(i.findings).padStart(4)}  ${i.severity.padEnd(8)} ${i.id}`);
}
