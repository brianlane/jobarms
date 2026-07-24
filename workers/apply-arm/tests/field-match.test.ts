import { describe, expect, it } from "vitest";
import { checkboxLabelMatches, splitAnswerValues } from "../src/field-match";

describe("splitAnswerValues", () => {
  it("splits multi-select answers on ; and ,", () => {
    expect(splitAnswerValues("U.S. citizen")).toEqual(["U.S. citizen"]);
    expect(splitAnswerValues("A; B, C")).toEqual(["A", "B", "C"]);
    expect(splitAnswerValues("  ")).toEqual([]);
  });
});

describe("checkboxLabelMatches", () => {
  it("matches the exact Databricks compliance options the arm should tick", () => {
    expect(checkboxLabelMatches("None of the above", ["None of the above"])).toBe(true);
    expect(checkboxLabelMatches("U.S. citizen", ["U.S. citizen"])).toBe(true);
  });

  it("does NOT tick unrelated options in the same group", () => {
    const wanted = ["None of the above"];
    expect(
      checkboxLabelMatches("Citizen or permanent resident of Cuba, Iran, North Korea, or Syria", wanted)
    ).toBe(false);
    expect(
      checkboxLabelMatches("Ordinarily a resident of Russia or Belarus", wanted)
    ).toBe(false);
  });

  it("guards the No-matches-None substring trap", () => {
    // A short answer must not fuzzy-match a longer unrelated option.
    expect(checkboxLabelMatches("None of these apply to me", ["No"])).toBe(false);
    expect(checkboxLabelMatches("No", ["No"])).toBe(true);
  });

  it("tolerates minor wording drift for specific labels", () => {
    expect(checkboxLabelMatches("U.S. permanent resident (Green Card holder)", ["U.S. permanent resident"])).toBe(true);
  });

  it("supports multiple wanted values", () => {
    const wanted = splitAnswerValues("U.S. citizen; Individual granted asylum in the U.S.");
    expect(checkboxLabelMatches("U.S. citizen", wanted)).toBe(true);
    expect(checkboxLabelMatches("Individual granted asylum in the U.S.", wanted)).toBe(true);
    expect(checkboxLabelMatches("U.S. non-citizen national", wanted)).toBe(false);
  });
});
