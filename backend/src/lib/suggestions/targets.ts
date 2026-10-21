import type pg from "pg";
import type { Queryable } from "../../db.js";
import type { CurrentUser } from "../auth.js";

export type SuggestionSource = "user" | "ai" | "autopilot";

export type ResolvedTarget = {
  studyId: string | null;
  /** Yjs document holding the text (`note:<id>`, `latex:<p>:<f>`…); null for plain-text targets. */
  docName: string | null;
  /** Shown in lists and notifications. */
  title: string;
  /** SPA path of the editor that reviews the suggestion. */
  url: string | null;
  /** Current version number of the target, stored as `base_version` (informational). */
  version?: number | null;
};

export type AppliedInfo = {
  /** Full text after the decision. */
  text: string;
  /** Hunks applied by this decision. */
  accepted: number;
  source: SuggestionSource;
  actorId: string | null;
  suggestion: { id: string; title: string; source: SuggestionSource };
};

/**
 * A kind of text a suggestion can target. Modules register theirs (notes: `note`; core summary: `study_summary`;
 * slides: `deck_source`; latex: `latex_file`). Yjs targets set `docName` in `resolve`; plain-text targets implement
 * `readText`/`writeText` instead.
 */
export type SuggestionTarget = {
  type: string;
  resolve(db: Queryable, targetId: string): Promise<ResolvedTarget | null>;
  /** May `user` accept/reject (and create) suggestions on this target? (Usually: study editor.) */
  canEdit(db: Queryable, user: CurrentUser, target: ResolvedTarget): Promise<boolean>;
  readText?(db: Queryable, targetId: string): Promise<string>;
  writeText?(client: pg.PoolClient, targetId: string, text: string, actorId: string | null): Promise<void>;
  /** Runs in the decision transaction after hunks were applied (versions, activity, materialized text). */
  afterApply?(client: pg.PoolClient, targetId: string, info: AppliedInfo): Promise<void>;
};

const targets = new Map<string, SuggestionTarget>();

export function registerSuggestionTarget(target: SuggestionTarget) {
  targets.set(target.type, target);
}

export const suggestionTarget = (type: string) => targets.get(type) ?? null;
