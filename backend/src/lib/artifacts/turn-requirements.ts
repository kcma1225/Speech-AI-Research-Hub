/**
 * The user's requirements of THIS chat turn, checked on an edit before the assistant moves on (docs/architecture.md
 * "Artifact edit gate"). Workflows have had a requirement ledger since 0668a3d7; chat edits had none, so 「我是要第一頁加，
 * 不是第二頁」 produced two edits on page 2 and nothing noticed (production 61666f10). The same detection the workflows
 * use (`detectRequirements`) runs on the turn's user message; every deterministic criterion is checked on the edited
 * artifact — its rendered view when the edit gate rendered it, else the source — and a requirement on a position is
 * checked against where the edit's new text actually lands. The result goes into the tool result (`user_requirements`)
 * and an unmet one keeps the turn open once (agent/guards.ts completion review).
 */
import type { Queryable } from "../../db.js";
import { runChecks } from "../../workflows/checks.js";
import { detectRequirements, requirementCriteria, type ArtifactKind } from "../../workflows/requirements.js";
import { venueTerms } from "../../workflows/venue.js";
import type { Requirement } from "../../workflows/types.js";
import type { ArtifactView } from "./view.js";

export type TurnRequirement = { text: string; ok: boolean; detail: string };

/** The newest user message of a conversation (the turn's own words; the page-context hint is not part of `text`). */
export async function turnWords(db: Queryable, conversationId: string | null): Promise<string> {
  if (!conversationId) return "";
  return (await db.query<{ text: string }>("SELECT text FROM agent_messages WHERE conversation_id=$1 AND role='user' AND hidden_by IS NULL ORDER BY seq DESC LIMIT 1", [conversationId])).rows[0]?.text ?? "";
}

/**
 * The turn's requirements on an edited artifact. `after` = the edited text (decks: the entry .qmd incl. front matter);
 * `landed` = player pages the edit's new text is on (decks); `venue` = the deck's paper's venue / year when known.
 */
export function checkTurnRequirements(words: string, kind: ArtifactKind, after: string, opts: { view?: ArtifactView; landed?: number[]; venue?: { venue: string | null; year: number | null } | null } = {}): TurnRequirement[] {
  if (!words.trim()) return [];
  const reqs = detectRequirements(words, { kind }).map((r, i) => ({ ...r, id: `t${i + 1}`, source: "request" as const })) as Requirement[];
  const out: TurnRequirement[] = [];
  for (const r of reqs) {
    const params = { ...r.params };
    if (params.venue && opts.venue && !params.terms?.length) params.terms = venueTerms(opts.venue);
    const [c] = requirementCriteria([{ ...r, params }], kind);
    // A position the user named: the edit's new text has to be on that page (the deck numbering of lib/artifacts/view.ts).
    if (kind === "deck" && typeof params.page === "number" && params.page > 0 && opts.landed?.length && !opts.landed.includes(params.page)) {
      out.push({ text: r.text, ok: false, detail: `使用者要的是第 ${params.page} 頁${params.page === 1 ? "（封面：改 front matter 的 title / subtitle）" : ""}，這次修改的新內容在第 ${opts.landed.join("、")} 頁。` });
      continue;
    }
    if (c?.kind !== "check" || !c.check) continue;
    // A removal of whole pages is the page-scope rule's (it reads the original deck), not a check on one file edit.
    if (c.check.id === "req_pages" || (c.check.id === "req_exclude" && params.pages?.length)) continue;
    const [res] = runChecks([c.check], after, { full: after, ...(opts.view ? { view: opts.view } : {}) });
    if (res) out.push({ text: r.text, ok: res.ok, detail: res.detail });
  }
  return out;
}

/** The unmet ones, for the tool result and the completion review. */
export const unmetOf = (list: TurnRequirement[]) => list.filter((r) => !r.ok);
