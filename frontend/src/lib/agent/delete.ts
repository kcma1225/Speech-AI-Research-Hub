/**
 * Deleting a conversation also stops and deletes its Agent workflows (backend `DELETE /agent/conversations/:id`).
 * The dialog loads what still runs (`/activity`) to warn first; the delete then confirms with `stop_agents=1`.
 */
import { api, ApiError } from "#lib/api.ts";
import { t } from "#lib/i18n.svelte.ts";

export type ConversationActivity = { assistant: boolean; workflows: { id: string; title: string; status: string }[]; goals?: { id: string; title: string; status: string }[] };

export const hasActivity = (a: ConversationActivity | null) => !!a && (a.assistant || a.workflows.length > 0 || (a.goals?.length ?? 0) > 0);

export async function loadActivity(id: string): Promise<ConversationActivity | null> {
  try {
    return await api.get<ConversationActivity>(`/agent/conversations/${id}/activity`);
  } catch {
    return null;
  }
}

/** The dialog text: the usual hint, or a warning naming what will be stopped. */
export function deleteDescription(a: ConversationActivity | null): string {
  if (!hasActivity(a)) return t("agent.deleteHint");
  const parts: string[] = [];
  if (a!.goals?.length) parts.push(t("goal.deleteActive", { n: a!.goals.length, titles: a!.goals.slice(0, 3).map((g) => `〈${g.title}〉`).join(t("agent.listSep")) }));
  if (a!.workflows.length) parts.push(t("agent.deleteActiveWorkflows", { n: a!.workflows.length, titles: a!.workflows.slice(0, 3).map((w) => `〈${w.title}〉`).join(t("agent.listSep")) }));
  if (a!.assistant) parts.push(t("agent.deleteActiveAssistant"));
  return `${parts.join(" ")} ${t("agent.deleteActiveHint")}`;
}

/**
 * Deletes the conversation. When the server reports agents the dialog did not know about (409 `active_agents`), the
 * activity is reloaded into `onActivity` and the error rethrown so the dialog stays open with the warning.
 */
export async function deleteConversation(id: string, a: ConversationActivity | null, onActivity: (a: ConversationActivity | null) => void) {
  try {
    await api.del(`/agent/conversations/${id}${hasActivity(a) ? "?stop_agents=1" : ""}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) onActivity(await loadActivity(id));
    throw e;
  }
}
