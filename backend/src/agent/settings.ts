import type { Queryable } from "../db.js";

/** `concept_memory`: 「先確認先備知識」 remembers concepts (user_concepts); its own switch, on by default. */
export type AgentSettings = { memory_enabled: boolean; autopilot_default: boolean; autopilot_explained: boolean; concept_memory: boolean };
export const DEFAULT_AGENT_SETTINGS: AgentSettings = { memory_enabled: false, autopilot_default: false, autopilot_explained: false, concept_memory: true };

export async function getAgentSettings(db: Queryable, userId: string): Promise<AgentSettings> {
  const row = (await db.query<AgentSettings>("SELECT memory_enabled,autopilot_default,autopilot_explained,concept_memory FROM agent_settings WHERE user_id=$1", [userId])).rows[0];
  return row ?? { ...DEFAULT_AGENT_SETTINGS };
}

export async function saveAgentSettings(db: Queryable, userId: string, patch: Partial<AgentSettings>): Promise<AgentSettings> {
  const cur = await getAgentSettings(db, userId);
  const next = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => typeof v === "boolean")) } as AgentSettings;
  await db.query(
    `INSERT INTO agent_settings(user_id,memory_enabled,autopilot_default,autopilot_explained,concept_memory) VALUES($1,$2,$3,$4,$5)
     ON CONFLICT (user_id) DO UPDATE SET memory_enabled=$2,autopilot_default=$3,autopilot_explained=$4,concept_memory=$5,updated_at=now()`,
    [userId, next.memory_enabled, next.autopilot_default, next.autopilot_explained, next.concept_memory],
  );
  return next;
}
