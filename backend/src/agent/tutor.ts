/**
 * 「先確認先備知識」 paper tutoring (docs/architecture.md "Agent" → Prerequisite check). The model reads a paper and
 * submits the concepts it builds on (`extract_prerequisites`); everything after that is decided here, in code:
 * validation and caps, the teaching order (topological, leaves first), the `concept_check` card rows (memory pre-fill),
 * which gap to teach next (`next_concept`), whether an explain-back is offered (≤ 1 per core concept), sub-prerequisites
 * (depth ≤ 3, budget) and what is remembered across papers (`user_concepts`).
 *
 * The pure functions (no DB) are unit-tested in test/tutor.unit.test.ts; the DB helpers below wrap them.
 */
import { z } from "zod";
import type { Queryable } from "../db.js";
import type { Quiz } from "./quiz.js";

export const CONCEPT_KINDS = ["prerequisite", "paper_defined", "symbol"] as const;
export const CONCEPT_LEVELS = ["known", "heard", "unknown"] as const;
export const CONCEPT_SOURCES = ["self_report", "checked"] as const;
export type ConceptKind = (typeof CONCEPT_KINDS)[number];
export type ConceptLevel = (typeof CONCEPT_LEVELS)[number];
export type ConceptSource = (typeof CONCEPT_SOURCES)[number];
export type Centrality = "core" | "supporting";

/** Caps: prerequisites asked on the card; paper-defined terms + symbols (explained in context, never asked). */
export const MAX_PREREQS = 10;
export const MAX_DEFINED = 12;
/** Lazy recursion: sub-prerequisites at most 3 levels below a card concept, ≤ 3 per parent, ≤ 8 per paper. */
export const MAX_DEPTH = 3;
export const MAX_SUB_PER_PARENT = 3;
export const SUB_BUDGET = 8;

export const LEVEL_LABEL: Record<ConceptLevel, string> = { known: "懂", heard: "有聽過", unknown: "不懂" };
/** The card's 「全部都懂，直接講」 shortcut inside a concept_check answer value. */
export const DIRECT = "__direct__";

/** Normalised English canonical term: NFKC, lower case, only [a-z0-9+#.-] words separated by one space, ≤ 60 chars. */
export function normaliseKey(raw: string): string {
  return raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9+#.\- ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .trim();
}

// ---------------------------------------------------------------- model input

export const conceptInput = z.object({
  key: z.string().trim().max(120).optional().describe("Canonical English term in lower case, e.g. 'connectionist temporal classification' (defaults to term_en)"),
  term_en: z.string().trim().min(1).max(120).describe("English term as the field uses it (abbreviation in parentheses), e.g. 'Connectionist Temporal Classification (CTC)'"),
  term_zh: z.string().trim().max(80).optional().describe("Traditional Chinese term (Taiwan usage), e.g. 連結時序分類"),
  gloss: z.string().trim().min(1).max(200).describe("ONE line (zh-TW): what it is, grounded in the paper — use the paper's own wording when it defines the term"),
  kind: z.enum(CONCEPT_KINDS).describe("prerequisite = background the paper assumes (asked on the card); paper_defined = introduced by this paper; symbol = a notation (both explained in context, never asked)"),
  depends_on: z.array(z.string().trim().max(120)).max(6).optional().describe("Keys of other prerequisites in this list that must be understood first"),
  section: z.string().trim().max(40).optional().describe("Where the paper first needs it, e.g. '3.2' or 'Method'"),
  centrality: z.enum(["core", "supporting"]).optional().describe("core = needed to follow the main idea; supporting = detail (default)"),
});
export type ConceptInput = z.infer<typeof conceptInput>;

export type SessionConcept = {
  key: string;
  term_en: string;
  term_zh: string;
  gloss: string;
  kind: ConceptKind;
  depends_on: string[];
  section: string | null;
  centrality: Centrality;
  /** 0 = extracted from the paper; 1–3 = a sub-prerequisite added while teaching. */
  depth: number;
  parent: string | null;
  /** The user's memory when the concept was added (pre-fill). */
  memory: { level: ConceptLevel; source: ConceptSource } | null;
  /** What the user answered on the card (or what teaching found out). */
  level: ConceptLevel | null;
  /** pending = a gap still to teach; teaching = handed to the model by next_concept; done = known / taught / skipped. */
  status: "pending" | "teaching" | "done";
  outcome: "known" | "understood" | "unclear" | "skipped" | null;
  /** The one optional explain-back of a core concept. */
  check: "none" | "offered" | "passed" | "failed" | "skipped";
  /** The end-of-paper quiz (quiz.ts): passed = verified; failed / guessed = taught again, tested in the next round. */
  quiz?: "passed" | "failed" | "guessed";
  /** The misconception behind a wrong quiz answer (the option chosen and why it is wrong), for the re-teach. */
  quiz_miss?: string;
};

export type Session = { paper_id: string; concepts: SessionConcept[]; answered: boolean; checks_off: boolean; quizzes?: Quiz[] };
export type MemoryRow = { concept_key: string; term_zh: string; term_en: string; level: ConceptLevel; source: ConceptSource };
export type MemoryWrite = { key: string; term_zh: string; term_en: string; level: ConceptLevel; source: ConceptSource };

const isPrereq = (c: SessionConcept) => c.kind === "prerequisite";
const isGap = (c: SessionConcept) => isPrereq(c) && c.status !== "done";
const checkedKnown = (m: SessionConcept["memory"] | MemoryRow | null | undefined) => !!m && m.source === "checked" && m.level === "known";
export const termLabel = (c: { term_zh?: string; term_en: string }) => (c.term_zh ? `${c.term_zh}（${c.term_en}）` : c.term_en);

/**
 * Topological order, leaves (no dependencies) first; ties keep the input order. A cycle is broken deterministically:
 * the remaining item with the fewest unresolved dependencies (then the earliest) goes next and its remaining edges are
 * ignored. Unknown / self references are ignored.
 */
export function topoOrder(items: { key: string; depends_on: string[] }[]): { order: string[]; broken: string[] } {
  const keys = new Set(items.map((i) => i.key));
  const deps = new Map(items.map((i) => [i.key, new Set(i.depends_on.filter((d) => d !== i.key && keys.has(d)))]));
  const order: string[] = [];
  const broken: string[] = [];
  const left = items.map((i) => i.key);
  while (left.length) {
    let idx = left.findIndex((k) => deps.get(k)!.size === 0);
    if (idx < 0) {
      let best = 0;
      for (let i = 1; i < left.length; i++) if (deps.get(left[i]!)!.size < deps.get(left[best]!)!.size) best = i;
      idx = best;
      broken.push(left[idx]!);
    }
    const k = left.splice(idx, 1)[0]!;
    order.push(k);
    for (const d of deps.values()) d.delete(k);
  }
  return { order, broken };
}

/**
 * Validates and caps the model's list and builds a session: duplicate keys merged (first wins), prerequisites capped
 * at MAX_PREREQS (core first, then input order), paper-defined + symbols at MAX_DEFINED, dependencies limited to kept
 * prerequisites, prerequisites ordered topologically. Concepts the user passed an explain-back for (memory `checked`
 * + `known`) are done at once and never asked.
 */
export function buildSession(paperId: string, input: ConceptInput[], memory: Map<string, MemoryRow>): { session: Session; dropped: string[]; merged: string[]; cyclesBroken: string[] } {
  const seen = new Map<string, SessionConcept>();
  const merged: string[] = [];
  for (const c of input) {
    const key = normaliseKey(c.key || c.term_en);
    if (!key) continue;
    if (seen.has(key)) {
      merged.push(key);
      continue;
    }
    seen.set(key, {
      key,
      term_en: c.term_en.trim(),
      term_zh: c.term_zh?.trim() ?? "",
      gloss: c.gloss.trim(),
      kind: c.kind,
      depends_on: [...new Set((c.depends_on ?? []).map(normaliseKey).filter((d) => d && d !== key))],
      section: c.section?.trim() || null,
      centrality: c.centrality ?? "supporting",
      depth: 0,
      parent: null,
      memory: null,
      level: null,
      status: "pending",
      outcome: null,
      check: "none",
    });
  }
  const all = [...seen.values()];
  const prereqAll = all.filter(isPrereq);
  const keep = new Set([...prereqAll.filter((c) => c.centrality === "core"), ...prereqAll.filter((c) => c.centrality !== "core")].slice(0, MAX_PREREQS).map((c) => c.key));
  const definedAll = all.filter((c) => !isPrereq(c));
  const defined = definedAll.slice(0, MAX_DEFINED);
  const dropped = [...prereqAll.filter((c) => !keep.has(c.key)), ...definedAll.slice(MAX_DEFINED)].map((c) => c.key);
  const prereqs = prereqAll.filter((c) => keep.has(c.key));
  for (const c of prereqs) c.depends_on = c.depends_on.filter((d) => keep.has(d));
  for (const c of defined) c.depends_on = [];
  const { order, broken } = topoOrder(prereqs);
  const byKey = new Map(prereqs.map((c) => [c.key, c]));
  const ordered = order.map((k) => byKey.get(k)!);
  for (const c of [...ordered, ...defined]) {
    const m = memory.get(c.key);
    c.memory = m ? { level: m.level, source: m.source } : null;
    if (!c.term_zh && m?.term_zh) c.term_zh = m.term_zh;
    if (isPrereq(c) && checkedKnown(m)) Object.assign(c, { level: "known", status: "done", outcome: "known", check: "passed" });
    if (!isPrereq(c)) c.status = "done";
  }
  return { session: { paper_id: paperId, concepts: [...ordered, ...defined], answered: false, checks_off: false, quizzes: [] }, dropped, merged, cyclesBroken: broken };
}

/** A row of the concept_check card. */
export type CardRow = { key: string; term_zh?: string; term_en: string; gloss: string; section?: string; centrality: Centrality; prefill?: ConceptLevel; remembered?: boolean };

/**
 * The card rows: the paper's own prerequisites (depth 0) except the ones already verified, in teaching order; a row is
 * pre-filled with the user's earlier self-report (「上次標記懂」).
 */
export function cardRows(s: Session): CardRow[] {
  return s.concepts
    .filter((c) => isPrereq(c) && c.depth === 0 && !checkedKnown(c.memory))
    .slice(0, MAX_PREREQS)
    .map((c) => ({
      key: c.key,
      ...(c.term_zh ? { term_zh: c.term_zh } : {}),
      term_en: c.term_en,
      gloss: c.gloss,
      ...(c.section ? { section: c.section } : {}),
      centrality: c.centrality,
      ...(c.memory ? { prefill: c.memory.level, remembered: true } : {}),
    }));
}

/** Parses a concept_check answer value (`key=level` entries, optional DIRECT). Throws a 繁中 message on bad input. */
export function parseCardValue(rows: Pick<CardRow, "key">[], value: string[]): { levels: Map<string, ConceptLevel>; direct: boolean } {
  const keys = new Set(rows.map((r) => r.key));
  const levels = new Map<string, ConceptLevel>();
  let direct = false;
  for (const v of value) {
    if (v === DIRECT) {
      direct = true;
      continue;
    }
    const at = v.lastIndexOf("=");
    const key = at > 0 ? v.slice(0, at) : "";
    const level = v.slice(at + 1) as ConceptLevel;
    if (!keys.has(key) || !CONCEPT_LEVELS.includes(level)) throw new Error("概念的回答不正確。");
    if (levels.has(key)) throw new Error("同一個概念回答了兩次。");
    levels.set(key, level);
  }
  if (direct) for (const r of rows) levels.set(r.key, "known");
  return { levels, direct };
}

/**
 * Applies the card answer: known → done; heard / unknown → a gap to teach; a row left empty or a skipped card → done
 * without teaching (explained in context). 「直接講」 or a skipped card turns explain-backs off. Returns the memory writes
 * (self_report; the user is the source).
 */
export function applyCardAnswer(s: Session, answer: { levels: Map<string, ConceptLevel>; direct: boolean } | null): MemoryWrite[] {
  s.answered = true;
  if (!answer || answer.direct) s.checks_off = true;
  const writes: MemoryWrite[] = [];
  for (const c of s.concepts) {
    if (!isPrereq(c) || c.depth !== 0 || checkedKnown(c.memory)) continue;
    const level = answer?.levels.get(c.key) ?? null;
    c.level = level;
    if (!level) Object.assign(c, { status: "done", outcome: "skipped" });
    else if (level === "known") Object.assign(c, { status: "done", outcome: "known" });
    else Object.assign(c, { status: "pending", outcome: null });
    if (level) writes.push({ key: c.key, term_zh: c.term_zh, term_en: c.term_en, level, source: "self_report" });
  }
  return writes;
}

/** "§3.2" / "Section 3" / "第 3 節" → "3.2" / "3"; titles lower-cased. */
export const normSection = (s: string) => s.trim().replace(/^§\s*/, "").replace(/^(?:section|sec\.?|第)\s*/i, "").replace(/\s*[節章]$/, "").trim().toLowerCase();
const sectionMatches = (have: string | null, want: string) => {
  if (!have) return false;
  const a = normSection(have);
  const b = normSection(want);
  return !!b && (a === b || a.startsWith(`${b}.`) || (b.length >= 3 && (a.includes(b) || b.includes(a))));
};

export type NextConcept =
  | { kind: "card_needed" }
  | { kind: "none"; section: string | null; remaining: number }
  | { kind: "concept"; concept: SessionConcept; mode: "recap" | "explain"; verify: boolean; before_section: string | null; remaining: number; chain: string[] };

/**
 * The next gap to teach, decided in code: the first pending concept in teaching order (dependencies first; a
 * sub-prerequisite comes before its parent). With `section` only the gaps that section needs (and their gap
 * dependencies). Marks it `teaching`; offers the one explain-back when it is a core card concept and checks are on.
 */
export function nextConcept(s: Session, section?: string | null): NextConcept {
  if (!s.answered) return { kind: "card_needed" };
  const gaps = s.concepts.filter(isGap);
  let pool = gaps;
  if (section) {
    const byKey = new Map(gaps.map((c) => [c.key, c]));
    const want = new Set<string>();
    const add = (c: SessionConcept) => {
      if (want.has(c.key)) return;
      want.add(c.key);
      for (const d of c.depends_on) {
        const dep = byKey.get(d);
        if (dep) add(dep);
      }
    };
    gaps.filter((c) => sectionMatches(c.section, section)).forEach(add);
    pool = gaps.filter((c) => want.has(c.key));
  }
  const gapKeys = new Set(gaps.map((g) => g.key));
  const c = pool.find((x) => x.depends_on.every((d) => !gapKeys.has(d))) ?? pool[0];
  if (!c) return { kind: "none", section: section ?? null, remaining: gaps.length };
  const verify = c.centrality === "core" && c.depth === 0 && c.check === "none" && !c.quiz && !s.checks_off;
  c.status = "teaching";
  if (verify) c.check = "offered";
  const chain: string[] = [];
  for (let p = c.parent; p; p = s.concepts.find((x) => x.key === p)?.parent ?? null) chain.push(p);
  return { kind: "concept", concept: c, mode: c.level === "heard" ? "recap" : "explain", verify, before_section: c.section, remaining: gaps.length - 1, chain };
}

/**
 * Lazy recursion: the user did not understand `parent`, so the model names what it rests on. Depth ≤ MAX_DEPTH below
 * a card concept, ≤ MAX_SUB_PER_PARENT per parent, ≤ SUB_BUDGET per paper. A concept already in the session only gains
 * the dependency (unless that would make a cycle); one the user's memory says is known (checked, or self-reported) is
 * added as done. Each new one is inserted right before its parent; the parent becomes pending again.
 */
export function addSubConcepts(s: Session, parentKey: string, input: ConceptInput[], memory: Map<string, MemoryRow>): { added: string[]; linked: string[]; known: string[]; refused: { key: string; why: string }[] } {
  const parent = s.concepts.find((c) => c.key === normaliseKey(parentKey) && isPrereq(c));
  if (!parent) throw new Error("找不到這個先備概念；請用 extract_prerequisites 或這裡列出的 key。");
  if (parent.depth >= MAX_DEPTH) throw new Error(`已經往下拆到第 ${MAX_DEPTH} 層，請直接用更白話的方式解釋，不要再拆。`);
  const used = s.concepts.filter((c) => c.depth > 0).length;
  const out = { added: [] as string[], linked: [] as string[], known: [] as string[], refused: [] as { key: string; why: string }[] };
  const reaches = (from: string, to: string, seen = new Set<string>()): boolean => {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (s.concepts.find((c) => c.key === from)?.depends_on ?? []).some((d) => reaches(d, to, seen));
  };
  let perParent = s.concepts.filter((c) => c.parent === parent.key).length;
  for (const raw of input) {
    const key = normaliseKey(raw.key || raw.term_en);
    if (!key || key === parent.key) continue;
    if (parent.depends_on.includes(key)) continue;
    const existing = s.concepts.find((c) => c.key === key);
    if (existing) {
      if (!isPrereq(existing)) {
        out.refused.push({ key, why: "這是論文自己定義的詞或符號，直接在講解中說明" });
        continue;
      }
      if (reaches(key, parent.key)) {
        out.refused.push({ key, why: "會形成循環依賴" });
        continue;
      }
      parent.depends_on.push(key);
      out.linked.push(key);
      continue;
    }
    if (perParent >= MAX_SUB_PER_PARENT || used + out.added.length + out.known.length >= SUB_BUDGET) {
      out.refused.push({ key, why: "子概念數量已達上限" });
      continue;
    }
    const m = memory.get(key);
    const sub: SessionConcept = {
      key,
      term_en: raw.term_en.trim(),
      term_zh: raw.term_zh?.trim() || m?.term_zh || "",
      gloss: raw.gloss.trim(),
      kind: "prerequisite",
      depends_on: [],
      section: parent.section,
      centrality: "supporting",
      depth: parent.depth + 1,
      parent: parent.key,
      memory: m ? { level: m.level, source: m.source } : null,
      level: m?.level === "known" ? "known" : "unknown",
      status: m?.level === "known" ? "done" : "pending",
      outcome: m?.level === "known" ? "known" : null,
      check: "none",
    };
    s.concepts.splice(s.concepts.indexOf(parent), 0, sub);
    parent.depends_on.push(key);
    perParent++;
    (sub.status === "done" ? out.known : out.added).push(key);
  }
  if (out.added.length || out.linked.some((k) => s.concepts.find((c) => c.key === k)?.status !== "done")) Object.assign(parent, { status: "pending", outcome: null });
  return out;
}

export const OUTCOMES = ["understood", "unclear", "explain_back_passed", "explain_back_failed", "skipped"] as const;
export type Outcome = (typeof OUTCOMES)[number];

/**
 * Records teaching outcomes. understood → done, remembered as known (self_report); explain_back_passed → done,
 * remembered as known + checked (only for the offered explain-back; otherwise it counts as understood);
 * explain_back_failed → stays a gap (no second check), remembered as heard; unclear → stays a gap (add sub-prerequisites
 * or explain differently), remembered as unknown; skipped → done without memory (a skipped explain-back turns checks off).
 * `stopChecks` (the user does not want to be asked) turns checks off.
 */
export function applyOutcomes(s: Session, updates: { key: string; outcome: Outcome }[], stopChecks = false): { writes: MemoryWrite[]; unknown: string[]; notes: string[] } {
  const writes: MemoryWrite[] = [];
  const unknown: string[] = [];
  const notes: string[] = [];
  if (stopChecks) s.checks_off = true;
  for (const u of updates) {
    const key = normaliseKey(u.key);
    const c = s.concepts.find((x) => x.key === key && isPrereq(x));
    if (!c) {
      unknown.push(u.key);
      continue;
    }
    const w = (level: ConceptLevel, source: ConceptSource) => writes.push({ key: c.key, term_zh: c.term_zh, term_en: c.term_en, level, source });
    let outcome = u.outcome;
    if ((outcome === "explain_back_passed" || outcome === "explain_back_failed") && c.check !== "offered") {
      notes.push(`${c.term_en}：沒有提供過確認題，記為${outcome === "explain_back_passed" ? "懂了" : "還不清楚"}`);
      outcome = outcome === "explain_back_passed" ? "understood" : "unclear";
    }
    switch (outcome) {
      case "understood":
        Object.assign(c, { status: "done", outcome: "understood", level: "known" });
        if (c.check === "offered") c.check = "skipped";
        w("known", "self_report");
        break;
      case "explain_back_passed":
        Object.assign(c, { status: "done", outcome: "understood", level: "known", check: "passed" });
        w("known", "checked");
        break;
      case "explain_back_failed":
        Object.assign(c, { status: "pending", outcome: "unclear", level: "heard", check: "failed" });
        w("heard", "self_report");
        break;
      case "unclear":
        Object.assign(c, { status: "pending", outcome: "unclear", level: "unknown" });
        w("unknown", "self_report");
        break;
      case "skipped":
        if (c.check === "offered") {
          c.check = "skipped";
          s.checks_off = true;
        }
        Object.assign(c, { status: "done", outcome: c.outcome ?? "skipped" });
        break;
    }
  }
  return { writes, unknown, notes };
}

/**
 * How a write merges into the user's memory: a verified concept (checked + known) is not demoted to a self-report of
 * the same level; any other write replaces the row. Null = nothing to write.
 */
export function mergeMemory(existing: Pick<MemoryRow, "level" | "source"> | null | undefined, incoming: Pick<MemoryWrite, "level" | "source">): { level: ConceptLevel; source: ConceptSource } | null {
  if (existing && checkedKnown(existing) && incoming.source === "self_report" && incoming.level === "known") return null;
  if (existing && existing.level === incoming.level && existing.source === incoming.source) return null;
  return { level: incoming.level, source: incoming.source };
}

/** 「已記下你懂：CTC、MFCC」 (and the other levels), for tool results and the card turn. */
export function savedLine(writes: MemoryWrite[], byKey: Map<string, Pick<SessionConcept, "term_zh" | "term_en">>): string {
  const name = (k: string) => {
    const c = byKey.get(k);
    return c ? (c.term_en.match(/\(([^)]{1,20})\)\s*$/)?.[1] ?? c.term_zh ?? c.term_en) || c.term_en : k;
  };
  const parts = CONCEPT_LEVELS.map((lv) => [lv, writes.filter((w) => w.level === lv).map((w) => name(w.key))] as const)
    .filter(([, list]) => list.length)
    .map(([lv, list]) => `${lv === "known" ? "你懂" : lv === "heard" ? "你有聽過" : "你還不熟"}：${list.join("、")}`);
  return parts.length ? `已記下${parts.join("；")}` : "";
}

// ---------------------------------------------------------------- DB

/** Whether the user lets 「先確認先備知識」 remember concepts (設定 → 懂的概念; on by default). */
export async function conceptMemoryOn(db: Queryable, userId: string): Promise<boolean> {
  const row = (await db.query<{ concept_memory: boolean }>("SELECT concept_memory FROM agent_settings WHERE user_id=$1", [userId])).rows[0];
  return row?.concept_memory ?? true;
}

/** The user's memory of these concepts (empty when concept memory is off). */
export async function loadMemory(db: Queryable, userId: string, keys: string[]): Promise<Map<string, MemoryRow>> {
  if (!keys.length || !(await conceptMemoryOn(db, userId))) return new Map();
  const rows = (await db.query<MemoryRow>("SELECT concept_key,term_zh,term_en,level,source FROM user_concepts WHERE user_id=$1 AND concept_key = ANY($2::text[])", [userId, keys])).rows;
  return new Map(rows.map((r) => [r.concept_key, r]));
}

/** Writes memory rows by the merge rule (nothing when concept memory is off). Returns the writes that changed something. */
export async function writeMemory(db: Queryable, userId: string, paperId: string | null, writes: MemoryWrite[]): Promise<MemoryWrite[]> {
  if (!writes.length || !(await conceptMemoryOn(db, userId))) return [];
  const existing = await loadMemory(db, userId, writes.map((w) => w.key));
  const done: MemoryWrite[] = [];
  for (const w of writes) {
    const next = mergeMemory(existing.get(w.key), w);
    if (!next) continue;
    await db.query(
      `INSERT INTO user_concepts(user_id,concept_key,term_zh,term_en,level,source,paper_id) VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (user_id,concept_key) DO UPDATE SET term_zh=CASE WHEN EXCLUDED.term_zh<>'' THEN EXCLUDED.term_zh ELSE user_concepts.term_zh END,
         term_en=CASE WHEN EXCLUDED.term_en<>'' THEN EXCLUDED.term_en ELSE user_concepts.term_en END, level=EXCLUDED.level, source=EXCLUDED.source,
         paper_id=COALESCE(EXCLUDED.paper_id,user_concepts.paper_id), updated_at=now()`,
      [userId, w.key, w.term_zh.slice(0, 80), w.term_en.slice(0, 120), next.level, next.source, paperId],
    );
    existing.set(w.key, { concept_key: w.key, term_zh: w.term_zh, term_en: w.term_en, ...next });
    done.push({ ...w, ...next });
  }
  return done;
}

type SessionRow = { paper_id: string; concepts: SessionConcept[]; answered: boolean; checks_off: boolean; quizzes: Quiz[] };

export async function loadSession(db: Queryable, conversationId: string, paperId: string, forUpdate = false): Promise<Session | null> {
  const row = (await db.query<SessionRow>(`SELECT paper_id,concepts,answered,checks_off,quizzes FROM paper_concept_sessions WHERE conversation_id=$1 AND paper_id=$2${forUpdate ? " FOR UPDATE" : ""}`, [conversationId, paperId])).rows[0];
  return row ?? null;
}

/**
 * Saves a session and records the write in paper_concept_history, tagged with the conversation's newest message on the
 * current branch, or untagged (`pending`) while the user turn that caused it is still being inserted (`tagPending`
 * tags it then). `rewindSessions` uses the history to follow edits and version switches.
 */
export async function saveSession(db: Queryable, conversationId: string, s: Session, opts: { pending?: boolean } = {}): Promise<void> {
  const quizzes = JSON.stringify(s.quizzes ?? []);
  await db.query(
    `INSERT INTO paper_concept_sessions(conversation_id,paper_id,concepts,answered,checks_off,quizzes) VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT (conversation_id,paper_id) DO UPDATE SET concepts=EXCLUDED.concepts, answered=EXCLUDED.answered, checks_off=EXCLUDED.checks_off, quizzes=EXCLUDED.quizzes, updated_at=now()`,
    [conversationId, s.paper_id, JSON.stringify(s.concepts), s.answered, s.checks_off, quizzes],
  );
  await db.query(
    `INSERT INTO paper_concept_history(conversation_id,paper_id,message_id,concepts,answered,checks_off,quizzes)
     VALUES($1,$2,${opts.pending ? "NULL" : "(SELECT id FROM agent_messages WHERE conversation_id=$1 AND hidden_by IS NULL ORDER BY seq DESC LIMIT 1)"},$3,$4,$5,$6)`,
    [conversationId, s.paper_id, JSON.stringify(s.concepts), s.answered, s.checks_off, quizzes],
  );
}

/** Tags the session writes of a user turn (saved with `pending`) with its message, once inserted. */
export async function tagPending(db: Queryable, conversationId: string, messageId: string): Promise<void> {
  await db.query("UPDATE paper_concept_history SET message_id=$2 WHERE conversation_id=$1 AND message_id IS NULL", [conversationId, messageId]);
}

/**
 * After the current branch changed (a message edited / regenerated, another version shown): every tutoring session of
 * the conversation goes back to its newest write whose message is on the current branch; a session with none (it was
 * started in the discarded part) is removed. Concept memory is not rolled back (the user edits it in 設定).
 */
export async function rewindSessions(db: Queryable, conversationId: string): Promise<void> {
  await db.query("DELETE FROM paper_concept_history WHERE conversation_id=$1 AND message_id IS NULL", [conversationId]);
  const papers = (await db.query<{ paper_id: string }>("SELECT paper_id FROM paper_concept_sessions WHERE conversation_id=$1 FOR UPDATE", [conversationId])).rows;
  for (const { paper_id } of papers) {
    const h = (await db.query<SessionRow>(
      `SELECT h.paper_id,h.concepts,h.answered,h.checks_off,h.quizzes FROM paper_concept_history h JOIN agent_messages m ON m.id=h.message_id
        WHERE h.conversation_id=$1 AND h.paper_id=$2 AND m.hidden_by IS NULL ORDER BY h.id DESC LIMIT 1`,
      [conversationId, paper_id],
    )).rows[0];
    if (!h) await db.query("DELETE FROM paper_concept_sessions WHERE conversation_id=$1 AND paper_id=$2", [conversationId, paper_id]);
    else
      await db.query("UPDATE paper_concept_sessions SET concepts=$3, answered=$4, checks_off=$5, quizzes=$6, updated_at=now() WHERE conversation_id=$1 AND paper_id=$2", [
        conversationId, paper_id, JSON.stringify(h.concepts), h.answered, h.checks_off, JSON.stringify(h.quizzes ?? []),
      ]);
  }
}

/** Whether the conversation has 「先確認先備知識」 on. */
export async function prereqCheckOn(db: Queryable, conversationId: string | null): Promise<boolean> {
  if (!conversationId) return false;
  return !!(await db.query<{ prereq_check: boolean }>("SELECT prereq_check FROM conversations WHERE id=$1", [conversationId])).rows[0]?.prereq_check;
}

/**
 * The user answered a concept_check card (inside the turn's transaction): the session records the answer and the
 * self-reports go to memory. Returns the note for the model (what was saved, what to do next).
 */
export async function applyConceptCheckAnswer(db: Queryable, conversationId: string, paperId: string, parsed: { levels: Map<string, ConceptLevel>; direct: boolean } | null): Promise<string> {
  const conv = (await db.query<{ user_id: string }>("SELECT user_id FROM conversations WHERE id=$1", [conversationId])).rows[0];
  const s = conv ? await loadSession(db, conversationId, paperId, true) : null;
  if (!conv || !s) return "";
  const writes = applyCardAnswer(s, parsed);
  await saveSession(db, conversationId, s, { pending: true });
  const saved = await writeMemory(db, conv.user_id, paperId, writes);
  const byKey = new Map(s.concepts.map((c) => [c.key, c]));
  const line = savedLine(saved, byKey);
  const gaps = s.concepts.filter(isGap);
  const lines = [
    line ? `回覆開頭用一句話告訴使用者「${line}」（可以在 設定 → 記憶 → 懂的概念 修改）。` : "",
    !parsed
      ? "使用者略過了概念確認：不要再問先備知識、不要出確認題；直接講解論文，遇到術語時順手用一句話解釋。"
      : parsed.direct
        ? "使用者選了「全部都懂，直接講」：不要再問先備知識、不要出確認題，直接講解論文。"
        : gaps.length
          ? `有 ${gaps.length} 個概念要先補（${gaps.map((g) => g.key).join("、")}）。先用一句話說明接下來的安排，然後呼叫 next_concept（paper_id ${paperId}）取得第一個要講的概念；講到論文某一節之前，用 next_concept 的 section 取得那一節需要先補的概念。`
          : "使用者都懂這些先備概念：直接講解論文。",
  ];
  return lines.filter(Boolean).join("\n");
}
