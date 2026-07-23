import type { FormField } from "./types";

/**
 * Does the extracted field set look like a real job application form?
 * The Databricks incident: the arm extracted a newsletter box (1 email
 * field) and confidently proceeded. A real application virtually always has
 * an email + name pair, a resume upload, or substantial question volume.
 */
export function looksLikeApplicationForm(fields: FormField[]): {
  ok: boolean;
  reason: string;
} {
  if (fields.length === 0) {
    return { ok: false, reason: "no fields extracted" };
  }

  const haystacks = fields.map((f) => `${f.label} ${f.name}`.toLowerCase());
  const hasEmail = haystacks.some((h) => h.includes("email"));
  const hasName = haystacks.some((h) =>
    /first[\s_-]?name|last[\s_-]?name|full[\s_-]?name|\bname\b/.test(h)
  );
  const hasResume =
    fields.some((f) => f.type === "file") ||
    haystacks.some((h) => h.includes("resume") || /\bcv\b/.test(h));

  if (hasResume) return { ok: true, reason: "resume upload present" };
  if (hasEmail && hasName) return { ok: true, reason: "email + name present" };
  if (fields.length >= 6) return { ok: true, reason: "substantial field count" };

  return {
    ok: false,
    reason: `only ${fields.length} field(s), no resume upload or email+name pair (likely a newsletter/search box)`
  };
}
