import { describe, expect, it } from "vitest";
import { looksLikeApplicationForm } from "../src/form-sanity";
import { filterApplicationFields, isNonApplicationField } from "../src/field-filter";
import { checkboxLabelMatches, splitAnswerValues } from "../src/field-match";
import { attrEscape, cssEscape } from "../src/fill";
import type { FormField } from "../src/types";

const field = (over: Partial<FormField> = {}): FormField => ({
  name: "f",
  label: "F",
  type: "text",
  required: false,
  options: [],
  ...over
});

describe("looksLikeApplicationForm", () => {
  it("rejects an empty field set", () => {
    expect(looksLikeApplicationForm([])).toEqual({
      ok: false,
      reason: "no fields extracted"
    });
  });

  it("accepts a form with a resume upload", () => {
    const result = looksLikeApplicationForm([field({ type: "file" })]);
    expect(result).toEqual({ ok: true, reason: "resume upload present" });
  });

  it("accepts a resume identified only by label wording", () => {
    expect(looksLikeApplicationForm([field({ label: "Attach CV" })]).ok).toBe(true);
    expect(looksLikeApplicationForm([field({ label: "Resume" })]).ok).toBe(true);
  });

  it("accepts an email + name pair", () => {
    const result = looksLikeApplicationForm([
      field({ name: "email", label: "Email" }),
      field({ name: "first_name", label: "First Name" })
    ]);
    expect(result).toEqual({ ok: true, reason: "email + name present" });
  });

  it("accepts a substantial field count with neither signal", () => {
    const many = Array.from({ length: 6 }, (_, i) => field({ name: `q${i}`, label: `Q${i}` }));
    expect(looksLikeApplicationForm(many)).toEqual({
      ok: true,
      reason: "substantial field count"
    });
  });

  it("rejects a lone newsletter box (the Databricks incident)", () => {
    const result = looksLikeApplicationForm([field({ name: "email", label: "Email" })]);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("newsletter");
  });
});

describe("isNonApplicationField", () => {
  it("drops file uploads, handled separately by attachResume", () => {
    expect(isNonApplicationField(field({ type: "file" }))).toBe(true);
  });

  it("drops search boxes by type, name, or label", () => {
    expect(isNonApplicationField(field({ type: "search" }))).toBe(true);
    expect(isNonApplicationField(field({ name: "q" }))).toBe(true);
    expect(isNonApplicationField(field({ name: "site-search" }))).toBe(true);
    expect(isNonApplicationField(field({ label: "Search" }))).toBe(true);
  });

  it("drops captcha token fields", () => {
    expect(isNonApplicationField(field({ name: "g-recaptcha-response" }))).toBe(true);
    expect(isNonApplicationField(field({ name: "cf-turnstile-response" }))).toBe(true);
    expect(isNonApplicationField(field({ label: "hCaptcha" }))).toBe(true);
  });

  it("drops honeypots", () => {
    expect(isNonApplicationField(field({ name: "honeypot" }))).toBe(true);
    expect(isNonApplicationField(field({ name: "bot-field" }))).toBe(true);
    expect(isNonApplicationField(field({ label: "Leave this blank" }))).toBe(true);
    expect(isNonApplicationField(field({ name: "url_trap" }))).toBe(true);
  });

  it("keeps a real question", () => {
    expect(isNonApplicationField(field({ name: "why_us", label: "Why this company?" }))).toBe(
      false
    );
  });

  it("tolerates missing name and label", () => {
    expect(
      isNonApplicationField({
        type: "text",
        required: false,
        options: []
      } as unknown as FormField)
    ).toBe(false);
  });
});

describe("filterApplicationFields", () => {
  it("keeps only real questions", () => {
    const kept = filterApplicationFields([
      field({ name: "why_us", label: "Why us?" }),
      field({ name: "resume", type: "file" }),
      field({ name: "q" })
    ]);
    expect(kept.map((f) => f.name)).toEqual(["why_us"]);
  });
});

describe("splitAnswerValues", () => {
  it("splits on semicolons and commas, trimming and dropping blanks", () => {
    expect(splitAnswerValues("a; b, c ;; ")).toEqual(["a", "b", "c"]);
  });

  it("returns empty for an empty answer", () => {
    expect(splitAnswerValues("  ")).toEqual([]);
  });
});

describe("checkboxLabelMatches", () => {
  it("matches exactly, ignoring case and curly quotes", () => {
    expect(checkboxLabelMatches("Yes", ["yes"])).toBe(true);
    expect(checkboxLabelMatches("Don\u2019t know", ["don't know"])).toBe(true);
    expect(checkboxLabelMatches('He said \u201chi\u201d', ['he said "hi"'])).toBe(true);
  });

  it("collapses runs of whitespace", () => {
    expect(checkboxLabelMatches("US   Citizen", ["us citizen"])).toBe(true);
  });

  it("allows containment for specific-enough strings, both directions", () => {
    expect(checkboxLabelMatches("U.S. citizen or national", ["U.S. citizen"])).toBe(true);
    expect(checkboxLabelMatches("citizen", ["I am a citizen of the US"])).toBe(true);
  });

  it("does NOT let a short answer substring-match a longer option", () => {
    // The classic false positive: "No" must not tick "None of the above".
    expect(checkboxLabelMatches("None of the above", ["No"])).toBe(false);
  });

  it("rejects blank labels and blank wanted values", () => {
    expect(checkboxLabelMatches("  ", ["yes"])).toBe(false);
    expect(checkboxLabelMatches("Yes", ["  "])).toBe(false);
    expect(checkboxLabelMatches("Yes", [])).toBe(false);
  });
});

describe("cssEscape", () => {
  it("escapes everything outside the safe identifier set", () => {
    expect(cssEscape("a.b:c")).toBe("a\\.b\\:c");
    expect(cssEscape("plain_name-1")).toBe("plain_name-1");
  });
});

describe("attrEscape", () => {
  it("escapes quotes so a field name cannot break out of the selector", () => {
    expect(attrEscape('we"ird')).toBe('we\\"ird');
  });

  it("escapes backslashes BEFORE quotes, so nothing is double-escaped", () => {
    // Quotes-first would turn \" into \\\" and corrupt the selector.
    expect(attrEscape('a\\"b')).toBe('a\\\\\\"b');
    expect(attrEscape("back\\slash")).toBe("back\\\\slash");
  });

  it("leaves an ordinary name untouched", () => {
    expect(attrEscape("first_name")).toBe("first_name");
  });
});
