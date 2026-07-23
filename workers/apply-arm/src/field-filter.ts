import type { FormField } from "./types";

/**
 * The page-wide `body` sweep the self-healing recovery uses grabs EVERY input
 * on the page, including things that are not application questions: the site
 * search box, the resume file input (handled separately by attachResume), the
 * hidden captcha token textarea, and honeypots. Surfacing those as review
 * questions ("needs your answer") is noise. This drops them from the answerable
 * set. It does NOT affect the sanity check (which runs on raw fields) or the
 * fill path for the resume/captcha (both operate on the live DOM directly).
 */

const CAPTCHA_RE = /recaptcha|g-?recaptcha|h-?captcha|hcaptcha|cf-turnstile|turnstile|captcha/i;
const HONEYPOT_RE = /honeypot|honey-pot|bot-?field|leave.?(this.?)?blank|url_?trap/i;
const SEARCH_NAME_RE = /^(search|q|query|site-?search|search-?query)$/i;

/**
 * True when a field is not a real application question the user should answer.
 */
export function isNonApplicationField(f: FormField): boolean {
  const name = (f.name ?? "").trim();
  const label = (f.label ?? "").trim();
  const hay = `${name} ${label}`;

  // Resume/file upload: the arm attaches the resume via attachResume against
  // the live DOM, so a file field in the Q&A set only produces a confusing
  // "needs your answer".
  if (f.type === "file") return true;

  // Site search box (from the page-wide sweep, never part of an application).
  if (f.type === "search") return true;
  if (SEARCH_NAME_RE.test(name)) return true;
  if (/^search$/i.test(label)) return true;

  // Captcha token fields (hidden textareas populated by the provider's JS).
  if (CAPTCHA_RE.test(hay)) return true;

  // Honeypots (bot traps that must stay empty).
  if (HONEYPOT_RE.test(hay)) return true;

  return false;
}

/** Drop non-application fields from the answerable set. */
export function filterApplicationFields(fields: FormField[]): FormField[] {
  return fields.filter((f) => !isNonApplicationField(f));
}
