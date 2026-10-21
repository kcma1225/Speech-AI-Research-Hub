/**
 * Memories: short atomic statements per user (scope global or one study). Only used when the user enabled memory
 * and the conversation has memory on. Writes by the agent always go through a consent card (`remember`).
 */
import type { Queryable } from "../db.js";

export type MemoryRow = {
  id: string;
  scope: "global" | "study";
  study_id: string | null;
  study: { id: string; slug: string; title: string } | null;
  content: string;
  source: "agent" | "user";
  source_conversation_id: string | null;
  source_conversation_title: string | null;
  /** The source conversation was deleted. */
  source_deleted: boolean;
  created_at: string;
  updated_at: string;
};

const SELECT = `SELECT m.id,m.scope,m.study_id,
    CASE WHEN s.id IS NULL THEN NULL ELSE json_build_object('id',s.id,'slug',s.slug,'title',s.title) END AS study,
    m.content,m.source,m.source_conversation_id,c.title AS source_conversation_title,
    (m.source_conversation_id IS NOT NULL AND c.id IS NULL) AS source_deleted,m.created_at,m.updated_at
  FROM memories m LEFT JOIN studies s ON s.id=m.study_id LEFT JOIN conversations c ON c.id=m.source_conversation_id`;

export const MEMORY_MAX = 300;
export const MEMORY_LIMIT_PER_USER = 500;
/** At most this many memories are injected into one model call. */
export const MEMORY_INJECT_MAX = 50;

export async function listMemories(db: Queryable, userId: string, filter: { scope?: "global" | "study"; studyId?: string; q?: string } = {}): Promise<MemoryRow[]> {
  const params: unknown[] = [userId];
  let where = "m.user_id=$1";
  if (filter.scope) where += ` AND m.scope=$${params.push(filter.scope)}`;
  if (filter.studyId) where += ` AND m.study_id=$${params.push(filter.studyId)}`;
  if (filter.q?.trim()) where += ` AND m.content ILIKE $${params.push(`%${filter.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`)}`;
  return (await db.query<MemoryRow>(`${SELECT} WHERE ${where} ORDER BY m.updated_at DESC LIMIT ${MEMORY_LIMIT_PER_USER}`, params)).rows;
}

export async function getMemory(db: Queryable, userId: string, id: string): Promise<MemoryRow | null> {
  return (await db.query<MemoryRow>(`${SELECT} WHERE m.user_id=$1 AND m.id=$2`, [userId, id])).rows[0] ?? null;
}

/** Memories for a model call: global ones plus the study's, newest first (capped). */
export async function memoriesForContext(db: Queryable, userId: string, studyId: string | null) {
  return (await db.query<{ id: string; content: string; scope: string; study_title: string | null }>(
    `SELECT m.id,m.content,m.scope,s.title AS study_title FROM memories m LEFT JOIN studies s ON s.id=m.study_id
      WHERE m.user_id=$1 AND (m.scope='global' OR m.study_id=$2) ORDER BY m.updated_at DESC LIMIT ${MEMORY_INJECT_MAX}`,
    [userId, studyId],
  )).rows;
}

export async function insertMemory(db: Queryable, userId: string, m: { content: string; scope: "global" | "study"; studyId: string | null; source: "agent" | "user"; conversationId: string | null }) {
  const count = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM memories WHERE user_id=$1", [userId])).rows[0]!.n;
  if (count >= MEMORY_LIMIT_PER_USER) return null;
  return (await db.query<{ id: string }>(
    "INSERT INTO memories(user_id,scope,study_id,content,source,source_conversation_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
    [userId, m.scope, m.scope === "study" ? m.studyId : null, m.content.trim().slice(0, MEMORY_MAX), m.source, m.conversationId],
  )).rows[0]!.id;
}

// ---------------------------------------------------------------- content checks

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/, // OpenAI-style keys
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{20,}/, // GitHub tokens
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, // Slack tokens
  /\bAIza[0-9A-Za-z_-]{30,}/, // Google API keys
  /\bhubmcp_[A-Za-z0-9_-]{10,}/, // our own MCP tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /(?:password|passwd|密碼|api[_ -]?key|token|secret)\s*[:：=]\s*\S{6,}/i,
];

/** Looks like a credential (never stored as a memory). */
export const looksSecret = (text: string) => SECRET_PATTERNS.some((re) => re.test(text));

/** Instruction-like text (shown as a warning on the card). */
export const looksLikeInstruction = (text: string) =>
  /(ignore (all|previous)|always|never|call the tool|系統提示|忽略(之前|以上)|一律|永遠要|務必呼叫|https?:\/\/)/i.test(text);

/** Character bigrams (CJK) / lower-case words (Latin) of a text. */
function grams(text: string): Set<string> {
  const out = new Set<string>();
  const norm = text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, " ");
  for (const word of norm.split(" ")) {
    if (!word) continue;
    if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+$/u.test(word)) {
      for (let i = 0; i + 1 < word.length; i++) out.add(word.slice(i, i + 2));
      if (word.length === 1) out.add(word);
    } else {
      // Mixed runs: split CJK and latin parts.
      for (const part of word.match(/[\p{Script=Han}]+|[^\p{Script=Han}]+/gu) ?? []) {
        if (/\p{Script=Han}/u.test(part)) for (let i = 0; i + 1 < part.length; i++) out.add(part.slice(i, i + 2));
        else if (part.length > 1) out.add(part);
      }
    }
  }
  return out;
}

/** Share of the memory's n-grams that appear in `source` (0..1). */
export function overlap(memory: string, source: string): number {
  const m = grams(memory);
  if (!m.size) return 0;
  const s = grams(source);
  let hit = 0;
  for (const g of m) if (s.has(g)) hit++;
  return hit / m.size;
}

/** Memories (from the injected list) the answer relied on: cited as 〔記憶 N〕 / [記憶 N] or strongly overlapping. */
export function usedMemories(answer: string, injected: { id: string; content: string }[]): string[] {
  const cited = new Set<number>();
  for (const m of answer.matchAll(/[〔[【(（]\s*記憶\s*#?\s*(\d{1,3})\s*[〕\]】)）]/g)) cited.add(Number(m[1]));
  return injected.filter((m, i) => cited.has(i + 1) || overlap(m.content, answer) >= 0.6).map((m) => m.id);
}

/** Removes memory citation markers from the text shown to the user. */
export const stripMemoryMarkers = (text: string) => text.replace(/\s?[〔[【]\s*記憶\s*#?\s*\d{1,3}\s*[〕\]】]/g, "");
