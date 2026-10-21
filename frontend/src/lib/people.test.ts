import { describe, expect, it } from "vitest";
import { composeZhName, formalZhAddress, formatPersonName, initialsOf, nameFormPayload, nameFormValid, personMatches } from "./people.ts";

const lin = { name: "林雅婷", username: "linyating", person: { zh_family: "林", zh_given: "雅婷", en_family: "Lin", en_given: "Ya-Ting", title: "dr" as const } };

describe("person names", () => {
  it("formats per locale and style", () => {
    expect(formatPersonName(lin, "zh-TW")).toBe("林雅婷");
    expect(formatPersonName(lin, "zh-TW", "formal")).toBe("林雅婷");
    expect(formatPersonName(lin, "en")).toBe("Ya-Ting Lin");
    expect(formatPersonName(lin, "en", "formal")).toBe("Dr. Ya-Ting Lin");
    expect(formatPersonName({ ...lin, person: { ...lin.person, en_given: null, title: null } }, "en", "formal")).toBe("Lin");
    expect(formatPersonName({ name: "舊名", name_en: "Old Name" }, "en")).toBe("Old Name");
    expect(formatPersonName({ name: "舊名" }, "en")).toBe("舊名");
    expect(formalZhAddress(lin)).toBe("林博士");
    expect(composeZhName("Smith", "Anna")).toBe("Anna Smith");
  });

  it("initials follow the displayed name", () => {
    expect(initialsOf("林雅婷")).toBe("雅婷");
    expect(initialsOf("Ya-Ting Lin")).toBe("YL");
    expect(initialsOf("Lin")).toBe("LI");
  });

  it("search matches every name part and the username", () => {
    for (const q of ["林雅", "雅婷", "ya-ting", "yating", "Lin", "ya-ting lin", "@linyat", "linyating", ""]) expect(personMatches(lin, q), q).toBe(true);
    expect(personMatches(lin, "chen")).toBe(false);
  });

  it("validates and builds the API payload", () => {
    const form = { zhFamily: " 林 ", zhGiven: "雅婷", enFamily: "Lin", enGiven: " ", title: "" as const };
    expect(nameFormValid(form)).toBe(true);
    expect(nameFormPayload(form)).toEqual({ zhFamily: "林", zhGiven: "雅婷", enFamily: "Lin", enGiven: null, title: null });
    expect(nameFormValid({ ...form, enFamily: "" })).toBe(false);
    expect(nameFormValid({ ...form, enFamily: "林" })).toBe(false);
    expect(nameFormValid({ ...form, zhGiven: "" })).toBe(false);
    expect(nameFormValid({ ...form, enGiven: "Ya2" })).toBe(false);
  });
});
