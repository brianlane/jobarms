/**
 * Deterministic cleanup for parsed-resume text. Resumes often style names,
 * headlines, and section text in ALL CAPS; models faithfully copy that
 * shouting. These normalizers fix casing and phone formats in code so the
 * result never depends on model behavior.
 */

/** Acronyms/initialisms kept uppercase when title-casing shouty text. */
const ACRONYMS = new Set([
  "ai", "api", "apis", "aws", "gcp", "azure", "ci", "cd", "ci/cd", "cli",
  "css", "html", "http", "https", "ios", "it", "js", "ts", "json", "jvm",
  "k8s", "ml", "nlp", "php", "qa", "rest", "sdk", "seo", "sql", "nosql",
  "ui", "ux", "vp", "cto", "ceo", "cfo", "coo", "pm", "tpm", "sre",
  "devops", "etl", "erp", "crm", "saas", "b2b", "b2c", "usa", "us", "uk",
  "llc", "inc", "iot", "grpc", "graphql", "css3", "html5", "ii", "iii", "iv"
]);

/** Words kept lowercase mid-phrase when title-casing. */
const SMALL_WORDS = new Set([
  "a", "an", "and", "as", "at", "but", "by", "for", "in", "of", "on", "or",
  "the", "to", "with", "de", "la"
]);

function letters(s: string): string {
  return s.replace(/[^a-zA-Z]/g, "");
}

/** True when a string is (nearly) all uppercase and long enough to judge. */
export function isShouty(s: string): boolean {
  const alpha = letters(s);
  if (alpha.length < 4) return false;
  const upper = alpha.replace(/[^A-Z]/g, "");
  return upper.length / alpha.length > 0.9;
}

function caseWord(word: string, isFirst: boolean): string {
  const lower = word.toLowerCase();
  if (ACRONYMS.has(lower)) return lower.toUpperCase().replace("DEVOPS", "DevOps");
  if (!isFirst && SMALL_WORDS.has(lower)) return lower;
  // Handle hyphen/slash compounds: FULL-STACK -> Full-Stack, CI/CD handled above
  return lower.replace(/(^|[-/])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
}

/** Title-case a phrase (used on shouty short fields: names, titles, orgs). */
export function titleCase(s: string): string {
  const words = s.split(/\s+/).filter(Boolean);
  return words.map((w, i) => caseWord(w, i === 0)).join(" ");
}

/** Fix a short field ONLY if the whole thing is shouting. */
export function fixShoutyField(s: string): string {
  const trimmed = s.trim();
  return isShouty(trimmed) ? titleCase(trimmed) : trimmed;
}

/**
 * Fix prose (summaries, bullets): if the WHOLE string shouts, sentence-case
 * it; otherwise fix a leading run of 2+ shouty words that resume layouts
 * commonly produce ("SENIOR SOFTWARE ENGINEER with a track record...").
 */
export function fixShoutyProse(s: string): string {
  const trimmed = s.trim();
  if (!trimmed) return trimmed;

  if (isShouty(trimmed)) {
    const sentence = trimmed.toLowerCase().replace(/(^|[.!?]\s+)([a-z])/g, (m) => m.toUpperCase());
    // Restore known acronyms
    return sentence.replace(/\b[a-z0-9/]+\b/g, (w) =>
      ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w
    );
  }

  // Leading shouty run followed by normal prose.
  const match = trimmed.match(/^([A-Z][A-Z0-9&/.'-]*(?:\s+[A-Z][A-Z0-9&/.'-]*)+)(\s+[a-z(].*)$/s);
  if (match && letters(match[1]).length >= 6) {
    return titleCase(match[1]) + match[2];
  }
  return trimmed;
}

/**
 * Normalize a phone number: US 10-digit -> (602) 686-6672, 11-digit with
 * leading 1 -> +1 (602) 686-6672. Anything else (international, extensions,
 * short fragments) is returned trimmed and untouched.
 */
export function normalizePhone(s: string): string {
  const trimmed = s.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return trimmed;
}

/** Emails are case-insensitive; store them lowercase. */
export function normalizeEmail(s: string): string {
  return s.trim().toLowerCase();
}
