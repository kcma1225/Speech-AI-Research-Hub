import { api } from "#lib/api.ts";

/** Feature roles of the AI platform (docs/v3-spec.md §4). Code asks for a role, never a model. */
export type AiRole = "assistant" | "writing" | "slides" | "analysis" | "fast" | "embedding" | "asr" | "asr_live";
export const AI_ROLES: AiRole[] = ["assistant", "writing", "slides", "analysis", "fast", "embedding", "asr", "asr_live"];
export type AiRoleState = "ok" | "degraded" | "unavailable" | "unconfigured";
export type AiRoleStatus = { status: AiRoleState; message?: string | null; hint?: string | null; /** The serving route accepts images. */ vision?: boolean };
export type SearchMode = "semantic" | "keyword_only";

/**
 * Shared AI status from `GET /api/ai/status` → `{ roles: { <role>: { state, message_zh } }, search_mode, updated_at }`.
 * While anything watches it, the store follows `GET /api/ai/status/stream` (SSE, pushed on change) and also polls
 * every 30 s as a fallback. A 404, an error or a missing role all read as `unavailable`, so every AI entry shows
 * 「維護中」 and the rest of the app keeps working. `unconfigured` (no route bound yet) is not available either.
 */
let roles = $state<Partial<Record<AiRole, AiRoleStatus>>>({});
let searchMode = $state<SearchMode>("keyword_only");
let loaded = $state(false);
let updatedAt = $state<string | null>(null);
let timer: ReturnType<typeof setInterval> | undefined;
let source: EventSource | null = null;
let users = 0;

const STATES = new Set<AiRoleState>(["ok", "degraded", "unavailable", "unconfigured"]);

function normalise(body: unknown): Partial<Record<AiRole, AiRoleStatus>> {
  const source = (body && typeof body === "object" && "roles" in body ? (body as { roles: unknown }).roles : body) as Record<string, unknown> | null;
  const result: Partial<Record<AiRole, AiRoleStatus>> = {};
  if (!source || typeof source !== "object") return result;
  for (const [role, value] of Object.entries(source)) {
    const v = value && typeof value === "object" ? (value as { state?: unknown; status?: unknown; message?: string; message_zh?: string; hint?: string; hint_zh?: string; vision?: unknown }) : null;
    const status = typeof value === "string" ? value : (v?.state ?? v?.status);
    if (typeof status === "string" && STATES.has(status as AiRoleState)) {
      result[role as AiRole] = { status: status as AiRoleState, message: v?.message_zh ?? v?.message ?? null, hint: v?.hint_zh ?? v?.hint ?? v?.message_zh ?? null, vision: v?.vision === true };
    }
  }
  return result;
}

function apply(body: unknown) {
  roles = normalise(body);
  const b = body as { search_mode?: unknown; updated_at?: unknown } | null;
  searchMode = b?.search_mode === "semantic" ? "semantic" : "keyword_only";
  updatedAt = typeof b?.updated_at === "string" ? b.updated_at : null;
}

async function refresh() {
  try {
    apply(await api.get<unknown>("/ai/status"));
  } catch {
    roles = {};
  } finally {
    loaded = true;
  }
}

function connect() {
  if (typeof EventSource !== "function" || source) return;
  source = new EventSource("/api/ai/status/stream");
  source.addEventListener("status", e => {
    try {
      apply(JSON.parse((e as MessageEvent<string>).data));
      loaded = true;
    } catch {}
  });
  // EventSource reconnects by itself (server sends `retry: 5000`); polling covers the gap.
}

function disconnect() {
  source?.close();
  source = null;
}

export const aiStatus = {
  get loaded() {
    return loaded;
  },
  get searchMode() {
    return searchMode;
  },
  get updatedAt() {
    return updatedAt;
  },
  /** Every known role with its status (unknown roles read as unavailable). */
  get all(): Array<{ role: AiRole } & AiRoleStatus> {
    return AI_ROLES.map(role => ({ role, ...(roles[role] ?? { status: "unavailable" as const }) }));
  },
  /** Status of `role`; unknown or unreachable means unavailable. */
  of(role: AiRole): AiRoleStatus {
    return roles[role] ?? { status: "unavailable" };
  },
  available(role: AiRole) {
    const state = roles[role]?.status;
    return state === "ok" || state === "degraded";
  },
  /** The role is available and can look at images (layout review). */
  vision(role: AiRole) {
    return this.available(role) && roles[role]?.vision === true;
  },
  /** Start following (ref-counted); returns the matching stop function. */
  watch() {
    users++;
    if (users === 1) {
      void refresh();
      connect();
      timer = setInterval(() => !document.hidden && void refresh(), 30_000);
    }
    return () => {
      users--;
      if (users === 0) {
        if (timer) clearInterval(timer);
        timer = undefined;
        disconnect();
      }
    };
  },
  refresh,
};
