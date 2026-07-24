import { describe, expect, it } from "vitest";
import { looksLikeApplicationForm } from "../src/form-sanity";
import type { FormField } from "../src/types";

const f = (over: Partial<FormField>): FormField => ({
  name: "",
  label: "",
  type: "text",
  required: false,
  options: [],
  ...over
});

describe("looksLikeApplicationForm", () => {
  it("rejects an empty field set", () => {
    expect(looksLikeApplicationForm([])).toEqual({ ok: false, reason: "no fields extracted" });
  });

  it("accepts a resume file input", () => {
    expect(looksLikeApplicationForm([f({ type: "file", label: "Attach resume" })]).ok).toBe(true);
  });

  it("accepts a resume/cv label without a file input", () => {
    expect(looksLikeApplicationForm([f({ label: "Upload CV", name: "cv" })]).ok).toBe(true);
  });

  it("accepts an email + name pair", () => {
    const ok = looksLikeApplicationForm([
      f({ name: "email", label: "Email" }),
      f({ name: "first_name", label: "First name" })
    ]);
    expect(ok).toEqual({ ok: true, reason: "email + name present" });
  });

  it("accepts a substantial field count", () => {
    expect(looksLikeApplicationForm(Array.from({ length: 6 }, (_, i) => f({ name: `q${i}`, label: `Q${i}` }))).ok).toBe(true);
  });

  it("rejects a lone newsletter box", () => {
    const res = looksLikeApplicationForm([f({ name: "email", label: "Email" })]);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("newsletter");
  });
});
