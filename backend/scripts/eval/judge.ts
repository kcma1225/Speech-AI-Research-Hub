/**
 * Quality judge of the eval: one rubric call per artifact, and a pairwise comparison with the previous run's artifact
 * run in BOTH orders (position bias: a preference that flips with the order is a tie). The call runs inside the
 * staging backend container through the hub's own AI platform (role `analysis`, `purpose eval_judge`, logged in
 * ai_call_log without a workflow id), so it uses the stack's configured model and no extra credentials.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PROJECT } from "./client.js";

const run = promisify(execFile);
const MAX_CHARS = 30_000;

/** Runs in the container (script on stdin; the container root is read-only): one `analysis` call, prints {text}. */
const ENTRY = (payload: string) => `
import { loadConfig } from "/app/dist/config.js";
import { createPool } from "/app/dist/db.js";
import { initAiPlatform } from "/app/dist/ai/platform/index.js";
const req = JSON.parse(Buffer.from("${payload}", "base64").toString("utf8"));
const db = createPool(loadConfig());
const quiet = { warn() {}, info() {}, debug() {}, error() {} };
try {
  const p = initAiPlatform(db, quiet);
  const r = await p.chat("analysis", { messages: [{ role: "system", content: req.system }, { role: "user", content: req.user }], maxTokens: 8000, temperature: 0 }, { purpose: "eval_judge" });
  process.stdout.write(JSON.stringify({ text: r.text }));
} finally { await db.end(); }
`;

async function callJudge(system: string, user: string): Promise<string> {
  const payload = Buffer.from(JSON.stringify({ system, user }), "utf8").toString("base64");
  const child = run("docker", ["exec", "-i", `${PROJECT}-backend-1`, "node", "--input-type=module", "-"], { maxBuffer: 8 * 1024 * 1024, timeout: 300_000 });
  child.child.stdin?.end(ENTRY(payload));
  const { stdout } = await child;
  return (JSON.parse(stdout) as { text: string }).text;
}

/** The JSON object in a reply (the model may echo LaTeX braces or prose around it): the first `{` that parses to the last `}`. */
export const json = (text: string): Record<string, unknown> | null => {
  const t = text.replace(/```(?:json)?/g, "");
  const end = t.lastIndexOf("}");
  for (let i = t.indexOf("{"); i >= 0 && i < end; i = t.indexOf("{", i + 1)) {
    try {
      const v = JSON.parse(t.slice(i, end + 1)) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      // try the next brace
    }
  }
  return null;
};
const clip = (s: string) => (s.length > MAX_CHARS ? `${s.slice(0, MAX_CHARS)}\n…（以下截斷，共 ${s.length} 字元）` : s);

export type Rubric = { request: number; substance: number; structure: number; form: number; overall: number; rationale: string };

const RUBRIC_SYSTEM = `You grade one artifact produced by a research assistant for a master's student. Score each dimension 1–5
(5 = excellent, 3 = acceptable with clear gaps, 1 = fails). Be strict and concrete; do not reward length.
- request: does it deliver exactly what the user's request asks (deliverable type, scope, language, explicit constraints)?
- substance: technically specific and correct for the topic; no generic filler, no invented facts or numbers.
- structure: logical organisation; every part has a purpose; no duplication.
- form: clean Markdown / Quarto / LaTeX; readable; no placeholders or broken markup.
Answer ONLY JSON: {"request":n,"substance":n,"structure":n,"form":n,"rationale":"<= 3 sentences"}`;

export async function rubric(request: string, focus: string, artifact: string): Promise<Rubric | null> {
  const text = await callJudge(RUBRIC_SYSTEM, `<request>\n${request}\n</request>\n<what_good_looks_like>\n${focus}\n</what_good_looks_like>\n<artifact>\n${clip(artifact)}\n</artifact>`);
  const j = json(text);
  if (!j) throw new Error(`judge reply is not JSON: ${text.slice(0, 200)}`);
  const n = (k: string) => Math.max(1, Math.min(5, Number(j[k]) || 1));
  const r = { request: n("request"), substance: n("substance"), structure: n("structure"), form: n("form") };
  return { ...r, overall: Math.round(((r.request + r.substance + r.structure + r.form) / 4) * 100) / 100, rationale: String(j.rationale ?? "").slice(0, 400) };
}

const PAIR_SYSTEM = `You compare two artifacts (A and B) produced for the same request. Judge only by the request and the stated
criteria; ignore length and the order in which they are shown. Answer ONLY JSON: {"winner":"A"|"B"|"tie","reason":"<= 2 sentences"}`;

/** Pairwise current vs previous, in both orders: `current` / `previous` only when both orders agree, else `tie`. */
export async function pairwise(request: string, focus: string, current: string, previous: string): Promise<{ winner: "current" | "previous" | "tie"; reasons: string[] }> {
  const ask = async (a: string, b: string) => {
    const j = json(await callJudge(PAIR_SYSTEM, `<request>\n${request}\n</request>\n<criteria>\n${focus}\n</criteria>\n<A>\n${clip(a)}\n</A>\n<B>\n${clip(b)}\n</B>`));
    return { w: String(j?.winner ?? "tie"), reason: String(j?.reason ?? "").slice(0, 300) };
  };
  const first = await ask(current, previous); // current = A
  const second = await ask(previous, current); // current = B
  const c1 = first.w === "A" ? "current" : first.w === "B" ? "previous" : "tie";
  const c2 = second.w === "B" ? "current" : second.w === "A" ? "previous" : "tie";
  return { winner: c1 === c2 ? c1 : "tie", reasons: [first.reason, second.reason] };
}
