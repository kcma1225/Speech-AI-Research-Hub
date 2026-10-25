/**
 * Offline replay of a scenario-matrix run against the CURRENT working tree (no staging deploy needed): for every case of
 * a results.json, the deterministic decisions the case exercises are recomputed with today's code and judged by the same
 * invariants — the Brief's user words (`taskTurns` on the case's stored conversation, read-only), the deterministic
 * requirements (`detectRequirements`, no model) → `req.clause_coverage` / part languages, the deliverable kind, the
 * new-deck vs edit decision and the deck resolution from the conversation. The model-extracted items are not replayed
 * (they only add coverage), so the coverage numbers here are a lower bound.
 *
 *   cd backend && npx tsx scripts/eval/scenarios/offline.ts scripts/eval/runs/<scenarios dir> [--compose hubv3]
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { taskTurns as briefTaskTurns, deliverableFromWords, briefKindOf } from "../../../src/workflows/brief.js";
import { clauseRequirement, detectRequirements, mergeRequirements, segmentClauses, uncoveredClauses } from "../../../src/workflows/requirements.js";
import { editAsked, newDeckAsked } from "../../../src/workflows/route.js";
import { POINTS_AT_RE } from "../../../src/workflows/context.js";
import { checkRun, languageClaims, type StoredRun } from "../../../src/workflows/invariants.js";

const dir = process.argv[2];
if (!dir) throw new Error("usage: offline.ts <scenarios dir>");
const compose = process.argv.includes("--compose") ? process.argv[process.argv.indexOf("--compose") + 1]! : "hubv3";
type Case = { id: string; dims: Record<string, string>; request: string; conversation_id: string | null; findings: { invariant: string; severity: string }[] };
const raw = JSON.parse(readFileSync(join(dir, "results.json"), "utf8")) as Case[] | { results: Case[] };
const cases = Array.isArray(raw) ? raw : raw.results;

/** Read-only: the case conversation's messages (user / assistant), oldest first. */
function messages(conv: string): { role: string; text: string; content: unknown }[] {
  if (!/^[0-9a-f-]{36}$/i.test(conv)) return [];
  const sql = `SELECT coalesce(json_agg(json_build_object('role', role, 'text', text, 'content', content) ORDER BY seq), '[]') FROM agent_messages WHERE conversation_id='${conv}' AND role IN ('user','assistant') AND hidden_by IS NULL`;
  const out = execSync(`docker compose -p ${compose} exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -tA -c "SET default_transaction_read_only=on" -f -'`, { input: sql, maxBuffer: 1e8 }).toString().trim().split("\n").at(-1) ?? "[]";
  return JSON.parse(out);
}

const KIND_OF_INTENT: Record<string, string> = { note_topic: "note", lit_review: "lit_review", latex_section: "latex" };
type Row = { id: string; before: string[]; after: string[]; detail: string[] };
const rows: Row[] = [];
for (const c of cases) {
  const before = [...new Set(c.findings.filter((f) => f.severity === "critical" || f.severity === "high").map((f) => f.invariant))];
  const after: string[] = [];
  const detail: string[] = [];
  // 1. The Brief's user words: today's taskTurns on the stored conversation, up to the newest user turn before the start.
  let words = [c.request];
  if (c.conversation_id) {
    const ms = messages(c.conversation_id);
    const lastUser = ms.map((m) => m.role).lastIndexOf("user");
    if (lastUser >= 0) {
      const turns = briefTaskTurns(ms.slice(0, lastUser + 1).map((m) => ({ role: m.role, text: (m.text ?? "").replace(/^（交給 Agent）/, ""), content: m.content })));
      if (turns.length) words = turns;
      if (c.dims.history === "unrelated" && turns.some((t) => /CER 和 WER|有什麼差別/.test(t))) after.push("req.user_words_scope");
    }
  }
  const said = words.join("\n");
  // 2. Deterministic requirements → clause coverage + part languages, judged by the invariants on a synthetic run.
  const det = mergeRequirements(words.flatMap((w) => detectRequirements(w, { kind: /^note_|lit_review/.test(c.dims.intent ?? "") ? "doc" : c.dims.intent === "latex_section" ? "latex" : "deck" })).map((r) => ({ ...r, source: "request" as const })));
  // The clause-coverage fallback of prepareRequirements (no model: every content clause no item accounts for).
  const kind = /^note_|lit_review/.test(c.dims.intent ?? "") ? "doc" : c.dims.intent === "latex_section" ? "latex" : "deck";
  const fallback = uncoveredClauses(words.flatMap(segmentClauses), det, new Set(), new Set(), kind).slice(0, 6).map(clauseRequirement);
  det.push(...mergeRequirements(fallback).map((r, i) => ({ ...r, id: `f${i + 1}` })));
  const run = { id: c.id, status: "awaiting_plan_approval", request: c.request, brief: { version: 1, user_words: words, base: words.length, requirements: det }, state: { requirements: det, route: {} } } as unknown as StoredRun;
  const cov = checkRun({ run, messages: [] }, ["req.clause_coverage"]).filter((f) => f.severity === "high" || f.severity === "critical");
  if (cov.length) {
    after.push("req.clause_coverage");
    detail.push(...cov.map((f) => `uncovered: ${String((f.evidence as { clause?: string }).clause ?? f.message).slice(0, 60)}`));
  }
  const claims = languageClaims ? languageClaims(said) : [];
  for (const cl of claims) {
    const parts = cl.part === "all" ? ["slides", "notes"] : [cl.part];
    for (const part of parts) {
      const eff = det.find((r) => r.type === "language" && (!r.params?.part || r.params.part === part));
      if (!eff || eff.params?.language !== cl.lang) {
        if (!after.includes("scenario.part_language")) after.push("scenario.part_language");
        detail.push(`language ${part}: want ${cl.lang}, got ${eff?.params?.language ?? "none"} (words: ${said.slice(0, 50)})`);
      }
    }
  }
  // 3. Deliverable kind for note / review / LaTeX intents.
  const wantKind = KIND_OF_INTENT[c.dims.intent ?? ""];
  if (wantKind) {
    const k = deliverableFromWords(words);
    const got = k ? briefKindOf(k) : null;
    if (got && got !== wantKind && !(wantKind === "note" && (got === "lit_review" || got === "reading_note"))) {
      after.push("scenario.kind");
      detail.push(`kind ${got} (want ${wantKind})`);
    }
  }
  // 4. New deck vs edit on a deck page; deck resolution from the conversation for edits.
  const isNew = /^new_/.test(c.dims.intent ?? "");
  const aboutDeck = /簡報|投影片|slide|deck|presentation/i.test(said);
  if (isNew && c.dims.entry === "deck" && !newDeckAsked(said)) after.push("scenario.new_not_edit");
  if (!isNew && !wantKind && c.dims.history === "artifact" && c.dims.entry !== "deck") {
    const resolves = aboutDeck && !newDeckAsked(said) && (POINTS_AT_RE.test(said) || editAsked(said, []));
    if (!resolves) {
      after.push("scenario.deck_resolved");
      detail.push("deck not resolved from the conversation");
    }
  }
  rows.push({ id: c.id, before, after, detail });
}
const count = (k: "before" | "after", inv: string) => rows.filter((r) => r[k].includes(inv)).length;
const invs = ["req.clause_coverage", "req.user_words_scope", "scenario.part_language", "scenario.kind", "scenario.new_not_edit", "scenario.deck_resolved"];
const md = [
  `# Offline replay of ${dir}`,
  "",
  "Deterministic decisions recomputed with the current working tree, including the clause-coverage fallback (model extraction not replayed: coverage is a lower bound).",
  "",
  "| Invariant | Cases before (stored runs) | Cases after (current code) |",
  "|---|---|---|",
  ...invs.map((i) => `| \`${i}\` | ${count("before", i)} | ${count("after", i)} |`),
  "",
  "## Cases still failing",
  ...rows.filter((r) => r.after.length).map((r) => `- ${r.id}: ${r.after.join(", ")}${r.detail.length ? ` — ${r.detail.slice(0, 4).join("; ")}` : ""}`),
].join("\n");
writeFileSync(join(dir, "offline.md"), md);
console.log(md);
