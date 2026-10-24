/** Eval report: the per-task result record, aggregates, the Markdown report and the comparison with a previous run. */
import type { Build } from "./client.js";
import type { Grade } from "./graders.js";
import type { Rubric } from "./judge.js";

export type TaskResult = {
  id: string;
  title: string;
  tags: string[];
  mode: string;
  started_at: string;
  ended_at: string;
  build_start: Build;
  build_end: Build;
  /** The ai-worker image changed while the task ran: its result mixes two builds. */
  redeployed: boolean;
  status: string;
  run_ids: string[];
  goal_id: string | null;
  conversation_id: string | null;
  playbook: string | null;
  deck_id: string | null;
  deck_pages: number | null;
  deliverable: { expected: string; got: string[]; brief: string | null; ok: boolean; detail: string };
  grades: Grade[];
  pass: boolean;
  /** The run's own verdict: its criteria (all / the user's requirements `req_*`). */
  criteria: { pass: number; fail: number; other: number; req_pass: number; req_total: number; failed: string[] };
  wall_s: number | null;
  queued_s: number | null;
  active_s: number | null;
  calls: number;
  /** Repair work: calls of fix rounds (ai_call_log.round > 0) and fix / repair purposes. */
  fix_calls: number;
  calls_by_purpose: Record<string, { n: number; s: number }>;
  tokens: { in: number; out: number };
  fix_rounds: number;
  final_rounds: number;
  stops: Record<string, number>;
  flips: { criteria: string[]; checks: string[] };
  judge: Rubric | null;
  pair: { winner: string; reasons: string[] } | null;
  question: string | null;
  error: string | null;
};

export type Report = {
  id: string;
  hub: string;
  user: string;
  started_at: string;
  ended_at: string;
  builds: Build[];
  selection: string;
  results: TaskResult[];
  summary: Summary;
  compared_with: string | null;
};

export type Summary = {
  tasks: number;
  passed: number;
  deliverable_ok: number;
  done: number;
  grades: { pass: number; total: number };
  median_wall_min: number | null;
  calls: number;
  fix_calls_share: number | null;
  fix_rounds: number;
  flips: number;
  judge_avg: number | null;
};

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const round1 = (x: number) => Math.round(x * 10) / 10;
/** Purposes that are repair work (fix rounds, final repairs, requirement fixes, visual fixes). */
export const isFixPurpose = (p: string) => /fix|repair|revise/i.test(p);

export function summarize(results: TaskResult[]): Summary {
  const ran = results.filter((r) => r.status !== "skipped");
  const calls = ran.reduce((a, r) => a + r.calls, 0);
  const fixCalls = ran.reduce((a, r) => a + (r.fix_calls ?? Object.entries(r.calls_by_purpose).filter(([p]) => isFixPurpose(p)).reduce((b, [, v]) => b + v.n, 0)), 0);
  const judged = ran.map((r) => r.judge?.overall).filter((x): x is number => typeof x === "number");
  return {
    tasks: ran.length,
    passed: ran.filter((r) => r.pass).length,
    deliverable_ok: ran.filter((r) => r.deliverable.ok).length,
    done: ran.filter((r) => r.status === "done").length,
    grades: { pass: ran.reduce((a, r) => a + r.grades.filter((g) => g.ok).length, 0), total: ran.reduce((a, r) => a + r.grades.length, 0) },
    median_wall_min: (() => {
      const m = median(ran.map((r) => r.wall_s).filter((x): x is number => x != null));
      return m == null ? null : round1(m / 60);
    })(),
    calls,
    fix_calls_share: calls ? Math.round((fixCalls / calls) * 1000) / 10 : null,
    fix_rounds: ran.reduce((a, r) => a + r.fix_rounds, 0),
    flips: ran.reduce((a, r) => a + r.flips.criteria.length + r.flips.checks.length, 0),
    judge_avg: judged.length ? Math.round((judged.reduce((a, b) => a + b, 0) / judged.length) * 100) / 100 : null,
  };
}

const mins = (s: number | null) => (s == null ? "–" : String(round1(s / 60)));
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function markdown(rep: Report, prev: Report | null): string {
  const s = rep.summary;
  const out: string[] = [];
  out.push(`# Agent eval ${rep.id}`, "");
  out.push(`- Hub: ${rep.hub}（使用者 ${rep.user}）；${rep.started_at} → ${rep.ended_at}；選擇：${rep.selection}`);
  out.push(`- 部署版本（ai-worker image / 本機 git）：${rep.builds.map((b) => `${b.image} @ ${b.created} / ${b.git}`).join("；")}`);
  out.push(`- 通過 ${s.passed}/${s.tasks}；交付物正確 ${s.deliverable_ok}/${s.tasks}；狀態 done ${s.done}/${s.tasks}；程式檢查 ${s.grades.pass}/${s.grades.total}`);
  out.push(`- 時間中位數 ${s.median_wall_min ?? "–"} 分；模型呼叫 ${s.calls}（修正輪／修正類 ${s.fix_calls_share ?? "–"}%）；修正輪 ${s.fix_rounds}；翻轉（對→錯）${s.flips}；評審平均 ${s.judge_avg ?? "–"}/5`);
  if (prev) {
    const p = prev.summary;
    out.push(`- 對照 ${prev.id}：通過 ${p.passed}/${p.tasks} → ${s.passed}/${s.tasks}；交付物 ${p.deliverable_ok} → ${s.deliverable_ok}；時間中位數 ${p.median_wall_min ?? "–"} → ${s.median_wall_min ?? "–"} 分；呼叫 ${p.calls} → ${s.calls}；翻轉 ${p.flips} → ${s.flips}；評審 ${p.judge_avg ?? "–"} → ${s.judge_avg ?? "–"}`);
  }
  out.push("", "| 任務 | 結果 | 狀態 | 交付物 | 程式檢查 | 系統驗收 (req) | 分鐘 | 呼叫 | 修正輪 | 翻轉 | 評審 | 版本 |", "|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rep.results) {
    const g = `${r.grades.filter((x) => x.ok).length}/${r.grades.length}`;
    const crit = r.criteria.pass + r.criteria.fail + r.criteria.other ? `${r.criteria.pass}/${r.criteria.pass + r.criteria.fail + r.criteria.other} (${r.criteria.req_pass}/${r.criteria.req_total})` : "–";
    const judge = r.judge ? `${r.judge.overall}${r.pair ? ` ${r.pair.winner === "current" ? "▲" : r.pair.winner === "previous" ? "▼" : "＝"}` : ""}` : "–";
    out.push(`| \`${r.id}\` | ${r.pass ? "PASS" : "FAIL"} | ${r.status} | ${r.deliverable.ok ? "✓" : "✗"} ${cell(r.deliverable.got.join("+") || "—")} | ${g} | ${crit} | ${mins(r.wall_s)} | ${r.calls} | ${r.fix_rounds} | ${r.flips.criteria.length + r.flips.checks.length} | ${judge} | ${r.build_start.image}${r.redeployed ? "→" + r.build_end.image : ""} |`);
  }
  out.push("", "## 細節", "");
  for (const r of rep.results) {
    out.push(`### \`${r.id}\` ${r.title}`);
    out.push(`- ${r.mode} · playbook ${r.playbook ?? "–"} · runs ${r.run_ids.map((x) => x.slice(0, 8)).join(", ") || "–"}${r.goal_id ? ` · goal ${r.goal_id.slice(0, 8)}` : ""} · ${r.started_at} → ${r.ended_at}${r.redeployed ? " · 注意：執行中重新部署" : ""}`);
    out.push(`- 交付物：${r.deliverable.detail}`);
    for (const g of r.grades) out.push(`- ${g.ok ? "✓" : "✗"} ${g.id}：${g.detail}`);
    if (r.criteria.failed.length) out.push(`- 系統未通過的驗收：${r.criteria.failed.map(cell).join("；")}`);
    const purposes = Object.entries(r.calls_by_purpose).sort((a, b) => b[1].n - a[1].n).map(([p, v]) => `${p} ${v.n}（${Math.round(v.s / 60)} 分）`);
    if (purposes.length) out.push(`- 呼叫（依 purpose）：${purposes.join("、")}`);
    if (Object.keys(r.stops).length) out.push(`- 步驟停止原因：${Object.entries(r.stops).map(([k, v]) => `${k} ×${v}`).join("、")}`);
    if (r.flips.criteria.length || r.flips.checks.length) out.push(`- 翻轉：${[...r.flips.criteria.map((x) => `criterion ${x}`), ...r.flips.checks.map((x) => `check ${x}`)].join("、")}`);
    if (r.judge) out.push(`- 評審：要求 ${r.judge.request}、內容 ${r.judge.substance}、結構 ${r.judge.structure}、形式 ${r.judge.form} — ${cell(r.judge.rationale)}`);
    if (r.pair) out.push(`- 與上次比較（兩種順序）：${r.pair.winner}；${r.pair.reasons.map(cell).join(" / ")}`);
    if (r.question) out.push(`- 問題卡：${cell(r.question)}`);
    if (r.error) out.push(`- 錯誤：${cell(r.error)}`);
    out.push("");
  }
  if (prev) {
    out.push("## 與上次逐項比較", "", "| 任務 | 上次 | 這次 | 分鐘 | 呼叫 | 程式檢查 |", "|---|---|---|---|---|---|");
    for (const r of rep.results) {
      const p = prev.results.find((x) => x.id === r.id);
      if (!p) continue;
      out.push(`| \`${r.id}\` | ${p.pass ? "PASS" : "FAIL"} ${p.status} | ${r.pass ? "PASS" : "FAIL"} ${r.status} | ${mins(p.wall_s)} → ${mins(r.wall_s)} | ${p.calls} → ${r.calls} | ${p.grades.filter((g) => g.ok).length}/${p.grades.length} → ${r.grades.filter((g) => g.ok).length}/${r.grades.length} |`);
    }
    out.push("");
  }
  return out.join("\n");
}
