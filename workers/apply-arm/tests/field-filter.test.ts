import { describe, expect, it } from "vitest";
import { filterApplicationFields, isNonApplicationField } from "../src/field-filter";
import type { FormField } from "../src/types";

const f = (over: Partial<FormField>): FormField => ({
  name: "",
  label: "",
  type: "text",
  required: false,
  options: [],
  ...over
});

describe("isNonApplicationField", () => {
  it("drops the site search box (from the Databricks page-wide sweep)", () => {
    expect(isNonApplicationField(f({ name: "search", label: "Search", type: "search" }))).toBe(true);
    expect(isNonApplicationField(f({ name: "q", label: "Search" }))).toBe(true);
    expect(isNonApplicationField(f({ name: "site-search", type: "text" }))).toBe(true);
  });

  it("drops the resume file input (handled by attachResume)", () => {
    expect(isNonApplicationField(f({ name: "resume", label: "Attach", type: "file" }))).toBe(true);
  });

  it("drops captcha token fields", () => {
    expect(isNonApplicationField(f({ name: "g-recaptcha-response", type: "textarea" }))).toBe(true);
    expect(isNonApplicationField(f({ name: "h-captcha-response", type: "textarea" }))).toBe(true);
    expect(isNonApplicationField(f({ name: "cf-turnstile-response", type: "hidden" }))).toBe(true);
  });

  it("drops honeypots", () => {
    expect(isNonApplicationField(f({ name: "url_trap", label: "Leave this blank" }))).toBe(true);
    expect(isNonApplicationField(f({ name: "bot-field" }))).toBe(true);
  });

  it("keeps real application questions", () => {
    expect(isNonApplicationField(f({ name: "email", label: "Email", type: "email" }))).toBe(false);
    expect(isNonApplicationField(f({ name: "first_name", label: "First Name" }))).toBe(false);
    expect(
      isNonApplicationField(
        f({ name: "gender", label: "Gender", type: "select", options: ["Male", "Female", "Decline"] })
      )
    ).toBe(false);
    // A legit "why do you want to work here" search-word in label must not trip
    expect(isNonApplicationField(f({ name: "cover_letter", label: "In your job search, why us?" }))).toBe(false);
    // Phone with a name that merely contains letters
    expect(isNonApplicationField(f({ name: "phone", label: "Phone" }))).toBe(false);
  });
});

describe("filterApplicationFields", () => {
  it("keeps only the real questions from a mixed Databricks-style set", () => {
    const raw = [
      f({ name: "first_name", label: "First Name" }),
      f({ name: "email", label: "Email", type: "email" }),
      f({ name: "search", label: "Search", type: "search" }),
      f({ name: "resume", label: "Attach", type: "file" }),
      f({ name: "g-recaptcha-response", type: "textarea" }),
      f({ name: "us_citizen", label: "U.S. citizen", type: "select", options: ["true", "false"] })
    ];
    const kept = filterApplicationFields(raw).map((x) => x.name);
    expect(kept).toEqual(["first_name", "email", "us_citizen"]);
  });
});
