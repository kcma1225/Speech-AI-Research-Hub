import type { SessionRow } from "#lib/types.ts";

/** How many sign-ins the Settings → 登入裝置 list shows before 「顯示全部」. */
export const SESSIONS_SHOWN = 8;

/** This device first, then the most recently active. */
export function orderSessions(list: readonly SessionRow[]): SessionRow[] {
  return [...list].sort((a, b) => Number(b.current) - Number(a.current) || Date.parse(b.last_seen_at) - Date.parse(a.last_seen_at));
}

/** The rows to render: all when expanded, else the first `limit`; `hidden` = how many are folded away. */
export function visibleSessions(list: readonly SessionRow[], expanded: boolean, limit = SESSIONS_SHOWN): { rows: SessionRow[]; hidden: number } {
  const ordered = orderSessions(list);
  if (expanded || ordered.length <= limit) return { rows: ordered, hidden: 0 };
  return { rows: ordered.slice(0, limit), hidden: ordered.length - limit };
}
