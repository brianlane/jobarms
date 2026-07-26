/**
 * Composing a descendant selector underneath an adapter's form scope.
 *
 * Adapter scopes are selector LISTS, because one ATS renders several shapes:
 * Greenhouse is `form[id*="application"], #application-form, #application_form`
 * and Workday is `[data-automation-id="jobApplicationPage"], form, [role="main"]`.
 *
 * Interpolating a list does not mean what it looks like. `${scope} input` reads
 * to CSS as
 *
 *     form[id*="application"]          <- the FORM element, not its inputs
 *     #application-form                <- likewise
 *     #application_form input          <- only the last fragment gets the suffix
 *
 * so a Greenhouse application with sixty controls extracted as exactly one
 * field: the `<form>` itself, which then failed the form-sanity check and
 * reported form_not_found on a page where the form was plainly visible. Lever
 * was unaffected only because its scope is the single selector `form`.
 *
 * Every fragment therefore has to be paired with every suffix explicitly.
 */

/**
 * Split a selector list on its TOP-LEVEL commas, leaving commas inside
 * attribute brackets, functional pseudo-classes, and quoted strings alone.
 */
export function splitSelectorList(scope: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quote = "";

  for (const ch of scope) {
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "[" || ch === "(") {
      depth++;
    } else if (ch === "]" || ch === ")") {
      depth--;
    } else if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);

  return parts.map((part) => part.trim()).filter(Boolean);
}

/** Every `suffix` scoped under every selector in `scope`, as one selector list. */
export function scopedSelector(scope: string, suffixes: readonly string[]): string {
  return splitSelectorList(scope)
    .flatMap((selector) => suffixes.map((suffix) => `${selector} ${suffix}`))
    .join(", ");
}
