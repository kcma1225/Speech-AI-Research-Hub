/** An English edit request on a given deck is an edit from the first routing (scenario matrix g15: the creation log said 「從 0 到 1 建立簡報」). */
import { describe, expect, it } from "vitest";
import { editAsked } from "../src/workflows/route.js";

describe("editAsked on English requests", () => {
  it("reads change / convert / per-part language as an edit", () => {
    expect(editAsked("Change the slide text of this deck to English, keep the speaker notes in Chinese.", [])).toBe(true);
    expect(editAsked("Convert this deck into English.", [])).toBe(true);
    expect(editAsked("Speaker notes in Chinese please.", [])).toBe(true);
  });
  it("does not read a plain new-deck request as an edit", () => {
    expect(editAsked("Make a progress report deck for this week.", [])).toBe(false);
  });
});
