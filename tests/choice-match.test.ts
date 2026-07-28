import { describe, expect, it } from "vitest";
import {
  checkboxLabelMatches,
  partitionGroupAnswer,
  splitAnswerValues,
  toggleGroupOption
} from "@/lib/choice-match";

/**
 * Mirrors the sidecar's field-match.ts. If these semantics drift, the review
 * screen reads a draft differently than the filler applies it.
 */

describe("splitAnswerValues", () => {
  it("splits on semicolons and commas, trimming and dropping blanks", () => {
    expect(splitAnswerValues("a; b,c ; ,")).toEqual(["a", "b", "c"]);
    expect(splitAnswerValues("")).toEqual([]);
  });
});

describe("checkboxLabelMatches", () => {
  it("matches exactly, case- and whitespace-insensitively", () => {
    expect(checkboxLabelMatches("Queer", ["queer"])).toBe(true);
    expect(checkboxLabelMatches("  Queer ", ["QUEER"])).toBe(true);
  });

  it("normalizes curly quotes both ways", () => {
    expect(checkboxLabelMatches("I \u2019prefer\u2019 not", ["i 'prefer' not"])).toBe(true);
    expect(checkboxLabelMatches('say \u201cno\u201d thanks', ['say "no" thanks'])).toBe(true);
  });

  it("allows containment for specific strings but not short tokens", () => {
    expect(checkboxLabelMatches("U.S. citizen", ["citizen"])).toBe(true);
    expect(checkboxLabelMatches("Yes, I am authorized", ["I am authorized"])).toBe(true);
    // ...and the other direction: a terse label inside a wordier draft.
    expect(checkboxLabelMatches("authorized", ["I am authorized"])).toBe(true);
    // "No" must not substring-match "None of the above", and a short label
    // ("Yes") only ever matches exactly.
    expect(checkboxLabelMatches("None of the above", ["No"])).toBe(false);
    expect(checkboxLabelMatches("Yes", ["Yes, definitely"])).toBe(false);
  });

  it("rejects empty labels and empty wanted values", () => {
    expect(checkboxLabelMatches("   ", ["x"])).toBe(false);
    expect(checkboxLabelMatches("x", ["  "])).toBe(false);
  });
});

describe("partitionGroupAnswer", () => {
  it("selects fuzzily matched options and keeps unmatched tokens as extras", () => {
    const { selected, extras } = partitionGroupAnswer("queer, made this up", [
      "Bisexual",
      "Queer"
    ]);
    expect([...selected]).toEqual(["Queer"]);
    expect(extras).toEqual(["made this up"]);
  });
});

describe("toggleGroupOption", () => {
  it("adds and removes options while preserving off-list tokens", () => {
    const options = ["A", "B", "C"];
    const withB = toggleGroupOption("A; custom note", options, "B");
    expect(withB).toBe("A; B; custom note");
    const withoutA = toggleGroupOption(withB, options, "A");
    expect(withoutA).toBe("B; custom note");
  });

  it("keeps the group's own option order regardless of toggle order", () => {
    const options = ["A", "B", "C"];
    expect(toggleGroupOption(toggleGroupOption("", options, "C"), options, "A")).toBe("A; C");
  });
});
