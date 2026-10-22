import { describe, expect, it } from "vitest";
import { hidesPageBanner } from "./nav.ts";

describe("hidesPageBanner", () => {
  it("hides on settings, assistant and full-height editors", () => {
    for (const p of ["/settings", "/settings/profile", "/assistant", "/assistant/abc", "/studies/x/notes/1", "/studies/x/latex/2", "/studies/x/decks/3/edit"]) expect(hidesPageBanner(p), p).toBe(true);
  });
  it("shows elsewhere", () => {
    for (const p of ["/", "/studies", "/studies/x", "/studies/x/decks/3", "/library", "/settingsx", "/meetings/1"]) expect(hidesPageBanner(p), p).toBe(false);
  });
});
