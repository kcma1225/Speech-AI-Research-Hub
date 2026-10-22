import { describe, expect, it } from "vitest";
import type { SessionRow } from "#lib/types.ts";
import { orderSessions, visibleSessions } from "./sessions.ts";

const row = (id: string, last: string, current = false): SessionRow => ({ id, user_agent: null, ip: null, created_at: last, last_seen_at: last, expires_at: last, current });

describe("sessions list", () => {
  const list = [row("a", "2026-10-01T00:00:00Z"), row("b", "2026-10-03T00:00:00Z"), row("me", "2026-09-01T00:00:00Z", true), row("c", "2026-10-02T00:00:00Z")];
  it("puts this device first, then newest activity", () => {
    expect(orderSessions(list).map(s => s.id)).toEqual(["me", "b", "c", "a"]);
  });
  it("folds rows past the limit unless expanded", () => {
    expect(visibleSessions(list, false, 2)).toEqual({ rows: orderSessions(list).slice(0, 2), hidden: 2 });
    expect(visibleSessions(list, true, 2).rows).toHaveLength(4);
    expect(visibleSessions(list, false, 4).hidden).toBe(0);
  });
});
