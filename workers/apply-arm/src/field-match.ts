/**
 * Pure matching helpers for mapping a generated answer onto the concrete
 * options of a choice field (checkbox group / radio). Kept separate from the
 * browser module so it can be unit-tested without a DOM or Playwright.
 */

/** Split a group answer into individual option values ("a; b" -> ["a","b"]). */
export function splitAnswerValues(value: string): string[] {
  return value
    .split(/[;,]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

const norm = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/[\u2018\u2019\u201b]/g, "'") // curly single quotes -> '
    .replace(/[\u201c\u201d]/g, '"') // curly double quotes -> "
    .replace(/\s+/g, " ");

/**
 * Does a concrete option label match any of the wanted answer values?
 * Exact match first; then containment either way so minor wording drift
 * ("U.S. citizen" vs "US citizen") still ticks the right box. Guards against
 * the classic false positive where "No" would substring-match "None ...": a
 * containment hit must clear a minimum length so short tokens need exact match.
 */
export function checkboxLabelMatches(optionLabel: string, wanted: string[]): boolean {
  const label = norm(optionLabel);
  if (!label) return false;
  return wanted.some((raw) => {
    const w = norm(raw);
    if (!w) return false;
    if (w === label) return true;
    // Only allow fuzzy containment for reasonably specific strings, so a 2-3
    // char answer can't accidentally match a longer unrelated option.
    if (w.length >= 4 && label.includes(w)) return true;
    if (label.length >= 4 && w.includes(label)) return true;
    return false;
  });
}
