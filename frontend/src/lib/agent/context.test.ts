import { describe, expect, it } from "vitest";
import { pageContextFrom } from "./context.ts";

const at = (href: string) => pageContextFrom(new URL(href, "http://hub.test"));
const P = "65047380-c1af-41e6-8d9c-41916d6e4ad3";

describe("pageContextFrom", () => {
  it("takes the paper of the reader page and the study it was opened from", () => {
    expect(at(`/library/${P}?study=my-study`)).toEqual({ path: `/library/${P}`, paperId: P, studySlug: "my-study" });
    expect(at(`/library/${P}`)).toEqual({ path: `/library/${P}`, paperId: P });
    expect(at("/library/not-a-uuid")).toEqual({ path: "/library/not-a-uuid" });
  });
  it("keeps the study paper sheet deep link", () => {
    expect(at(`/studies/s1?tab=papers&paper=${P}`)).toEqual({ path: "/studies/s1", studySlug: "s1", paperId: P });
  });
  it("has no context on the assistant page", () => {
    expect(at("/assistant/x")).toBeNull();
  });
});
